#![windows_subsystem = "windows"]

mod autostart_manager;
mod commands;
mod docindex;
mod extract;
mod hotkey_manager;
mod index;
mod lifecycle;
mod logging;
mod material;
mod native;
mod preview;
mod ocr;
mod scanner;
mod secrets;
mod semantic;
mod settings;
mod update;
mod state;
mod tray_manager;
mod watcher;
mod windowing;

use std::path::PathBuf;

use tauri::{Emitter, Manager};
use tauri_plugin_global_shortcut::ShortcutState;

/// 把旧品牌目录（com.aurasearch.desktop）里的数据搬到新目录。
/// 只在目标目录还没有数据时执行，避免覆盖用户后续的改动。
fn migrate_legacy_data(target: &PathBuf) {
    // 注意：settings::load 会先把配置目录建出来，所以不能用「目录存在」判断，
    // 只有目标目录里已经有 index.db 才算迁移过。
    if target.join("index.db").exists() {
        return;
    }
    let Ok(appdata) = std::env::var("APPDATA") else {
        return;
    };
    let legacy = PathBuf::from(appdata).join("com.aurasearch.desktop");
    if !legacy.exists() {
        return;
    }

    let _ = std::fs::create_dir_all(target);
    for name in ["index.db", "index.db-wal", "index.db-shm", "settings.json"] {
        let from = legacy.join(name);
        if from.exists() {
            let _ = std::fs::copy(&from, target.join(name));
        }
    }

    // 语义模型体积大，直接搬目录
    let models = legacy.join("models");
    if models.exists() {
        copy_dir(&models, &target.join("models"));
    }
    crate::aura_log!("已从旧目录迁移数据：{}", legacy.display());
}

fn copy_dir(from: &PathBuf, to: &PathBuf) {
    if std::fs::create_dir_all(to).is_err() {
        return;
    }
    let Ok(entries) = std::fs::read_dir(from) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let dest = to.join(entry.file_name());
        if path.is_dir() {
            copy_dir(&path, &dest);
        } else {
            let _ = std::fs::copy(&path, &dest);
        }
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        aura_log!("全局快捷键触发（真实按键）");
                        lifecycle::toggle(app);
                    }
                })
                .build(),
        )
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None::<Vec<&str>>,
        ))
        .setup(|app| {
            let handle = app.handle().clone();
            logging::init(&handle);
            aura_log!("TraceFind 启动");

            let data_dir = std::env::var("TRACEFIND_DATA_DIR")
                .or_else(|_| std::env::var("AURA_DATA_DIR"))
                .map(PathBuf::from)
                .unwrap_or_else(|_| {
                    handle
                        .path()
                        .app_data_dir()
                        .unwrap_or_else(|_| PathBuf::from("."))
                });

            // 品牌改名后数据目录也变了：把旧目录里的索引与配置搬过来，避免用户"数据消失"
            if std::env::var("TRACEFIND_DATA_DIR").is_err()
                && std::env::var("AURA_DATA_DIR").is_err()
            {
                migrate_legacy_data(&data_dir);
            }
            let _ = std::fs::create_dir_all(&data_dir);
            let loaded = settings::load(&handle);
            let index_path = data_dir.join("index.db");
            let conn = match index::open(&index_path).and_then(|conn| {
                index::init(&conn)?;
                Ok(conn)
            }) {
                Ok(conn) => conn,
                Err(err) => {
                    aura_log!("索引数据库打开失败：{err}");
                    // 退化为临时文件，保证应用仍能启动（只是没有持久化）
                    let fallback = data_dir.join("index-recovery.db");
                    index::open(&fallback).expect("无法创建索引数据库")
                }
            };
            aura_log!(
                "索引库：{}（已有 {} 个条目）",
                index_path.display(),
                index::count(&conn)
            );

            let existing = index::count(&conn).max(0) as u64;
            let last_scan_at = index::last_scan(&conn);
            app.manage(state::AppState::new(
                loaded.clone(),
                conn,
                index_path.clone(),
            ));
            // 已有索引时状态直接是 ready，避免界面显示“未索引”
            if existing > 0 {
                let state = app.state::<state::AppState>();
                let mut status = state
                    .index_status
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                status.state = "ready".to_string();
                status.files = existing;
                status.scanned = existing;
                status.last_scan = last_scan_at;
            }

            if let Some(window) = handle.get_webview_window("main") {
                // 材质由前端在挂载后按“解析后的主题”下发（见 set_window_dark）：
                // 这里不猜明暗，猜错就会出现浅色界面配深色 Mica 的发灰观感。
                let _ = window.set_always_on_top(loaded.always_on_top);
            }

            // 快捷键：配置的组合被占用时依次尝试兜底组合，避免"窗口隐藏后叫不回来"
            let (active_hotkey, hotkey_fallback, hotkey_error) =
                hotkey_manager::register_with_fallback(&handle, &loaded.hotkey);
            {
                let state = handle.state::<state::AppState>();
                *state
                    .hotkey_label
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner()) = active_hotkey.clone();
                *state
                    .hotkey_fallback
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner()) = hotkey_fallback;
            }
            if hotkey_fallback {
                aura_log!(
                    "快捷键 {} 不可用（{}），已降级为 {}",
                    loaded.hotkey,
                    hotkey_error.clone().unwrap_or_default(),
                    active_hotkey
                );
                let _ = handle.emit(
                    "aura:hotkey-fallback",
                    serde_json::json!({ "configured": loaded.hotkey, "active": active_hotkey }),
                );
            } else if let Some(err) = hotkey_error {
                // 连兜底都失败：前端会在状态栏提示冲突
                aura_log!("全局快捷键注册失败：{err}");
                let _ = handle.emit("aura:hotkey-conflict", loaded.hotkey.clone());
            }

            if let Err(err) = tray_manager::create(&handle) {
                aura_log!("托盘创建失败：{err}");
            }

            // 正文索引 worker（低优先级，空闲时才跑）
            docindex::spawn(handle.clone());
            // 语义检索 worker（默认关闭，启用后才会加载模型）
            semantic::spawn_worker(handle.clone());

            // 实时更新：监听扫描范围内的变化
            watcher::refresh(&handle);

            // 索引：空库立刻扫；非空时 10 分钟内扫过就跳过（全量扫描只要 0.5s，\n            // 顺手清掉监听可能漏掉的删除/移动，代价可以接受）
            let scan_handle = handle.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(1200));
                if scan_handle.state::<state::AppState>().settings_snapshot().roots.is_empty() || scanner::is_running(&scan_handle) {
                    return;
                }

                let last_scan = {
                    let state = scan_handle.state::<state::AppState>();
                    let conn = state
                        .db
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner());
                    index::last_scan(&conn)
                };
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_secs() as i64)
                    .unwrap_or(0);
                if last_scan > 0 && now - last_scan <= 600 {
                    return;
                }

                aura_log!("开始后台索引扫描（上次：{last_scan}）");
                scanner::spawn_full(&scan_handle);
            });

            // 兜底：前端脚本异常时不能让应用“隐身”，1.6s 后强制显示窗口
            let fallback = handle.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(1600));
                if fallback.state::<state::AppState>().phase() == state::Phase::Hidden {
                    aura_log!("未收到 frontend_ready，回退为直接显示窗口");
                    lifecycle::show(&fallback);
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_settings,
            commands::suggested_roots,
            commands::complete_onboarding,
        commands::restart_onboarding,
        commands::check_update,
        commands::open_url,
            commands::patch_settings,
            commands::set_window_dark,
            commands::set_hold_visible,
            commands::open_path_hold,
            commands::search_files,
            commands::recent_files,
            commands::index_status,
            commands::preview_file,
            commands::content_status,
            commands::rebuild_content,
            commands::semantic_status,
            commands::set_semantic,
            commands::rebuild_semantic,
            commands::semantic_probe,
            commands::ocr_probe,
            commands::ask_files,
            commands::test_cloud_embedding,
            commands::cloud_key_status,
            commands::start_index,
            commands::pause_index,
            commands::resume_index,
            commands::add_root,
            commands::remove_root,
            commands::apply_hotkey,
            commands::get_runtime_info,
            commands::frontend_ready,
            commands::launcher_animation_finished,
            commands::show_launcher,
            commands::hide_launcher,
            commands::toggle_launcher,
            commands::open_settings,
            commands::close_settings,
            commands::quit_app,
            commands::open_path,
            commands::reveal_path,
        ])
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::CloseRequested { api, .. } => {
                // 主窗口的关闭按钮 = 隐藏到托盘，进程继续常驻
                if window.label() == "main" {
                    api.prevent_close();
                    lifecycle::hide(window.app_handle());
                }
            }
            tauri::WindowEvent::Focused(false) => {
                if window.label() == "main" {
                    lifecycle::focus_lost(window.app_handle());
                }
            }
            tauri::WindowEvent::Focused(true) => {
                // 焦点回到主窗口：解除"打开文件后保持可见"，恢复默认失焦隐藏
                if window.label() == "main" {
                    window
                        .app_handle()
                        .state::<state::AppState>()
                        .hold_visible
                        .store(false, std::sync::atomic::Ordering::SeqCst);
                }
            }
            _ => {}
        })
        .build(tauri::generate_context!())
        .expect("failed to build AURA Search")
        .run(|_app, _event| {});
}
