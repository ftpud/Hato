use base64::Engine;
use gpui_kit::{ClipboardEntry, ClipboardItem, Image, ImageFormat};
use serde_json::{json, Value};
use std::{io::Read, path::Path, sync::Arc};

/// Native ceilings. Modules choose limits at or below these (`maxFiles`, `maxBytes` on the node).
const MAX_BYTES: usize = 20 * 1024 * 1024;
const MAX_FILES: usize = 16;
const DEFAULT_BYTES: usize = 5 * 1024 * 1024;

#[derive(Clone, Copy, Debug)]
pub struct Limits { pub max_files: usize, pub max_bytes: usize }

impl Limits {
    pub fn from_node(n: &Value) -> Self {
        Limits {
            max_files: n["maxFiles"].as_u64().map(|v| (v as usize).clamp(1, MAX_FILES)).unwrap_or(4),
            max_bytes: n["maxBytes"].as_u64().map(|v| (v as usize).clamp(1024, MAX_BYTES)).unwrap_or(DEFAULT_BYTES),
        }
    }
}

impl Default for Limits {
    fn default() -> Self { Limits { max_files: 4, max_bytes: DEFAULT_BYTES } }
}

fn mb(bytes: usize) -> String { format!("{:.0} MB", bytes as f64 / 1048576.0) }

fn format(bytes: &[u8]) -> Option<(ImageFormat, &'static str)> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") { Some((ImageFormat::Png, "image/png")) }
    else if bytes.starts_with(b"\xff\xd8\xff") { Some((ImageFormat::Jpeg, "image/jpeg")) }
    else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") { Some((ImageFormat::Gif, "image/gif")) }
    else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") { Some((ImageFormat::Webp, "image/webp")) }
    else { None }
}

fn attachment(name: &str, bytes: &[u8], limits: Limits) -> Result<Value, String> {
    if bytes.len() > limits.max_bytes { return Err(format!("Pictures must be under {} each.", mb(limits.max_bytes))); }
    let (_, mime) = format(bytes).ok_or("Use PNG, JPEG, WebP or GIF pictures.")?;
    Ok(json!({"name": name, "mimeType": mime, "data": base64::engine::general_purpose::STANDARD.encode(bytes)}))
}

pub fn files(paths: &[impl AsRef<Path>], limits: Limits) -> Value {
    let result = (|| -> Result<Vec<Value>, String> {
        if paths.len() > limits.max_files { return Err(format!("Attach up to {} pictures.", limits.max_files)); }
        paths.iter().map(|path| {
            let path = path.as_ref();
            let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
            if !file.metadata().map_err(|e| e.to_string())?.is_file() { return Err("Choose an image file.".into()); }
            let mut bytes = Vec::new();
            file.take((limits.max_bytes + 1) as u64).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
            attachment(&path.file_name().unwrap_or_default().to_string_lossy(), &bytes, limits)
        }).collect()
    })();
    match result { Ok(images) => json!(images), Err(error) => json!({"error": error}) }
}

fn clipboard_image(image: &Image, limits: Limits) -> Result<Value, String> {
    if matches!(image.format(), ImageFormat::Tiff | ImageFormat::Bmp) {
        if image.bytes().len() > MAX_BYTES { return Err(format!("Pictures must be under {} each.", mb(limits.max_bytes))); }
        let mut reader = image::ImageReader::new(std::io::Cursor::new(image.bytes())).with_guessed_format().map_err(|e| e.to_string())?;
        let mut decode = image::Limits::default();
        decode.max_image_width = Some(8192);
        decode.max_image_height = Some(8192);
        decode.max_alloc = Some(64 * 1024 * 1024);
        reader.limits(decode);
        let decoded = reader.decode().map_err(|e| format!("Cannot paste this picture: {e}"))?;
        let mut png = std::io::Cursor::new(Vec::new());
        decoded.write_to(&mut png, image::ImageFormat::Png).map_err(|e| e.to_string())?;
        attachment("Pasted picture", png.get_ref(), limits)
    } else { attachment("Pasted picture", image.bytes(), limits) }
}

pub fn clipboard(item: ClipboardItem, limits: Limits) -> Option<Value> {
    let mut images = Vec::new();
    for entry in item.entries() {
        match entry {
            ClipboardEntry::Image(image) => match clipboard_image(image, limits) {
                Ok(image) => images.push(image), Err(error) => return Some(json!({"error": error})),
            },
            ClipboardEntry::ExternalPaths(paths) => {
                let paths: Vec<_> = paths.0.iter().filter(|p| p.extension().and_then(|x| x.to_str()).map(|x| ["png", "jpg", "jpeg", "webp", "gif"].contains(&x.to_lowercase().as_str())).unwrap_or(false)).collect();
                if !paths.is_empty() { return Some(files(&paths, limits)); }
            }
            _ => {}
        }
    }
    if images.is_empty() { None } else { Some(json!(images)) }
}

pub fn preview(value: &Value) -> Option<Arc<Image>> {
    let data = value["data"].as_str()?;
    if data.len() > (MAX_BYTES + 2) / 3 * 4 { return None; }
    let bytes = base64::engine::general_purpose::STANDARD.decode(data).ok()?;
    let (format, _) = format(&bytes)?;
    Some(Arc::new(Image::from_bytes(format, bytes)))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn converts_native_clipboard_bitmaps_to_png() {
        let mut bytes = std::io::Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(1, 1).write_to(&mut bytes, image::ImageFormat::Tiff).unwrap();
        let image = Image::from_bytes(ImageFormat::Tiff, bytes.into_inner());
        let result = clipboard(ClipboardItem::new_image(&image), Limits::default()).unwrap();
        assert_eq!(result[0]["mimeType"], "image/png");
    }
    #[test]
    fn validates_image_types_and_limits() {
        let l = Limits::default();
        assert!(attachment("x", b"not a picture", l).is_err());
        assert!(attachment("x", &vec![0; DEFAULT_BYTES + 1], l).is_err());
        // Module limits are clamped to native ceilings.
        let big = Limits::from_node(&json!({"maxBytes": 1u64 << 40, "maxFiles": 999}));
        assert_eq!((big.max_bytes, big.max_files), (MAX_BYTES, MAX_FILES));
        let picture = attachment("x", b"\x89PNG\r\n\x1a\n", l).unwrap();
        assert_eq!(picture["mimeType"], "image/png");
        assert!(preview(&picture).is_some());
        assert!(clipboard(ClipboardItem::new_string("text".into()), Limits::default()).is_none());
    }
}
