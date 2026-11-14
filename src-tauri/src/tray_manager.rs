//! 系统托盘：左键唤起/隐藏；右键弹出与应用同风格的自绘面板。

use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, Rect, Runtime, WebviewUrl,
    WebviewWindow, WebviewWindowBuilder,
};

use crate::state::AppState;
use crate::lifecycle;

pub const TRAY_ID: &str = "tracefind-tray";
const MENU_LABEL: &str = "tray-menu";
const MENU_WIDTH: f64 = 268.0;
const MENU_HEIGHT: f64 = 420.0;

/// 12,345 → 1.2 万；不到一万就原样显示
fn compact_count(value: u64) -> String {
    if value >= 10_000 {
        format!("{:.1} 万", value as f64 / 10_000.0)
    } else {
        value.to_string()
    }
}

fn hotkey_label<R: Runtime>(app: &AppHandle<R>) -> String {
    app.state::<AppState>()
        .hotkey_label
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone()
}

fn tooltip<R: Runtime>(app: &AppHandle<R>) -> String {
    let hotkey = hotkey_label(app);
    let files = {
        let state = app.state::<AppState>();
        let status = state
            .index_status
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        status.files
    };
    let head = if files > 0 {
        format!("TraceFind · {} 个文件", compact_count(files))
    } else {
        "TraceFind · 尚未建立索引".to_string()
    };
    if hotkey.is_empty() {
        head
    } else {
        format!("{head} · {hotkey} 唤起")
    }
}

fn ensure_menu_window<R: Runtime>(app: &AppHandle<R>) -> Option<WebviewWindow<R>> {
    if let Some(window) = app.get_webview_window(MENU_LABEL) {
        return Some(window);
    }
    WebviewWindowBuilder::new(app, MENU_LABEL, WebviewUrl::App("tray-menu.html".into()))
        .title("TraceFind")
        .inner_size(MENU_WIDTH, MENU_HEIGHT)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .decorations(false)
        .transparent(true)
        .shadow(true)
        .skip_taskbar(true)
        .always_on_top(true)
        .focused(false)
        .visible(false)
        .build()
        .ok()
}

/// 右键：贴着托盘图标上方弹出；再点一次收起
fn toggle_menu<R: Runtime>(app: &AppHandle<R>, rect: Rect) {
    let Some(window) = ensure_menu_window(app) else {
        crate::aura_log!("托盘面板创建失败");
        return;
    };
    if window.is_visible().unwrap_or(false) {
        let _ = window.hide();
        return;
    }

    let scale = window.scale_factor().unwrap_or(1.0);
    let anchor = rect.position.to_physical::<i32>(scale);
    let anchor_size = rect.size.to_physical::<u32>(scale);
    let outer = window
        .outer_size()
        .unwrap_or(PhysicalSize::new(MENU_WIDTH as u32, MENU_HEIGHT as u32));

    // 默认锚在托盘图标右上方
    let mut x = anchor.x + anchor_size.width as i32 - outer.width as i32;
    let mut y = anchor.y - outer.height as i32 - 8;

    // 限制在托盘所在显示器的工作区里
    if let Ok(monitors) = window.available_monitors() {
        let hit = monitors.into_iter().find(|monitor| {
            let origin = monitor.position();
            let size = monitor.size();
            anchor.x >= origin.x
                && anchor.x < origin.x + size.width as i32
                && anchor.y >= origin.y
                && anchor.y < origin.y + size.height as i32
        });
        if let Some(monitor) = hit {
            let origin = monitor.position();
            let size = monitor.size();
            let max_x = origin.x + size.width as i32 - outer.width as i32 - 8;
            let max_y = origin.y + size.height as i32 - outer.height as i32 - 8;
            x = x.clamp(origin.x + 8, max_x.max(origin.x + 8));
            y = y.clamp(origin.y + 8, max_y.max(origin.y + 8));
        }
    }

    let _ = window.set_position(PhysicalPosition::new(x, y));
    let _ = window.emit("tray:open", ());
    let _ = window.show();
    let _ = window.set_focus();
}

pub fn hide_menu<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window(MENU_LABEL) {
        let _ = window.hide();
    }
}

pub fn create<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    // 用 128px 源图，高 DPI 下缩小时更清晰
    let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/128x128.png"))?;
    let hint = tooltip(app);

    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .tooltip(hint)
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            let app = tray.app_handle();
            match event {
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                } => {
                    app.state::<AppState>().suppress_hide_for(600);
                    lifecycle::toggle(app);
                }
                TrayIconEvent::Click {
                    button: MouseButton::Right,
                    button_state: MouseButtonState::Up,
                    rect,
                    ..
                } => {
                    // 面板弹出时主窗口会失焦，先抑制"失焦即隐藏"
                    app.state::<AppState>().suppress_hide_for(1200);
                    toggle_menu(app, rect);
                }
                _ => {}
            }
        })
        .build(app)?;

    crate::aura_log!("托盘已创建：{}", tooltip(app));
    Ok(())
}

/// 索引状态变化后同步托盘提示，并让面板重新读一次数据
pub fn refresh<R: Runtime>(app: &AppHandle<R>) {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let hint = tooltip(app);
        let _ = tray.set_tooltip(Some(hint.clone()));
        if app
            .get_webview_window(MENU_LABEL)
            .map(|window| window.is_visible().unwrap_or(false))
            .unwrap_or(false)
        {
            let _ = app.emit("tray:open", ());
        }
        crate::aura_log!("托盘已刷新：{hint}");
    }
}


