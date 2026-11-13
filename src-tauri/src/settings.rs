use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager, Runtime};

/// 与前端 AppSettings 一一对应的持久化结构（camelCase 直接在 IPC 上使用）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AppSettings {
    pub theme: String,
    pub reduced_motion: bool,
    pub hotkey: String,
    pub autostart: bool,
    pub always_on_top: bool,
    pub close_to_tray: bool,
    pub result_limit: u32,
    /// 打开文件后是否保持窗口可见（不因失焦自动隐藏）
    pub keep_open_after_open: bool,
    /// 索引扫描范围（绝对路径），空数组表示首次运行尚未初始化
    pub roots: Vec<String>,
    pub excluded_paths: Vec<String>,
    /// 是否建立正文索引（FTS）
    pub content_index: bool,
    /// 是否启用语义检索（本地嵌入）
    pub semantic_enabled: bool,
    /// 语义提供方：local | cloud
    pub semantic_provider: String,
    /// 云端嵌入接口地址（OpenAI 兼容）
    pub cloud_base_url: String,
    /// 云端嵌入模型名
    pub cloud_model: String,
    /// 用户是否已确认「云端会收到文档片段」这项数据边界
    pub cloud_consent: bool,
    /// 排序方式：relevance | recent | name | size
    pub sort_mode: String,
    /// 结果类型筛选：all | doc | image | code | folder | other
    pub type_filter: String,
    /// 是否用系统 OCR 识别图片与扫描件 PDF
    pub ocr_enabled: bool,
    /// 是否启用 AI 文件助手（检索增强问答）
    pub assistant_enabled: bool,
    /// 问答模型名（与云端嵌入共用地址与 Key）
    pub assistant_model: String,
    /// 云端 API Key（DPAPI 加密后的 base64；落盘需要它，返回前端时再抹掉）
    #[serde(default)]
    pub cloud_key: String,
    pub ai_enabled: bool,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            theme: "dark".to_string(),
            reduced_motion: false,
            hotkey: "Alt+Space".to_string(),
            autostart: false,
            always_on_top: false,
            close_to_tray: true,
            result_limit: 8,
            keep_open_after_open: true,
            roots: Vec::new(),
            excluded_paths: Vec::new(),
            content_index: true,
            semantic_enabled: false,
            semantic_provider: "local".to_string(),
            cloud_base_url: "https://api.openai.com/v1".to_string(),
            cloud_model: "text-embedding-3-small".to_string(),
            cloud_consent: false,
            sort_mode: "relevance".to_string(),
            type_filter: "all".to_string(),
            ocr_enabled: true,
            assistant_enabled: false,
            assistant_model: "gpt-4o-mini".to_string(),
            cloud_key: String::new(),
            ai_enabled: false,
        }
    }
}

/// 部分更新：前端只发送变化过的字段。
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SettingsPatch {
    pub theme: Option<String>,
    pub reduced_motion: Option<bool>,
    pub hotkey: Option<String>,
    pub autostart: Option<bool>,
    pub always_on_top: Option<bool>,
    pub close_to_tray: Option<bool>,
    pub result_limit: Option<u32>,
    pub keep_open_after_open: Option<bool>,
    pub roots: Option<Vec<String>>,
    pub excluded_paths: Option<Vec<String>>,
    pub content_index: Option<bool>,
    pub semantic_enabled: Option<bool>,
    pub semantic_provider: Option<String>,
    pub cloud_base_url: Option<String>,
    pub cloud_model: Option<String>,
    pub cloud_consent: Option<bool>,
    pub sort_mode: Option<String>,
    pub type_filter: Option<String>,
    pub ocr_enabled: Option<bool>,
    pub assistant_enabled: Option<bool>,
    pub assistant_model: Option<String>,
    /// 明文 API Key，落盘前会做 DPAPI 加密
    pub cloud_api_key: Option<String>,
    pub ai_enabled: Option<bool>,
}

/// 返回给前端前抹掉加密后的 Key：磁盘保留，界面只看到「已保存/未保存」
pub fn redacted(mut settings: AppSettings) -> AppSettings {
    settings.cloud_key.clear();
    settings
}

impl AppSettings {
    pub fn apply(&mut self, patch: SettingsPatch) {
        if let Some(value) = patch.theme {
            self.theme = value;
        }
        if let Some(value) = patch.reduced_motion {
            self.reduced_motion = value;
        }
        if let Some(value) = patch.hotkey {
            self.hotkey = value;
        }
        if let Some(value) = patch.autostart {
            self.autostart = value;
        }
        if let Some(value) = patch.always_on_top {
            self.always_on_top = value;
        }
        if let Some(value) = patch.close_to_tray {
            self.close_to_tray = value;
        }
        if let Some(value) = patch.result_limit {
            self.result_limit = value.clamp(3, 50);
        }
        if let Some(value) = patch.keep_open_after_open {
            self.keep_open_after_open = value;
        }
        if let Some(value) = patch.excluded_paths {
            self.excluded_paths = value;
        }
        if let Some(value) = patch.roots {
            self.roots = value;
        }
        if let Some(value) = patch.content_index {
            self.content_index = value;
        }
        if let Some(value) = patch.semantic_enabled {
            self.semantic_enabled = value;
        }
        if let Some(value) = patch.semantic_provider {
            self.semantic_provider = if value.eq_ignore_ascii_case("cloud") {
                "cloud".to_string()
            } else {
                "local".to_string()
            };
        }
        if let Some(value) = patch.cloud_base_url {
            self.cloud_base_url = value.trim().to_string();
        }
        if let Some(value) = patch.cloud_consent {
            self.cloud_consent = value;
        }
        if let Some(value) = patch.sort_mode {
            self.sort_mode = match value.as_str() {
                "recent" | "name" | "size" => value,
                _ => "relevance".to_string(),
            };
        }
        if let Some(value) = patch.ocr_enabled {
            self.ocr_enabled = value;
        }
        if let Some(value) = patch.assistant_enabled {
            self.assistant_enabled = value;
        }
        if let Some(value) = patch.assistant_model {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                self.assistant_model = trimmed.to_string();
            }
        }
        if let Some(value) = patch.type_filter {
            self.type_filter = match value.as_str() {
                "doc" | "image" | "code" | "folder" | "other" => value,
                _ => "all".to_string(),
            };
        }
        if let Some(value) = patch.cloud_model {
            self.cloud_model = value.trim().to_string();
        }
        if let Some(value) = patch.cloud_api_key {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                self.cloud_key.clear();
            } else {
                match crate::secrets::protect(trimmed) {
                    Ok(encrypted) => self.cloud_key = encrypted,
                    Err(err) => crate::aura_log!("保存 API Key 失败：{err}"),
                }
            }
        }
        if let Some(value) = patch.ai_enabled {
            self.ai_enabled = value;
        }
    }
}

pub fn config_path<R: Runtime>(app: &AppHandle<R>) -> PathBuf {
    // TRACEFIND_CONFIG_DIR / AURA_CONFIG_DIR 用于隔离测试，避免改动真实用户配置
    let dir = std::env::var("TRACEFIND_CONFIG_DIR")
        .or_else(|_| std::env::var("AURA_CONFIG_DIR"))
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            app.path()
                .app_config_dir()
                .unwrap_or_else(|_| PathBuf::from("."))
        });
    dir.join("settings.json")
}

pub fn load<R: Runtime>(app: &AppHandle<R>) -> AppSettings {
    let path = config_path(app);
    match fs::read_to_string(&path) {
        Ok(raw) => serde_json::from_str(&raw).unwrap_or_default(),
        Err(_) => AppSettings::default(),
    }
}

pub fn save<R: Runtime>(app: &AppHandle<R>, settings: &AppSettings) -> Result<(), String> {
    let path = config_path(app);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    let raw = serde_json::to_string_pretty(settings).map_err(|err| err.to_string())?;
    fs::write(&path, raw).map_err(|err| err.to_string())
}

#[cfg(test)]
mod settings_tests {
    use super::*;

    #[test]
    fn redacted_hides_key_but_keeps_other_fields() {
        let mut settings = AppSettings::default();
        settings.cloud_key = "AQAAANCM-ciphertext".to_string();
        settings.cloud_model = "text-embedding-3-small".to_string();

        let safe = redacted(settings);
        assert!(safe.cloud_key.is_empty(), "密文不能回传给前端");
        assert_eq!(safe.cloud_model, "text-embedding-3-small");
    }
}