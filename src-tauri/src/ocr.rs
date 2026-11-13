//! Windows 自带 OCR（Windows.Media.Ocr）：不引入模型，也不增加安装包体积。
//!
//! 两个入口：
//! - `image_text()`：直接识别图片（截图、照片、扫描页导出图）
//! - `pdf_text()`：把 PDF 页面渲染成位图后逐页识别（扫描件 PDF 的主要场景）
//!
//! 全部同步阻塞调用，调用方应放在后台线程里。

use std::path::Path;
use std::sync::Once;

use windows::core::HSTRING;
use windows::Graphics::Imaging::{BitmapDecoder, BitmapPixelFormat, SoftwareBitmap};
use windows::Media::Ocr::OcrEngine;
use windows::Storage::StorageFile;
use windows::Storage::Streams::{InMemoryRandomAccessStream, RandomAccessStreamReference};

/// 单张图最多识别的页数，避免一本扫描书把索引拖死
pub const MAX_PDF_PAGES: u32 = 12;
/// 渲染宽度（像素）：太大慢，太小认不出行
const PDF_RENDER_WIDTH: i32 = 1600;

static INIT: Once = Once::new();

fn ensure_init() {
    INIT.call_once(|| {
        // OCR / PDF 都走 WinRT，MTA 足够；失败也不致命（后续调用会自己报错）
        unsafe {
            windows_sys::Win32::System::Com::CoInitializeEx(
                std::ptr::null(),
                windows_sys::Win32::System::Com::COINIT_MULTITHREADED as u32,
            );
        }
    });
}

pub fn ocr_available() -> bool {
    ensure_init();
    OcrEngine::TryCreateFromUserProfileLanguages().is_ok()
}

fn engine() -> Result<OcrEngine, String> {
    ensure_init();
    OcrEngine::TryCreateFromUserProfileLanguages()
        .map_err(|err| format!("系统 OCR 不可用（可能未安装语言包）：{err}"))
}

/// Windows OCR 会在中文字之间插空格；这里把「汉字 汉字」之间的空格去掉，
/// 英文单词之间的空格保留（否则 "AURA Search" 会粘成一坨）。
fn tidy_ocr(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    for (index, ch) in chars.iter().enumerate() {
        if *ch == ' ' {
            let prev = index.checked_sub(1).and_then(|i| chars.get(i)).copied();
            let next = chars.get(index + 1).copied();
            // 只在「汉字 空格 汉字」时去掉空格，数字/英文周围的空格保留
            let prev_cjk = prev.map(is_cjk).unwrap_or(false);
            let next_cjk = next.map(is_cjk).unwrap_or(false);
            if prev_cjk && next_cjk {
                continue;
            }
        }
        out.push(*ch);
    }
    out
}

fn is_cjk(ch: char) -> bool {
    matches!(ch as u32,
        0x3000..=0x303F | 0x3400..=0x4DBF | 0x4E00..=0x9FFF | 0xFF00..=0xFFEF)
}

fn recognize(bitmap: &SoftwareBitmap) -> Result<String, String> {
    let engine = engine()?;
    let result = engine
        .RecognizeAsync(bitmap)
        .map_err(|err| format!("OCR 调用失败：{err}"))?
        .get()
        .map_err(|err| format!("OCR 执行失败：{err}"))?;
    let text = result.Text().map_err(|err| err.to_string())?;
    Ok(tidy_ocr(&text.to_string()))
}

/// 识别单张图片
pub fn image_text(path: &Path) -> Result<String, String> {
    let file = StorageFile::GetFileFromPathAsync(&HSTRING::from(path.to_string_lossy().as_ref()))
        .map_err(|err| format!("打开图片失败：{err}"))?
        .get()
        .map_err(|err| format!("打开图片失败：{err}"))?;

    let stream = file
        .OpenReadAsync()
        .map_err(|err| format!("读取图片失败：{err}"))?
        .get()
        .map_err(|err| format!("读取图片失败：{err}"))?;

    let decoder = BitmapDecoder::CreateAsync(&stream)
        .map_err(|err| format!("解码图片失败：{err}"))?
        .get()
        .map_err(|err| format!("解码图片失败：{err}"))?;

    let bitmap = decoder
        .GetSoftwareBitmapAsync()
        .map_err(|err| format!("读取像素失败：{err}"))?
        .get()
        .map_err(|err| format!("读取像素失败：{err}"))?;

    // OCR 只接受 Bgra8 / Gray8 等少数格式
    let bitmap = SoftwareBitmap::Convert(&bitmap, BitmapPixelFormat::Bgra8)
        .unwrap_or(bitmap);

    recognize(&bitmap)
}

/// 识别 PDF（逐页渲染后 OCR），最多 `max_pages` 页
pub fn pdf_text(path: &Path, max_pages: u32) -> Result<String, String> {
    ensure_init();

    let file = StorageFile::GetFileFromPathAsync(&HSTRING::from(path.to_string_lossy().as_ref()))
        .map_err(|err| format!("打开 PDF 失败：{err}"))?
        .get()
        .map_err(|err| format!("打开 PDF 失败：{err}"))?;

    let document = windows::Data::Pdf::PdfDocument::LoadFromFileAsync(&file)
        .map_err(|err| format!("解析 PDF 失败：{err}"))?
        .get()
        .map_err(|err| format!("解析 PDF 失败：{err}"))?;

    let page_count = document
        .PageCount()
        .map_err(|err| format!("读取页数失败：{err}"))?
        .min(max_pages);

    let mut out = String::new();
    for index in 0..page_count {
        let page = match document.GetPage(index) {
            Ok(page) => page,
            Err(err) => {
                crate::aura_log!("PDF 第 {} 页打开失败：{err}", index + 1);
                continue;
            }
        };

        let stream = InMemoryRandomAccessStream::new().map_err(|err| err.to_string())?;
        let options = windows::Data::Pdf::PdfPageRenderOptions::new().map_err(|err| err.to_string())?;
        let size = page.Size().map_err(|err| err.to_string())?;
        if size.Width > 0.0 {
            let scale = PDF_RENDER_WIDTH as f32 / size.Width;
            let _ = options.SetDestinationWidth((size.Width * scale) as u32);
        }

        if let Err(err) = page
            .RenderWithOptionsToStreamAsync(&stream, &options)
            .and_then(|action| action.get())
        {
            crate::aura_log!("PDF 第 {} 页渲染失败：{err}", index + 1);
            continue;
        }

        let _ = stream.Seek(0);
        let decoder = match BitmapDecoder::CreateAsync(&stream).and_then(|op| op.get()) {
            Ok(decoder) => decoder,
            Err(err) => {
                crate::aura_log!("PDF 第 {} 页解码失败：{err}", index + 1);
                continue;
            }
        };

        let bitmap = match decoder.GetSoftwareBitmapAsync().and_then(|op| op.get()) {
            Ok(bitmap) => bitmap,
            Err(err) => {
                crate::aura_log!("PDF 第 {} 页取像素失败：{err}", index + 1);
                continue;
            }
        };
        let bitmap = SoftwareBitmap::Convert(&bitmap, BitmapPixelFormat::Bgra8).unwrap_or(bitmap);

        match recognize(&bitmap) {
            Ok(text) if !text.trim().is_empty() => {
                out.push_str(&text);
                out.push('\n');
            }
            Ok(_) => {}
            Err(err) => crate::aura_log!("PDF 第 {} 页 OCR 失败：{err}", index + 1),
        }
    }

    Ok(out)
}

/// 开启 OCR 时纳入正文索引的图片类型
pub const IMAGE_EXTS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "bmp", "heic"];

/// 这些扩展名可以直接 OCR
pub fn supports_image(ext: &str) -> bool {
    matches!(ext, "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "heic")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tidy_removes_spaces_between_cjk_only() {
        assert_eq!(tidy_ocr("季 度 预 算"), "季度预算");
        assert_eq!(tidy_ocr("AURA Search OCR"), "AURA Search OCR");
        assert_eq!(tidy_ocr("预算 2026 报告"), "预算 2026 报告");
    }
}
