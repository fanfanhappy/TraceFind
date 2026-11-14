//! 持久化文件名索引：SQLite 表结构、拼音字段、查询与排序。
//!
//! 文件名索引只记录「名字/路径/大小/时间」，不读文件内容；
//! 全文检索（Tantivy/FTS）在后续模块接入，届时复用同一张表的 path 主键。

use std::path::Path;

use pinyin::ToPinyin;
use rusqlite::{params, Connection, OptionalExtension, Result as SqlResult};
use serde::Serialize;

/// 命中结果（直接给前端）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileHit {
    pub path: String,
    pub name: String,
    pub dir: String,
    pub ext: String,
    pub kind: String,
    pub size: u64,
    /// Unix 秒；时间格式由前端本地化
    pub modified: i64,
    /// 正文命中片段（没有内容索引时为 None）
    pub snippet: Option<String>,
    /// 命中来源：name / content / semantic（可多选，按固定顺序）
    pub sources: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct IndexStatus {
    /// idle | scanning | paused | ready
    pub state: String,
    pub files: u64,
    pub scanned: u64,
    pub current: String,
    pub last_scan: i64,
    pub error: Option<String>,
}

pub fn open(path: &Path) -> SqlResult<Connection> {
    let conn = Connection::open(path)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.pragma_update(None, "temp_store", "MEMORY")?;
    Ok(conn)
}

pub fn init(conn: &Connection) -> SqlResult<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS files (
            path    TEXT PRIMARY KEY,
            name    TEXT NOT NULL,
            name_lc TEXT NOT NULL,
            dir     TEXT NOT NULL,
            ext     TEXT NOT NULL,
            kind    TEXT NOT NULL,
            size    INTEGER NOT NULL,
            mtime   INTEGER NOT NULL,
            depth   INTEGER NOT NULL,
            py      TEXT NOT NULL,
            pyf     TEXT NOT NULL,
            gen     INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_files_mtime ON files(mtime DESC);
        CREATE INDEX IF NOT EXISTS idx_files_name  ON files(name_lc);
        CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS doc_text (
            path  TEXT PRIMARY KEY,
            state TEXT NOT NULL,
            mtime INTEGER NOT NULL,
            size  INTEGER NOT NULL DEFAULT 0,
            chars INTEGER NOT NULL DEFAULT 0,
            error TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_doc_state ON doc_text(state);
        CREATE TABLE IF NOT EXISTS doc_body (
            path TEXT PRIMARY KEY,
            body TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS chunk (
            id    INTEGER PRIMARY KEY AUTOINCREMENT,
            path  TEXT NOT NULL,
            ord   INTEGER NOT NULL,
            text  TEXT NOT NULL,
            UNIQUE(path, ord)
        );
        CREATE INDEX IF NOT EXISTS idx_chunk_path ON chunk(path);
        CREATE TABLE IF NOT EXISTS chunk_vec (
            chunk_id INTEGER PRIMARY KEY,
            dim      INTEGER NOT NULL,
            vec      BLOB NOT NULL
        );
        CREATE TABLE IF NOT EXISTS embed_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE VIRTUAL TABLE IF NOT EXISTS doc_fts USING fts5(body, path UNINDEXED, tokenize='unicode61');
        "#,
    )?;
    // 老库补列（已存在时忽略错误）
    let _ = conn.execute(
        "ALTER TABLE doc_text ADD COLUMN size INTEGER NOT NULL DEFAULT 0",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE doc_text ADD COLUMN via_ocr INTEGER NOT NULL DEFAULT 0",
        [],
    );
    // 图片的正文只能是 OCR 出来的，老库直接标上；PDF 要等重新提取才知道
    if meta_get(conn, "ocr_flag_version").as_deref() != Some("1") {
        let list = crate::ocr::IMAGE_EXTS
            .iter()
            .map(|ext| format!("'{}'", ext))
            .collect::<Vec<_>>()
            .join(", ");
        let _ = conn.execute(
            &format!(
                "UPDATE doc_text SET via_ocr = 1 WHERE state = 'done' AND path IN \
                 (SELECT path FROM files WHERE lower(ext) IN ({list}))"
            ),
            [],
        );
        let _ = meta_set(conn, "ocr_flag_version", "1");
    }

    // 原文表是后加的：老库没有 body，清空状态让 worker 重抽一遍，
    // 否则片段会一直是空的。按 meta 版本只做一次。
    let body_version = meta_get(conn, "body_version").unwrap_or_default();
    if body_version != "2" {
        let _ = conn.execute("DELETE FROM doc_text", []);
        let _ = conn.execute("DELETE FROM doc_body", []);
        let _ = meta_set(conn, "body_version", "2");
    }
    Ok(())
}

fn meta_get(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row("SELECT value FROM meta WHERE key = ?1", params![key], |row| {
        row.get::<_, String>(0)
    })
    .ok()
}

fn meta_set(conn: &Connection, key: &str, value: &str) -> SqlResult<()> {
    conn.execute(
        "INSERT INTO meta(key, value) VALUES(?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

pub fn next_generation(conn: &Connection) -> SqlResult<i64> {
    let current: i64 = meta_get(conn, "gen")
        .and_then(|value| value.parse().ok())
        .unwrap_or(0);
    let next = current + 1;
    meta_set(conn, "gen", &next.to_string())?;
    Ok(next)
}

/// 当前扫描代数（监听线程写入时沿用，避免被下一次清理误删）
pub fn current_gen(conn: &Connection) -> i64 {
    meta_get(conn, "gen")
        .and_then(|value| value.parse().ok())
        .unwrap_or(0)
}

/// 删除这些路径本身及其子树（目录被删除、改名或移出扫描范围时用）。
/// 文件、正文状态、FTS 三张表在一个事务里一起清，避免出现"结果没了但正文统计还在"。
pub fn delete_paths(conn: &mut Connection, paths: &[String]) -> SqlResult<usize> {
    if paths.is_empty() {
        return Ok(0);
    }
    let tx = conn.transaction()?;
    let mut removed = 0usize;
    {
        let mut files_stmt =
            tx.prepare("DELETE FROM files WHERE path = ?1 OR path LIKE ?2 ESCAPE '\\'")?;
        let mut text_stmt =
            tx.prepare("DELETE FROM doc_text WHERE path = ?1 OR path LIKE ?2 ESCAPE '\\'")?;
        let mut fts_stmt =
            tx.prepare("DELETE FROM doc_fts WHERE path = ?1 OR path LIKE ?2 ESCAPE '\\'")?;
        let mut body_stmt =
            tx.prepare("DELETE FROM doc_body WHERE path = ?1 OR path LIKE ?2 ESCAPE '\\'")?;
        for path in paths {
            let prefix = format!("{}%", escape_like(&format!("{path}\\")));
            removed += files_stmt.execute(params![path, prefix])?;
            let _ = text_stmt.execute(params![path, prefix]);
            let _ = fts_stmt.execute(params![path, prefix]);
            let _ = body_stmt.execute(params![path, prefix]);
        }
    }
    tx.commit()?;
    Ok(removed)
}

pub fn mark_scanned(conn: &Connection, timestamp: i64) -> SqlResult<()> {
    meta_set(conn, "last_scan", &timestamp.to_string())
}

pub fn last_scan(conn: &Connection) -> i64 {
    meta_get(conn, "last_scan")
        .and_then(|value| value.parse().ok())
        .unwrap_or(0)
}

pub fn count(conn: &Connection) -> i64 {
    conn.query_row("SELECT COUNT(*) FROM files", [], |row| row.get(0))
        .unwrap_or(0)
}

/// 删除本次扫描没见到的行（文件被删/被移走）
pub fn prune_stale(conn: &Connection, gen: i64) -> SqlResult<usize> {
    conn.execute("DELETE FROM files WHERE gen != ?1", params![gen])
}

/* ------------------------------------------------------------------ 拼音 */

/// 生成两套拼音字段：
/// - full：中文取全拼，ASCII 原样小写（用于 "caiwu" 这类输入）
/// - initials：中文取首字母，ASCII 保留字符（用于 "cwbg" 这类输入）
pub fn pinyin_fields(name: &str) -> (String, String) {
    let mut full = String::with_capacity(name.len() * 3);
    let mut initials = String::with_capacity(name.len());

    for ch in name.chars() {
        if ch.is_ascii_alphanumeric() {
            let lower = ch.to_ascii_lowercase();
            full.push(lower);
            initials.push(lower);
        } else if let Some(py) = ch.to_pinyin() {
            full.push_str(py.plain());
            initials.push_str(py.first_letter());
        }
        // 空格、标点、符号直接跳过，让 "财务 预算" 和 "财务预算" 都能命中
    }

    (full, initials)
}

/* ------------------------------------------------------------------ 分类 */

pub fn classify(ext: &str, is_dir: bool) -> &'static str {
    if is_dir {
        return "folder";
    }
    match ext {
        "pdf" => "pdf",
        "doc" | "docx" | "rtf" | "odt" | "txt" | "md" | "markdown" => "doc",
        "xls" | "xlsx" | "csv" | "ods" | "numbers" => "sheet",
        "ppt" | "pptx" | "key" | "odp" => "slide",
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "svg" | "ico" | "heic" => "image",
        "zip" | "7z" | "rar" | "tar" | "gz" => "archive",
        "mp4" | "mov" | "mkv" | "avi" | "wmv" | "webm" => "video",
        "mp3" | "wav" | "flac" | "m4a" | "aac" => "audio",
        "rs" | "ts" | "tsx" | "js" | "jsx" | "py" | "go" | "java" | "c" | "cpp" | "h"
        | "cs" | "rb" | "php" | "sh" | "ps1" | "json" | "yaml" | "yml" | "toml" | "sql"
        | "html" | "css" | "scss" => "code",
        "exe" | "msi" | "dll" | "bat" | "cmd" => "binary",
        _ => "other",
    }
}

/* ------------------------------------------------------------------ 写入 */

pub struct NewEntry<'a> {
    pub path: &'a str,
    pub name: &'a str,
    pub dir: &'a str,
    pub ext: &'a str,
    pub kind: &'a str,
    pub size: i64,
    pub mtime: i64,
    pub depth: i64,
}

/// 批量写入（调用方负责开事务）
pub fn upsert_batch(conn: &mut Connection, entries: &[NewEntry<'_>], gen: i64) -> SqlResult<()> {
    let tx = conn.transaction()?;
    {
        let mut stmt = tx.prepare_cached(
            r#"
            INSERT INTO files (path, name, name_lc, dir, ext, kind, size, mtime, depth, py, pyf, gen)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
            ON CONFLICT(path) DO UPDATE SET
                name = excluded.name,
                name_lc = excluded.name_lc,
                dir = excluded.dir,
                ext = excluded.ext,
                kind = excluded.kind,
                size = excluded.size,
                mtime = excluded.mtime,
                depth = excluded.depth,
                py = excluded.py,
                pyf = excluded.pyf,
                gen = excluded.gen
            "#,
        )?;

        for entry in entries {
            let (py, pyf) = pinyin_fields(entry.name);
            let name_lc = entry.name.to_lowercase();
            stmt.execute(params![
                entry.path,
                entry.name,
                name_lc,
                entry.dir,
                entry.ext,
                entry.kind,
                entry.size,
                entry.mtime,
                entry.depth,
                py,
                pyf,
                gen
            ])?;
        }
    }
    tx.commit()
}

/* ------------------------------------------------------------------ 查询 */

/// 目录边界：命中目录本身，或"目录 + 分隔符"开头的子路径。
/// 不加分隔符时 D:\Work 会命中 D:\Workbench，这是最常见的误报来源。
pub fn scope_patterns(root: &str) -> (String, String) {
    let trimmed = root.trim_end_matches(['\\', '/']);
    // 等值比较用原始路径；只有 LIKE 需要转义与 ESCAPE
    let exact = trimmed.to_string();
    // 注意：ESCAPE '\' 下 `\%` 表示字面量百分号，分隔符本身要写成 `\\`
    let prefix = format!("{}%", escape_like(&format!("{trimmed}\\")));
    (exact, prefix)
}

fn escape_like(input: &str) -> String {
    input
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

/// 把一行算成一个分数：命中位置越靠前、名字越短、越新、层级越浅，分越高
fn score(
    name_lc: &str,
    path_lc: &str,
    py: &str,
    pyf: &str,
    depth: i64,
    mtime: i64,
    terms: &[String],
    now: i64,
) -> i32 {
    let mut total = 0i32;

    for term in terms {
        let mut best = 0i32;

        if name_lc == *term {
            best = 1200;
        } else if name_lc.starts_with(term.as_str()) {
            best = 900;
        } else if name_lc.contains(term.as_str()) {
            // 词边界（"-"、空格、"_" 之后）稍微加权
            let boundary = name_lc
                .split([' ', '-', '_', '.', '(', '['])
                .any(|part| part.starts_with(term.as_str()));
            best = if boundary { 760 } else { 620 };
        }

        if best < 700 {
            if pyf.starts_with(term.as_str()) {
                best = best.max(680);
            } else if py.starts_with(term.as_str()) {
                best = best.max(660);
            } else if pyf.contains(term.as_str()) {
                best = best.max(480);
            } else if py.contains(term.as_str()) {
                best = best.max(440);
            }
        }

        if best == 0 && path_lc.contains(term.as_str()) {
            best = 300;
        }

        // 一个词都不命中就整体淘汰
        if best == 0 {
            return 0;
        }
        total += best;
    }

    // 所有词都出现在文件名里：通常就是目标文件，给一档加成
    if terms.len() > 1 && terms.iter().all(|term| name_lc.contains(term.as_str())) {
        total += 120;
    }

    // 多个词在文件名里连续出现（类似短语匹配），再给一档
    if terms.len() > 1 {
        let phrase = terms.join(" ");
        let compact: String = terms.concat();
        if name_lc.contains(&phrase) || name_lc.contains(&compact) {
            total += 160;
        }
    }

    // 名字越短越可能是目标
    total += (60 - name_lc.chars().count().min(60) as i32).max(0);
    // 层级越浅越优先
    total -= (depth.min(20) as i32) * 6;
    // 最近改过的优先（7 天内 +90，30 天内 +45）
    let age = now - mtime;
    if age <= 86_400 {
        total += 90;
    } else if age <= 7 * 86_400 {
        total += 45;
    } else if age <= 30 * 86_400 {
        total += 18;
    }

    total
}

const SELECT_COLUMNS: &str =
    "path, name, name_lc, dir, ext, kind, size, mtime, depth, py, pyf";

fn row_to_hit(row: &rusqlite::Row<'_>) -> SqlResult<FileHit> {
    Ok(FileHit {
        path: row.get(0)?,
        name: row.get(1)?,
        dir: row.get(3)?,
        ext: row.get(4)?,
        kind: row.get(5)?,
        size: row.get::<_, i64>(6)? as u64,
        modified: row.get(7)?,
        snippet: None,
        sources: Vec::new(),
    })
}

fn collect(rows: Vec<(FileHit, String, String, String, String, i64)>, terms: &[String], limit: usize) -> Vec<FileHit> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);

    let mut scored: Vec<(i32, FileHit)> = rows
        .into_iter()
        .map(|(hit, name_lc, path_lc, py, pyf, depth)| {
            let mtime = hit.modified;
            let value = score(&name_lc, &path_lc, &py, &pyf, depth, mtime, terms, now);
            (value, hit)
        })
        .filter(|(value, _)| *value > 0)
        .collect();

    scored.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| b.1.modified.cmp(&a.1.modified)));
    scored.into_iter().take(limit).map(|(_, hit)| hit).collect()
}

/// 搜索：所有词都必须命中（AND），命中范围含文件名、路径、拼音全拼、拼音首字母。
pub fn search(
    conn: &Connection,
    query: &str,
    scope: Option<&str>,
    limit: usize,
) -> SqlResult<Vec<FileHit>> {
    search_with(conn, query, scope, limit, None, SortMode::Relevance)
}

pub fn search_with(
    conn: &Connection,
    query: &str,
    scope: Option<&str>,
    limit: usize,
    kind: Option<&str>,
    sort: SortMode,
) -> SqlResult<Vec<FileHit>> {
    let terms: Vec<String> = query
        .split_whitespace()
        .map(|term| term.to_lowercase())
        .filter(|term| !term.is_empty())
        .collect();

    if terms.is_empty() {
        return recent(conn, scope, limit);
    }

    let mut sql = format!("SELECT {SELECT_COLUMNS} FROM files WHERE 1 = 1");
    let mut params_dyn: Vec<String> = Vec::new();

    if let Some(root) = scope.filter(|root| !root.is_empty()) {
        let (exact, prefix) = scope_patterns(root);
        sql.push_str(" AND (path = ? OR path LIKE ? ESCAPE '\\')");
        params_dyn.push(exact);
        params_dyn.push(prefix);
    }

    // 类型筛选：一组 kind 归成一个用户可见分类
    if let Some(group) = kind {
        if let Some(clause) = kind_group_sql(group) {
            sql.push_str(" AND ");
            sql.push_str(clause);
        }
    }

    let exact_hits = if sort == SortMode::Relevance {
        let exact_sql = format!(
            "{sql} AND name_lc = ? ORDER BY mtime DESC, path LIMIT {limit}"
        );
        let exact = query.trim().to_lowercase();
        let mut stmt = conn.prepare_cached(&exact_sql)?;
        let rows = stmt.query_map(
            rusqlite::params_from_iter(params_dyn.iter().chain(std::iter::once(&exact))),
            row_to_hit,
        )?;
        rows.collect::<SqlResult<Vec<_>>>()?
    } else {
        Vec::new()
    };

    if exact_hits.len() >= limit {
        return Ok(exact_hits);
    }

    for term in &terms {
        sql.push_str(
            " AND (name_lc LIKE ? ESCAPE '\\' OR path LIKE ? ESCAPE '\\' \
              OR py LIKE ? ESCAPE '\\' OR pyf LIKE ? ESCAPE '\\')",
        );
        let pattern = format!("%{}%", escape_like(term));
        params_dyn.push(pattern.clone());
        params_dyn.push(pattern.clone());
        params_dyn.push(pattern.clone());
        params_dyn.push(pattern.clone());
    }

    // 先按时间取一批候选，再在 Rust 侧精排
    sql.push_str(" ORDER BY mtime DESC LIMIT 800");

    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(rusqlite::params_from_iter(params_dyn.iter()), |row| {
        Ok((
            row_to_hit(row)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(0)?,
            row.get::<_, String>(9)?,
            row.get::<_, String>(10)?,
            row.get::<_, i64>(8)?,
        ))
    })?;

    let mut collected = Vec::new();
    for row in rows {
        collected.push(row?);
    }

    let ranked = collect(collected, &terms, limit.saturating_mul(4));
    let exact_paths: std::collections::HashSet<_> =
        exact_hits.iter().map(|hit| hit.path.clone()).collect();
    let mut hits = exact_hits;
    hits.extend(ranked.into_iter().filter(|hit| !exact_paths.contains(&hit.path)));

    // 非相关度排序：按用户选的键重排后再截断
    match sort {
        SortMode::Relevance => {}
        SortMode::Recent => hits.sort_by(|a, b| b.modified.cmp(&a.modified)),
        SortMode::Name => hits.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase())),
        SortMode::Size => hits.sort_by(|a, b| b.size.cmp(&a.size)),
    }
    hits.truncate(limit);

    // 首字母缩写的补召回：用户常跳过中间的字，例如「财务预算报告」打 cwbg。
    // 这类是子序列匹配，SQL 的 LIKE 拿不到，只在结果偏少时补一轮候选。
    if hits.len() < 3 && terms.len() == 1 {
        let term = &terms[0];
        if term.len() >= 2 && term.len() <= 8 && term.chars().all(|c| c.is_ascii_alphabetic()) {
            if let Ok(extra) = subsequence_hits(conn, term, scope, limit) {
                for hit in extra {
                    if !hits.iter().any(|existing| existing.path == hit.path) {
                        hits.push(hit);
                    }
                }
                hits.truncate(limit);
            }
        }
    }

    Ok(hits)
}

/// 首字母子序列匹配：按顺序命名字母即可，允许中间跳字。
fn subsequence_hits(
    conn: &Connection,
    term: &str,
    scope: Option<&str>,
    limit: usize,
) -> SqlResult<Vec<FileHit>> {
    let Some(first) = term.chars().next() else {
        return Ok(Vec::new());
    };

    let mut sql = format!("SELECT {SELECT_COLUMNS}, pyf FROM files WHERE pyf LIKE ?1 ESCAPE '\\'");
    let mut scope_filter: Option<(String, String)> = None;
    if let Some(root) = scope.filter(|root| !root.is_empty()) {
        sql.push_str(" AND (path = ?2 OR path LIKE ?3 ESCAPE '\\')");
        scope_filter = Some(scope_patterns(root));
    }
    sql.push_str(" ORDER BY mtime DESC LIMIT 2000");

    let pattern = format!("{}%", escape_like(&first.to_string()));
    let mut stmt = conn.prepare(&sql)?;

    let mut kept: Vec<FileHit> = Vec::new();
    let mut collect_row = |hit: FileHit, pyf: String| {
        if kept.len() < limit && is_subsequence(term, &pyf) {
            kept.push(hit);
        }
    };

    match scope_filter {
        Some((exact, prefix)) => {
            let mut rows = stmt.query(params![pattern, exact, prefix])?;
            while let Some(row) = rows.next()? {
                collect_row(row_to_hit(row)?, row.get::<_, String>(11)?);
            }
        }
        None => {
            let mut rows = stmt.query(params![pattern])?;
            while let Some(row) = rows.next()? {
                collect_row(row_to_hit(row)?, row.get::<_, String>(11)?);
            }
        }
    }

    Ok(kept)
}

fn is_subsequence(needle: &str, haystack: &str) -> bool {
    let mut chars = haystack.chars();
    needle
        .chars()
        .all(|needle_char| chars.any(|hay| hay == needle_char))
}

pub fn recent(conn: &Connection, scope: Option<&str>, limit: usize) -> SqlResult<Vec<FileHit>> {
    recent_filtered(conn, scope, limit, None)
}

/// 最近使用；`kind_group` 与搜索的类型筛选一致（doc 含 pdf，other 含 binary 等）
pub fn recent_filtered(
    conn: &Connection,
    scope: Option<&str>,
    limit: usize,
    kind_group: Option<&str>,
) -> SqlResult<Vec<FileHit>> {
    let kind_clause = kind_group
        .and_then(kind_group_sql)
        .map(|clause| format!(" AND {clause}"))
        .unwrap_or_default();

    match scope.filter(|root| !root.is_empty()) {
        Some(root) => {
            let (exact, prefix) = scope_patterns(root);
            let mut stmt = conn.prepare(&format!(
                "SELECT {SELECT_COLUMNS} FROM files \
                 WHERE kind != 'folder'{kind_clause} AND (path = ?1 OR path LIKE ?2 ESCAPE '\\') \
                 ORDER BY mtime DESC LIMIT ?3"
            ))?;
            let rows = stmt.query_map(params![exact, prefix, limit as i64], row_to_hit)?;
            rows.collect()
        }
        None => {
            let mut stmt = conn.prepare(&format!(
                "SELECT {SELECT_COLUMNS} FROM files WHERE kind != 'folder'{kind_clause} \
                 ORDER BY mtime DESC LIMIT ?1"
            ))?;
            let rows = stmt.query_map(params![limit as i64], row_to_hit)?;
            rows.collect()
        }
    }
}

/* ------------------------------------------------------------ 内容索引 */

pub fn is_cjk(ch: char) -> bool {
    matches!(
        ch as u32,
        0x3040..=0x30FF      // 日文假名
        | 0x3400..=0x4DBF    // 扩展 A
        | 0x4E00..=0x9FFF    // 基本区
        | 0xF900..=0xFAFF    // 兼容区
        | 0xAC00..=0xD7AF    // 谚文
        | 0x20000..=0x2FA1F  // 扩展 B+
    )
}

/// 入库前把每个中日韩字符拆成单独 token（unicode61 不切分中文）。
/// “预算报告” → “预 算 报 告”，查询也用同样方式拼成短语，得到精确的子串匹配。
pub fn segment(text: &str) -> String {
    let mut out = String::with_capacity(text.len() * 2);
    let mut prev_space = true;
    for ch in text.chars() {
        if is_cjk(ch) {
            if !prev_space {
                out.push(' ');
            }
            out.push(ch);
            out.push(' ');
            prev_space = true;
        } else if ch.is_whitespace() {
            if !prev_space {
                out.push(' ');
                prev_space = true;
            }
        } else {
            out.push(ch);
            prev_space = false;
        }
    }
    out.trim().to_string()
}

/// 把用户输入拼成 FTS5 查询：每个词变成短语，词之间 AND
fn fts_query(query: &str) -> Option<String> {
    let terms: Vec<String> = query
        .split_whitespace()
        .filter(|term| !term.is_empty())
        .map(|term| format!("\"{}\"", segment(term).replace('"', " ")))
        .collect();
    if terms.is_empty() {
        None
    } else {
        Some(terms.join(" AND "))
    }
}

#[allow(dead_code)] // 测试与调试用；生产路径走 commit_body
pub fn put_body(conn: &mut Connection, path: &str, body: &str) -> SqlResult<()> {
    let tx = conn.transaction()?;
    tx.execute("DELETE FROM doc_fts WHERE path = ?1", params![path])?;
    tx.execute(
        "INSERT INTO doc_fts(body, path) VALUES(?1, ?2)",
        params![segment(body), path],
    )?;
    // 原文单独存一份：FTS 里是分段后的文本，片段展示必须回到原文
    tx.execute(
        "INSERT INTO doc_body(path, body) VALUES(?1, ?2)
         ON CONFLICT(path) DO UPDATE SET body = excluded.body",
        params![path, body],
    )?;
    tx.commit()
}

/// 正文提交结果：正常入库 / 提取期间文件已变（丢弃）/ 文件已不在索引
#[derive(Debug, PartialEq, Eq)]
pub enum BodyCommit {
    Stored,
    Stale,
    MissingFile,
}

/// 把正文、原文、提取状态放在**同一个事务**里提交，并在事务内核对文件版本。
/// 否则会出现：提取过程中文件被覆盖 → 监听器清掉旧记录 → 旧正文又被写回去。
pub fn commit_body(
    conn: &mut Connection,
    path: &str,
    expect_mtime: i64,
    expect_size: i64,
    body: &str,
    via_ocr: bool,
) -> SqlResult<BodyCommit> {
    let tx = conn.transaction()?;

    let current: Option<(i64, i64)> = tx
        .query_row(
            "SELECT mtime, size FROM files WHERE path = ?1",
            params![path],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;

    let outcome = match current {
        None => {
            tx.execute("DELETE FROM doc_text WHERE path = ?1", params![path])?;
            tx.execute("DELETE FROM doc_fts WHERE path = ?1", params![path])?;
            tx.execute("DELETE FROM doc_body WHERE path = ?1", params![path])?;
            BodyCommit::MissingFile
        }
        Some((mtime, size)) if mtime != expect_mtime || size != expect_size => {
            // 提取期间文件被覆盖/清空：这批正文已过期，直接丢弃并清掉旧记录
            tx.execute("DELETE FROM doc_text WHERE path = ?1", params![path])?;
            tx.execute("DELETE FROM doc_fts WHERE path = ?1", params![path])?;
            tx.execute("DELETE FROM doc_body WHERE path = ?1", params![path])?;
            BodyCommit::Stale
        }
        Some(_) => {
            let chars = body.chars().count() as i64;
            tx.execute("DELETE FROM doc_fts WHERE path = ?1", params![path])?;
            tx.execute(
                "INSERT INTO doc_fts(body, path) VALUES(?1, ?2)",
                params![segment(body), path],
            )?;
            tx.execute(
                "INSERT INTO doc_body(path, body) VALUES(?1, ?2)
                 ON CONFLICT(path) DO UPDATE SET body = excluded.body",
                params![path, body],
            )?;
            tx.execute(
                r#"
                INSERT INTO doc_text(path, state, mtime, size, chars, error, via_ocr)
                VALUES(?1, 'done', ?2, ?3, ?4, NULL, ?5)
                ON CONFLICT(path) DO UPDATE SET
                    state = 'done', mtime = excluded.mtime, size = excluded.size,
                    chars = excluded.chars, error = NULL, via_ocr = excluded.via_ocr
                "#,
                params![path, expect_mtime, expect_size, chars, if via_ocr { 1 } else { 0 }],
            )?;
            BodyCommit::Stored
        }
    };

    tx.commit()?;
    Ok(outcome)
}

pub fn mark_doc(
    conn: &Connection,
    path: &str,
    state: &str,
    mtime: i64,
    size: i64,
    chars: i64,
    error: Option<&str>,
) -> SqlResult<()> {
    conn.execute(
        r#"
        INSERT INTO doc_text(path, state, mtime, size, chars, error) VALUES(?1, ?2, ?3, ?4, ?5, ?6)
        ON CONFLICT(path) DO UPDATE SET
            state = excluded.state,
            mtime = excluded.mtime,
            size = excluded.size,
            chars = excluded.chars,
            error = excluded.error
        "#,
        params![path, state, mtime, size, chars, error],
    )?;
    Ok(())
}

/// 让某个文件的正文失效：删掉状态与 FTS 行，等 worker 重新提取。
/// 监听收到 Modify 时用它解决"同一秒内改两次 mtime 没变"的问题。
pub fn invalidate_docs(conn: &Connection, paths: &[String]) -> SqlResult<()> {
    if paths.is_empty() {
        return Ok(());
    }
    let tx = conn.unchecked_transaction()?;
    for path in paths {
        tx.execute("DELETE FROM doc_text WHERE path = ?1", params![path])?;
        tx.execute("DELETE FROM doc_fts WHERE path = ?1", params![path])?;
        tx.execute("DELETE FROM doc_body WHERE path = ?1", params![path])?;
    }
    tx.commit()
}

/// 待提取的正文：新文件、或修改时间变过的文件
pub fn pending_docs(
    conn: &Connection,
    exts: &[&str],
    max_size: i64,
    limit: usize,
) -> SqlResult<Vec<(String, i64, i64)>> {
    pending_docs_filtered(conn, exts, max_size, limit, &[])
}

/// 同 pending_docs，但跳过指定扩展名（例如让图片 OCR 排在文本之后）
pub fn pending_docs_filtered(
    conn: &Connection,
    exts: &[&str],
    max_size: i64,
    limit: usize,
    skip_exts: &[&str],
) -> SqlResult<Vec<(String, i64, i64)>> {
    if exts.is_empty() {
        return Ok(Vec::new());
    }
    let skip_clause = if skip_exts.is_empty() {
        String::new()
    } else {
        let skip_placeholders = std::iter::repeat("?")
            .take(skip_exts.len())
            .collect::<Vec<_>>()
            .join(", ");
        format!(" AND f.ext NOT IN ({skip_placeholders})")
    };
    let placeholders = std::iter::repeat("?")
        .take(exts.len())
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!(
        r#"
        SELECT f.path, f.mtime, f.size
        FROM files f
        LEFT JOIN doc_text d ON d.path = f.path
        WHERE f.kind != 'folder' AND f.size > 0 AND f.size <= ?
          AND (d.path IS NULL OR d.mtime != f.mtime OR d.size != f.size)
          AND f.ext IN ({placeholders}){skip_clause}
        ORDER BY f.mtime DESC
        LIMIT ?
        "#
    );

    let mut stmt = conn.prepare(&sql)?;
    let mut params_dyn: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
    params_dyn.push(Box::new(max_size));
    for ext in exts {
        params_dyn.push(Box::new(ext.to_string()));
    }
    for ext in skip_exts {
        params_dyn.push(Box::new(ext.to_string()));
    }
    params_dyn.push(Box::new(limit as i64));

    let rows = stmt.query_map(
        rusqlite::params_from_iter(params_dyn.iter().map(|value| value.as_ref())),
        |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
            ))
        },
    )?;

    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

pub fn doc_stats(conn: &Connection) -> SqlResult<(i64, i64, i64)> {
    let done: i64 = conn.query_row(
        "SELECT COUNT(*) FROM doc_text WHERE state = 'done'",
        [],
        |row| row.get(0),
    )?;
    let failed: i64 = conn.query_row(
        "SELECT COUNT(*) FROM doc_text WHERE state = 'failed'",
        [],
        |row| row.get(0),
    )?;
    let chars: i64 = conn.query_row(
        "SELECT COALESCE(SUM(chars), 0) FROM doc_text WHERE state = 'done'",
        [],
        |row| row.get(0),
    )?;
    Ok((done, failed, chars))
}

/// 清理已经被删掉的文件的正文记录
pub fn prune_docs(conn: &Connection) -> SqlResult<usize> {
    let removed_text = conn.execute(
        "DELETE FROM doc_text WHERE path NOT IN (SELECT path FROM files)",
        [],
    )?;
    conn.execute("DELETE FROM doc_fts WHERE path NOT IN (SELECT path FROM files)", [])?;
    conn.execute("DELETE FROM doc_body WHERE path NOT IN (SELECT path FROM files)", [])?;
    Ok(removed_text)
}

/// 待提取数量（给进度展示用）
pub fn pending_count(conn: &Connection, exts: &[&str], max_size: i64) -> SqlResult<i64> {
    if exts.is_empty() {
        return Ok(0);
    }
    let placeholders = std::iter::repeat("?")
        .take(exts.len())
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!(
        r#"
        SELECT COUNT(*)
        FROM files f
        LEFT JOIN doc_text d ON d.path = f.path
        WHERE f.kind != 'folder' AND f.size > 0 AND f.size <= ?
          AND (d.path IS NULL OR d.mtime != f.mtime OR d.size != f.size)
          AND f.ext IN ({placeholders})
        "#
    );
    let mut stmt = conn.prepare(&sql)?;
    let mut params_dyn: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
    params_dyn.push(Box::new(max_size));
    for ext in exts {
        params_dyn.push(Box::new(ext.to_string()));
    }
    stmt.query_row(
        rusqlite::params_from_iter(params_dyn.iter().map(|value| value.as_ref())),
        |row| row.get(0),
    )
}

/// 正文命中：带文件元信息与片段，供上层和文件名结果合并
pub fn content_hits(
    conn: &Connection,
    query: &str,
    scope: Option<&str>,
    limit: usize,
) -> SqlResult<Vec<FileHit>> {
    let Some(match_query) = fts_query(query) else {
        return Ok(Vec::new());
    };

    // 片段从原文（doc_body）里取，而不是从 FTS 的分段文本还原：
    // 分段会插入空格，靠删空格还原不可逆（"使用 Windows" 会变成 "使用Windows"）。
    let needle = query.split_whitespace().next().unwrap_or("").to_string();
    let snippet_expr = "CASE \
        WHEN b.body IS NULL THEN NULL \
        WHEN instr(lower(b.body), lower(?2)) > 0 THEN \
            '…' || substr(b.body, max(1, instr(lower(b.body), lower(?2)) - 40), 140) || '…' \
        ELSE substr(b.body, 1, 140) || '…' END";

    let head = format!(
        "SELECT f.path, f.name, f.name_lc, f.dir, f.ext, f.kind, f.size, f.mtime, f.depth, f.py, f.pyf, \
         {snippet_expr}, COALESCE(dt.via_ocr, 0) \
         FROM doc_fts JOIN files f ON f.path = doc_fts.path \
         JOIN doc_body b ON b.path = doc_fts.path \
         LEFT JOIN doc_text dt ON dt.path = doc_fts.path \
         WHERE doc_fts MATCH ?1"
    );

    let map_row = |row: &rusqlite::Row<'_>| -> SqlResult<FileHit> {
        let mut hit = row_to_hit(row)?;
        hit.snippet = row.get::<_, Option<String>>(11)?;
        if row.get::<_, i64>(12).unwrap_or(0) == 1 {
            hit.sources.push("ocr".to_string());
        }
        Ok(hit)
    };

    let mut out = Vec::new();
    match scope.filter(|root| !root.is_empty()) {
        Some(root) => {
            let (exact, prefix) = scope_patterns(root);
            let sql = format!(
                "{head} AND (f.path = ?3 OR f.path LIKE ?4 ESCAPE '\\') ORDER BY rank LIMIT ?5"
            );
            let mut stmt = conn.prepare(&sql)?;
            let mut rows = stmt.query(params![match_query, needle, exact, prefix, limit as i64])?;
            while let Some(row) = rows.next()? {
                out.push(map_row(row)?);
            }
        }
        None => {
            let sql = format!("{head} ORDER BY rank LIMIT ?3");
            let mut stmt = conn.prepare(&sql)?;
            let mut rows = stmt.query(params![match_query, needle, limit as i64])?;
            while let Some(row) = rows.next()? {
                out.push(map_row(row)?);
            }
        }
    }
    Ok(out)
}


/* ------------------------------------------------------------ 语义检索 */

/// 一段待嵌入的文本块
pub struct ChunkDraft {
    pub ord: i64,
    pub text: String,
}

/// 把正文切成约 400 字、重叠 80 字的块，尽量按段落边界切
pub fn chunk_text(body: &str, max_chars: usize, overlap: usize) -> Vec<ChunkDraft> {
    let chars: Vec<char> = body.chars().collect();
    let mut out = Vec::new();
    if chars.is_empty() {
        return out;
    }

    let mut start = 0usize;
    let mut ord = 0i64;
    while start < chars.len() {
        let mut end = (start + max_chars).min(chars.len());
        // 往回找一个段落/句号边界，避免把句子劈开
        if end < chars.len() {
            let floor = start + max_chars / 2;
            while end > floor {
                let ch = chars[end - 1];
                if ch == '\n' || ch == '。' || ch == '！' || ch == '？' || ch == '.' {
                    break;
                }
                end -= 1;
            }
        }
        let text: String = chars[start..end].iter().collect();
        let trimmed = text.trim();
        if trimmed.chars().count() >= 20 {
            out.push(ChunkDraft {
                ord,
                text: trimmed.to_string(),
            });
            ord += 1;
        }
        if end >= chars.len() {
            break;
        }
        start = end.saturating_sub(overlap).max(start + 1);
    }
    out
}

/// 还没有切块/嵌入的文档（正文已提取完成）
pub fn docs_without_chunks(conn: &Connection, limit: usize) -> SqlResult<Vec<(String, i64, i64)>> {
    let mut stmt = conn.prepare(
        r#"
        SELECT d.path, d.mtime, d.size
        FROM doc_text d
        LEFT JOIN chunk c ON c.path = d.path
        WHERE d.state = 'done' AND c.id IS NULL
        ORDER BY d.mtime DESC
        LIMIT ?1
        "#,
    )?;
    let rows = stmt.query_map(params![limit as i64], |row| {
        Ok((row.get(0)?, row.get(1)?, row.get(2)?))
    })?;
    rows.collect()
}

pub fn body_of(conn: &Connection, path: &str) -> SqlResult<Option<String>> {
    conn.query_row(
        "SELECT body FROM doc_body WHERE path = ?1",
        params![path],
        |row| row.get(0),
    )
    .optional()
}

/// 写入文本块，返回 (chunk_id, text)
pub fn insert_chunks(
    conn: &mut Connection,
    path: &str,
    chunks: &[ChunkDraft],
) -> SqlResult<Vec<(i64, String)>> {
    let tx = conn.transaction()?;
    let mut out = Vec::with_capacity(chunks.len());
    {
        let mut stmt = tx.prepare(
            "INSERT INTO chunk(path, ord, text) VALUES(?1, ?2, ?3)
             ON CONFLICT(path, ord) DO UPDATE SET text = excluded.text",
        )?;
        let mut id_stmt = tx.prepare("SELECT id FROM chunk WHERE path = ?1 AND ord = ?2")?;
        for chunk in chunks {
            stmt.execute(params![path, chunk.ord, chunk.text])?;
            let id: i64 = id_stmt.query_row(params![path, chunk.ord], |row| row.get(0))?;
            out.push((id, chunk.text.clone()));
        }
    }
    tx.commit()?;
    Ok(out)
}

/// 切块 + 向量一次性提交。任何一个环节失败都不留下半成品，
/// 文档会因为"没有切片"重新进入待处理队列。
pub fn insert_chunks_with_vectors(
    conn: &mut Connection,
    path: &str,
    chunks: &[ChunkDraft],
    vectors: &[Vec<f32>],
) -> SqlResult<()> {
    if chunks.len() != vectors.len() {
        return Err(rusqlite::Error::InvalidParameterName(
            "chunks/vectors 数量不一致".to_string(),
        ));
    }

    let tx = conn.transaction()?;
    tx.execute("DELETE FROM chunk WHERE path = ?1", params![path])?;
    {
        let mut insert = tx.prepare(
            "INSERT INTO chunk(path, ord, text) VALUES(?1, ?2, ?3)
             ON CONFLICT(path, ord) DO UPDATE SET text = excluded.text",
        )?;
        let mut id_stmt = tx.prepare("SELECT id FROM chunk WHERE path = ?1 AND ord = ?2")?;
        let mut vec_stmt = tx.prepare(
            "INSERT INTO chunk_vec(chunk_id, dim, vec) VALUES(?1, ?2, ?3)
             ON CONFLICT(chunk_id) DO UPDATE SET dim = excluded.dim, vec = excluded.vec",
        )?;

        for (chunk, vector) in chunks.iter().zip(vectors.iter()) {
            insert.execute(params![path, chunk.ord, chunk.text])?;
            let id: i64 = id_stmt.query_row(params![path, chunk.ord], |row| row.get(0))?;
            let mut bytes = Vec::with_capacity(vector.len() * 4);
            for value in vector {
                bytes.extend_from_slice(&value.to_le_bytes());
            }
            vec_stmt.execute(params![id, vector.len() as i64, bytes])?;
        }
    }
    tx.commit()
}

#[allow(dead_code)] // 生产路径用 insert_chunks_with_vectors（事务内一并提交）
pub fn store_vectors(conn: &mut Connection, vectors: &[(i64, Vec<f32>)]) -> SqlResult<()> {
    let tx = conn.transaction()?;
    {
        let mut stmt = tx.prepare(
            "INSERT INTO chunk_vec(chunk_id, dim, vec) VALUES(?1, ?2, ?3)
             ON CONFLICT(chunk_id) DO UPDATE SET dim = excluded.dim, vec = excluded.vec",
        )?;
        for (id, vec) in vectors {
            let mut bytes = Vec::with_capacity(vec.len() * 4);
            for value in vec {
                bytes.extend_from_slice(&value.to_le_bytes());
            }
            stmt.execute(params![id, vec.len() as i64, bytes])?;
        }
    }
    tx.commit()
}

pub fn chunk_count(conn: &Connection) -> i64 {
    conn.query_row("SELECT COUNT(*) FROM chunk", [], |row| row.get(0))
        .unwrap_or(0)
}

pub fn vector_count(conn: &Connection) -> i64 {
    conn.query_row("SELECT COUNT(*) FROM chunk_vec", [], |row| row.get(0))
        .unwrap_or(0)
}

/// 把整个向量表读进内存（调用方缓存，见 semantic.rs）
pub fn load_vectors(conn: &Connection) -> SqlResult<Vec<(i64, String, String, Vec<f32>)>> {
    let mut stmt = conn.prepare(
        "SELECT v.chunk_id, c.path, c.text, v.dim, v.vec
         FROM chunk_vec v JOIN chunk c ON c.id = v.chunk_id",
    )?;
    let rows = stmt.query_map([], |row| {
        let dim: i64 = row.get(3)?;
        let bytes: Vec<u8> = row.get(4)?;
        let mut vec = Vec::with_capacity(dim as usize);
        for index in 0..dim as usize {
            let from = index * 4;
            if from + 4 > bytes.len() {
                break;
            }
            let mut buf = [0u8; 4];
            buf.copy_from_slice(&bytes[from..from + 4]);
            vec.push(f32::from_le_bytes(buf));
        }
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            vec,
        ))
    })?;
    rows.collect()
}

/// 用户可见分类 -> SQL 条件（doc 同时包含 pdf）
fn kind_group_sql(group: &str) -> Option<&'static str> {
    match group {
        "doc" => Some("kind IN ('doc', 'pdf')"),
        "image" => Some("kind = 'image'"),
        "code" => Some("kind = 'code'"),
        "folder" => Some("kind = 'folder'"),
        "other" => Some("kind NOT IN ('doc', 'pdf', 'image', 'code', 'folder')"),
        _ => None,
    }
}

/// 与 SQL 条件等价的 Rust 判定，用于正文/语义结果的内存过滤
pub fn kind_in_group(kind: &str, group: &str) -> bool {
    match group {
        "doc" => kind == "doc" || kind == "pdf",
        "image" => kind == "image",
        "code" => kind == "code",
        "folder" => kind == "folder",
        "other" => !matches!(kind, "doc" | "pdf" | "image" | "code" | "folder"),
        _ => true,
    }
}

/// 结果排序方式
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SortMode {
    Relevance,
    Recent,
    Name,
    Size,
}

impl SortMode {
    pub fn parse(value: &str) -> Self {
        match value {
            "recent" => SortMode::Recent,
            "name" => SortMode::Name,
            "size" => SortMode::Size,
            _ => SortMode::Relevance,
        }
    }
}

/// 路径是否落在某个扫描根之内（语义检索结果是裸路径，需要自己过滤）
pub fn path_in_scope(path: &str, scope: Option<&str>) -> bool {
    let Some(root) = scope.map(str::trim).filter(|root| !root.is_empty()) else {
        return true;
    };
    // 这里不能用 scope_patterns：那是给 LIKE 用的转义串（含 `\\%`）
    let root_lc = root.trim_end_matches(['\\', '/']).to_ascii_lowercase();
    let path_lc = path.to_ascii_lowercase();
    if path_lc == root_lc {
        return true;
    }
    path_lc.starts_with(&format!("{root_lc}\\")) || path_lc.starts_with(&format!("{root_lc}/"))
}

/// 按路径取单条文件元信息（语义命中需要补文件名/大小等）
pub fn hit_by_path(conn: &Connection, path: &str) -> SqlResult<Option<FileHit>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {SELECT_COLUMNS} FROM files WHERE path = ?1"
    ))?;
    let mut rows = stmt.query(params![path])?;
    match rows.next()? {
        Some(row) => Ok(Some(row_to_hit(row)?)),
        None => Ok(None),
    }
}

pub fn clear_semantic(conn: &Connection) -> SqlResult<()> {
    conn.execute_batch("DELETE FROM chunk_vec; DELETE FROM chunk;")?;
    Ok(())
}

/// 清理已被删除文件的文本块
pub fn prune_semantic(conn: &Connection) -> SqlResult<usize> {
    let removed = conn.execute("DELETE FROM chunk WHERE path NOT IN (SELECT path FROM files)", [])?;
    conn.execute(
        "DELETE FROM chunk_vec WHERE chunk_id NOT IN (SELECT id FROM chunk)",
        [],
    )?;
    Ok(removed)
}
#[cfg(test)]
mod fts_tests {
    use super::*;

    fn memory() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        init(&conn).unwrap();
        conn
    }

    #[test]
    fn fts5_is_available() {
        let conn = memory();
        conn.execute(
            "INSERT INTO doc_fts(body, path) VALUES('hello world', 'a')",
            [],
        )
        .unwrap();
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM doc_fts WHERE doc_fts MATCH '\"hello\"'", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn chinese_segments_and_matches_phrase() {
        let mut conn = memory();
        seed(&mut conn, "C:\\Docs\\p1.docx", "p1.docx", "C:\\Docs");
        put_body(&mut conn, "C:\\Docs\\p1.docx", "本季度预算报告已提交").unwrap();

        let hits = content_hits(&conn, "预算", None, 5).unwrap();
        assert_eq!(hits.len(), 1, "中文双字应命中");
        let snippet = hits[0].snippet.clone().unwrap_or_default();
        assert!(snippet.contains("预算"), "片段应保留原文连续文本: {snippet}");
    }

    #[test]
    fn snippet_keeps_latin_spacing() {
        let mut conn = memory();
        seed(&mut conn, "C:\\Docs\\p2.docx", "p2.docx", "C:\\Docs");
        put_body(&mut conn, "C:\\Docs\\p2.docx", "系统托盘使用 Windows 原生材质。").unwrap();

        let hits = content_hits(&conn, "托盘", None, 5).unwrap();
        let snippet = hits[0].snippet.clone().unwrap_or_default();
        assert!(
            snippet.contains("使用 Windows 原生材质"),
            "中英文之间的空格必须保留: {snippet}"
        );
    }

    #[test]
    fn ocr_text_is_marked() {
        let mut conn = memory();
        seed(&mut conn, "C:\\Docs\\shot.png", "shot.png", "C:\\Docs");
        commit_body(&mut conn, "C:\\Docs\\shot.png", 1_700_000_000, 10, "扫描件里的报价单", true).unwrap();

        let hits = content_hits(&conn, "报价单", None, 5).unwrap();
        assert_eq!(hits.len(), 1);
        assert!(
            hits[0].sources.iter().any(|source| source == "ocr"),
            "OCR 正文要带标记: {:?}",
            hits[0].sources
        );

        // 普通正文不该被标成 OCR
        seed(&mut conn, "C:\\Docs\\note.txt", "note.txt", "C:\\Docs");
        commit_body(&mut conn, "C:\\Docs\\note.txt", 1_700_000_000, 10, "普通正文里的报价单", false).unwrap();
        let plain = content_hits(&conn, "普通正文", None, 5).unwrap();
        assert!(plain[0].sources.is_empty(), "普通正文不应带 ocr");
    }

    fn seed(conn: &mut Connection, path: &str, name: &str, dir: &str) {
        let entry = NewEntry {
            path,
            name,
            dir,
            ext: "txt",
            kind: "doc",
            size: 10,
            mtime: 1_700_000_000,
            depth: 1,
        };
        upsert_batch(conn, &[entry], 1).unwrap();
    }

    #[test]
    fn exact_name_survives_recent_candidate_limit() {
        let mut conn = memory();
        seed(&mut conn, "D:\\Work\\budget.txt", "budget.txt", "D:\\Work");
        seed(&mut conn, "D:\\Workbench\\budget.txt", "budget.txt", "D:\\Workbench");
        conn.execute_batch(
            r"WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 805)
             INSERT INTO files(path, name, name_lc, dir, ext, kind, size, mtime, depth, py, pyf, gen)
             SELECT 'D:\Work\draft-' || x, 'draft-budget.txt', 'draft-budget.txt',
                 'D:\Work', 'txt', 'doc', 10, 1800000000, 1, '', '', 1 FROM n;",
        ).unwrap();

        let hits = search_with(&conn, "BUDGET.TXT", Some("D:\\Work"), 2, Some("doc"), SortMode::Relevance).unwrap();
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].path, "D:\\Work\\budget.txt");
        assert_eq!(hits[1].name, "draft-budget.txt");
    }

    #[test]
    fn scope_respects_directory_boundary() {
        let mut conn = memory();
        seed(&mut conn, "D:\\Work\\a.txt", "a.txt", "D:\\Work");
        seed(&mut conn, "D:\\Work\\sub\\c.txt", "c.txt", "D:\\Work\\sub");
        seed(&mut conn, "D:\\Workbench\\b.txt", "b.txt", "D:\\Workbench");

        let hits = search(&conn, "txt", Some("D:\\Work"), 10).unwrap();
        let names: Vec<&str> = hits.iter().map(|hit| hit.name.as_str()).collect();
        assert!(names.contains(&"a.txt"), "目录本身要命中: {names:?}");
        assert!(names.contains(&"c.txt"), "子目录要命中: {names:?}");
        assert!(
            !names.contains(&"b.txt"),
            "D:\\Workbench 不能被 D:\\Work 命中: {names:?}"
        );

        let recent = super::recent(&conn, Some("D:\\Work"), 10).unwrap();
        let recent_names: Vec<&str> = recent.iter().map(|hit| hit.name.as_str()).collect();
        assert!(!recent_names.contains(&"b.txt"), "recent 也要守边界: {recent_names:?}");
    }

    #[test]
    fn scope_pattern_handles_trailing_separator() {
        let (exact, prefix) = scope_patterns("D:\\Work\\");
        assert_eq!(exact, "D:\\Work");
        assert_eq!(prefix, "D:\\\\Work\\\\%");
    }

    #[test]
    fn multi_term_phrase_ranks_first() {
        let mut conn = memory();
        // 两个文件都包含全部词，但只有一个把词连在一起
        seed(&mut conn, "C:\\Docs\\季度预算报告.docx", "季度预算报告.docx", "C:\\Docs");
        seed(&mut conn, "C:\\Docs\\预算与季度计划.txt", "预算与季度计划.txt", "C:\\Docs");

        let hits = search(&conn, "季度 预算", Some("C:\\Docs"), 5).unwrap();
        assert_eq!(hits.len(), 2, "两个文件都命中全部词，都应保留");
        assert_eq!(hits[0].name, "季度预算报告.docx", "连续短语应排第一");
    }

    #[test]
    fn scope_filter_uses_directory_boundary() {
        assert!(path_in_scope("C:\\A\\b.txt", Some("C:\\A")));
        assert!(path_in_scope("C:\\A\\sub\\b.txt", Some("C:\\A\\")));
        assert!(!path_in_scope("C:\\AB\\b.txt", Some("C:\\A")));
        assert!(!path_in_scope("C:\\Other\\b.txt", Some("C:\\A")));
        assert!(path_in_scope("C:\\Other\\b.txt", None));
        assert!(path_in_scope("c:\\a\\b.txt", Some("C:\\A")));
    }

    #[test]
    fn commit_body_rejects_stale_version() {
        let mut conn = memory();
        seed(&mut conn, "C:\\Docs\\a.txt", "a.txt", "C:\\Docs");

        // 提取期间文件被改了（大小不同）：正文必须丢弃
        let stale = commit_body(&mut conn, "C:\\Docs\\a.txt", 1_700_000_000, 22, "过期正文", false).unwrap();
        assert_eq!(stale, BodyCommit::Stale);
        assert!(content_hits(&conn, "过期正文", None, 5).unwrap().is_empty());
        assert!(pending_docs(&conn, &["txt"], 1024, 10).unwrap().len() == 1, "应重新排队");

        // 版本一致：正常入库
        let stored = commit_body(&mut conn, "C:\\Docs\\a.txt", 1_700_000_000, 10, "有效正文", false).unwrap();
        assert_eq!(stored, BodyCommit::Stored);
        assert_eq!(content_hits(&conn, "有效正文", None, 5).unwrap().len(), 1);
        assert!(pending_docs(&conn, &["txt"], 1024, 10).unwrap().is_empty());
    }

    #[test]
    fn pending_docs_picks_up_size_change() {
        let mut conn = memory();
        seed(&mut conn, "C:\\Docs\\a.txt", "a.txt", "C:\\Docs");
        let exts = ["txt"];
        assert_eq!(pending_docs(&conn, &exts, 1024, 10).unwrap().len(), 1);

        mark_doc(&conn, "C:\\Docs\\a.txt", "done", 1_700_000_000, 10, 5, None).unwrap();
        assert_eq!(pending_docs(&conn, &exts, 1024, 10).unwrap().len(), 0);

        // 同秒覆盖、大小变了：仍要重抽
        conn.execute(
            "UPDATE files SET size = 22 WHERE path = 'C:\\Docs\\a.txt'",
            [],
        )
        .unwrap();
        assert_eq!(pending_docs(&conn, &exts, 1024, 10).unwrap().len(), 1);
    }
}
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pinyin_fields_split_full_and_initials() {
        let (full, initials) = pinyin_fields("财务预算报告.docx");
        assert_eq!(initials, "cwysbgdocx");
        assert!(full.starts_with("caiwuyusuanbaogao"));
    }

    #[test]
    fn ascii_names_keep_characters() {
        let (full, initials) = pinyin_fields("AURA-Search.md");
        assert_eq!(full, "aurasearchmd");
        assert_eq!(initials, "aurasearchmd");
    }

    #[test]
    fn classify_common_extensions() {
        assert_eq!(classify("pdf", false), "pdf");
        assert_eq!(classify("docx", false), "doc");
        assert_eq!(classify("", true), "folder");
        assert_eq!(classify("rs", false), "code");
    }
}
