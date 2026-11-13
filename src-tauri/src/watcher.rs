//! 文件监听：把磁盘上的变化增量写回索引，让新建/改名/删除立刻可搜。
//!
//! 取舍：
//! - notify 的原生 watcher（Windows 上是 ReadDirectoryChangesW），不轮询；
//! - 事件先攒 320ms 再落库，避免批量操作（解压、构建）把数据库打散；
//! - 扫描进行中时直接丢事件——扫描结束会以全量结果覆盖，避免两边写同一个代数；
//! - 目录新增/改名时递归补扫该子树，否则只能看到目录本身。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter, Manager, Runtime};
use walkdir::WalkDir;

use crate::index::{self, NewEntry};
use crate::scanner::{self, OwnedEntry};
use crate::state::AppState;

const DEBOUNCE_MS: u64 = 320;
const MAX_BATCH: usize = 256;
const MAX_PENDING: usize = 5_000;
const MAX_DIR_SCAN: usize = 5_000;
const MAX_DIR_DEPTH: usize = 8;

static WATCHER: OnceLock<Mutex<Option<RecommendedWatcher>>> = OnceLock::new();

fn slot() -> &'static Mutex<Option<RecommendedWatcher>> {
    WATCHER.get_or_init(|| Mutex::new(None))
}

pub fn is_active() -> bool {
    slot()
        .lock()
        .map(|guard| guard.is_some())
        .unwrap_or(false)
}

pub fn start<R: Runtime>(app: &AppHandle<R>, roots: Vec<PathBuf>, excludes: Vec<PathBuf>) {
    stop();

    let (tx, rx) = channel();
    let mut watcher = match notify::recommended_watcher(move |result| {
        let _ = tx.send(result);
    }) {
        Ok(watcher) => watcher,
        Err(err) => {
            crate::aura_log!("文件监听创建失败：{err}");
            return;
        }
    };

    let roots_for_worker = roots.clone();
    let mut watched = 0usize;
    for root in &roots {
        if !root.is_dir() {
            continue;
        }
        match watcher.watch(root, RecursiveMode::Recursive) {
            Ok(()) => watched += 1,
            Err(err) => crate::aura_log!("监听目录失败（{}）：{err}", root.display()),
        }
    }
    if watched == 0 {
        crate::aura_log!("没有可监听的目录，实时更新未启用");
        return;
    }

    let handle = app.clone();
    std::thread::spawn(move || worker(handle, rx, roots_for_worker, excludes));

    if let Ok(mut guard) = slot().lock() {
        *guard = Some(watcher);
    }
    crate::aura_log!("文件监听已启动：{watched} 个目录，防抖 {DEBOUNCE_MS}ms");
}

/// 丢弃 watcher 即停止接收事件，工作线程会随 channel 断开退出
pub fn stop() {
    if let Ok(mut guard) = slot().lock() {
        if guard.take().is_some() {
            crate::aura_log!("文件监听已停止");
        }
    }
}

fn worker<R: Runtime>(
    app: AppHandle<R>,
    rx: Receiver<notify::Result<Event>>,
    roots: Vec<PathBuf>,
    excludes: Vec<PathBuf>,
) {
    let index_path = app.state::<AppState>().index_path.clone();
    let mut conn = match index::open(&index_path) {
        Ok(conn) => conn,
        Err(err) => {
            crate::aura_log!("监听线程无法打开索引库：{err}");
            return;
        }
    };

    // 值为 true 表示这是"修改"事件：需要让该文件的正文失效后重抽
    let mut pending: HashMap<PathBuf, bool> = HashMap::new();
    // 扫描期间不落库：全量扫描会用新代数重写整表，但事件不能丢，
    // 攒在 pending 里等扫描结束再重放（否则扫描窗口内的改动会永久缺席）。
    let mut overflowed = false;

    loop {
        let scanning = app.state::<AppState>().scan_running.load(Ordering::SeqCst);
        match rx.recv_timeout(Duration::from_millis(DEBOUNCE_MS)) {
            Ok(Ok(event)) => {
                // 只关心增删改，读事件没意义
                if matches!(event.kind, EventKind::Access(_)) {
                    continue;
                }
                let modified = matches!(event.kind, EventKind::Modify(_));
                for path in event.paths {
                    if !scanner::ignored_path(&path, &roots, &excludes) {
                        let entry = pending.entry(path).or_insert(false);
                        *entry = *entry || modified;
                    }
                }
                if pending.len() > MAX_PENDING {
                    // 极端情况（一次解压几十万文件）：放弃逐条重放，交给全量扫描
                    crate::aura_log!("监听积压过多，改为全量补扫");
                    pending.clear();
                    overflowed = true;
                }
                if !scanning && !overflowed && pending.len() >= MAX_BATCH {
                    apply(&app, &mut conn, &mut pending, &roots, &excludes);
                }
            }
            Ok(Err(err)) => {
                // 事件缓冲区溢出等错误：靠一次全量扫描兜底，避免索引长期缺数据
                crate::aura_log!("文件监听出错，安排补扫：{err}");
                let options = crate::scanner::ScanOptions {
                    roots: roots.clone(),
                    excludes: excludes.clone(),
                    index_path: app.state::<AppState>().index_path.clone(),
                };
                crate::scanner::spawn(app.clone(), options);
            }
            Err(RecvTimeoutError::Timeout) => {
                if !pending.is_empty() && !scanning {
                    apply(&app, &mut conn, &mut pending, &roots, &excludes);
                }
                if overflowed && !scanning {
                    overflowed = false;
                    let options = crate::scanner::ScanOptions {
                        roots: roots.clone(),
                        excludes: excludes.clone(),
                        index_path: app.state::<AppState>().index_path.clone(),
                    };
                    crate::scanner::spawn(app.clone(), options);
                }
            }
            Err(RecvTimeoutError::Disconnected) => break,
        }
    }

    crate::aura_log!("文件监听线程结束");
}

fn apply<R: Runtime>(
    app: &AppHandle<R>,
    conn: &mut rusqlite::Connection,
    pending: &mut HashMap<PathBuf, bool>,
    roots: &[PathBuf],
    excludes: &[PathBuf],
) {
    let state = app.state::<AppState>();
    // 扫描进行中保留事件，等结束后重放
    if state.scan_running.load(Ordering::SeqCst) {
        return;
    }

    let gen = index::current_gen(conn);
    let mut entries: Vec<OwnedEntry> = Vec::new();
    let mut removals: Vec<String> = Vec::new();
    let mut modified: Vec<String> = Vec::new();

    for (path, was_modified) in pending.drain() {
        if path.exists() {
            if was_modified && path.is_file() {
                modified.push(path.to_string_lossy().to_string());
            }
            if path.is_dir() {
                collect_dir(&path, &mut entries, roots, excludes);
            } else if let Some(entry) = OwnedEntry::from_path(&path, 0) {
                entries.push(entry);
            }
        } else {
            // 文件或目录消失：连同子树一起删
            removals.push(path.to_string_lossy().to_string());
        }
    }

    // 修改事件：先让正文失效，下一轮会被重新抽取（解决同秒覆盖 mtime 不变）
    if !modified.is_empty() {
        if let Err(err) = index::invalidate_docs(conn, &modified) {
            crate::aura_log!("正文失效标记失败：{err}");
        }
    }

    let mut changed = 0usize;

    if !entries.is_empty() {
        let rows: Vec<NewEntry<'_>> = entries
            .iter()
            .map(|entry| NewEntry {
                path: &entry.path,
                name: &entry.name,
                dir: &entry.dir,
                ext: &entry.ext,
                kind: &entry.kind,
                size: entry.size,
                mtime: entry.mtime,
                depth: entry.depth,
            })
            .collect();
        match index::upsert_batch(conn, &rows, gen) {
            Ok(()) => changed += entries.len(),
            Err(err) => crate::aura_log!("增量写入失败：{err}"),
        }
    }

    if !removals.is_empty() {
        match index::delete_paths(conn, &removals) {
            Ok(count) => changed += count,
            Err(err) => crate::aura_log!("增量删除失败：{err}"),
        }
    }

    if changed == 0 {
        return;
    }

    let files = index::count(conn).max(0) as u64;
    {
        let mut status = state
            .index_status
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        status.files = files;
    }

    let _ = app.emit(
        "index:changed",
        serde_json::json!({ "files": files, "changed": changed }),
    );
}

fn collect_dir(root: &Path, out: &mut Vec<OwnedEntry>, roots: &[PathBuf], excludes: &[PathBuf]) {
    for entry in WalkDir::new(root)
        .max_depth(MAX_DIR_DEPTH)
        .follow_links(false)
        .into_iter()
        .filter_map(Result::ok)
    {
        if out.len() >= MAX_DIR_SCAN {
            break;
        }
        if scanner::ignored_path(entry.path(), roots, excludes) {
            continue;
        }
        if let Some(owned) = OwnedEntry::from_path(entry.path(), entry.depth() as i64) {
            out.push(owned);
        }
    }
}
