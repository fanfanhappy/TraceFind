//! 生命周期状态机。
//!
//! 一次唤起 = Rust 显示窗口 + 派发 launcher:show → React 播 180ms 动画
//! → animationend 回传 launcher_animation_finished → Rust 记为 Visible。
//! 隐藏同理，前端有 120ms 退场动画，Rust 收到回传后才真正 hide。
//! 状态只存在 Rust 侧，React 只持有视觉相位，避免双份状态互相覆盖。

use std::sync::atomic::Ordering;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::state::{AppState, Phase};
use crate::windowing;

pub fn show<R: Runtime>(app: &AppHandle<R>) {
    let state = app.state::<AppState>();
    let Some(window) = app.get_webview_window("main") else {
        return;
    };

    if window.is_minimized().unwrap_or(false) {
        let _ = window.unminimize();
    }

    match state.phase() {
        Phase::Hidden => {
            crate::aura_log!("唤起：开始定位并显示窗口");
            windowing::place_on_cursor_monitor(&window);
            let _ = window.show();
            let _ = window.set_focus();
            crate::aura_log!("窗口已显示（可交互）");
            state.set_phase(Phase::Showing);
            let _ = app.emit("launcher:show", ());
        }
        Phase::Hiding => {
            // 退场动画被打断：直接回到可见态，避免闪一下再出现
            state.set_phase(Phase::Visible);
            let _ = window.show();
            let _ = window.set_focus();
            let _ = app.emit("launcher:focus", ());
        }
        _ => {
            let _ = window.show();
            let _ = window.set_focus();
            let _ = app.emit("launcher:focus", ());
        }
    }
}

pub fn hide<R: Runtime>(app: &AppHandle<R>) {
    let state = app.state::<AppState>();
    match state.phase() {
        Phase::Hidden | Phase::Hiding => return,
        _ => {}
    }

    if app.tray_by_id(crate::tray_manager::TRAY_ID).is_none()
        && !crate::hotkey_manager::is_registered(app)
    {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.set_skip_taskbar(false);
            let _ = window.minimize();
        }
        return;
    }

    state.set_phase(Phase::Hiding);
    let _ = app.emit("launcher:hide", ());

    // 兜底：前端因为不可见而没有触发 animationend 时，320ms 后强制收起
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(320));
        let state = handle.state::<AppState>();
        if state.phase() == Phase::Hiding {
            finish_hide(&handle);
        }
    });
}

pub fn finish_hide<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
    app.state::<AppState>().set_phase(Phase::Hidden);
}

pub fn toggle<R: Runtime>(app: &AppHandle<R>) {
    if app.get_webview_window("main").is_some_and(|window| window.is_minimized().unwrap_or(false)) {
        show(app);
        return;
    }
    match app.state::<AppState>().phase() {
        Phase::Hidden | Phase::Hiding => show(app),
        _ => hide(app),
    }
}

pub fn animation_finished<R: Runtime>(app: &AppHandle<R>, phase: &str) {
    let state = app.state::<AppState>();
    match phase {
        "hide" => {
            if state.phase() == Phase::Hiding {
                finish_hide(app);
            }
        }
        "show" => {
            if state.phase() == Phase::Showing {
                state.set_phase(Phase::Visible);
                crate::aura_log!("唤起完成：窗口可交互");
            }
        }
        _ => {}
    }
}

/// 失焦不是立刻隐藏：延迟 190ms 再判定，给设置窗口、托盘菜单、
/// 文件对话框等“合法夺焦”留出时间窗（说明书 06 的要求）。
pub fn focus_lost<R: Runtime>(app: &AppHandle<R>) {
    let state = app.state::<AppState>();
    // 用户刚打开了一个文件：窗口保持可见，等焦点回到窗口再恢复正常失焦隐藏
    if state.hold_visible.load(Ordering::SeqCst) {
        return;
    }
    if state.hide_suppressed() || state.phase() != Phase::Visible {
        return;
    }

    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(190));

        let state = handle.state::<AppState>();
        if state.quitting.load(Ordering::Relaxed) || state.hide_suppressed() {
            return;
        }
        if state.phase() != Phase::Visible {
            return;
        }
        if let Some(window) = handle.get_webview_window("main") {
            if window.is_focused().unwrap_or(false) {
                return;
            }
        }
        if let Some(settings) = handle.get_webview_window("settings") {
            if settings.is_visible().unwrap_or(false) {
                return;
            }
        }
        hide(&handle);
    });
}
