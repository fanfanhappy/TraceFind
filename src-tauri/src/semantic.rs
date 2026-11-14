//! 语义检索：本地 ONNX（fastembed + bge-small-zh）或云端嵌入接口。
//!
//! 设计要点：
//! - 两种提供方共用同一套切块/存储/检索逻辑，只有"怎么算向量"不同；
//! - 本地模型按需下载，未启用/未下载时完全不影响现有检索；
//! - 云端 Key 用 Windows DPAPI 加密后落盘，明文只存在于内存；
//! - 查询向量与文档向量都做 L2 归一化，余弦相似度即点积。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::Duration;
use std::time::Instant;

use fastembed::{EmbeddingModel, TextEmbedding, TextInitOptions};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::index;
use crate::settings::AppSettings;
use crate::state::AppState;

pub const MODEL_NAME: &str = "bge-small-zh-v1.5";
/// bge 中文模型建议查询侧加指令前缀
const QUERY_PREFIX: &str = "为这个句子生成表示以用于检索相关文章：";
const MAX_CHUNK_CHARS: usize = 400;
const CHUNK_OVERLAP: usize = 80;
const MAX_CHUNKS_PER_DOC: usize = 40;
const EMBED_BATCH: usize = 32;
const CLOUD_BATCH: usize = 32;
/// 低于这个余弦相似度就不算命中（bge 无关文本通常 0.3–0.4）
const MIN_SCORE: f32 = 0.50;

static ENGINE: OnceLock<Mutex<Option<TextEmbedding>>> = OnceLock::new();
static ENGINE_STATE: OnceLock<Mutex<EngineState>> = OnceLock::new();

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SemanticStatus {
    pub enabled: bool,
    /// disabled | idle | downloading | ready | error
    pub state: String,
    /// local | cloud
    pub provider: String,
    pub model: String,
    pub chunks: i64,
    pub vectors: i64,
    pub message: Option<String>,
}

#[derive(Debug, Default)]
struct EngineState {
    state: String,
    message: Option<String>,
}

fn engine_slot() -> &'static Mutex<Option<TextEmbedding>> {
    ENGINE.get_or_init(|| Mutex::new(None))
}

fn state_slot() -> &'static Mutex<EngineState> {
    ENGINE_STATE.get_or_init(|| Mutex::new(EngineState::default()))
}

pub fn model_cache_dir<R: Runtime>(app: &AppHandle<R>) -> PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("models")
}

fn set_state(state: &str, message: Option<String>) {
    if let Ok(mut guard) = state_slot().lock() {
        guard.state = state.to_string();
        guard.message = message;
    }
}

fn is_local_ready() -> bool {
    engine_slot()
        .lock()
        .map(|guard| guard.is_some())
        .unwrap_or(false)
}

pub fn is_cloud(settings: &AppSettings) -> bool {
    settings.semantic_provider.eq_ignore_ascii_case("cloud")
}

/// 当前配置是否可用（本地=模型已加载；云端=地址/模型/Key 齐全）
pub fn is_ready(settings: &AppSettings) -> bool {
    if is_cloud(settings) {
        !settings.cloud_base_url.is_empty()
            && !settings.cloud_model.is_empty()
            && !settings.cloud_key.is_empty()
    } else {
        is_local_ready()
    }
}

pub fn status<R: Runtime>(app: &AppHandle<R>, conn: &rusqlite::Connection) -> SemanticStatus {
    let settings = app.state::<AppState>().settings_snapshot();
    let enabled = settings.semantic_enabled;
    let cloud = is_cloud(&settings);

    let (state, message) = if cloud && enabled {
        if is_ready(&settings) {
            ("ready".to_string(), None)
        } else {
            (
                "idle".to_string(),
                Some("请填写云端地址、模型与 API Key".to_string()),
            )
        }
    } else {
        state_slot()
            .lock()
            .map(|guard| {
                let state = if guard.state.is_empty() {
                    if enabled {
                        "idle".to_string()
                    } else {
                        "disabled".to_string()
                    }
                } else {
                    guard.state.clone()
                };
                (state, guard.message.clone())
            })
            .unwrap_or_else(|_| ("disabled".to_string(), None))
    };

    SemanticStatus {
        enabled,
        state,
        provider: if cloud { "cloud".to_string() } else { "local".to_string() },
        model: if cloud {
            settings.cloud_model.clone()
        } else {
            MODEL_NAME.to_string()
        },
        chunks: index::chunk_count(conn),
        vectors: index::vector_count(conn),
        message,
    }
}

/// 初始化本地模型（首次会下载）
pub fn init_engine(cache_dir: &Path) -> Result<(), String> {
    {
        let guard = engine_slot().lock().map_err(|_| "引擎锁失败".to_string())?;
        if guard.is_some() {
            return Ok(());
        }
    }

    set_state(
        "downloading",
        Some("正在准备本地模型（首次会下载）".to_string()),
    );
    std::fs::create_dir_all(cache_dir).ok();

    let options = TextInitOptions::new(EmbeddingModel::BGESmallZHV15)
        .with_cache_dir(cache_dir.to_path_buf())
        .with_show_download_progress(false);

    match TextEmbedding::try_new(options) {
        Ok(model) => {
            if let Ok(mut guard) = engine_slot().lock() {
                *guard = Some(model);
            }
            set_state("ready", None);
            Ok(())
        }
        Err(err) => {
            set_state("error", Some(format!("模型加载失败：{err}")));
            Err(format!("{err}"))
        }
    }
}

fn normalize(vector: &mut [f32]) {
    let norm = vector.iter().map(|value| value * value).sum::<f32>().sqrt();
    if norm > f32::EPSILON {
        for value in vector.iter_mut() {
            *value /= norm;
        }
    }
}

fn embed_local(texts: Vec<String>) -> Result<Vec<Vec<f32>>, String> {
    let mut guard = engine_slot().lock().map_err(|_| "引擎锁失败".to_string())?;
    let Some(model) = guard.as_mut() else {
        return Err("本地模型未就绪".to_string());
    };
    let mut vectors = model
        .embed(texts, Some(EMBED_BATCH))
        .map_err(|err| format!("嵌入失败：{err}"))?;
    for vector in vectors.iter_mut() {
        normalize(vector);
    }
    Ok(vectors)
}

fn embed_cloud(settings: &AppSettings, texts: Vec<String>) -> Result<Vec<Vec<f32>>, String> {
    let key = crate::secrets::unprotect(&settings.cloud_key)?;
    if key.is_empty() {
        return Err("云端 API Key 未设置".to_string());
    }

    let endpoint = format!(
        "{}/embeddings",
        settings.cloud_base_url.trim_end_matches('/')
    );
    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(25))
        .build();

    let mut out = Vec::with_capacity(texts.len());
    for batch in texts.chunks(CLOUD_BATCH) {
        let body = serde_json::json!({
            "model": settings.cloud_model,
            "input": batch,
        });
        let response = agent
            .post(&endpoint)
            .set("Authorization", &format!("Bearer {key}"))
            .set("Content-Type", "application/json")
            .send_json(body)
            .map_err(|err| format!("云端嵌入请求失败：{err}"))?;

        let value: serde_json::Value = response
            .into_json()
            .map_err(|err| format!("云端返回不是合法 JSON：{err}"))?;

        let data = value
            .get("data")
            .and_then(|item| item.as_array())
            .ok_or_else(|| "云端返回缺少 data 字段".to_string())?;

        for item in data {
            let embedding = item
                .get("embedding")
                .and_then(|item| item.as_array())
                .ok_or_else(|| "云端返回缺少 embedding".to_string())?;
            let mut vector: Vec<f32> = embedding
                .iter()
                .map(|value| value.as_f64().unwrap_or(0.0) as f32)
                .collect();
            normalize(&mut vector);
            out.push(vector);
        }
    }

    if out.len() != texts.len() {
        return Err(format!(
            "云端返回条数不符：期望 {}，实际 {}",
            texts.len(),
            out.len()
        ));
    }
    Ok(out)
}

/// 按当前提供方计算向量
pub fn embed(settings: &AppSettings, texts: Vec<String>) -> Result<Vec<Vec<f32>>, String> {
    if is_cloud(settings) {
        embed_cloud(settings, texts)
    } else {
        embed_local(texts)
    }
}

/* ------------------------------------------------------------------ 查询 */

type SearchJob = Box<dyn FnOnce() + Send>;
type PendingSearch = (u64, Instant, SearchJob);
type SearchQueue = (Mutex<Option<PendingSearch>>, Condvar);

pub fn schedule_search(generation: u64, job: impl FnOnce() + Send + 'static) {
    static QUEUE: OnceLock<SearchQueue> = OnceLock::new();
    static WORKER: std::sync::Once = std::sync::Once::new();
    let queue = QUEUE.get_or_init(|| (Mutex::new(None), Condvar::new()));
    WORKER.call_once(|| {
        std::thread::spawn(move || run_search_worker(queue));
    });
    let (pending, wake) = queue;
    let mut pending = pending.lock().unwrap_or_else(|err| err.into_inner());
    if pending.as_ref().is_some_and(|(queued, _, _)| *queued > generation) {
        return;
    }
    *pending = Some((generation, Instant::now() + Duration::from_millis(120), Box::new(job)));
    wake.notify_one();
}

fn run_search_worker((pending, wake): &SearchQueue) {
    let mut slot = pending.lock().unwrap_or_else(|err| err.into_inner());
    loop {
        let Some((_, deadline, _)) = slot.as_ref() else {
            slot = wake.wait(slot).unwrap_or_else(|err| err.into_inner());
            continue;
        };
        let remaining = deadline.saturating_duration_since(Instant::now());
        if !remaining.is_zero() {
            (slot, _) = wake.wait_timeout(slot, remaining).unwrap_or_else(|err| err.into_inner());
            continue;
        }
        let (_, _, job) = slot.take().expect("pending search exists");
        drop(slot);
        job();
        slot = pending.lock().unwrap_or_else(|err| err.into_inner());
    }
}

pub struct VectorSnapshot(Vec<(String, String, Vec<f32>)>);

struct VectorCache {
    loaded: Instant,
    snapshot: Arc<VectorSnapshot>,
}

static VECTORS_CHANGED: AtomicBool = AtomicBool::new(false);
static CACHE: OnceLock<Mutex<Option<VectorCache>>> = OnceLock::new();

fn cache_slot() -> &'static Mutex<Option<VectorCache>> {
    CACHE.get_or_init(|| Mutex::new(None))
}

pub fn vector_snapshot(conn: &rusqlite::Connection) -> Result<Arc<VectorSnapshot>, String> {
    let mut guard = cache_slot().lock().map_err(|err| err.to_string())?;
    if let Some(cache) = guard.as_ref() {
        if !VECTORS_CHANGED.load(Ordering::Acquire)
            || cache.loaded.elapsed() < Duration::from_secs(2)
        {
            return Ok(Arc::clone(&cache.snapshot));
        }
    }

    VECTORS_CHANGED.swap(false, Ordering::AcqRel);
    let rows = index::load_vectors(conn)
        .map_err(|err| {
            VECTORS_CHANGED.store(true, Ordering::Release);
            err.to_string()
        })?
        .into_iter()
        .map(|(_id, path, text, vector)| (path, text, vector))
        .collect();
    let snapshot = Arc::new(VectorSnapshot(rows));
    *guard = Some(VectorCache {
        loaded: Instant::now(),
        snapshot: Arc::clone(&snapshot),
    });
    Ok(snapshot)
}

pub fn mark_vectors_changed() {
    VECTORS_CHANGED.store(true, Ordering::Release);
}

pub fn invalidate_cache() {
    if let Ok(mut guard) = cache_slot().lock() {
        *guard = None;
    }
}

/// 只算查询向量：可能走网络（云端），必须在持锁之前完成
pub fn embed_search_query(
    settings: &AppSettings,
    query: &str,
    is_current: impl Fn() -> bool,
) -> Result<Vec<f32>, String> {
    type QueryKey = (String, String, String, String, String);
    type QueryCache = std::collections::VecDeque<(QueryKey, Vec<f32>)>;
    static QUERIES: OnceLock<Mutex<QueryCache>> = OnceLock::new();

    let key = (
        settings.semantic_provider.clone(),
        settings.cloud_base_url.clone(),
        settings.cloud_model.clone(),
        settings.cloud_key.clone(),
        query.to_string(),
    );
    // Only search workers take this lock. Serialize misses so a refresh can reuse an in-flight query.
    let mut cache = QUERIES.get_or_init(|| Mutex::new(QueryCache::new()))
        .lock().unwrap_or_else(|err| err.into_inner());
    if !is_current() {
        return Err("Search superseded".to_string());
    }
    if let Some(position) = cache.iter().position(|(cached, _)| cached == &key) {
        if let Some(entry) = cache.remove(position) {
            let vector = entry.1.clone();
            cache.push_front(entry);
            return Ok(vector);
        }
    }
    let vector = embed_query(settings, query)?;
    cache.push_front((key, vector.clone()));
    cache.truncate(16);
    Ok(vector)
}

pub fn embed_query(settings: &AppSettings, query: &str) -> Result<Vec<f32>, String> {
    if !is_ready(settings) {
        return Err("语义提供方未就绪".to_string());
    }
    embed(settings, vec![format!("{QUERY_PREFIX}{query}")])?
        .pop()
        .ok_or_else(|| "查询向量为空".to_string())
}

/// 用已算好的查询向量打分；调用方负责持锁
pub fn search_with_vector(
    conn: &rusqlite::Connection,
    query_vector: &[f32],
    limit: usize,
    scope: Option<&str>,
) -> Result<Vec<(String, String, f32)>, String> {
    Ok(vector_snapshot(conn)?.search(query_vector, limit, scope))
}

/// 诊断/探测用：不做阈值过滤
pub fn score_rows_public(
    conn: &rusqlite::Connection,
    query_vector: &[f32],
    limit: usize,
    scope: Option<&str>,
) -> Result<Vec<(String, String, f32)>, String> {
    score_rows(conn, query_vector, limit, scope, f32::NEG_INFINITY)
}

fn score_rows(
    conn: &rusqlite::Connection,
    query_vector: &[f32],
    limit: usize,
    scope: Option<&str>,
    threshold: f32,
) -> Result<Vec<(String, String, f32)>, String> {
    Ok(vector_snapshot(conn)?.score(query_vector, limit, scope, threshold))
}

impl VectorSnapshot {
    pub fn search(
        &self,
        query_vector: &[f32],
        limit: usize,
        scope: Option<&str>,
    ) -> Vec<(String, String, f32)> {
        self.score(query_vector, limit, scope, MIN_SCORE)
    }

    fn score(
        &self,
        query_vector: &[f32],
        limit: usize,
        scope: Option<&str>,
        threshold: f32,
    ) -> Vec<(String, String, f32)> {
        if limit == 0 {
            return Vec::new();
        }

        let mut best: HashMap<&str, (&str, f32)> = HashMap::new();
        for (path, text, vector) in &self.0 {
            if vector.len() != query_vector.len() || !index::path_in_scope(path, scope) {
                continue;
            }
            let score: f32 = vector.iter().zip(query_vector).map(|(a, b)| a * b).sum();
            if score >= threshold {
                let hit = best.entry(path).or_insert((text, score));
                if score > hit.1 {
                    *hit = (text, score);
                }
            }
        }

        let mut hits: Vec<_> = best.into_iter().collect();
        let compare = |(path_a, (_, score_a)): &(&str, (&str, f32)),
                       (path_b, (_, score_b)): &(&str, (&str, f32))| {
            score_b.partial_cmp(score_a).unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| path_a.cmp(path_b))
        };
        if hits.len() > limit {
            hits.select_nth_unstable_by(limit, compare);
            hits.truncate(limit);
        }
        hits.sort_unstable_by(compare);
        hits.into_iter()
            .map(|(path, (text, score))| (path.to_string(), text.to_string(), score))
            .collect()
    }
}

/// 一次性完成：算向量 + 打分（探测/单测用；搜索命令请先算向量再持锁）
#[allow(dead_code)]
pub fn search(
    conn: &rusqlite::Connection,
    settings: &AppSettings,
    query: &str,
    limit: usize,
    scope: Option<&str>,
) -> Result<Vec<(String, String, f32)>, String> {
    let query_vector = embed_query(settings, query)?;
    search_with_vector(conn, &query_vector, limit, scope)
}

/// 诊断用：不做阈值过滤，返回原始相似度，便于调参
#[allow(dead_code)]
pub fn probe(
    conn: &rusqlite::Connection,
    settings: &AppSettings,
    query: &str,
    limit: usize,
    scope: Option<&str>,
) -> Result<Vec<(String, f32)>, String> {
    let query_vector = embed_query(settings, query)?;
    let hits = score_rows(conn, &query_vector, limit, scope, f32::NEG_INFINITY)?;
    Ok(hits.into_iter().map(|(path, _text, score)| (path, score)).collect())
}

/* ------------------------------------------------------------------ worker */

pub fn spawn_worker<R: Runtime>(app: AppHandle<R>) {
    std::thread::spawn(move || {
        // 失败退避：path -> (失败次数, 下次可重试时间)
        let mut backoff: std::collections::HashMap<String, (u32, Instant)> =
            std::collections::HashMap::new();
        loop {
        let state = app.state::<AppState>();
        if state.quitting.load(Ordering::Relaxed) {
            break;
        }
        let settings = state.settings_snapshot();
        if !settings.semantic_enabled {
            std::thread::sleep(Duration::from_millis(1500));
            continue;
        }
        if state.scan_running.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_millis(800));
            continue;
        }

        let index_path = state.index_path.clone();
        let mut conn = match index::open(&index_path) {
            Ok(conn) => conn,
            Err(_) => {
                std::thread::sleep(Duration::from_millis(3000));
                continue;
            }
        };

        // 本地模型才需要预热；云端只要配置齐全
        if !is_cloud(&settings) && !is_local_ready() {
            let cache = model_cache_dir(&app);
            if let Err(err) = init_engine(&cache) {
                crate::aura_log!("语义模型初始化失败：{err}");
                let _ = app.emit("semantic:status", status(&app, &conn));
                std::thread::sleep(Duration::from_secs(10));
                continue;
            }
            crate::aura_log!("语义模型就绪：{MODEL_NAME}");
            let _ = app.emit("semantic:status", status(&app, &conn));
        }

        if !is_ready(&settings) {
            std::thread::sleep(Duration::from_millis(1500));
            continue;
        }

        let docs = match index::docs_without_chunks(&conn, 20) {
            Ok(list) => list,
            Err(err) => {
                crate::aura_log!("读取待嵌入文档失败：{err}");
                std::thread::sleep(Duration::from_millis(2000));
                continue;
            }
        };

        // 失败的文档按指数退避重试，避免接口挂掉时死循环打请求
        let now = Instant::now();
        let mut docs: Vec<(String, i64, i64)> = docs
            .into_iter()
            .filter(|(path, _, _)| {
                backoff
                    .get(path)
                    .map(|(_, next)| *next <= now)
                    .unwrap_or(true)
            })
            .take(2)
            .collect();

        if docs.is_empty() {
            std::thread::sleep(Duration::from_millis(1500));
            continue;
        }

        for (path, _mtime, _size) in { std::mem::take(&mut docs) } {
            if app.state::<AppState>().quitting.load(Ordering::Relaxed) {
                break;
            }
            // 正文缺失或切不出块（OCR 空文本、纯图、极短文件）：
            // 写一个空占位块，把它标记成"已处理"，否则队列会一直取到同一批文件原地打转
            let body = index::body_of(&conn, &path).ok().flatten();
            let mut chunks = body
                .as_deref()
                .map(|text| index::chunk_text(text, MAX_CHUNK_CHARS, CHUNK_OVERLAP))
                .unwrap_or_default();
            chunks.truncate(MAX_CHUNKS_PER_DOC);
            if chunks.is_empty() {
                let placeholder = [index::ChunkDraft {
                    ord: -1,
                    text: String::new(),
                }];
                let _ = index::insert_chunks(&mut conn, &path, &placeholder);
                continue;
            }

            // 先把整篇文档的向量全部算完，再与切片一起提交：
            // 中途失败不会留下"有切片没向量"的半成品，文档会重新排队
            let mut vectors: Vec<Vec<f32>> = Vec::with_capacity(chunks.len());
            let mut failure: Option<String> = None;
            for batch in chunks.chunks(EMBED_BATCH) {
                let texts: Vec<String> = batch.iter().map(|chunk| chunk.text.clone()).collect();
                match embed(&settings, texts) {
                    Ok(mut embedded) => vectors.append(&mut embedded),
                    Err(err) => {
                        failure = Some(err);
                        break;
                    }
                }
            }

            if let Some(err) = failure {
                let entry = backoff.entry(path.clone()).or_insert((0, Instant::now()));
                entry.0 = entry.0.saturating_add(1);
                let delay = Duration::from_secs(5 * (1u64 << entry.0.min(6)));
                entry.1 = Instant::now() + delay;
                crate::aura_log!(
                    "嵌入失败（{path}），第 {} 次，{} 秒后重试：{err}",
                    entry.0,
                    delay.as_secs()
                );
                continue;
            }

            backoff.remove(&path);

            if let Err(err) = index::insert_chunks_with_vectors(&mut conn, &path, &chunks, &vectors) {
                crate::aura_log!("写入切片/向量失败（{path}）：{err}");
                continue;
            }

            mark_vectors_changed();
            let _ = app.emit("semantic:status", status(&app, &conn));
            }
        }
    });
}

#[cfg(test)]
mod search_tests {
    use super::*;

    #[test]
    fn semantic_queue_runs_only_the_latest_pending_job() {
        use std::sync::mpsc;

        let timeout = Duration::from_secs(5);
        let (started, running) = mpsc::channel();
        let (release, blocked) = mpsc::channel();
        let (finished, results) = mpsc::channel();
        schedule_search(1, move || {
            started.send(()).unwrap();
            let _ = blocked.recv_timeout(timeout);
        });
        running.recv_timeout(timeout).unwrap();

        for generation in [2, 4, 3] {
            let finished = finished.clone();
            schedule_search(generation, move || {
                finished.send(generation).unwrap();
            });
        }
        drop(finished);
        release.send(()).unwrap();

        assert_eq!(results.recv_timeout(timeout), Ok(4));
        assert_eq!(
            results.recv_timeout(timeout),
            Err(mpsc::RecvTimeoutError::Disconnected)
        );
    }

    #[test]
    fn semantic_top_k_keeps_the_best_chunk_per_file() {
        let snapshot = VectorSnapshot(vec![
            ("b".into(), "first".into(), vec![0.7]),
            ("b".into(), "best".into(), vec![0.9]),
            ("b".into(), "other".into(), vec![0.8]),
            ("a".into(), "tied".into(), vec![0.9]),
            ("c".into(), "below threshold".into(), vec![0.4]),
            ("d".into(), "wrong dimension".into(), vec![1.0, 1.0]),
        ]);

        assert!(snapshot.search(&[1.0], 0, None).is_empty());
        assert_eq!(
            snapshot.search(&[1.0], 1, None),
            vec![("a".into(), "tied".into(), 0.9)]
        );
        assert_eq!(
            snapshot.search(&[1.0], 3, None),
            vec![
                ("a".into(), "tied".into(), 0.9),
                ("b".into(), "best".into(), 0.9),
            ]
        );
    }
}
