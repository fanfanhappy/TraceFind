//! 全局快捷键：先校验新组合，注册成功才替换旧组合；失败自动回滚。

use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};

use crate::state::AppState;

pub fn parse(accel: &str) -> Result<Shortcut, String> {
    match accel.parse::<Shortcut>() {
        Ok(shortcut) => Ok(shortcut),
        Err(err) => Err(format!("无法识别的快捷键「{accel}」：{err}")),
    }
}

/// 启动时的兜底组合：配置的快捷键被占用时依次尝试，避免"隐藏后叫不回来"
pub const FALLBACK_HOTKEYS: &[&str] = &[
    "Ctrl+Alt+Space",
    "Ctrl+Shift+Space",
    "Alt+Shift+Space",
    "Ctrl+Alt+Q",
    "Ctrl+Shift+F12",
];

pub fn register<R: Runtime>(app: &AppHandle<R>, accel: &str) -> Result<Shortcut, String> {
    let shortcut = parse(accel)?;
    let state = app.state::<AppState>();
    let previous = state
        .hotkey
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone();

    // 没变化就不用动：重复注册同一个组合会被系统判为冲突
    if previous == Some(shortcut) {
        return Ok(shortcut);
    }

    // 先注册新组合，成功后才释放旧的：任何一步失败，旧快捷键都还在。
    match app.global_shortcut().register(shortcut) {
        Ok(()) => {
            if let Some(old) = previous {
                let _ = app.global_shortcut().unregister(old);
            }
            *state
                .hotkey
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(shortcut);
            Ok(shortcut)
        }
        Err(err) => Err(format!("{err}")),
    }
}

/// 先试用户配置，失败则按兜底链再试。
/// 返回 (实际生效的快捷键字符串, 是否降级)。
pub fn register_with_fallback<R: Runtime>(
    app: &AppHandle<R>,
    preferred: &str,
) -> (String, bool, Option<String>) {
    match register(app, preferred) {
        Ok(_) => (preferred.to_string(), false, None),
        Err(first_error) => {
            for candidate in FALLBACK_HOTKEYS {
                if candidate.eq_ignore_ascii_case(preferred) {
                    continue;
                }
                if register(app, candidate).is_ok() {
                    return (candidate.to_string(), true, Some(first_error));
                }
            }
            (preferred.to_string(), false, Some(first_error))
        }
    }
}

pub fn is_registered<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.state::<AppState>()
        .hotkey
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .is_some()
}

pub fn unregister_all<R: Runtime>(app: &AppHandle<R>) {
    let state = app.state::<AppState>();
    let mut guard = state
        .hotkey
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(shortcut) = guard.take() {
        let _ = app.global_shortcut().unregister(shortcut);
    }
}
