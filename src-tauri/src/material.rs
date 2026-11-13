//! 窗口材质：Windows 11 优先 Mica，其次 Acrylic，最后不透明降级。
//!
//! 说明书 04 的约束：backdrop-filter 只用于 WebView 内部层次，
//! 跨应用的桌面模糊必须由系统材质提供；不支持的平台直接退到可读性最好的实色背景。

use tauri::{Runtime, WebviewWindow};

pub fn apply<R: Runtime>(window: &WebviewWindow<R>, dark: bool) -> String {
    #[cfg(windows)]
    {
        if let Ok(hwnd) = window.hwnd() {
            let raw = hwnd.0 as *mut std::ffi::c_void;
            crate::native::set_rounded_corners(raw);
            crate::native::set_dark_frame(raw, dark);
        }

        // Windows 11 的 Mica：跟随桌面壁纸，最接近说明书的“低透明度玻璃”
        if window_vibrancy::apply_mica(window, Some(dark)).is_ok() {
            return "mica".to_string();
        }

        // Windows 10 1809+ 的 Acrylic：给一层很薄的深色着色，保证文字对比度
        let tint = if dark {
            (23, 25, 31, 196)
        } else {
            (245, 244, 248, 210)
        };
        if window_vibrancy::apply_acrylic(window, Some(tint)).is_ok() {
            crate::state::warn_once("material-acrylic", || {
                crate::aura_log!("未启用 Mica，已降级为 Acrylic");
            });
            return "acrylic".to_string();
        }

        let _ = window_vibrancy::clear_mica(window);
        crate::state::warn_once("material-solid", || {
            crate::aura_log!("原生材质不可用，已降级为不透明背景");
        });
        "solid".to_string()
    }

    #[cfg(not(windows))]
    {
        let _ = (window, dark);
        "solid".to_string()
    }
}
