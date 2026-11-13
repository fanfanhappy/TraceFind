//! 轻量日志：同时写 stderr 与 %APPDATA%\com.aurasearch.desktop\aura.log。
//! 发布版没有控制台，文件日志是排查启动问题的唯一线索。

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::Instant;

use tauri::{AppHandle, Manager, Runtime};

static LOG_PATH: OnceLock<PathBuf> = OnceLock::new();
static START: OnceLock<Instant> = OnceLock::new();

pub fn init<R: Runtime>(app: &AppHandle<R>) {
    let _ = START.set(Instant::now());
    if let Ok(dir) = app.path().app_log_dir() {
        let _ = fs::create_dir_all(&dir);
        let _ = LOG_PATH.set(dir.join("aura.log"));
    }
}

pub fn log(message: impl AsRef<str>) {
    let line = message.as_ref();
    let elapsed = START
        .get()
        .map(|start| start.elapsed().as_millis())
        .unwrap_or(0);
    eprintln!("[tracefind] [+{elapsed}ms] {line}");
    if let Some(path) = LOG_PATH.get() {
        if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
            let _ = writeln!(file, "[+{elapsed}ms] {line}");
        }
    }
}

#[macro_export]
macro_rules! aura_log {
    ($($arg:tt)*) => {
        $crate::logging::log(format!($($arg)*))
    };
}
