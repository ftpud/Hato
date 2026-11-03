use base64::Engine;
use gpui_kit::{ClipboardEntry, ClipboardItem, Image, ImageFormat};
use serde_json::{json, Value};
use std::{io::Read, path::Path, sync::Arc};

const MAX_BYTES: usize = 5 * 1024 * 1024;

fn format(bytes: &[u8]) -> Option<(ImageFormat, &'static str)> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") { Some((ImageFormat::Png, "image/png")) }
    else if bytes.starts_with(b"\xff\xd8\xff") { Some((ImageFormat::Jpeg, "image/jpeg")) }
    else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") { Some((ImageFormat::Gif, "image/gif")) }
    else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") { Some((ImageFormat::Webp, "image/webp")) }
    else { None }
}

fn attachment(name: &str, bytes: &[u8]) -> Result<Value, String> {
    if bytes.len() > MAX_BYTES { return Err("Pictures must be under 5 MB each.".into()); }
    let (_, mime) = format(bytes).ok_or("Use PNG, JPEG, WebP or GIF pictures.")?;
    Ok(json!({"name": name, "mimeType": mime, "data": base64::engine::general_purpose::STANDARD.encode(bytes)}))
}

pub fn files(paths: &[impl AsRef<Path>]) -> Value {
    let result = (|| -> Result<Vec<Value>, String> {
        if paths.len() > 4 { return Err("Attach up to 4 pictures.".into()); }
        paths.iter().map(|path| {
            let path = path.as_ref();
            let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
            if !file.metadata().map_err(|e| e.to_string())?.is_file() { return Err("Choose an image file.".into()); }
            let mut bytes = Vec::new();
            file.take((MAX_BYTES + 1) as u64).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
            attachment(&path.file_name().unwrap_or_default().to_string_lossy(), &bytes)
        }).collect()
    })();
    match result { Ok(images) => json!(images), Err(error) => json!({"error": error}) }
}

fn clipboard_image(image: &Image) -> Result<Value, String> {
    if matches!(image.format(), ImageFormat::Tiff | ImageFormat::Bmp) {
        if image.bytes().len() > MAX_BYTES { return Err("Pictures must be under 5 MB each.".into()); }
        let mut reader = image::ImageReader::new(std::io::Cursor::new(image.bytes())).with_guessed_format().map_err(|e| e.to_string())?;
        let mut limits = image::Limits::default();
        limits.max_image_width = Some(8192);
        limits.max_image_height = Some(8192);
        limits.max_alloc = Some(64 * 1024 * 1024);
        reader.limits(limits);
        let decoded = reader.decode().map_err(|e| format!("Cannot paste this picture: {e}"))?;
        let mut png = std::io::Cursor::new(Vec::new());
        decoded.write_to(&mut png, image::ImageFormat::Png).map_err(|e| e.to_string())?;
        attachment("Pasted picture", png.get_ref())
    } else { attachment("Pasted picture", image.bytes()) }
}

pub fn clipboard(item: ClipboardItem) -> Option<Value> {
    let mut images = Vec::new();
    for entry in item.entries() {
        match entry {
            ClipboardEntry::Image(image) => match clipboard_image(image) {
                Ok(image) => images.push(image), Err(error) => return Some(json!({"error": error})),
            },
            ClipboardEntry::ExternalPaths(paths) => {
                let paths: Vec<_> = paths.0.iter().filter(|p| p.extension().and_then(|x| x.to_str()).map(|x| ["png", "jpg", "jpeg", "webp", "gif"].contains(&x.to_lowercase().as_str())).unwrap_or(false)).collect();
                if !paths.is_empty() { return Some(files(&paths)); }
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
        let result = clipboard(ClipboardItem::new_image(&image)).unwrap();
        assert_eq!(result[0]["mimeType"], "image/png");
    }
    #[test]
    fn validates_image_types_and_limits() {
        assert!(attachment("x", b"not a picture").is_err());
        assert!(attachment("x", &vec![0; MAX_BYTES + 1]).is_err());
        let picture = attachment("x", b"\x89PNG\r\n\x1a\n").unwrap();
        assert_eq!(picture["mimeType"], "image/png");
        assert!(preview(&picture).is_some());
        assert!(clipboard(ClipboardItem::new_string("text".into())).is_none());
    }
}
