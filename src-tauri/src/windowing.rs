//! 窗口位置与设置窗口：不写死屏幕坐标，始终围绕“光标所在显示器”计算。

use std::sync::Mutex;
use tauri::{Manager, PhysicalPosition, Runtime, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

const LAUNCHER_WIDTH: f64 = 800.0;
const LAUNCHER_HEIGHT: f64 = 540.0;

/// 把主窗口居中放到光标所在的那块显示器上（多显示器 + 不同 DPI 都成立）。
pub fn place_on_cursor_monitor<R: Runtime>(window: &WebviewWindow<R>) {
    let monitors = window.available_monitors().unwrap_or_default();

    #[cfg(windows)]
    let cursor = crate::native::cursor_position();
    #[cfg(not(windows))]
    let cursor: Option<(i32, i32)> = None;

    let target = cursor.and_then(|(x, y)| {
        monitors.into_iter().find(|monitor| {
            let origin = monitor.position();
            let size = monitor.size();
            let right = origin.x + size.width as i32;
            let bottom = origin.y + size.height as i32;
            x >= origin.x && x < right && y >= origin.y && y < bottom
        })
    });

    let monitor = match target {
        Some(monitor) => Some(monitor),
        None => window.current_monitor().unwrap_or(None),
    };

    let Some(monitor) = monitor else { return };

    let scale = monitor.scale_factor();
    let width = (LAUNCHER_WIDTH * scale).round() as i32;
    let height = (LAUNCHER_HEIGHT * scale).round() as i32;
    let origin = monitor.position();
    let size = monitor.size();

    let x = origin.x + (size.width as i32 - width) / 2;
    // 视觉重心略高于几何中心：屏幕上方三分之一处更符合视线落点
    let y = origin.y + ((size.height as i32 - height) as f64 * 0.42).round() as i32;

    crate::aura_log!(
        "place: monitor pos=({}, {}) size={}x{} scale={} -> window {}x{} at ({}, {})",
        origin.x,
        origin.y,
        size.width,
        size.height,
        scale,
        width,
        height,
        x,
        y
    );

    let _ = window.set_position(PhysicalPosition::new(x, y));
}

/// 设置窗口是独立窗口：存在则复用，不存在则按需创建。
pub fn ensure_settings<R: Runtime>(app: &tauri::AppHandle<R>) {
    // 连点"设置"时只允许一个创建流程
    static CREATING: Mutex<()> = Mutex::new(());
    let _guard = CREATING.lock().unwrap_or_else(|poisoned| poisoned.into_inner());

    if let Some(window) = app.get_webview_window("settings") {
        // 复用已有窗口：可见时只聚焦，隐藏时直接显示（页面不重载）
        if !window.is_visible().unwrap_or(false) {
            let _ = window.show();
        }
        let _ = window.set_focus();
        return;
    }

    let builder = WebviewWindowBuilder::new(app, "settings", WebviewUrl::App("settings.html".into()))
        .title("TraceFind · 设置")
        .inner_size(900.0, 620.0)
        .min_inner_size(780.0, 540.0)
        .center()
        .decorations(false)
        .transparent(true)
        .shadow(true)
        .skip_taskbar(false)
        // 先隐藏创建，套好材质再显示，避免"先亮后暗"闪一下
        .visible(false);

    match builder.build() {
        Ok(window) => {
            let dark = *app
                .state::<crate::state::AppState>()
                .window_dark
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let _ = crate::material::apply(&window, dark);
            let _ = window.show();
            let _ = window.set_focus();
        }
        Err(err) => crate::aura_log!("设置窗口创建失败：{err}"),
    }
}

/// 关闭设置：只隐藏，窗口留着复用（下次打开不用重新加载页面）
pub fn close_settings<R: Runtime>(app: &tauri::AppHandle<R>) {
    if let Some(window) = app.get_webview_window("settings") {
        let _ = window.hide();
    }
}
