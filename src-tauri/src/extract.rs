//! 正文抽取：把文件里的文字挖出来，交给 FTS5。
//!
//! 覆盖顺序按产品方案的优先级：
//! TXT/Markdown/代码 → DOCX/PPTX/XLSX → PDF。
//! 扫描件 OCR 留给后续模块，这里遇到取不到文字的 PDF 会标记为 failed 并保留原因。

use std::fs;
use std::io::Read;
use std::path::Path;

use encoding_rs::GBK;
use quick_xml::events::Event;
use quick_xml::Reader;

/// 单个文件最多读这么多字节（防止误读巨型日志/二进制）
pub const MAX_INPUT_BYTES: u64 = 16 * 1024 * 1024;
/// 单个文件最多保留这么多字符
pub const MAX_CHARS: usize = 200_000;
/// 单个 zip 条目解压上限（防 zip bomb：几 KB 的 docx 可以声明几 GB 的内容）
const MAX_ENTRY_BYTES: u64 = 64 * 1024 * 1024;
/// 一次 Office 抽取允许读的条目总预算
const MAX_TOTAL_BYTES: u64 = 128 * 1024 * 1024;
/// PPTX 最多读这么多页
const MAX_SLIDES: usize = 500;

const TEXT_EXTS: &[&str] = &[
    "txt", "md", "markdown", "json", "csv", "tsv", "log", "xml", "html", "htm", "rs", "ts", "tsx",
    "js", "jsx", "py", "go", "java", "c", "cpp", "h", "hpp", "cs", "rb", "php", "sh", "ps1",
    "sql", "yaml", "yml", "toml", "ini", "conf", "css", "scss", "less",
];

const OFFICE_EXTS: &[&str] = &["docx", "pptx", "xlsx"];

#[allow(dead_code)]
pub fn supports(ext: &str) -> bool {
    TEXT_EXTS.contains(&ext) || OFFICE_EXTS.contains(&ext) || ext == "pdf"
}

/// 需要正文索引的扩展名列表（给 SQL 的 IN 用）
pub fn supported_extensions() -> Vec<&'static str> {
    let mut all: Vec<&'static str> = Vec::new();
    all.extend_from_slice(TEXT_EXTS);
    all.extend_from_slice(OFFICE_EXTS);
    all.push("pdf");
    all
}

/// 纯文本类扩展名（预览可直接分页读取）
pub fn is_plain_text(ext: &str) -> bool {
    TEXT_EXTS.contains(&ext)
}

/// 预览用：按字节上限读取纯文本（不做 MAX_CHARS 截断，便于分页）
pub fn read_text_capped(path: &Path, max_bytes: u64) -> Result<String, String> {
    let bytes = fs::read(path).map_err(|err| format!("读取失败：{err}"))?;
    let slice = if (bytes.len() as u64) > max_bytes {
        &bytes[..max_bytes as usize]
    } else {
        &bytes[..]
    };
    let bytes = slice.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(slice);
    match std::str::from_utf8(bytes) {
        Ok(text) => Ok(text.to_string()),
        // 截断可能切在多字节字符中间，这里用 lossy 而不是整体回退到 GBK
        Err(_) => {
            let lossy = String::from_utf8_lossy(bytes);
            if lossy.chars().filter(|ch| *ch == '\u{FFFD}').count() > 32 {
                Ok(decode(bytes))
            } else {
                Ok(lossy.into_owned())
            }
        }
    }
}

pub fn extract(path: &Path, ext: &str) -> Result<String, String> {
    let text = match ext {
        "docx" => office_text(path, "word/document.xml", b"w:t", b"w:p")?,
        "pptx" => pptx_text(path)?,
        "xlsx" => office_text(path, "xl/sharedStrings.xml", b"t", b"si")?,
        "pdf" => pdf_text(path)?,
        "html" | "htm" => html_text(path)?,
        _ => plain_text(path)?,
    };

    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err("没有可索引的文字".to_string());
    }

    let mut out: String = trimmed.chars().take(MAX_CHARS).collect();
    if trimmed.chars().count() > MAX_CHARS {
        out.push('…');
    }
    Ok(out)
}

/* ------------------------------------------------------------------ 纯文本 */

fn decode(bytes: &[u8]) -> String {
    let bytes = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes);
    match std::str::from_utf8(bytes) {
        Ok(text) => text.to_string(),
        // 中文环境里 GBK 的 txt/csv 很常见，UTF-8 失败就按 GBK 解
        Err(_) => {
            let (text, _, _) = GBK.decode(bytes);
            text.into_owned()
        }
    }
}

fn plain_text(path: &Path) -> Result<String, String> {
    let meta = fs::metadata(path).map_err(|err| format!("读取失败：{err}"))?;
    if meta.len() > MAX_INPUT_BYTES {
        return Err(format!("文件过大（{} MB）", meta.len() / 1024 / 1024));
    }
    let file = fs::File::open(path).map_err(|err| format!("打开失败：{err}"))?;
    let mut bytes = Vec::new();
    file.take(MAX_INPUT_BYTES)
        .read_to_end(&mut bytes)
        .map_err(|err| format!("读取失败：{err}"))?;
    Ok(decode(&bytes))
}

fn html_text(path: &Path) -> Result<String, String> {
    let raw = plain_text(path)?;
    Ok(strip_markup(&raw))
}

/// 极简标签剥离：够用于 html/xml，不想为此引入完整解析器
fn strip_markup(input: &str) -> String {
    let mut out = String::with_capacity(input.len() / 2);
    let mut inside = false;
    for ch in input.chars() {
        match ch {
            '<' => inside = true,
            '>' => {
                inside = false;
                out.push(' ');
            }
            _ if !inside => out.push(ch),
            _ => {}
        }
    }
    out
}

/* ------------------------------------------------------------------- Office */

fn read_zip_entry(path: &Path, name: &str) -> Result<Vec<u8>, String> {
    let file = fs::File::open(path).map_err(|err| format!("打开失败：{err}"))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|err| format!("不是有效的 Office 文件：{err}"))?;
    let entry = archive
        .by_name(name)
        .map_err(|_| format!("缺少 {name}（可能是旧版 .doc/.xls）"))?;

    // 声明的解压体积先挡一道，避免为畸形文件分配巨量内存
    let declared = entry.size();
    if declared > MAX_ENTRY_BYTES {
        return Err(format!(
            "{name} 解压后 {} MB，超过 {} MB 上限",
            declared / 1024 / 1024,
            MAX_ENTRY_BYTES / 1024 / 1024
        ));
    }

    let mut buffer = Vec::new();
    entry
        .take(MAX_ENTRY_BYTES)
        .read_to_end(&mut buffer)
        .map_err(|err| format!("解压失败：{err}"))?;
    Ok(buffer)
}

fn office_text(path: &Path, entry: &str, text_tag: &[u8], break_tag: &[u8]) -> Result<String, String> {
    let xml = read_zip_entry(path, entry)?;
    Ok(xml_to_text(&xml, text_tag, break_tag))
}

fn pptx_text(path: &Path) -> Result<String, String> {
    let file = fs::File::open(path).map_err(|err| format!("打开失败：{err}"))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|err| format!("不是有效的 Office 文件：{err}"))?;

    let mut slides: Vec<String> = (0..archive.len())
        .filter_map(|index| {
            let name = archive.by_index(index).ok()?.name().to_string();
            if name.starts_with("ppt/slides/slide") && name.ends_with(".xml") {
                Some(name)
            } else {
                None
            }
        })
        .collect();
    slides.sort();
    slides.truncate(MAX_SLIDES);

    let mut out = String::new();
    let mut budget = MAX_TOTAL_BYTES;
    for name in slides {
        if budget == 0 {
            break;
        }
        if let Ok(entry) = archive.by_name(&name) {
            let declared = entry.size().min(budget);
            let mut buffer = Vec::new();
            if entry.take(declared).read_to_end(&mut buffer).is_ok() {
                budget = budget.saturating_sub(buffer.len() as u64);
                out.push_str(&xml_to_text(&buffer, b"a:t", b"a:p"));
                out.push('\n');
            }
        }
    }
    Ok(out)
}

/// 从 WordprocessingML 之类的 XML 里抽文本
fn xml_to_text(xml: &[u8], text_tag: &[u8], break_tag: &[u8]) -> String {
    let mut reader = Reader::from_reader(xml);
    reader.config_mut().trim_text(false);
    let mut buffer = Vec::new();
    let mut out = String::new();
    let mut in_text = false;

    loop {
        match reader.read_event_into(&mut buffer) {
            Ok(Event::Start(event)) => {
                if event.name().as_ref() == text_tag {
                    in_text = true;
                }
            }
            Ok(Event::End(event)) => {
                let name = event.name();
                if name.as_ref() == text_tag {
                    in_text = false;
                } else if name.as_ref() == break_tag {
                    out.push('\n');
                }
            }
            Ok(Event::Text(text)) if in_text => {
                if let Ok(value) = text.unescape() {
                    out.push_str(&value);
                }
            }
            Ok(Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
        buffer.clear();
    }

    out
}

/* ---------------------------------------------------------------------- PDF */

fn pdf_text(path: &Path) -> Result<String, String> {
    pdf_extract::extract_text(path).map_err(|err| format!("PDF 解析失败：{err}"))
}
