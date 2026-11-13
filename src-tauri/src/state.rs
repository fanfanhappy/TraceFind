use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use tauri_plugin_global_shortcut::Shortcut;

use crate::index::IndexStatus;
use crate::settings::AppSettings;

/// 窗口生命周期状态机：真实状态只存在于 Rust 侧，
/// 前端只负责视觉动画，并通过 launcher:animation-finished 回传结果。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Phase {
    Hidden,
    Showing,
    Visible,
    Hiding,
}

pub struct AppState {
    pub settings: Mutex<AppSettings>,
    pub phase: Mutex<Phase>,
    pub material: Mutex<String>,
    /// 原生材质当前用的明暗版本（由前端按解析后的主题下发）
    pub window_dark: Mutex<bool>,
    pub hotkey: Mutex<Option<Shortcut>>,
    /// 实际生效的快捷键文本（可能是降级后的组合）
    pub hotkey_label: Mutex<String>,
    /// 是否因为配置的组合被占用而启用了兜底组合
    pub hotkey_fallback: Mutex<bool>,
    /// 查询用的连接；扫描线程另开一个连接，靠 WAL 并发
    pub db: Mutex<rusqlite::Connection>,
    pub index_path: PathBuf,
    pub index_status: Mutex<IndexStatus>,
    pub scan_running: AtomicBool,
    /// 打开文件后暂时不因失焦而隐藏（用户关掉文件回来还能看到窗口）
    pub hold_visible: AtomicBool,
    /// 扫描范围/排除项的版本号：每次变更 +1，用来让旧扫描任务主动作废
    pub config_version: AtomicU64,
    /// 最近一次查询词：异步语义结果回来时用它判断是否还有效
    pub current_query: Mutex<String>,
    /// 扫描结束后是否需要再补一轮（范围变更时置位）
    pub pending_rescan: AtomicBool,
    pub scan_paused: AtomicBool,
    /// 托盘菜单/系统弹窗会抢焦点，用一个时间窗抑制“失焦即隐藏”。
    suppress_hide_until: Mutex<Option<Instant>>,
    pub quitting: AtomicBool,
}

impl AppState {
    pub fn new(settings: AppSettings, db: rusqlite::Connection, index_path: PathBuf) -> Self {
        Self {
            settings: Mutex::new(settings),
            phase: Mutex::new(Phase::Hidden),
            material: Mutex::new("solid".to_string()),
            window_dark: Mutex::new(true),
            hotkey: Mutex::new(None),
            hotkey_label: Mutex::new(String::new()),
            hotkey_fallback: Mutex::new(false),
            db: Mutex::new(db),
            index_path,
            index_status: Mutex::new(IndexStatus {
                state: "idle".to_string(),
                ..Default::default()
            }),
            scan_running: AtomicBool::new(false),
            hold_visible: AtomicBool::new(false),
            config_version: AtomicU64::new(0),
            current_query: Mutex::new(String::new()),
            pending_rescan: AtomicBool::new(false),
            scan_paused: AtomicBool::new(false),
            suppress_hide_until: Mutex::new(None),
            quitting: AtomicBool::new(false),
        }
    }

    pub fn phase(&self) -> Phase {
        *self.phase.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn set_phase(&self, phase: Phase) {
        *self.phase.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = phase;
    }

    pub fn settings_snapshot(&self) -> AppSettings {
        self.settings
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    pub fn suppress_hide_for(&self, millis: u64) {
        let mut guard = self
            .suppress_hide_until
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *guard = Some(Instant::now() + Duration::from_millis(millis));
    }

    pub fn hide_suppressed(&self) -> bool {
        match *self
            .suppress_hide_until
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
        {
            Some(until) => Instant::now() < until,
            None => false,
        }
    }
}

/// 一次性告警去重（例如材质降级只提示一次）。
pub fn warn_once(key: &'static str, message: impl FnOnce()) {
    static SEEN: OnceLock<Mutex<Vec<&'static str>>> = OnceLock::new();
    let seen = SEEN.get_or_init(|| Mutex::new(Vec::new()));
    let mut seen = seen.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if !seen.contains(&key) {
        seen.push(key);
        message();
    }
}
