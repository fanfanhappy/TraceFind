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
                return UpdateStatus {
                    checked: true,
                    available: is_newer(current, &latest),
                    current: current.to_string(),
                    latest,
                    url,
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
    fn rfc3339_to_unix() {
        assert_eq!(parse_rfc3339("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_rfc3339("2026-11-14T06:41:17Z"), Some(1_794_638_477));
    }
}
