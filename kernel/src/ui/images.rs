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

fn background_bounds(container: gpui_kit::Bounds<gpui_kit::Pixels>, dimensions: (u32, u32), style: &Value) -> gpui_kit::Bounds<gpui_kit::Pixels> {
    use gpui_kit::{point, px, size, Bounds};
    let number = |key: &str| style[key].as_f64().filter(|v| v.is_finite()).map(|v| v as f32);
    let scale = number("scale").unwrap_or(1.0).clamp(1.0, 4.0);
    let offset_x = number("offsetX").unwrap_or(0.0).clamp(-1.0, 1.0);
    let (iw, ih) = (dimensions.0.max(1) as f32, dimensions.1.max(1) as f32);
    let (cw, ch) = (container.size.width.as_f32(), container.size.height.as_f32());
    let factor = number("width").map(|w| w.clamp(16.0, 8192.0) / iw).unwrap_or_else(|| (cw / iw).max(ch / ih)) * scale;
    let (width, height) = (iw * factor, ih * factor);
    let left = number("left").map(|v| v.clamp(-8192.0, 8192.0)).unwrap_or((cw - width) / 2.0 + cw * offset_x);
    let top = number("top").map(|v| v.clamp(-8192.0, 8192.0)).unwrap_or((ch - height) / 2.0);
    Bounds { origin: container.origin + point(px(left), px(top)), size: size(px(width), px(height)) }
}

/// Lay out the full artwork at its real aspect ratio. `img(Cover)` in a shifted panel-sized
/// box would crop at that box's edge before the panel can clip it at its own boundary.
pub fn background(image: Arc<Image>, style: &Value) -> gpui_kit::AnyElement {
    use gpui_kit::{canvas, img, size, AvailableSpace, IntoElement, ObjectFit, Styled, StyledImage};
    let dimensions = image::ImageReader::new(std::io::Cursor::new(image.bytes())).with_guessed_format().ok()
        .and_then(|reader| reader.into_dimensions().ok()).unwrap_or((1, 1));
    let opacity = style["opacity"].as_f64().filter(|v| v.is_finite()).unwrap_or(1.0).clamp(0.0, 1.0) as f32;
    let style = style.clone();
    canvas(move |bounds, window, cx| {
        let artwork = background_bounds(bounds, dimensions, &style);
        let mut element = img(image).w(artwork.size.width).h(artwork.size.height).object_fit(ObjectFit::Fill).opacity(opacity).into_any_element();
        element.layout_as_root(size(AvailableSpace::Definite(artwork.size.width), AvailableSpace::Definite(artwork.size.height)), window, cx);
        element.prepaint_at(artwork.origin, window, cx);
        element
    }, |_, mut element, window, cx| element.paint(window, cx)).absolute().inset_0().into_any_element()
}

/// The module supplies the artwork; AppKit owns the process's Dock/app-switcher icon.
/// Keep this separate from bundle metadata so unbundled development launches work too.
pub fn application_icon(cx: &mut gpui_kit::App, value: &Value) {
    #[cfg(target_os = "macos")]
    {
        use objc2_app_kit::{NSApplication, NSImage};
        use objc2_foundation::{MainThreadMarker, NSData};

        #[derive(Default)]
        struct AppliedIcon(Option<String>);
        impl gpui_kit::Global for AppliedIcon {}

        let data = value["data"].as_str();
        let previous = cx.try_global::<AppliedIcon>().and_then(|icon| icon.0.as_deref());
        if data == previous { return; }
        let Some(main_thread) = MainThreadMarker::new() else { return; };
        let app = NSApplication::sharedApplication(main_thread);
        if let Some(data) = data {
            if data.len() > (MAX_BYTES + 2) / 3 * 4 { return; }
            let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(data) else { return; };
            if format(&bytes).is_none() { return; }
            let Some(image) = NSImage::initWithData(main_thread.alloc(), &NSData::with_bytes(&bytes)) else { return; };
            // SAFETY: called on the main thread with a valid, retained NSImage.
            unsafe { app.setApplicationIconImage(Some(&image)); }
        } else {
            // SAFETY: main-thread AppKit call; nil restores the bundle's default icon.
            unsafe { app.setApplicationIconImage(None); }
        }
        cx.set_global(AppliedIcon(data.map(str::to_owned)));
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (cx, value);
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn shifted_background_uses_full_artwork_bounds() {
        use gpui_kit::{point, px, size, Bounds};
        let panel = Bounds { origin: point(px(20.0), px(10.0)), size: size(px(250.0), px(800.0)) };
        let artwork = background_bounds(panel, (1280, 1280), &json!({"scale": 1.2, "offsetX": -0.35}));
        assert!(artwork.origin.x + artwork.size.width > panel.origin.x + panel.size.width, "the image must not end inside the panel");
        assert_eq!(artwork.size.width, artwork.size.height);
    }

    #[test]
    fn fixed_background_size_survives_panel_height_changes() {
        use gpui_kit::{point, px, size, Bounds};
        let style = json!({"width": 640, "offsetX": -0.35});
        let bounds = |height| Bounds { origin: point(px(0.0), px(0.0)), size: size(px(250.0), px(height)) };
        let short = background_bounds(bounds(400.0), (1280, 1280), &style);
        let tall = background_bounds(bounds(900.0), (1280, 1280), &style);
        assert_eq!(short.size, size(px(640.0), px(640.0)));
        assert_eq!(short.size, tall.size);
        assert_eq!(short.origin.x, tall.origin.x);
        let wide = background_bounds(bounds(400.0), (1280, 640), &style);
        assert_eq!(wide.size, size(px(640.0), px(320.0)));
    }

    #[test]
    fn top_left_background_stays_fixed_when_panel_resizes_or_moves() {
        use gpui_kit::{point, px, size, Bounds};
        let style = json!({"width": 800, "left": -350, "top": 0});
        let bounds = |width, height| Bounds { origin: point(px(20.0), px(30.0)), size: size(px(width), px(height)) };
        let original = background_bounds(bounds(250.0, 800.0), (1280, 1280), &style);
        assert_eq!(original.origin, point(px(-330.0), px(30.0)));
        assert_eq!(original.size, size(px(800.0), px(800.0)));
        for resized in [bounds(500.0, 800.0), bounds(250.0, 400.0), bounds(700.0, 1200.0)] {
            assert_eq!(background_bounds(resized, (1280, 1280), &style), original);
        }
        let moved = Bounds { origin: point(px(100.0), px(150.0)), ..bounds(250.0, 800.0) };
        let artwork = background_bounds(moved, (1280, 1280), &style);
        assert_eq!(artwork.origin - moved.origin, original.origin - bounds(250.0, 800.0).origin);
        assert_eq!(artwork.size, original.size);
    }
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
