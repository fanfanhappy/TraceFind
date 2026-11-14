//! 目录扫描：把文件系统里的名字/路径/大小/时间写进索引。
//!
//! 设计取舍：
//! - 单线程顺序遍历 + 批量事务，避免大量小事务把磁盘打满；
//! - 用“代数（generation）”标记本次扫描见到的行，扫完删掉旧代，天然处理删除/移动；
//! - 暂停只停遍历，不中断事务，恢复后继续；
//! - 不跟随符号链接，避免环。

use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Emitter, Manager, Runtime};
use walkdir::WalkDir;

use crate::index::{self, NewEntry};
use crate::state::AppState;

const BATCH_SIZE: usize = 256;
const EMIT_EVERY: u64 = 200;
const MAX_FILES: usize = 400_000;
const MAX_DEPTH: usize = 16;

/// 系统目录/依赖目录一律不进：这些地方既没用户文件，又会拖慢扫描
const SKIP_DIRS: &[&str] = &[
    "node_modules",
    "target",
    ".git",
    ".svn",
    ".hg",
    "AppData",
    "$RECYCLE.BIN",
    "System Volume Information",
    "Windows",
    "Program Files",
    "Program Files (x86)",
    "ProgramData",
    ".venv",
    "venv",
    "__pycache__",
    ".next",
    ".cache",
    ".gradle",
    ".idea",
    "obj",
    "bin",
];

pub struct ScanOptions {
    pub roots: Vec<PathBuf>,
    pub excludes: Vec<PathBuf>,
    pub index_path: PathBuf,
}

fn unix_seconds(time: SystemTime) -> i64 {
    time.duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn is_hidden(name: &str) -> bool {
    name.starts_with('.') || name.starts_with('$')
}

fn should_skip_dir(entry: &walkdir::DirEntry, excludes: &[PathBuf]) -> bool {
    let name = entry.file_name().to_string_lossy();
    if SKIP_DIRS.iter().any(|skip| skip.eq_ignore_ascii_case(&name)) || is_hidden(&name) {
        return true;
    }
    let path = entry.path();
    excludes.iter().any(|exclude| path.starts_with(exclude))
}

/// 扫描结果：正常完成，或因为范围变更而主动作废（此时不能 prune）
pub enum ScanOutcome {
    Done(u64),
    Superseded,
}

fn current_config_version<R: Runtime>(app: &AppHandle<R>) -> u64 {
    app.state::<AppState>()
        .config_version
        .load(Ordering::SeqCst)
}

/// 启动一次扫描（后台线程）。已有扫描在跑时直接返回 false。
pub fn spawn<R: Runtime>(app: AppHandle<R>, options: ScanOptions) -> bool {
    let state = app.state::<AppState>();
    if state.scan_running.swap(true, Ordering::SeqCst) {
        return false;
    }
    state.scan_paused.store(false, Ordering::SeqCst);
    state.pending_rescan.store(false, Ordering::SeqCst);
    let version = state.config_version.load(Ordering::SeqCst);
    let _ = crate::tray_manager::refresh(&app);

    std::thread::spawn(move || {
        let result = run(&app, options, version);
        let state = app.state::<AppState>();
        state.scan_running.store(false, Ordering::SeqCst);
        state.scan_paused.store(false, Ordering::SeqCst);

        let mut status = state
            .index_status
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        match result {
            Ok(ScanOutcome::Done(files)) => {
                status.state = "ready".to_string();
                status.files = files;
                status.scanned = files;
                status.current.clear();
                status.last_scan = unix_seconds(SystemTime::now());
                status.error = None;
                let _ = app.emit("index:progress", status.clone());
                let _ = app.emit("index:done", status.clone());
                crate::aura_log!("索引完成：{} 个条目", files);
            }
            Ok(ScanOutcome::Superseded) => {
                status.state = "idle".to_string();
                status.current.clear();
                let _ = app.emit("index:progress", status.clone());
                crate::aura_log!("扫描范围已变更，本轮扫描作废");
            }
            Err(err) => {
                status.state = "idle".to_string();
                status.error = Some(err.clone());
                let _ = app.emit("index:progress", status.clone());
                crate::aura_log!("索引失败：{err}");
            }
        }
        drop(status);
        // 统计写好之后再刷新托盘，提示里的文件数才是最新的
        let _ = crate::tray_manager::refresh(&app);
        maybe_rescan(&app);
    });

    true
}

/// 扫描退出时如果积压了「范围变更」，按最新设置再扫一轮
fn maybe_rescan<R: Runtime>(app: &AppHandle<R>) {
    let state = app.state::<AppState>();
    if !state.pending_rescan.swap(false, Ordering::SeqCst) {
        return;
    }
    let settings = state.settings_snapshot();
    let options = ScanOptions {
        roots: settings.roots.iter().map(PathBuf::from).collect(),
        excludes: settings.excluded_paths.iter().map(PathBuf::from).collect(),
        index_path: state.index_path.clone(),
    };
    crate::aura_log!("按最新扫描范围重新扫描");
    spawn(app.clone(), options);
}

/// 按当前设置启动一次全量扫描（范围变更后调用）
pub fn spawn_full<R: Runtime>(app: &AppHandle<R>) -> bool {
    let state = app.state::<AppState>();
    let settings = state.settings_snapshot();
    let options = ScanOptions {
        roots: settings.roots.iter().map(PathBuf::from).collect(),
        excludes: settings.excluded_paths.iter().map(PathBuf::from).collect(),
        index_path: state.index_path.clone(),
    };
    spawn(app.clone(), options)
}

pub fn pause<R: Runtime>(app: &AppHandle<R>) {
    let state = app.state::<AppState>();
    if state.scan_running.load(Ordering::SeqCst) {
        state.scan_paused.store(true, Ordering::SeqCst);
    }
}

pub fn resume<R: Runtime>(app: &AppHandle<R>) {
    app.state::<AppState>()
        .scan_paused
        .store(false, Ordering::SeqCst);
}

pub fn is_running<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.state::<AppState>().scan_running.load(Ordering::SeqCst)
}

fn run<R: Runtime>(
    app: &AppHandle<R>,
    options: ScanOptions,
    version: u64,
) -> Result<ScanOutcome, String> {
    let mut conn = index::open(&options.index_path).map_err(|err| err.to_string())?;
    index::init(&conn).map_err(|err| err.to_string())?;
    let gen = index::next_generation(&conn).map_err(|err| err.to_string())?;

    let state = app.state::<AppState>();
    {
        let mut status = state
            .index_status
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        status.state = "scanning".to_string();
        status.scanned = 0;
        status.error = None;
        status.current.clear();
    }

    let mut batch: Vec<OwnedEntry> = Vec::with_capacity(BATCH_SIZE);
    let mut scanned: u64 = 0;
    let mut last_emit = 0u64;

    for root in &options.roots {
        if !root.exists() {
            continue;
        }

        let walker = WalkDir::new(root)
            .max_depth(MAX_DEPTH)
            .follow_links(false)
            .into_iter()
            .filter_entry(|entry| {
                if entry.depth() == 0 {
                    return true;
                }
                if entry.file_type().is_dir() {
                    !should_skip_dir(entry, &options.excludes)
                } else {
                    true
                }
            });

        for entry in walker.filter_map(Result::ok) {
            // 范围改过了：立即作废，避免把旧范围的条目写回去
            if current_config_version(app) != version {
                return Ok(ScanOutcome::Superseded);
            }
            // 暂停：原地等待，恢复后继续
            while state.scan_paused.load(Ordering::SeqCst) {
                {
                    let mut status = state
                        .index_status
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner());
                    status.state = "paused".to_string();
                }
                std::thread::sleep(Duration::from_millis(200));
            }
            {
                let mut status = state
                    .index_status
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                if status.state != "scanning" {
                    status.state = "scanning".to_string();
                }
            }

            let Some(owned) = OwnedEntry::from_path(entry.path(), entry.depth() as i64) else {
                continue;
            };
            let dir_for_status = owned.dir.clone();
            batch.push(owned);

            scanned += 1;

            if batch.len() >= BATCH_SIZE {
                flush(&mut conn, &batch, gen)?;
                batch.clear();
            }

            if scanned - last_emit >= EMIT_EVERY {
                last_emit = scanned;
                let mut status = state
                    .index_status
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                status.scanned = scanned;
                status.current = dir_for_status.clone();
                let _ = app.emit("index:progress", status.clone());
            }

            if scanned as usize >= MAX_FILES {
                crate::aura_log!("已达单次扫描上限 {MAX_FILES}，提前结束");
                break;
            }
        }
    }

    if !batch.is_empty() {
        flush(&mut conn, &batch, gen)?;
    }

    if current_config_version(app) != version {
        return Ok(ScanOutcome::Superseded);
    }

    let removed = index::prune_stale(&conn, gen).map_err(|err| err.to_string())?;
    if removed > 0 {
        crate::aura_log!("索引清理：移除 {removed} 个已不存在的条目");
    }
    // 顺带清掉已删除文件的正文记录与文本块
    if index::prune_semantic(&conn).is_ok_and(|removed| removed > 0) {
        crate::semantic::mark_vectors_changed();
    }
    if let Ok(removed_docs) = index::prune_docs(&conn) {
        if removed_docs > 0 {
            crate::aura_log!("正文索引清理：{removed_docs} 条");
        }
    }
    index::mark_scanned(&conn, unix_seconds(SystemTime::now())).map_err(|err| err.to_string())?;
    // 收尾整理：更新统计信息并把 WAL 截断，避免库文件无限增长
    let _ = conn.execute_batch("PRAGMA optimize; PRAGMA wal_checkpoint(TRUNCATE);");

    let total = index::count(&conn) as u64;
    Ok(ScanOutcome::Done(total))
}

pub(crate) struct OwnedEntry {
    pub path: String,
    pub name: String,
    pub dir: String,
    pub ext: String,
    pub kind: String,
    pub size: i64,
    pub mtime: i64,
    pub depth: i64,
}

impl OwnedEntry {
    pub fn from_path(path: &Path, depth: i64) -> Option<Self> {
        let name = path.file_name()?.to_string_lossy().to_string();
        if name.is_empty() {
            return None;
        }
        let meta = std::fs::metadata(path).ok()?;
        let is_dir = meta.is_dir();
        let ext = path
            .extension()
            .map(|value| value.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        let dir = path
            .parent()
            .map(|parent| parent.to_string_lossy().to_string())
            .unwrap_or_default();

        Some(Self {
            path: path.to_string_lossy().to_string(),
            name,
            dir,
            ext: ext.clone(),
            kind: index::classify(&ext, is_dir).to_string(),
            size: if is_dir { 0 } else { meta.len() as i64 },
            mtime: meta.modified().map(unix_seconds).unwrap_or(0),
            depth,
        })
    }
}

/// 监听与扫描共用的忽略规则：系统目录、依赖目录、隐藏项、临时文件。
/// SKIP_DIRS 只对「扫描根之下」的路径生效——否则根目录本身位于
/// AppData/Program Files 时会连根被判定为忽略（隔离测试就踩过）。
pub fn ignored_path(path: &Path, roots: &[PathBuf], excludes: &[PathBuf]) -> bool {
    if excludes.iter().any(|exclude| path.starts_with(exclude)) {
        return true;
    }
    let Some(name) = path.file_name().map(|value| value.to_string_lossy().to_string()) else {
        return true;
    };
    if name.is_empty() || is_hidden(&name) {
        return true;
    }
    let lower = name.to_lowercase();
    if lower.ends_with(".tmp")
        || lower.ends_with(".crdownload")
        || lower.ends_with(".part")
        || lower.ends_with(".partial")
        || name.starts_with('~')
    {
        return true;
    }
    let base = roots
        .iter()
        .filter(|root| path.starts_with(root))
        .max_by_key(|root| root.as_os_str().len());
    let relative = base
        .and_then(|root| path.strip_prefix(root).ok())
        .unwrap_or(path);

    relative.components().any(|component| {
        let text = component.as_os_str().to_string_lossy();
        SKIP_DIRS.iter().any(|skip| skip.eq_ignore_ascii_case(&text))
    })
}

fn flush(conn: &mut rusqlite::Connection, batch: &[OwnedEntry], gen: i64) -> Result<(), String> {
    let entries: Vec<NewEntry<'_>> = batch
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
    index::upsert_batch(conn, &entries, gen).map_err(|err| err.to_string())
}

/// 首次运行的默认扫描范围：桌面、下载、文档
pub fn default_roots<R: Runtime>(app: &AppHandle<R>) -> Vec<String> {
    let path = app.path();
    [path.desktop_dir().ok(), path.download_dir().ok(), path.document_dir().ok()]
        .into_iter()
        .flatten()
        .map(|dir| dir.to_string_lossy().to_string())
        .collect()
}

/// 把字符串路径规范化成存在的绝对路径
pub fn normalize_root(raw: &str) -> Option<PathBuf> {
    let path = Path::new(raw.trim());
    if !path.is_dir() {
        return None;
    }
    Some(path.to_path_buf())
}

/// 只补扫一个新加入的目录：不推进代数、不 prune。
/// 部分扫描无法判断别的目录里哪些文件还活着，做 prune 会误删。
pub fn spawn_root_scan<R: Runtime>(app: AppHandle<R>, root: PathBuf, excludes: Vec<PathBuf>) -> bool {
    let state = app.state::<AppState>();
    if state.scan_running.swap(true, Ordering::SeqCst) {
        return false;
    }
    state.pending_rescan.store(false, Ordering::SeqCst);
    let version = state.config_version.load(Ordering::SeqCst);

    std::thread::spawn(move || {
        let index_path = app.state::<AppState>().index_path.clone();
        let mut conn = match index::open(&index_path) {
            Ok(conn) => conn,
            Err(err) => {
                crate::aura_log!("补扫无法打开索引库：{err}");
                app.state::<AppState>()
                    .scan_running
                    .store(false, Ordering::SeqCst);
                return;
            }
        };

        let gen = index::current_gen(&conn);
        let mut batch: Vec<OwnedEntry> = Vec::with_capacity(BATCH_SIZE);
        let mut scanned = 0u64;

        let walker = WalkDir::new(&root)
            .max_depth(MAX_DEPTH)
            .follow_links(false)
            .into_iter()
            .filter_entry(|entry| {
                if entry.depth() == 0 {
                    return true;
                }
                if entry.file_type().is_dir() {
                    !should_skip_dir(entry, &excludes)
                } else {
                    true
                }
            });

        for entry in walker.filter_map(Result::ok) {
            if current_config_version(&app) != version {
                // 范围又变了：本轮作废，交给结束后的补扫
                app.state::<AppState>()
                    .pending_rescan
                    .store(true, Ordering::SeqCst);
                app.state::<AppState>()
                    .scan_running
                    .store(false, Ordering::SeqCst);
                crate::aura_log!("补扫期间范围变更，本轮作废");
                return;
            }
            let Some(owned) = OwnedEntry::from_path(entry.path(), entry.depth() as i64) else {
                continue;
            };
            batch.push(owned);
            scanned += 1;
            if batch.len() >= BATCH_SIZE {
                let _ = flush(&mut conn, &batch, gen);
                batch.clear();
            }
        }
        if !batch.is_empty() {
            let _ = flush(&mut conn, &batch, gen);
        }

        let files = index::count(&conn).max(0) as u64;
        {
            let state = app.state::<AppState>();
            let mut status = state
                .index_status
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            status.state = "ready".to_string();
            status.files = files;
            status.scanned = files;
            status.last_scan = unix_seconds(SystemTime::now());
            let _ = app.emit("index:progress", status.clone());
        }
        app.state::<AppState>()
            .scan_running
            .store(false, Ordering::SeqCst);
        let _ = app.emit(
            "index:changed",
            serde_json::json!({ "files": files, "changed": scanned }),
        );
        crate::aura_log!("补扫完成：{} 个条目（{}）", scanned, root.display());
    });

    true
}
