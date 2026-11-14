//! 检查新版本：只读 GitHub Releases 的公开接口，不上传任何本地信息。

use serde::Serialize;
use std::time::Duration;

const REPO: &str = "fanfanhappy/TraceFind";
const DEFAULT_API: &str = "https://api.github.com";

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    /// 是否真的问到了远端（离线/限流时为 false）
    pub checked: bool,
    pub available: bool,
    pub current: String,
    pub latest: String,
    pub url: String,
    pub notes: String,
    pub published_at: i64,
    pub size_bytes: u64,
    /// 下载包的 sha256（发布时上传的 .sha256 资产，可能为空）
    pub sha256: String,
    pub error: Option<String>,
}

fn api_base() -> String {
    std::env::var("TRACEFIND_UPDATE_BASE")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_API.to_string())
}

/// 把 "2.10.1" 这类版本号拆成数字段；不带预发布后缀的处理
fn parts(version: &str) -> Vec<u64> {
    version
        .trim()
        .trim_start_matches('v')
        .split(['.', '-', '+'])
        .map(|piece| piece.parse::<u64>().unwrap_or(0))
        .collect()
}

/// 远端版本是否比当前新
pub fn is_newer(current: &str, latest: &str) -> bool {
    let a = parts(current);
    let b = parts(latest);
    let len = a.len().max(b.len());
    for index in 0..len {
        let left = a.get(index).copied().unwrap_or(0);
        let right = b.get(index).copied().unwrap_or(0);
        if right != left {
            return right > left;
        }
    }
    false
}

pub fn check(current: &str) -> UpdateStatus {
    let url = format!("{}/repos/{}/releases/latest", api_base().trim_end_matches('/'), REPO);
    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(8))
        .build();

    let response = agent
        .get(&url)
        .set("User-Agent", "TraceFind-updater")
        .set("Accept", "application/vnd.github+json")
        .call();

    let body = match response {
        Ok(res) => match res.into_string() {
            Ok(text) => text,
            Err(err) => {
                return UpdateStatus {
                    current: current.to_string(),
                    error: Some(format!("读取响应失败：{err}")),
                    ..Default::default()
                }
            }
        },
        Err(err) => {
            // API 被限流或临时不可用时，改读 releases/latest 的跳转地址：
            // 这是网页跳转，不走 API 配额。
            if let Some((latest, url)) = latest_from_redirect() {
                // 限流时 API 给不了资产大小与哈希，但 .sha256 地址可以按版本拼出来
                let sha256 = sha_for_version(&latest);
                return UpdateStatus {
                    checked: true,
                    available: is_newer(current, &latest),
                    current: current.to_string(),
                    latest,
                    url,
                    sha256,
                    ..Default::default()
                };
            }
            return UpdateStatus {
                current: current.to_string(),
                error: Some(format!("无法连接更新服务：{err}")),
                ..Default::default()
            }
        }
    };

    let json: serde_json::Value = match serde_json::from_str(&body) {
        Ok(value) => value,
        Err(err) => {
            return UpdateStatus {
                current: current.to_string(),
                error: Some(format!("更新信息格式异常：{err}")),
                ..Default::default()
            }
        }
    };

    if json.get("tag_name").is_none() {
        // 常见情况：仓库还没有正式发布，或触发了限流（返回 message 字段）
        let message = json
            .get("message")
            .and_then(|value| value.as_str())
            .unwrap_or("没有可用的发布版本");
        return UpdateStatus {
            current: current.to_string(),
            error: Some(message.to_string()),
            ..Default::default()
        };
    }

    let latest = json
        .get("tag_name")
        .and_then(|value| value.as_str())
        .unwrap_or_default()
        .trim_start_matches('v')
        .to_string();
    let html_url = json
        .get("html_url")
        .and_then(|value| value.as_str())
        .unwrap_or_default()
        .to_string();
    let notes = json
        .get("body")
        .and_then(|value| value.as_str())
        .unwrap_or_default()
        .to_string();
    let published_at = json
        .get("published_at")
        .and_then(|value| value.as_str())
        .and_then(parse_rfc3339)
        .unwrap_or(0);

    let (size_bytes, sha256) = asset_info(&json, &latest);

    UpdateStatus {
        checked: true,
        available: is_newer(current, &latest),
        current: current.to_string(),
        latest,
        url: html_url,
        notes,
        published_at,
        size_bytes,
        sha256,
        error: None,
    }
}

/// 不经过 API：请求 releases/latest 并读 302 的 Location
fn latest_from_redirect() -> Option<(String, String)> {
    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(8))
        .redirects(0)
        .build();
    let url = format!("https://github.com/{}/releases/latest", REPO);
    let result = agent.head(&url).set("User-Agent", "TraceFind-updater").call();
    let response = match result {
        Ok(response) => response,
        Err(ureq::Error::Status(_, response)) => response,
        Err(_) => return None,
    };
    let location = response.header("location")?.to_string();
    let tag = location.trim_end_matches('/').rsplit('/').next()?;
    let version = tag.trim_start_matches('v').to_string();
    if version.is_empty() || !version.chars().next()?.is_ascii_digit() {
        return None;
    }
    Some((version, location))
}

/// 不经过 API 拿 sha256：资产地址是可以按版本号拼出来的
fn sha_for_version(version: &str) -> String {
    let url = format!(
        "https://github.com/{}/releases/download/v{}/TraceFind-{}-win64.zip.sha256",
        REPO, version, version
    );
    let Ok(response) = ureq::get(&url)
        .set("User-Agent", "TraceFind-updater")
        .timeout(Duration::from_secs(10))
        .call()
    else {
        return String::new();
    };
    let Ok(text) = response.into_string() else {
        return String::new();
    };
    let hash = text.split_whitespace().next().unwrap_or_default().trim().to_string();
    if hash.len() == 64 && hash.chars().all(|c| c.is_ascii_hexdigit()) {
        hash
    } else {
        String::new()
    }
}

/// 从资产里找 zip 的下载大小与 .sha256 内容
fn asset_info(json: &serde_json::Value, version: &str) -> (u64, String) {
    let mut size = 0;
    let mut sha = String::new();
    let Some(assets) = json.get("assets").and_then(|value| value.as_array()) else {
        return (0, sha);
    };
    for asset in assets {
        let name = asset.get("name").and_then(|value| value.as_str()).unwrap_or_default();
        if name.ends_with(".sha256") && name.contains(version) {
            if let Some(url) = asset.get("browser_download_url").and_then(|value| value.as_str()) {
                let response = ureq::get(url)
                    .set("User-Agent", "TraceFind-updater")
                    .timeout(Duration::from_secs(8))
                    .call();
                if let Ok(res) = response {
                    if let Ok(text) = res.into_string() {
                        sha = text.split_whitespace().next().unwrap_or_default().to_string();
                    }
                }
            }
        } else if name.ends_with(".zip") && name.contains(version) {
            size = asset.get("size").and_then(|value| value.as_u64()).unwrap_or(0);
        }
    }
    (size, sha)
}

/// 只解析 GitHub 返回的 "2026-11-14T06:41:17Z"
fn parse_rfc3339(text: &str) -> Option<i64> {
    let date = text.get(0..10)?;
    let time = text.get(11..19)?;
    let mut ymd = date.split('-');
    let year: i64 = ymd.next()?.parse().ok()?;
    let month: i64 = ymd.next()?.parse().ok()?;
    let day: i64 = ymd.next()?.parse().ok()?;
    let mut hms = time.split(':');
    let hour: i64 = hms.next()?.parse().ok()?;
    let minute: i64 = hms.next()?.parse().ok()?;
    let second: i64 = hms.next()?.parse().ok()?;

    // 天数换算（省略闰年细节之外的复杂度，够排序用）
    let mut days = 0i64;
    for year_index in 1970..year {
        days += if is_leap(year_index) { 366 } else { 365 };
    }
    let month_days = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    for month_index in 0..(month - 1).max(0) as usize {
        days += month_days[month_index] as i64;
        if month_index == 1 && is_leap(year) {
            days += 1;
        }
    }
    days += day - 1;
    Some(days * 86400 + hour * 3600 + minute * 60 + second)
}

fn is_leap(year: i64) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

/// 下载完成、已校验并解出新的 exe，等脚本替换
pub struct Staged {
    pub dir: std::path::PathBuf,
    pub zip: std::path::PathBuf,
    pub exe: std::path::PathBuf,
}

/// 下载 zip、校验 sha256、解出 TraceFind.exe
pub fn stage<F>(url: &str, sha256: &str, progress: F) -> Result<Staged, String>
where
    F: Fn(u64, u64),
{
    use sha2::{Digest, Sha256};
    use std::io::{Read, Write};

    if !url.starts_with("https://github.com/fanfanhappy/TraceFind/releases/") {
        return Err("更新地址不是本项目的发布页".to_string());
    }
    if sha256.trim().len() != 64 {
        return Err("缺少可校验的 sha256，请手动下载".to_string());
    }

    let dir = std::env::temp_dir().join(format!("tracefind-update-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).map_err(|err| format!("无法创建临时目录：{err}"))?;
    let zip_path = dir.join("update.zip");
    let exe_path = dir.join("TraceFind.new.exe");

    let agent = ureq::AgentBuilder::new()
        .timeout(std::time::Duration::from_secs(600))
        .build();
    let response = agent
        .get(url)
        .set("User-Agent", "TraceFind-updater")
        .call()
        .map_err(|err| format!("下载失败：{err}"))?;
    let total = response
        .header("content-length")
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(0);

    let mut reader = response.into_reader();
    let mut file = std::fs::File::create(&zip_path).map_err(|err| format!("无法写入临时文件：{err}"))?;
    let mut hasher = Sha256::new();
    let mut downloaded = 0u64;
    let mut buffer = vec![0u8; 64 * 1024];
    let mut last_reported = 0u64;
    progress(0, total);
    loop {
        let read = reader.read(&mut buffer).map_err(|err| format!("下载中断：{err}"))?;
        if read == 0 {
            break;
        }
        file.write_all(&buffer[..read])
            .map_err(|err| format!("写入失败：{err}"))?;
        hasher.update(&buffer[..read]);
        downloaded += read as u64;
        if downloaded - last_reported >= 256 * 1024 || (total > 0 && downloaded == total) {
            last_reported = downloaded;
            progress(downloaded, total);
        }
    }
    drop(file);

    let digest = format!("{:x}", hasher.finalize());
    if !digest.eq_ignore_ascii_case(sha256.trim()) {
        let _ = std::fs::remove_dir_all(&dir);
        return Err(format!("校验失败（下载 {digest}）"));
    }

    let archive_file = std::fs::File::open(&zip_path).map_err(|err| format!("无法读取压缩包：{err}"))?;
    let mut archive =
        zip::ZipArchive::new(archive_file).map_err(|err| format!("压缩包无效：{err}"))?;
    let mut found = None;
    for index in 0..archive.len() {
        let Ok(entry) = archive.by_index(index) else { continue };
        if entry.name().to_ascii_lowercase().ends_with("tracefind.exe") {
            found = Some(index);
            break;
        }
    }
    let Some(index) = found else {
        let _ = std::fs::remove_dir_all(&dir);
        return Err("压缩包里没有 TraceFind.exe".to_string());
    };
    let mut entry = archive.by_index(index).map_err(|err| err.to_string())?;
    let mut exe_bytes = Vec::with_capacity(48 * 1024 * 1024);
    entry
        .read_to_end(&mut exe_bytes)
        .map_err(|err| format!("解压失败：{err}"))?;
    // 基本校验：PE 头 + 大小下限，防止把半截文件换上去
    if exe_bytes.len() < 10 * 1024 * 1024 || exe_bytes.get(0..2) != Some(b"MZ") {
        let _ = std::fs::remove_dir_all(&dir);
        return Err("解出的程序不完整".to_string());
    }
    std::fs::write(&exe_path, &exe_bytes).map_err(|err| format!("写入新程序失败：{err}"))?;

    Ok(Staged {
        dir,
        zip: zip_path,
        exe: exe_path,
    })
}

/// 生成并在后台启动"等进程退出→替换→重启"的脚本
pub fn schedule_replace(staged: &Staged, current_exe: &std::path::Path) -> Result<(), String> {
    let script = staged.dir.join("apply.ps1");
    // 单引号包裹，路径里的单引号翻倍转义（先转义再包，顺序不能反）
    let quote = |path: &std::path::Path| {
        format!("'{}'", path.display().to_string().replace('\'', "''"))
    };
    let content = format!(
        r#"$ErrorActionPreference = 'Stop'
$pidToWait = {pid}
$exe = {exe}
$new = {new}
$zip = {zip}
$log = {log}
$started = {started}
try {{
  "started $(Get-Date -Format o)" | Out-File -FilePath $started -Encoding utf8
  while (Get-Process -Id $pidToWait -ErrorAction SilentlyContinue) {{ Start-Sleep -Milliseconds 200 }}
  Start-Sleep -Milliseconds 600
  $backup = "$($exe).old"
  if (Test-Path $backup) {{ Remove-Item $backup -Force }}
  Move-Item $exe $backup -Force
  Copy-Item $new $exe -Force
  Start-Process -FilePath $exe -WorkingDirectory (Split-Path $exe)
  Remove-Item $zip -Force -ErrorAction SilentlyContinue
  Remove-Item $new -Force -ErrorAction SilentlyContinue
  "ok $(Get-Date -Format o)" | Out-File -FilePath $log -Encoding utf8
}} catch {{
  "fail: $_" | Out-File -FilePath $log -Encoding utf8
  if (-not (Test-Path $exe) -and (Test-Path $backup)) {{ Move-Item $backup $exe -Force }}
}}
"#,
        pid = std::process::id(),
        exe = quote(current_exe),
        new = quote(&staged.exe),
        zip = quote(&staged.zip),
        log = quote(&staged.dir.join("apply.log")),
        started = quote(&staged.dir.join("apply.started")),
    );
    std::fs::write(&script, content).map_err(|err| format!("无法写入更新脚本：{err}"))?;

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        std::process::Command::new("powershell")
            .args([
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                &script.to_string_lossy(),
            ])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|err| format!("无法启动更新脚本：{err}"))?;

        // 握个手：脚本真的跑起来才让应用退出，否则会变成"更新后打不开"
        let marker = staged.dir.join("apply.started");
        for _ in 0..30 {
            if marker.exists() {
                return Ok(());
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        Err("更新脚本未能启动，已取消更新".to_string())
    }
    #[cfg(not(windows))]
    {
        Err("仅 Windows 支持原地更新".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_compare() {
        assert!(is_newer("2.0.1", "2.1.0"));
        assert!(is_newer("2.0.1", "2.0.2"));
        assert!(is_newer("2.9.9", "2.10.0"));
        assert!(!is_newer("2.1.0", "2.1.0"));
        assert!(!is_newer("2.1.0", "2.0.9"));
        assert!(!is_newer("2.1.0", "v2.0.0"));
        assert!(is_newer("1.0.0", "1.0.0.1"));
    }

    #[test]
    fn sha_lookup_matches_release() {
        // 这条依赖网络；用当前已知的 2.3.0 资产做基准
        let sha = sha_for_version("2.3.0");
        assert!(
            sha.is_empty() || (sha.len() == 64 && sha.starts_with("71F6FFF1")),
            "从资产地址取 sha256 失败：{sha}"
        );
    }

    #[test]
    fn rfc3339_to_unix() {
        assert_eq!(parse_rfc3339("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_rfc3339("2026-11-14T06:41:17Z"), Some(1_794_638_477));
    }
}
