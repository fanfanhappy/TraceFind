//! 少量 Windows 原生调用：光标位置、系统版本、DWM 圆角与深色边框。
//!
//! 这里只用系统 DLL 的 FFI，不引入额外的 windows crate，
//! 以免与 Tauri 自身依赖的 windows 版本产生类型耦合。

use std::ffi::c_void;
use std::sync::OnceLock;

#[repr(C)]
struct Point {
    x: i32,
    y: i32,
}

#[link(name = "user32")]
extern "system" {
    fn GetCursorPos(point: *mut Point) -> i32;
}

/// 当前鼠标的屏幕坐标（物理像素），用于把窗口放到光标所在的显示器。
pub fn cursor_position() -> Option<(i32, i32)> {
    let mut point = Point { x: 0, y: 0 };
    let ok = unsafe { GetCursorPos(&mut point) };
    if ok != 0 {
        Some((point.x, point.y))
    } else {
        None
    }
}

#[repr(C)]
struct OsVersionInfoW {
    size: u32,
    major: u32,
    minor: u32,
    build: u32,
    platform_id: u32,
    csd_version: [u16; 128],
}

#[link(name = "ntdll")]
extern "system" {
    fn RtlGetVersion(info: *mut OsVersionInfoW) -> i32;
}

pub fn windows_build() -> u32 {
    static BUILD: OnceLock<u32> = OnceLock::new();
    *BUILD.get_or_init(|| {
        let mut info = OsVersionInfoW {
            size: std::mem::size_of::<OsVersionInfoW>() as u32,
            major: 0,
            minor: 0,
            build: 0,
            platform_id: 0,
            csd_version: [0; 128],
        };
        let status = unsafe { RtlGetVersion(&mut info) };
        if status == 0 {
            info.build
        } else {
            0
        }
    })
}

pub fn windows_display_name() -> String {
    match windows_build() {
        0 => "Windows".to_string(),
        build if build >= 22000 => format!("Windows 11 (build {build})"),
        build => format!("Windows 10 (build {build})"),
    }
}

#[link(name = "dwmapi")]
extern "system" {
    fn DwmSetWindowAttribute(
        hwnd: *mut c_void,
        attribute: u32,
        value: *const c_void,
        size: u32,
    ) -> i32;
}

const DWMWA_USE_IMMERSIVE_DARK_MODE: u32 = 20;
const DWMWA_WINDOW_CORNER_PREFERENCE: u32 = 33;
const DWMWCP_ROUND: u32 = 2;

/// Windows 11 的圆角由 DWM 裁切窗口本身提供；
/// CSS 的圆角只能画出内层形状，无法让原生材质边界变圆。
pub fn set_rounded_corners(hwnd: *mut c_void) {
    if windows_build() < 22000 {
        return;
    }
    unsafe {
        DwmSetWindowAttribute(
            hwnd,
            DWMWA_WINDOW_CORNER_PREFERENCE,
            &DWMWCP_ROUND as *const u32 as *const c_void,
            std::mem::size_of::<u32>() as u32,
        );
    }
}

/// 让系统绘制的边框/阴影跟随深浅主题（Windows 10 1809+ 支持）。
pub fn set_dark_frame(hwnd: *mut c_void, dark: bool) {
    let value: i32 = if dark { 1 } else { 0 };
    unsafe {
        DwmSetWindowAttribute(
            hwnd,
            DWMWA_USE_IMMERSIVE_DARK_MODE,
            &value as *const i32 as *const c_void,
            std::mem::size_of::<i32>() as u32,
        );
    }
}
