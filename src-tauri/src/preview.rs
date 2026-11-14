//! 预览数据：给右侧抽屉提供"不打开外部程序也能看内容"的数据。
//!
//! 复用正文抽取器，所以 Office/PDF 不需要第二套解析；
//! 图片走 data URL，避免为预览单独开 asset 协议与额外权限。

use std::collections::VecDeque;
use std::fs;
use std::path::Path;
use std::sync::{Mutex, OnceLock};

use base64::Engine;
use serde::Serialize;

use crate::extract;
use crate::index;

/// 文本预览最多回传这么多字符（够滚几屏，又不至于把 IPC 撑爆）
const TEXT_LIMIT: usize = 120_000;
/// 单页预览字符数（分页加载）
const TEXT_PAGE: usize = 60_000;
/// 纯文本预览单次最多读取 4 MB
const PREVIEW_TEXT_BYTES: u64 = 4 * 1024 * 1024;
/// 图片预览上限
const IMAGE_LIMIT: u64 = 8 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PreviewPayload {
    /// text | image | unsupported | error
    pub kind: String,
    pub name: String,
    pub path: String,
    pub ext: String,
    pub size: u64,
    pub modified: i64,
    pub text: Option<String>,
    pub truncated: bool,
    pub total_chars: Option<usize>,
    /// 下一页的起始字符位置；None 表示已到底
    pub next_start: Option<usize>,
    pub image_data_url: Option<String>,
    pub language: Option<String>,
    pub message: Option<String>,
}

fn mime_for(ext: &str) -> &'static str {
    match ext {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        _ => "application/octet-stream",
    }
}

fn language_for(ext: &str) -> Option<&'static str> {
    let language = match ext {
        "rs" => "rust",
        "ts" | "tsx" => "typescript",
        "js" | "jsx" => "javascript",
        "py" => "python",
        "go" => "go",
        "java" => "java",
        "c" | "h" => "c",
        "cpp" | "hpp" => "cpp",
        "cs" => "csharp",
        "rb" => "ruby",
        "php" => "php",
        "sh" => "shell",
        "ps1" => "powershell",
        "sql" => "sql",
        "json" => "json",
        "yaml" | "yml" => "yaml",
        "toml" => "toml",
        "css" => "css",
        "scss" => "scss",
        "html" | "htm" => "html",
        "md" | "markdown" => "markdown",
        _ => return None,
    };
    Some(language)
}

/// 预览缓存：抽屉里按 ↑↓ 连续切换时不必重复解析。
/// 只缓存文本类结果（图片是 MB 级 data URL，缓存性价比低）。
const CACHE_CAPACITY: usize = 12;

static CACHE: OnceLock<Mutex<VecDeque<CacheEntry>>> = OnceLock::new();

struct CacheEntry {
    path: String,
    mtime: i64,
    size: u64,
    payload: PreviewPayload,
}

fn cache() -> &'static Mutex<VecDeque<CacheEntry>> {
    CACHE.get_or_init(|| Mutex::new(VecDeque::new()))
}

fn cache_lookup(path: &str, mtime: i64, size: u64) -> Option<PreviewPayload> {
    let mut guard = cache().lock().ok()?;
    let index = guard
        .iter()
        .position(|entry| entry.path == path && entry.mtime == mtime && entry.size == size)?;
    let entry = guard.remove(index)?;
    let payload = entry.payload.clone();
    guard.push_front(entry);
    Some(payload)
}

fn cache_store(path: &str, mtime: i64, size: u64, payload: &PreviewPayload) {
    if payload.kind != "text" {
        return;
    }
    if let Ok(mut guard) = cache().lock() {
        guard.retain(|entry| entry.path != path);
        guard.push_front(CacheEntry {
            path: path.to_string(),
            mtime,
            size,
            payload: payload.clone(),
        });
        while guard.len() > CACHE_CAPACITY {
            guard.pop_back();
        }
    }
}

pub fn build_with_offset(path: &Path, start: usize) -> PreviewPayload {
    let mut payload = build(path);
    if payload.kind == "text" {
        if let Some(text) = payload.text.take() {
            let chars: Vec<char> = text.chars().collect();
            let total = payload.total_chars.unwrap_or(chars.len());
            let end = (start + TEXT_PAGE).min(chars.len());
            let page: String = if start < chars.len() {
                chars[start..end].iter().collect()
            } else {
                String::new()
            };
            payload.text = Some(page);
            payload.next_start = if end < chars.len() { Some(end) } else { None };
            payload.total_chars = Some(total);
            payload.truncated = payload.next_start.is_some();
        }
    }
    payload
}

pub fn build(path: &Path) -> PreviewPayload {
    let name = path
        .file_name()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_default();
    let ext = path
        .extension()
        .map(|value| value.to_string_lossy().to_lowercase())
        .unwrap_or_default();

    let meta = fs::metadata(path).ok();
    let mut payload = PreviewPayload {
        kind: "unsupported".to_string(),
        name,
        path: path.to_string_lossy().to_string(),
        ext: ext.clone(),
        size: meta.as_ref().map(|m| m.len()).unwrap_or(0),
        modified: meta
            .as_ref()
            .and_then(|m| m.modified().ok())
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0),
        ..Default::default()
    };

    if let Some(hit) = cache_lookup(&payload.path, payload.modified, payload.size) {
        crate::aura_log!("预览命中缓存：{}", payload.path);
        return hit;
    }

    if path.is_dir() {
        payload.kind = "folder".to_string();
        payload.message = Some("这是一个文件夹".to_string());
        return payload;
    }

    let ext_kind = index::classify(&ext, false);
    if ext_kind == "image" {
        match fs::metadata(path) {
            Ok(meta) if meta.len() > IMAGE_LIMIT => {
                payload.kind = "unsupported".to_string();
                payload.message = Some(format!(
                    "图片过大（{} MB），超过 {} MB 预览上限",
                    meta.len() / 1024 / 1024,
                    IMAGE_LIMIT / 1024 / 1024
                ));
                return payload;
            }
            Ok(_) => match fs::read(path) {
                Ok(bytes) => {
                    let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
                    payload.kind = "image".to_string();
                    payload.image_data_url =
                        Some(format!("data:{};base64,{}", mime_for(&ext), encoded));
                    cache_store(&payload.path.clone(), payload.modified, payload.size, &payload);
                    return payload;
                }
                Err(err) => {
                    payload.kind = "error".to_string();
                    payload.message = Some(format!("读取失败：{err}"));
                    return payload;
                }
            },
            Err(err) => {
                payload.kind = "error".to_string();
                payload.message = Some(format!("读取失败：{err}"));
                return payload;
            }
        }
    }

    // 二进制/压缩包等：不尝试解码，直接告诉用户用外部程序
    if !extract::supports(&ext) {
        payload.kind = "unsupported".to_string();
        payload.message = Some(format!("{} 文件不支持内置预览", ext.to_uppercase()));
        return payload;
    }

    // 纯文本/代码：直接读（最多 4 MB），支持分页；Office/PDF 仍走抽取器
    if extract::is_plain_text(&ext) {
        match extract::read_text_capped(path, PREVIEW_TEXT_BYTES) {
            Ok(text) => {
                let total = text.chars().count();
                payload.kind = "text".to_string();
                payload.text = Some(text);
                payload.total_chars = Some(total);
                payload.language = language_for(&ext).map(|value| value.to_string());
                cache_store(&payload.path.clone(), payload.modified, payload.size, &payload);
                return payload;
            }
            Err(err) => {
                payload.kind = "error".to_string();
                payload.message = Some(err);
                return payload;
            }
        }
    }

    // 文档：复用正文抽取器
    let extracted = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        extract::extract(path, &ext)
    }));

    match extracted {
        Ok(Ok(text)) => {
            let total = text.chars().count();
            let truncated = total > TEXT_LIMIT;
            let mut body: String = if truncated {
                text.chars().take(TEXT_LIMIT).collect()
            } else {
                text
            };
            if truncated {
                body.push_str("\n\n…（预览已截断，完整内容请用外部程序打开）");
            }
            payload.kind = "text".to_string();
            payload.text = Some(body);
            payload.truncated = truncated;
            payload.total_chars = Some(total);
            payload.language = language_for(&ext).map(|value| value.to_string());
        }
        Ok(Err(err)) => {
            payload.kind = "unsupported".to_string();
            payload.message = Some(format!("无法预览：{err}"));
        }
        Err(_) => {
            payload.kind = "error".to_string();
            payload.message = Some("解析器崩溃（编码不受支持或文件损坏）".to_string());
        }
    }

    cache_store(&payload.path.clone(), payload.modified, payload.size, &payload);
    payload
}
