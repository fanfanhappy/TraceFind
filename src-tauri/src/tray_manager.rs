//! 系统托盘：左键唤起/隐藏，右键菜单提供搜索、设置、索引控制、更新检查与退出。

use std::sync::atomic::Ordering;

use tauri::menu::{CheckMenuItem, Menu, MenuBuilder, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::state::AppState;
use crate::{autostart_manager, lifecycle, windowing};

pub const TRAY_ID: &str = "tracefind-tray";

/// 12,345 → 1.2 万；不到一万就原样显示
fn compact_count(value: u64) -> String {
    if value >= 10_000 {
        format!("{:.1} 万", value as f64 / 10_000.0)
    } else if value >= 1_000 {
        format!("{value}")
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

fn build_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let hotkey = hotkey_label(app);
    let suffix = if hotkey.is_empty() {
        String::new()
    } else {
        format!("（{hotkey}）")
    };

    let state = app.state::<AppState>();
    let scanning = state.scan_running.load(Ordering::SeqCst);
    let paused = state.scan_paused.load(Ordering::SeqCst);

    let show = MenuItem::with_id(app, "show", format!("打开搜索{suffix}"), true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "偏好设置…", true, None::<&str>)?;
    let pause_label = if paused { "继续索引" } else { "暂停索引" };
    let pause = MenuItem::with_id(app, "pause", pause_label, scanning || paused, None::<&str>)?;
    let check_update = MenuItem::with_id(app, "check_update", "检查更新…", true, None::<&str>)?;
    let autostart = CheckMenuItem::with_id(
        app,
        "autostart",
        "开机启动",
        true,
        autostart_manager::is_enabled(app),
        None::<&str>,
    )?;
    let open_data = MenuItem::with_id(app, "open_data", "打开数据目录", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出 TraceFind", true, None::<&str>)?;

    MenuBuilder::new(app)
        .item(&show)
        .item(&settings)
        .separator()
        .item(&pause)
        .item(&check_update)
        .separator()
        .item(&autostart)
        .item(&open_data)
        .separator()
        .item(&quit)
        .build()
}

pub fn create<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let menu = build_menu(app)?;
    // 用 128px 源图，高 DPI 下缩小时更清晰
    let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/128x128.png"))?;
    let hint = tooltip(app);

    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .tooltip(hint)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
            // 菜单弹出期间主窗口必然失焦，先抑制"失焦即隐藏"
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
                "check_update" => {
                    // 托盘里不弹窗：有更新就抬出主窗口并标出提示，没有就发一条状态
                    let handle = app.clone();
                    std::thread::spawn(move || {
                        let status = crate::update::check(env!("CARGO_PKG_VERSION"));
                        if status.checked && status.available {
                            let _ = handle.emit(
                                "aura:update-available",
                                serde_json::json!({
                                    "latest": status.latest,
                                    "url": status.url,
                                    "sha256": status.sha256,
                                }),
                            );
                            lifecycle::show(&handle);
                        } else if status.checked {
                            let _ = handle.emit("aura:tray-status", "已是最新版本");
                        } else {
                            let _ = handle.emit(
                                "aura:tray-status",
                                status.error.unwrap_or_else(|| "检查更新失败".to_string()),
                            );
                        }
                    });
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
                "open_data" => {
                    let dir = app
                        .state::<AppState>()
                        .index_path
                        .parent()
                        .map(|path| path.to_path_buf());
                    if let Some(dir) = dir {
                        let _ = std::process::Command::new("explorer").arg(dir).spawn();
                    }
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

    crate::aura_log!("托盘已创建：{}", tooltip(app));
    Ok(())
}

/// 菜单勾选/索引状态变化后重建菜单，并同步托盘提示
pub fn refresh<R: Runtime>(app: &AppHandle<R>) {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        if let Ok(menu) = build_menu(app) {
            let _ = tray.set_menu(Some(menu));
        }
        let hint = tooltip(app);
        let _ = tray.set_tooltip(Some(hint.clone()));
        crate::aura_log!("托盘已刷新：{hint}");
    }
}
