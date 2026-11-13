//! Windows DPAPI 包装：API Key 落盘前加密，只有当前用户能解开。
//!
//! 存储形式是 base64 文本，直接塞进 settings.json；即使配置文件被拷走，
//! 换一台机器/换一个用户也解不开。

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use std::ptr;
use windows_sys::Win32::Foundation::LocalFree;
use windows_sys::Win32::Security::Cryptography::{
    CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
};

fn blob_of(bytes: &[u8]) -> CRYPT_INTEGER_BLOB {
    CRYPT_INTEGER_BLOB {
        cbData: bytes.len() as u32,
        pbData: bytes.as_ptr() as *mut u8,
    }
}

fn take_blob(blob: &CRYPT_INTEGER_BLOB) -> Vec<u8> {
    if blob.pbData.is_null() || blob.cbData == 0 {
        return Vec::new();
    }
    unsafe { std::slice::from_raw_parts(blob.pbData, blob.cbData as usize).to_vec() }
}

fn free(blob: &CRYPT_INTEGER_BLOB) {
    if !blob.pbData.is_null() {
        unsafe {
            LocalFree(blob.pbData as *mut core::ffi::c_void);
        }
    }
}

/// 加密：返回 base64（DPAPI blob）
pub fn protect(plain: &str) -> Result<String, String> {
    if plain.is_empty() {
        return Ok(String::new());
    }
    let input = blob_of(plain.as_bytes());
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: ptr::null_mut(),
    };

    let ok = unsafe {
        CryptProtectData(
            &input,
            ptr::null(),
            ptr::null(),
            ptr::null(),
            ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };

    if ok == 0 {
        return Err(format!(
            "DPAPI 加密失败（错误码 {}）",
            std::io::Error::last_os_error()
        ));
    }

    let bytes = take_blob(&output);
    free(&output);
    Ok(BASE64.encode(bytes))
}

/// 解密：输入 base64（DPAPI blob）
pub fn unprotect(encoded: &str) -> Result<String, String> {
    if encoded.is_empty() {
        return Ok(String::new());
    }
    let raw = BASE64
        .decode(encoded)
        .map_err(|err| format!("密钥编码损坏：{err}"))?;

    let input = blob_of(&raw);
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: ptr::null_mut(),
    };

    let ok = unsafe {
        CryptUnprotectData(
            &input,
            ptr::null_mut(),
            ptr::null(),
            ptr::null(),
            ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };

    if ok == 0 {
        return Err(format!(
            "DPAPI 解密失败（错误码 {}）",
            std::io::Error::last_os_error()
        ));
    }

    let bytes = take_blob(&output);
    free(&output);
    String::from_utf8(bytes).map_err(|err| format!("密钥不是合法 UTF-8：{err}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip() {
        let secret = "sk-test-1234567890";
        let encoded = protect(secret).expect("加密应成功");
        assert_ne!(encoded, secret, "密文不能等于明文");
        assert_eq!(unprotect(&encoded).expect("解密应成功"), secret);
    }

    #[test]
    fn empty_is_empty() {
        assert_eq!(protect("").unwrap(), "");
        assert_eq!(unprotect("").unwrap(), "");
    }
}
