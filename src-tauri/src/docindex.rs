//! 正文索引 worker。
//!
//! 一个常驻低优先级线程：找出"还没有正文、或修改时间变了"的文件，抽取文字写进 FTS5。
//! 每处理一个文件睡 25ms，避免和用户的实际操作抢磁盘；全量扫描期间让路。

use std::path::Path;
use std::sync::atomic::Ordering;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::extract;
use crate::index;
use crate::state::AppState;

const BATCH: usize = 6;
const IDLE_SLEEP_MS: u64 = 1500;
const PER_FILE_SLEEP_MS: u64 = 25;

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ContentStatus {
    pub done: i64,
    pub failed: i64,
    pub chars: i64,
    pub pending: i64,
    pub enabled: bool,
}

pub fn status<R: Runtime>(app: &AppHandle<R>, conn: &rusqlite::Connection) -> ContentStatus {
    let settings = app.state::<AppState>().settings_snapshot();
    let mut exts = extract::supported_extensions();
    if settings.ocr_enabled {
        exts.extend_from_slice(crate::ocr::IMAGE_EXTS);
    }
    let exts = exts;
    let (done, failed, chars) = index::doc_stats(conn).unwrap_or((0, 0, 0));
    let pending = index::pending_count(conn, &exts, extract::MAX_INPUT_BYTES as i64).unwrap_or(0);
    let enabled = app.state::<AppState>().settings_snapshot().content_index;
    ContentStatus {
        done,
        failed,
        chars,
        pending,
        enabled,
    }
}

pub fn spawn<R: Runtime>(app: AppHandle<R>) {
    std::thread::spawn(move || run(app));
}

fn run<R: Runtime>(app: AppHandle<R>) {
    let index_path = app.state::<AppState>().index_path.clone();
    let mut conn = match index::open(&index_path) {
        Ok(conn) => conn,
        Err(err) => {
            crate::aura_log!("正文索引线程无法打开索引库：{err}");
            return;
        }
    };

    let ocr_enabled = app.state::<AppState>().settings_snapshot().ocr_enabled;
    let mut exts = extract::supported_extensions();
    if ocr_enabled {
        exts.extend_from_slice(crate::ocr::IMAGE_EXTS);
    }
    let exts = exts;

    loop {
        let state = app.state::<AppState>();
        if state.quitting.load(Ordering::Relaxed) {
            break;
        }

        if !state.settings_snapshot().content_index {
            std::thread::sleep(Duration::from_millis(IDLE_SLEEP_MS));
            continue;
        }

        // 全量扫描优先用磁盘
        if state.scan_running.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_millis(400));
            continue;
        }

        // 文本类优先：图片 OCR 慢，别让它挡住新文档的正文索引
        let mut pending = match index::pending_docs_filtered(
            &conn,
            &exts,
            extract::MAX_INPUT_BYTES as i64,
            BATCH,
            crate::ocr::IMAGE_EXTS,
        ) {
            Ok(list) => list,
            Err(err) => {
                crate::aura_log!("读取待提取列表失败：{err}");
                std::thread::sleep(Duration::from_millis(IDLE_SLEEP_MS));
                continue;
            }
        };

        if pending.is_empty() {
            // 没有文本待处理了，再吃图片 OCR 队列
            pending = index::pending_docs(&conn, &exts, extract::MAX_INPUT_BYTES as i64, BATCH)
                .unwrap_or_default();
        }

        if pending.is_empty() {
            std::thread::sleep(Duration::from_millis(IDLE_SLEEP_MS));
            continue;
        }

        let mut processed = 0usize;
        for (path, mtime, size) in pending {
            if app.state::<AppState>().quitting.load(Ordering::Relaxed) {
                break;
            }

            let path_buf = Path::new(&path);
            let ext = path_buf
                .extension()
                .map(|value| value.to_string_lossy().to_lowercase())
                .unwrap_or_default();

            // 第三方解析器（尤其 pdf-extract）遇到异常文件会直接 panic，
            // 不隔离的话整个 worker 线程会被打死，索引从此停摆。
            let ocr_enabled = app.state::<AppState>().settings_snapshot().ocr_enabled;
            let extracted = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let base = extract::extract(path_buf, &ext);

                // 图片：本来就没有文本层，直接 OCR
                if crate::ocr::supports_image(&ext) {
                    if !ocr_enabled {
                        return base;
                    }
                    // 小图标基本没有文字，OCR 只是白烧 CPU；超大图直接跳过
                    if size < 8 * 1024 {
                        return Ok(String::new());
                    }
                    if size > 8 * 1024 * 1024 {
                        return Err("图片超过 8 MB，跳过 OCR".to_string());
                    }
                    return crate::ocr::image_text(path_buf);
                }

                // PDF：文本层太薄基本就是扫描件，OCR 兜底（上限 12 页）
                if ext == "pdf" && ocr_enabled {
                    let thin = base
                        .as_ref()
                        .map(|text| text.trim().chars().count() < 40)
                        .unwrap_or(true);
                    if thin {
                        match crate::ocr::pdf_text(path_buf, crate::ocr::MAX_PDF_PAGES) {
                            Ok(text) if text.trim().chars().count() > 40 => return Ok(text),
                            Ok(_) => {}
                            Err(err) => crate::aura_log!("PDF OCR 失败（{path}）：{err}"),
                        }
                    }
                }

                base
            }));

            match extracted {
                Ok(Ok(text)) => {
                    // 事务内核对版本：提取期间文件变了就不写，避免旧正文复活
                    match index::commit_body(&mut conn, &path, mtime, size, &text) {
                        Ok(index::BodyCommit::Stored) => {}
                        Ok(index::BodyCommit::Stale) => {
                            crate::aura_log!("正文已过期，丢弃：{path}");
                        }
                        Ok(index::BodyCommit::MissingFile) => {}
                        Err(err) => {
                            let _ = index::invalidate_docs(&conn, std::slice::from_ref(&path));
                            let _ = index::mark_doc(
                                &conn,
                                &path,
                                "failed",
                                mtime,
                                size,
                                0,
                                Some(&err.to_string()),
                            );
                        }
                    }
                }
                Ok(Err(err)) => {
                    // 提取失败：旧正文必须失效，否则"文件已损坏/清空"还能搜到旧内容
                    let _ = index::invalidate_docs(&conn, std::slice::from_ref(&path));
                    let _ = index::mark_doc(&conn, &path, "failed", mtime, size, 0, Some(&err));
                }
                Err(_) => {
                    let _ = index::invalidate_docs(&conn, std::slice::from_ref(&path));
                    let _ = index::mark_doc(
                        &conn,
                        &path,
                        "failed",
                        mtime,
                        size,
                        0,
                        Some("解析器崩溃（编码不受支持或文件损坏）"),
                    );
                }
            }

            processed += 1;
            std::thread::sleep(Duration::from_millis(PER_FILE_SLEEP_MS));
        }

        if processed > 0 {
            let status = status(&app, &conn);
            let _ = app.emit("index:content", status);
        }
    }

    crate::aura_log!("正文索引线程结束");
}

/// 清空正文索引，让 worker 重新提取
pub fn rebuild<R: Runtime>(app: &AppHandle<R>) -> bool {
    let state = app.state::<AppState>();
    let conn = match state.db.lock() {
        Ok(conn) => conn,
        Err(_) => return false,
    };
    match conn.execute_batch(
        "DELETE FROM doc_text; DELETE FROM doc_fts;",
    ) {
        Ok(()) => {
            let _ = app.emit("index:content", status_from(&conn, state.settings_snapshot().content_index, state.settings_snapshot().ocr_enabled));
            crate::aura_log!("正文索引已清空，等待重建");
            true
        }
        Err(err) => {
            crate::aura_log!("清空正文索引失败：{err}");
            false
        }
    }
}

fn status_from(conn: &rusqlite::Connection, enabled: bool, ocr_enabled: bool) -> ContentStatus {
    let mut exts = extract::supported_extensions();
    if ocr_enabled {
        exts.extend_from_slice(crate::ocr::IMAGE_EXTS);
    }
    let exts = exts;
    let (done, failed, chars) = index::doc_stats(conn).unwrap_or((0, 0, 0));
    let pending = index::pending_count(conn, &exts, extract::MAX_INPUT_BYTES as i64).unwrap_or(0);
    ContentStatus {
        done,
        failed,
        chars,
        pending,
        enabled,
    }
}
