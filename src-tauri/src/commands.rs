use std::path::PathBuf;
use std::sync::atomic::Ordering;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime, State};

use crate::docindex;
use crate::index::{self, FileHit, IndexStatus};
use crate::settings::{AppSettings, SettingsPatch};
use crate::state::{AppState, Phase};
use crate::{
    autostart_manager, hotkey_manager, lifecycle, material, scanner, settings, tray_manager,
    windowing,
};


#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> AppSettings {
    settings::redacted(state.settings_snapshot())
}

#[tauri::command]
pub fn suggested_roots<R: Runtime>(app: AppHandle<R>) -> Vec<String> {
    scanner::default_roots(&app)
}

#[tauri::command]
pub fn complete_onboarding<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    roots: Vec<String>,
) -> Result<AppSettings, String> {
    let mut validated: Vec<String> = Vec::new();
    for path in roots {
        let root = scanner::normalize_root(&path)
            .filter(|root| root.is_absolute())
            .ok_or_else(|| format!("目录不可用：{path}"))?;
        let root = root.to_string_lossy().into_owned();
        if !validated.iter().any(|existing| existing.eq_ignore_ascii_case(&root)) {
            validated.push(root);
        }
    }
    let current = {
        let mut settings = state.settings.lock().unwrap_or_else(|err| err.into_inner());
        if settings.onboarding_complete || !settings.roots.is_empty() {
            return Ok(settings::redacted(settings.clone()));
        }
        let mut next = settings.clone();
        next.roots = validated;
        next.onboarding_complete = true;
        next.content_index = false;
        next.ocr_enabled = false;
        settings::save(&app, &next)?;
        *settings = next.clone();
        next
    };
    if !current.roots.is_empty() {
        restart_watcher(&app);
        scanner::spawn_full(&app);
    }
    let current = settings::redacted(current);
    let _ = app.emit("aura:settings-changed", current.clone());
    Ok(current)
}

/// 用解析后的明暗重新应用原生材质（主窗口与设置窗口一起）。
/// 前端把“跟随系统”解析成确定的深/浅后调用这里，保证材质与界面一致。
#[tauri::command]
pub fn set_window_dark<R: Runtime>(app: AppHandle<R>, state: State<'_, AppState>, dark: bool) {
    *state
        .window_dark
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = dark;

    if let Some(window) = app.get_webview_window("main") {
        let mode = material::apply(&window, dark);
        *state
            .material
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = mode;
    }
    if let Some(window) = app.get_webview_window("settings") {
        let _ = material::apply(&window, dark);
    }
}

#[tauri::command]
pub fn patch_settings<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    patch: SettingsPatch,
) -> AppSettings {
    let mut current = state.settings_snapshot();
    let previous_autostart = current.autostart;
    current.apply(patch);

    let previous_provider = state.settings_snapshot().semantic_provider;
    let previous_base = state.settings_snapshot().cloud_base_url;
    let previous_model = state.settings_snapshot().cloud_model;
    let previous_roots = state.settings_snapshot().roots;
    let previous_excludes = state.settings_snapshot().excluded_paths;
    let previous_roots_for_compare = previous_roots.clone();
    let previous_excludes_for_compare = previous_excludes.clone();

    *state
        .settings
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = current.clone();
    let _ = settings::save(&app, &current);

    // 被移出范围的目录、新增的排除项：立即清掉旧行，不能让它们继续出现在结果里
    let dropped_roots: Vec<String> = previous_roots
        .into_iter()
        .filter(|root| !current.roots.iter().any(|next| next.eq_ignore_ascii_case(root)))
        .collect();
    let added_excludes: Vec<String> = current
        .excluded_paths
        .iter()
        .filter(|path| !previous_excludes.iter().any(|old| old.eq_ignore_ascii_case(path)))
        .cloned()
        .collect();
    let scope_changed = previous_roots_for_compare != current.roots
        || previous_excludes_for_compare != current.excluded_paths;
    if scope_changed {
        bump_config_version(&app);
    }

    let mut to_purge = dropped_roots;
    to_purge.extend(added_excludes);
    purge_paths(&app, &to_purge);

    // 向量索引身份 = 提供方 + 地址 + 模型：任一变化都必须重算
    let identity_of = |provider: &str, base: &str, model: &str| -> String {
        if provider.eq_ignore_ascii_case("local") {
            "local".to_string()
        } else {
            format!("cloud|{base}|{model}")
        }
    };
    let previous_identity = identity_of(&previous_provider, &previous_base, &previous_model);
    let current_identity = identity_of(
        &current.semantic_provider,
        &current.cloud_base_url,
        &current.cloud_model,
    );
    if previous_identity != current_identity {
        if let Ok(conn) = state.db.lock() {
            let _ = index::clear_semantic(&conn);
        }
        crate::semantic::invalidate_cache();
        crate::aura_log!(
            "语义索引身份变化（{previous_identity} → {current_identity}），旧向量已清空，等待重建"
        );
    }

    // 范围变了且当前没有扫描在跑：立刻按新范围重扫
    if scope_changed && !crate::scanner::is_running(&app) {
        crate::scanner::spawn_full(&app);
    }

    // 主题变化后的材质明暗由前端解析（“跟随系统”只有前端知道结果），
    // 它会调用 set_window_dark 重新应用，这里不重复处理。

    // 开机启动：只在真正变化时写注册表
    if previous_autostart != current.autostart && !autostart_manager::set(&app, current.autostart) {
        let mut reverted = current.clone();
        reverted.autostart = previous_autostart;
        current = reverted;
        *state
            .settings
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = current.clone();
        let _ = settings::save(&app, &current);
    }

    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_always_on_top(current.always_on_top);
    }

    tray_manager::refresh(&app);
    restart_watcher(&app);
    let _ = app.emit("aura:settings-changed", settings::redacted(current.clone()));
    settings::redacted(current)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HotkeyOutcome {
    pub ok: bool,
    pub conflict: Option<String>,
    pub settings: Option<AppSettings>,
}

#[tauri::command]
pub fn apply_hotkey<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    accel: String,
) -> HotkeyOutcome {
    match hotkey_manager::register(&app, &accel) {
        Ok(_) => {
            let mut current = state.settings_snapshot();
            current.hotkey = accel.clone();
            {
                *state
                    .hotkey_label
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner()) = accel.clone();
                *state
                    .hotkey_fallback
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner()) = false;
            }
            *state
                .settings
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()) = current.clone();
            let _ = settings::save(&app, &current);
            let _ = app.emit("aura:hotkey-ok", accel);
            let _ = app.emit("aura:settings-changed", settings::redacted(current.clone()));
            HotkeyOutcome {
                ok: true,
                conflict: None,
                settings: Some(current),
            }
        }
        Err(err) => {
            let _ = app.emit("aura:hotkey-conflict", accel);
            HotkeyOutcome {
                ok: false,
                conflict: Some(err),
                settings: None,
            }
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeInfo {
    pub version: String,
    pub platform: String,
    pub material: String,
    pub hotkey: String,
    pub hotkey_active: bool,
    pub autostart: bool,
    pub data_dir: String,
    /// 生命周期相位（hidden / showing / visible / hiding），用于诊断与端到端验证
    pub phase: String,
    pub launcher_visible: bool,
    /// 当前原生材质用的明暗版本，便于确认“跟随系统”是否解析正确
    pub window_dark: bool,
    /// 实时文件监听是否在运行
    pub watching: bool,
    /// 设置里配置的快捷键
    pub hotkey_configured: String,
    /// 是否启用了兜底快捷键
    pub hotkey_fallback: bool,
}

fn platform_label() -> String {
    #[cfg(windows)]
    {
        format!(
            "{} · {}",
            crate::native::windows_display_name(),
            std::env::consts::ARCH
        )
    }
    #[cfg(not(windows))]
    {
        format!("{} · {}", std::env::consts::OS, std::env::consts::ARCH)
    }
}

#[tauri::command]
pub fn get_runtime_info<R: Runtime>(app: AppHandle<R>, state: State<'_, AppState>) -> RuntimeInfo {
    let settings = state.settings_snapshot();
    let data_dir = settings::config_path(&app)
        .parent()
        .map(|path| path.display().to_string())
        .unwrap_or_else(|| "—".to_string());

    RuntimeInfo {
        version: app.package_info().version.to_string(),
        platform: platform_label(),
        material: state
            .material
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone(),
        hotkey: {
            let label = state
                .hotkey_label
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clone();
            if label.is_empty() { settings.hotkey.clone() } else { label }
        },
        hotkey_configured: settings.hotkey.clone(),
        hotkey_fallback: *state
            .hotkey_fallback
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()),
        hotkey_active: hotkey_manager::is_registered(&app),
        autostart: autostart_manager::is_enabled(&app),
        data_dir,
        phase: match state.phase() {
            Phase::Hidden => "hidden",
            Phase::Showing => "showing",
            Phase::Visible => "visible",
            Phase::Hiding => "hiding",
        }
        .to_string(),
        launcher_visible: app
            .get_webview_window("main")
            .and_then(|window| window.is_visible().ok())
            .unwrap_or(false),
        window_dark: *state
            .window_dark
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()),
        watching: crate::watcher::is_active(),
    }
}

/// 前端挂载完成：此时才让主窗口出现，避免 WebView 首帧白屏。
#[tauri::command]
pub fn frontend_ready<R: Runtime>(app: AppHandle<R>) {
    crate::aura_log!("frontend_ready 已收到");
    if app.state::<AppState>().phase() == Phase::Hidden {
        lifecycle::show(&app);
    }
}

#[tauri::command]
pub fn launcher_animation_finished<R: Runtime>(app: AppHandle<R>, phase: String) {
    lifecycle::animation_finished(&app, &phase);
}

#[tauri::command]
pub fn show_launcher<R: Runtime>(app: AppHandle<R>) {
    lifecycle::show(&app);
}

#[tauri::command]
pub fn hide_launcher<R: Runtime>(app: AppHandle<R>) {
    lifecycle::hide(&app);
}

#[tauri::command]
pub fn toggle_launcher<R: Runtime>(app: AppHandle<R>) {
    lifecycle::toggle(&app);
}

#[tauri::command]
pub fn open_settings<R: Runtime>(app: AppHandle<R>) {
    lifecycle::hide(&app);
    // 窗口创建推迟一拍：在命令处理函数里同步创建 WebView 会让本次 IPC 往返
    // 与 WebView 初始化互相等待，表现为界面假死。
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(40));
        windowing::ensure_settings(&handle);
    });
}

#[tauri::command]
pub fn close_settings<R: Runtime>(app: AppHandle<R>) {
    windowing::close_settings(&app);
}

/// 扫描范围变了：让正在跑的扫描作废，并在它退出后按新范围重扫
fn bump_config_version<R: Runtime>(app: &AppHandle<R>) {
    let state = app.state::<AppState>();
    state
        .config_version
        .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    state
        .pending_rescan
        .store(true, std::sync::atomic::Ordering::SeqCst);
}

/// 把路径（含子树）从索引里立刻移除，并刷新状态与广播。
/// 用于"移除扫描目录""新增排除目录"这类必须立即生效的操作。
fn purge_paths<R: Runtime>(app: &AppHandle<R>, paths: &[String]) -> usize {
    if paths.is_empty() {
        return 0;
    }
    let state = app.state::<AppState>();
    let removed = {
        let mut conn = state
            .db
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        index::delete_paths(&mut conn, paths).unwrap_or(0)
    };

    if removed > 0 {
        let files = {
            let conn = state
                .db
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            index::count(&conn).max(0) as u64
        };
        {
            let mut status = state
                .index_status
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            status.files = files;
        }
        let _ = app.emit(
            "index:changed",
            serde_json::json!({ "files": files, "changed": removed }),
        );
        crate::aura_log!("按范围清理索引：{} 个条目", removed);
    }
    removed
}

/// 扫描范围或排除项变化后重启监听（watcher 绑定的是目录句柄）
fn restart_watcher<R: Runtime>(app: &AppHandle<R>) {
    let settings = app.state::<AppState>().settings_snapshot();
    crate::watcher::start(
        app,
        settings.roots.iter().map(PathBuf::from).collect(),
        settings.excluded_paths.iter().map(PathBuf::from).collect(),
    );
}

pub fn quit<R: Runtime>(app: &AppHandle<R>) {
    crate::watcher::stop();
    app.state::<AppState>().quitting.store(true, Ordering::Relaxed);
    hotkey_manager::unregister_all(app);
    app.exit(0);
}

#[tauri::command]
pub fn quit_app<R: Runtime>(app: AppHandle<R>) {
    quit(&app);
}

/// 模块一只做“交给系统默认程序打开”，真实文件动作在模块二接入索引后使用。
#[tauri::command]
pub fn open_path(path: String) {
    let _ = std::process::Command::new("explorer").arg(path).spawn();
}

#[tauri::command]
pub fn reveal_path(path: String) {
    let _ = std::process::Command::new("explorer")
        .arg(format!("/select,{path}"))
        .spawn();
}

/* ---------------------------------------------------------------- 索引与搜索 */

fn scan_options(state: &AppState) -> scanner::ScanOptions {
    let settings = state.settings_snapshot();
    scanner::ScanOptions {
        roots: settings.roots.iter().map(PathBuf::from).collect(),
        excludes: settings.excluded_paths.iter().map(PathBuf::from).collect(),
        index_path: state.index_path.clone(),
    }
}

#[tauri::command]
pub fn search_files(
    app: AppHandle<tauri::Wry>,
    state: State<'_, AppState>,
    query: String,
    scope: Option<String>,
    limit: Option<usize>,
    request_id: Option<u64>,
) -> Result<Vec<FileHit>, String> {
    let limit = limit.unwrap_or(30);
    let settings = state.settings_snapshot();
    let content_enabled = settings.content_index;

    let generation = state.search_generation.fetch_add(1, Ordering::SeqCst) + 1;

    let conn = state
        .db
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());

    // 给正文留出固定槽位：文件名命中再多也不能把正文结果全挤掉。
    let reserved = (limit / 3).clamp(2, 10);
    let sort = index::SortMode::parse(&settings.sort_mode);
    let kind_filter = if settings.type_filter == "all" {
        None
    } else {
        Some(settings.type_filter.clone())
    };
    let filename_quota = if sort == index::SortMode::Relevance {
        limit.saturating_sub(reserved).max(1)
    } else {
        limit
    };

    let filename_hits = index::search_with(
        &conn,
        &query,
        scope.as_deref(),
        filename_quota,
        kind_filter.as_deref(),
        sort,
    )
    .map_err(|err| err.to_string())?;

    // 单字符词（"a"、"的"）在 6000 万字正文里几乎命中所有文档，
    // FTS5 要为整库算 bm25，实测会卡到 800ms。这类查询只走文件名。
    let worth_content = query.split_whitespace().any(|term| term.chars().count() >= 2);

    let mut content_hits = if content_enabled && worth_content {
        index::content_hits(&conn, &query, scope.as_deref(), limit).unwrap_or_default()
    } else {
        Vec::new()
    };
    if let Some(group) = kind_filter.as_deref() {
        content_hits.retain(|hit| index::kind_in_group(&hit.kind, group));
    }

    // 语义检索不再阻塞本地结果：算向量（云端=网络）放到锁外，结果走事件补发
    let semantic_enabled = settings.semantic_enabled && crate::semantic::is_ready(&settings);

    // RRF 融合：文件名、正文、语义三路各自按排名贡献分数，
    // 避免任一路被另外两路挤掉（k=60 是常用经验值）。
    const RRF_K: f64 = 60.0;
    let mut scores: std::collections::HashMap<String, f64> = std::collections::HashMap::new();
    for (rank, hit) in filename_hits.iter().enumerate() {
        *scores.entry(hit.path.clone()).or_default() += 1.0 / (RRF_K + rank as f64 + 1.0);
    }
    for (rank, hit) in content_hits.iter().enumerate() {
        *scores.entry(hit.path.clone()).or_default() += 0.6 / (RRF_K + rank as f64 + 1.0);
    }


    // 元信息优先取文件名命中；片段优先用语义块，其次正文片段
    let mut sources: std::collections::HashMap<String, Vec<&'static str>> =
        std::collections::HashMap::new();
    let mut by_path: std::collections::HashMap<String, FileHit> = std::collections::HashMap::new();
    for hit in filename_hits {
        sources.entry(hit.path.clone()).or_default().push("name");
        by_path.insert(hit.path.clone(), hit);
    }
    for hit in content_hits {
        let snippet = hit.snippet.clone();
        let via_ocr = hit.sources.iter().any(|source| source == "ocr");
        sources.entry(hit.path.clone()).or_default().push("content");
        if via_ocr {
            sources.entry(hit.path.clone()).or_default().push("ocr");
        }
        match by_path.get_mut(&hit.path) {
            Some(existing) => {
                if existing.snippet.is_none() {
                    existing.snippet = snippet;
                }
            }
            None => {
                by_path.insert(hit.path.clone(), hit);
            }
        }
    }


    let mut merged: Vec<(f64, FileHit)> = by_path
        .into_iter()
        .filter_map(|(path, hit)| scores.get(&path).map(|score| (*score, hit)))
        .collect();
    merged.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    let mut local_hits: Vec<FileHit> = merged.into_iter().map(|(_, hit)| hit).collect();

    // 统一写入来源（顺序固定：name → content → ocr → semantic）
    for hit in local_hits.iter_mut() {
        let keep_semantic: Vec<String> = hit
            .sources
            .iter()
            .filter(|source| source.as_str() == "semantic")
            .cloned()
            .collect();
        hit.sources.clear();
        hit.sources.extend(keep_semantic);
        if let Some(list) = sources.get(&hit.path) {
            for source in ["name", "content", "ocr"] {
                if list.contains(&source) {
                    hit.sources.push(source.to_string());
                }
            }
        }
    }

    match sort {
        index::SortMode::Relevance => {}
        index::SortMode::Recent => local_hits.sort_by(|a, b| b.modified.cmp(&a.modified)),
        index::SortMode::Name => {
            local_hits.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        }
        index::SortMode::Size => local_hits.sort_by(|a, b| b.size.cmp(&a.size)),
    }
    if sort == index::SortMode::Relevance {
        let exact_name = query.trim().to_lowercase();
        local_hits.sort_by_key(|hit| hit.name.to_lowercase() != exact_name);
    }
    local_hits.truncate(limit);

    // 后台补语义：先算向量（可能走网络），再短暂持锁打分；
    // 若期间查询已变（用户继续输入），直接丢弃，避免旧结果盖新结果。
    if semantic_enabled {
        let app_handle = app.clone();
        let query_for_task = query.clone();
        let scope_for_task = scope.clone();
        let kind_filter_for_task = kind_filter.clone();
        let settings_for_task = settings.clone();
        let local_paths: std::collections::HashSet<String> =
            local_hits.iter().map(|hit| hit.path.clone()).collect();

        crate::semantic::schedule_search(generation, move || {
            let state = app_handle.state::<AppState>();
            let is_current = || state.search_generation.load(Ordering::SeqCst) == generation;
            if !is_current() {
                return;
            }
            let Ok(vector) = crate::semantic::embed_search_query(
                &settings_for_task, &query_for_task, is_current,
            ) else {
                return;
            };
            if !is_current() {
                return;
            }

            let snapshot = {
                let conn = state.db.lock().unwrap_or_else(|err| err.into_inner());
                crate::semantic::vector_snapshot(&conn)
            };
            let Ok(snapshot) = snapshot else {
                return;
            };
            if !is_current() {
                return;
            }
            let hits = snapshot.search(&vector, limit.min(8), scope_for_task.as_deref());
            if hits.is_empty() || !is_current() {
                return;
            }

            let mut payload_hits = Vec::new();
            {
                let conn = state
                    .db
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                for (path, snippet, _score) in hits {
                    if local_paths.contains(&path) {
                        continue;
                    }
                    if !index::path_in_scope(&path, scope_for_task.as_deref()) {
                        continue;
                    }
                    if let Ok(Some(mut hit)) = index::hit_by_path(&conn, &path) {
                        hit.sources.push("semantic".to_string());
                        if let Some(group) = kind_filter_for_task.as_deref() {
                            if !index::kind_in_group(&hit.kind, group) {
                                continue;
                            }
                        }
                        hit.snippet = Some(snippet.chars().take(120).collect());
                        payload_hits.push(hit);
                    }
                }
            }

            if payload_hits.is_empty() || !is_current() {
                return;
            }

            let _ = app_handle.emit(
                "search:semantic",
                serde_json::json!({ "query": query_for_task, "requestId": request_id, "hits": payload_hits }),
            );
        });
    }

    Ok(local_hits)
}

#[tauri::command]
pub fn recent_files(
    state: State<'_, AppState>,
    scope: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<FileHit>, String> {
    let settings = state.settings_snapshot();
    let kind = if settings.type_filter == "all" {
        None
    } else {
        Some(settings.type_filter.clone())
    };
    let conn = state
        .db
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    index::recent_filtered(&conn, scope.as_deref(), limit.unwrap_or(5), kind.as_deref())
        .map_err(|err| err.to_string())
}

/// 打开文件前后调用：hold=true 时窗口不因失焦隐藏，
/// 焦点重新回到窗口（Focused(true)）后自动恢复默认行为。
#[tauri::command]
pub fn set_hold_visible(state: State<'_, AppState>, hold: bool) {
    state.hold_visible.store(hold, Ordering::SeqCst);
}

/// 打开文件：在同一次调用里先设"保持可见"再拉起系统程序，
/// 避免前端两条 IPC 并行导致打开动作先于标志生效。
/// 返回是否成功交给系统打开。
#[tauri::command]
pub fn open_path_hold(
    state: State<'_, AppState>,
    path: String,
    hold: bool,
) -> Result<bool, String> {
    state.hold_visible.store(hold, Ordering::SeqCst);
    match std::process::Command::new("explorer").arg(&path).spawn() {
        Ok(_) => Ok(true),
        Err(err) => Err(format!("无法用系统默认程序打开：{err}")),
    }
}

/// 预览：复用正文抽取器，图片走 data URL
#[tauri::command]
pub fn preview_file(
    path: String,
    start: Option<usize>,
) -> crate::preview::PreviewPayload {
    crate::preview::build_with_offset(std::path::Path::new(&path), start.unwrap_or(0))
}

#[tauri::command]
pub fn content_status(app: AppHandle<tauri::Wry>, state: State<'_, AppState>) -> docindex::ContentStatus {
    let conn = state
        .db
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    docindex::status(&app, &conn)
}

#[tauri::command]
pub fn rebuild_content(app: AppHandle<tauri::Wry>) -> bool {
    docindex::rebuild(&app)
}

#[tauri::command]
pub fn index_status(state: State<'_, AppState>) -> IndexStatus {
    let mut status = state
        .index_status
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone();

    // 空闲时从数据库取真实条目数，避免状态和索引内容对不上
    if status.state != "scanning" && status.state != "paused" {
        if let Ok(conn) = state.db.lock() {
            status.files = index::count(&conn).max(0) as u64;
            status.last_scan = index::last_scan(&conn);
        }
    }
    status
}

#[tauri::command]
pub fn start_index<R: Runtime>(app: AppHandle<R>, state: State<'_, AppState>) -> bool {
    let options = scan_options(&state);
    scanner::spawn(app.clone(), options)
}

#[tauri::command]
pub fn pause_index<R: Runtime>(app: AppHandle<R>) {
    scanner::pause(&app);
}

#[tauri::command]
pub fn resume_index<R: Runtime>(app: AppHandle<R>) {
    scanner::resume(&app);
}

#[tauri::command]
pub fn add_root<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    path: String,
) -> Result<AppSettings, String> {
    let Some(root) = scanner::normalize_root(&path) else {
        return Err("目录不存在或不可访问".to_string());
    };
    let normalized = root.to_string_lossy().to_string();

    let mut current = state.settings_snapshot();
    if !current
        .roots
        .iter()
        .any(|existing| existing.eq_ignore_ascii_case(&normalized))
    {
        current.roots.push(normalized);
    }
    *state
        .settings
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = current.clone();
    settings::save(&app, &current)?;
    bump_config_version(&app);
    restart_watcher(&app);

    // 新目录里已有的文件要能立刻搜到；如果已有扫描在跑，补扫会返回 false，
    // 由 pending_rescan 在当前扫描退出后按新范围补一轮。
    let excludes: Vec<PathBuf> = current.excluded_paths.iter().map(PathBuf::from).collect();
    crate::scanner::spawn_root_scan(app.clone(), root, excludes);

    let _ = app.emit("aura:settings-changed", settings::redacted(current.clone()));
    Ok(settings::redacted(current))
}

#[tauri::command]
pub fn remove_root<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    path: String,
) -> Result<AppSettings, String> {
    let mut current = state.settings_snapshot();
    current
        .roots
        .retain(|existing| !existing.eq_ignore_ascii_case(&path));
    *state
        .settings
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = current.clone();
    settings::save(&app, &current)?;

    bump_config_version(&app);
    // 立即停止返回该目录下的文件（不用等下一次全量扫描）
    purge_paths(&app, std::slice::from_ref(&path));
    restart_watcher(&app);
    if !crate::scanner::is_running(&app) {
        crate::scanner::spawn_full(&app);
    }
    let _ = app.emit("aura:settings-changed", settings::redacted(current.clone()));
    Ok(settings::redacted(current))
}

/* -------------------------------------------------------------- 语义检索 */

#[tauri::command]
pub fn semantic_status(
    app: AppHandle<tauri::Wry>,
    state: State<'_, AppState>,
) -> crate::semantic::SemanticStatus {
    let conn = state
        .db
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    crate::semantic::status(&app, &conn)
}

#[tauri::command]
pub fn set_semantic(
    app: AppHandle<tauri::Wry>,
    state: State<'_, AppState>,
    enabled: bool,
) -> Result<AppSettings, String> {
    let settings = state.settings_snapshot();
    if enabled
        && settings.semantic_provider.eq_ignore_ascii_case("cloud")
        && !settings.cloud_consent
    {
        return Err("云端模式需要先确认数据边界（会发送文档片段与查询文本）".to_string());
    }

    Ok(patch_settings(
        app,
        state,
        SettingsPatch {
            semantic_enabled: Some(enabled),
            ..Default::default()
        },
    ))
}

/// 清空文本块与向量，worker 会按当前语料重新嵌入
/// 诊断：查看语义相似度的原始分布（不做阈值过滤）
#[tauri::command]
pub fn semantic_probe(
    state: State<'_, AppState>,
    query: String,
    limit: Option<usize>,
    scope: Option<String>,
) -> Result<Vec<(String, f32)>, String> {
    let settings = state.settings_snapshot();
    // 网络调用放在锁外
    let vector = crate::semantic::embed_query(&settings, &query)?;
    let conn = state
        .db
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let hits = crate::semantic::score_rows_public(&conn, &vector, limit.unwrap_or(8), scope.as_deref())?;
    Ok(hits.into_iter().map(|(path, _text, score)| (path, score)).collect())
}

/// 诊断/预览用：返回图片或 PDF 的 OCR 文本
#[tauri::command]
pub fn ocr_probe(path: String) -> Result<String, String> {
    let target = std::path::Path::new(&path);
    let ext = target
        .extension()
        .map(|value| value.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    if ext == "pdf" {
        crate::ocr::pdf_text(target, crate::ocr::MAX_PDF_PAGES)
    } else {
        crate::ocr::image_text(target)
    }
}

/// 云端配置是否已保存 Key（不返回 Key 本身）
#[tauri::command]
pub fn cloud_key_status(state: State<'_, AppState>) -> bool {
    !state.settings_snapshot().cloud_key.is_empty()
}

/// 用当前云端配置试算一次，确认地址/模型/Key 可用
#[tauri::command]
pub fn test_cloud_embedding(
    state: State<'_, AppState>,
    base_url: Option<String>,
    model: Option<String>,
    api_key: Option<String>,
) -> Result<serde_json::Value, String> {
    let mut settings = state.settings_snapshot();
    if let Some(value) = base_url {
        settings.cloud_base_url = value.trim().to_string();
    }
    if let Some(value) = model {
        settings.cloud_model = value.trim().to_string();
    }
    if let Some(value) = api_key {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            settings.cloud_key = crate::secrets::protect(trimmed)?;
        }
    }

    if settings.cloud_base_url.is_empty() || settings.cloud_model.is_empty() {
        return Err("请先填写接口地址与模型名".to_string());
    }
    if settings.cloud_key.is_empty() {
        return Err("请先填写 API Key".to_string());
    }

    let started = std::time::Instant::now();
    let vectors = crate::semantic::embed(&settings, vec!["连接测试".to_string()])?;
    let dim = vectors.first().map(|vec| vec.len()).unwrap_or(0);
    Ok(serde_json::json!({
        "ok": true,
        "dim": dim,
        "ms": started.elapsed().as_millis() as u64,
        "model": settings.cloud_model,
    }))
}

#[tauri::command]
pub fn rebuild_semantic(app: AppHandle<tauri::Wry>, state: State<'_, AppState>) -> bool {
    let cleared = {
        let conn = state
            .db
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        index::clear_semantic(&conn).is_ok()
    };

    crate::semantic::invalidate_cache();

    if cleared {
        let conn = state
            .db
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let _ = app.emit("semantic:status", crate::semantic::status(&app, &conn));
        crate::aura_log!("语义索引已清空，等待重建");
    }
    cleared
}

/// 把口语问题拆成可检索的词：中文取二元组，英文取整词，丢掉疑问词。
/// 例如「这份预算报告里哪个科目超支了」→ ["预算", "报告", "科目", "超支"]
fn extract_keywords(question: &str) -> Vec<String> {
    const STOPWORDS: &[&str] = &[
        "什么", "怎么", "如何", "为什么", "哪些", "哪个", "是否", "可以", "需要", "我们", "你们",
        "这个", "那个", "一下", "请问", "告诉", "帮我", "资料", "文件", "里面", "关于", "有关",
        "这份", "那份", "的是", "了吗", "么样", "怎样", "多少",
    ];

    let mut terms: Vec<String> = Vec::new();
    let mut run = String::new();
    let push_run = |run: &mut String, out: &mut Vec<String>| {
        let chars: Vec<char> = run.chars().collect();
        if chars.is_empty() {
            return;
        }
        // 英文/数字整词保留；中文按 2 字滑窗
        if chars.iter().all(|ch| ch.is_ascii_alphanumeric()) {
            if chars.len() >= 2 {
                out.push(run.to_lowercase());
            }
        } else {
            for window in chars.windows(2) {
                let gram: String = window.iter().collect();
                if !STOPWORDS.contains(&gram.as_str()) {
                    out.push(gram);
                }
            }
        }
        run.clear();
    };

    for ch in question.chars() {
        let keep = ch.is_alphanumeric() || ('\u{4E00}'..='\u{9FFF}').contains(&ch);
        if keep {
            run.push(ch);
        } else {
            push_run(&mut run, &mut terms);
        }
    }
    push_run(&mut run, &mut terms);

    // 去重并保留前 8 个，避免 FTS 查询过长
    let mut seen = std::collections::HashSet::new();
    terms.retain(|term| seen.insert(term.clone()));
    terms.truncate(8);
    terms
}

/* ---------------------------------------------------------- AI 文件助手 */

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AskSource {
    pub path: String,
    pub name: String,
    pub snippet: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AskAnswer {
    pub answer: String,
    pub sources: Vec<AskSource>,
    pub model: String,
    pub chars: usize,
}

/// 检索增强问答：先用本地检索挑出最相关的几段正文，再交给云端模型作答。
/// 回答只能基于这些片段，并要求给出引用编号。
#[tauri::command]
pub fn ask_files(
    state: State<'_, AppState>,
    question: String,
    scope: Option<String>,
    limit: Option<usize>,
) -> Result<AskAnswer, String> {
    let question = question.trim().to_string();
    if question.is_empty() {
        return Err("问题不能为空".to_string());
    }
    let settings = state.settings_snapshot();
    if !settings.assistant_enabled {
        return Err("AI 文件助手未启用（设置 → AI 与模型）".to_string());
    }
    if settings.cloud_key.is_empty() {
        return Err("请先在设置中保存云端 API Key".to_string());
    }

    let top = limit.unwrap_or(6).clamp(1, 10);

    let vector = if crate::semantic::is_ready(&settings) {
        crate::semantic::embed_query(&settings, &question).ok()
    } else {
        None
    };

    let mut chunks: Vec<(String, String)> = Vec::new();
    if let Some(vector) = vector {
        let snapshot = {
            let conn = state.db.lock().unwrap_or_else(|err| err.into_inner());
            crate::semantic::vector_snapshot(&conn)
        };
        if let Ok(snapshot) = snapshot {
            let hits = snapshot.search(&vector, top, scope.as_deref());
            chunks.extend(hits.into_iter().map(|(path, text, _)| (path, text)));
        }
    }

    {
        let conn = state.db.lock().unwrap_or_else(|err| err.into_inner());
        if chunks.len() < top {
            if let Ok(hits) =
                index::content_hits(&conn, &question, scope.as_deref(), top - chunks.len())
            {
                for hit in hits {
                    if let Some(snippet) = hit.snippet {
                        chunks.push((hit.path, snippet));
                    }
                }
            }
        }

        // 口语化问题常常整句匹配不到：拆成词逐个召回，再按出现顺序累加
        if chunks.is_empty() {
            let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
            for keyword in extract_keywords(&question) {
                if chunks.len() >= top {
                    break;
                }
                if let Ok(hits) =
                    index::content_hits(&conn, &keyword, scope.as_deref(), top - chunks.len())
                {
                    for hit in hits {
                        if !seen.insert(hit.path.clone()) {
                            continue;
                        }
                        if let Some(snippet) = hit.snippet {
                            chunks.push((hit.path, snippet));
                        }
                        if chunks.len() >= top {
                            break;
                        }
                    }
                }
            }
        }
    }

    if chunks.is_empty() {
        return Err("没有找到相关资料，换个问法或先建立正文索引".to_string());
    }

    // 2) 组装上下文（每段最多 500 字，避免把 prompt 撑爆）
    let mut context = String::new();
    let mut sources = Vec::new();
    for (index, (path, text)) in chunks.iter().enumerate() {
        let name = std::path::Path::new(path)
            .file_name()
            .map(|value| value.to_string_lossy().to_string())
            .unwrap_or_else(|| path.clone());
        let snippet: String = text.chars().take(500).collect();
        context.push_str(&format!(
            "[{}] 《{}》\n路径：{}\n内容：{}\n\n",
            index + 1,
            name,
            path,
            snippet
        ));
        sources.push(AskSource {
            path: path.clone(),
            name,
            snippet: text.chars().take(120).collect(),
        });
    }

    let system = "你是本地文件搜索助手的问答模块。只能依据用户提供的资料片段回答；\
资料不足时明确说“资料中没有提到”，不要编造。回答用中文，简洁分点，\
并在句末用 [1][2] 标注引用的资料编号。";
    let user = format!("资料片段：\n{context}\n问题：{question}");

    // 3) 调云端 chat/completions（OpenAI 兼容）
    let key = crate::secrets::unprotect(&settings.cloud_key)?;
    let endpoint = format!(
        "{}/chat/completions",
        settings.cloud_base_url.trim_end_matches('/')
    );
    let agent = ureq::AgentBuilder::new()
        .timeout(std::time::Duration::from_secs(60))
        .build();

    let body = serde_json::json!({
        "model": settings.assistant_model,
        "temperature": 0.2,
        "messages": [
            { "role": "system", "content": system },
            { "role": "user", "content": user },
        ],
    });

    let response = agent
        .post(&endpoint)
        .set("Authorization", &format!("Bearer {key}"))
        .set("Content-Type", "application/json")
        .send_json(body)
        .map_err(|err| format!("问答请求失败：{err}"))?;

    let value: serde_json::Value = response
        .into_json()
        .map_err(|err| format!("问答返回不是合法 JSON：{err}"))?;

    let answer = value
        .get("choices")
        .and_then(|item| item.get(0))
        .and_then(|item| item.get("message"))
        .and_then(|item| item.get("content"))
        .and_then(|item| item.as_str())
        .ok_or_else(|| "问答返回缺少 choices[0].message.content".to_string())?
        .to_string();

    let chars = context.chars().count();
    Ok(AskAnswer {
        answer,
        sources,
        model: settings.assistant_model,
        chars,
    })
}
