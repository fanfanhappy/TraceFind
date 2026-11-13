//! 系统托盘：左键唤起/隐藏，右键菜单提供搜索、设置、开机启动与退出。

use tauri::menu::{CheckMenuItem, Menu, MenuBuilder, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use std::sync::atomic::Ordering;

use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::state::AppState;
use crate::{autostart_manager, lifecycle, windowing};

pub const TRAY_ID: &str = "aura-tray";

fn build_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let hotkey = {
        let label = app
            .state::<AppState>()
            .hotkey_label
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        if label.is_empty() { String::new() } else { format!("（{label}）") }
    };
    let show = MenuItem::with_id(app, "show", format!("打开搜索{hotkey}"), true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "偏好设置…", true, None::<&str>)?;
    let autostart = CheckMenuItem::with_id(
        app,
        "autostart",
        "开机启动",
        true,
        autostart_manager::is_enabled(app),
        None::<&str>,
    )?;
    let state = app.state::<AppState>();
    let scanning = state.scan_running.load(Ordering::SeqCst);
    let paused = state.scan_paused.load(Ordering::SeqCst);
    let pause_label = if paused { "继续索引" } else { "暂停索引" };
    let pause = MenuItem::with_id(app, "pause", pause_label, scanning, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出 AURA Search", true, None::<&str>)?;

    MenuBuilder::new(app)
        .item(&show)
        .separator()
        .item(&pause)
        .separator()
        .item(&settings)
        .item(&autostart)
        .separator()
        .item(&quit)
        .build()
}

pub fn create<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let menu = build_menu(app)?;
    let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png"))?;

    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .tooltip("TraceFind · 本地文件搜索")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
            // 菜单弹出期间主窗口必然失焦，先抑制“失焦即隐藏”
            app.state::<AppState>().suppress_hide_for(600);
            match event.id.as_ref() {
                "show" => lifecycle::show(app),
                "settings" => windowing::ensure_settings(app),
                "pause" => {
                    if app.state::<AppState>().scan_paused.load(Ordering::SeqCst) {
                        crate::scanner::resume(app);
                    } else {
                        crate::scanner::pause(app);
                    }
                    refresh(app);
                }
                "autostart" => {
                    let state = app.state::<AppState>();
                    let enabled = !state.settings_snapshot().autostart;
                    if autostart_manager::set(app, enabled) {
                        let mut settings = state.settings_snapshot();
                        settings.autostart = enabled;
                        *state
                            .settings
                            .lock()
                            .unwrap_or_else(|poisoned| poisoned.into_inner()) = settings.clone();
                        let _ = crate::settings::save(app, &settings);
                        let _ = app.emit("aura:settings-changed", crate::settings::redacted(settings));
                    }
                    refresh(app);
                }
                "quit" => crate::commands::quit(app),
                _ => {}
            }
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                tray.app_handle()
                    .state::<AppState>()
                    .suppress_hide_for(600);
                lifecycle::toggle(tray.app_handle());
            }
        })
        .build(app)?;

    Ok(())
}

/// 开机启动勾选状态变化后重建菜单。
pub fn refresh<R: Runtime>(app: &AppHandle<R>) {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        if let Ok(menu) = build_menu(app) {
            let _ = tray.set_menu(Some(menu));
        }
    }
}
