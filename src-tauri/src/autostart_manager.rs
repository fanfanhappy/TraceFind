//! 开机自启动：走系统登录项（注册表 Run 键），只开关当前用户。

use tauri::{AppHandle, Runtime};
use tauri_plugin_autostart::ManagerExt;

pub fn is_enabled<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.autolaunch().is_enabled().unwrap_or(false)
}

pub fn set<R: Runtime>(app: &AppHandle<R>, enabled: bool) -> bool {
    let manager = app.autolaunch();
    let result = if enabled {
        manager.enable()
    } else {
        manager.disable()
    };
    match result {
        Ok(()) => true,
        Err(err) => {
            crate::aura_log!("开机启动设置失败：{err}");
            false
        }
    }
}
