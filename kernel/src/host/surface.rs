//! Pushed-frame surface: a module-owned resource holding the latest encoded picture (PNG, JPEG,
//! WebP or GIF) and an optional pointer overlay target. A `surface` UiNode references the handle;
//! the native renderer decodes and paints frames as they arrive, without a module re-render, and
//! reports pointer/keyboard input in the frame's logical coordinate space. What the frames show
//! (a remote screen, an emulator, a page) is decided entirely by the owning module.
use crate::util::{HResult, HostError};
use base64::Engine;
use parking_lot::Mutex;
use serde_json::Value;
use std::sync::Arc;

pub const MAX_FRAME_BYTES: usize = 16 << 20;

pub struct SurfaceFrame {
    pub bytes: Vec<u8>,
    /// Logical coordinate space for input and the overlay (e.g. CSS pixels); 0 = picture pixels.
    pub width: f64,
    pub height: f64,
    pub seq: u64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct SurfaceCursor {
    pub x: f64,
    pub y: f64,
    pub visible: bool,
    /// Animate from the previous position over this many ms.
    pub duration_ms: u64,
    /// Show a press ripple once the pointer arrives.
    pub click: bool,
    pub seq: u64,
}

#[derive(Default)]
pub struct SurfaceState {
    pub frame: Option<Arc<SurfaceFrame>>,
    pub cursor: Option<SurfaceCursor>,
    seq: u64,
}

#[derive(Default)]
pub struct Surface {
    pub state: Mutex<SurfaceState>,
    pub notify: Mutex<Option<Arc<dyn Fn() + Send + Sync>>>,
}

pub fn sniff(bytes: &[u8]) -> bool {
    bytes.starts_with(b"\x89PNG\r\n\x1a\n") || bytes.starts_with(b"\xff\xd8\xff") || bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a")
        || (bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP"))
}

fn dim(args: &Value, key: &str) -> HResult<f64> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(0.0),
        Some(v) => v.as_f64().filter(|v| v.is_finite() && *v >= 0.0 && *v <= 100_000.0).ok_or_else(|| HostError::invalid(format!("invalid {key}"))),
    }
}

impl Surface {
    fn changed(&self) {
        let notify = self.notify.lock().clone();
        if let Some(n) = notify { n(); }
    }

    pub fn push_frame(&self, args: &Value) -> HResult<u64> {
        let data = args.get("data").and_then(|d| d.as_str()).ok_or_else(|| HostError::invalid("missing data"))?;
        if data.len() > MAX_FRAME_BYTES / 3 * 4 + 4 { return Err(HostError::new("E2BIG", "frame too large")); }
        let bytes = base64::engine::general_purpose::STANDARD.decode(data).map_err(|e| HostError::invalid(e.to_string()))?;
        if !sniff(&bytes) { return Err(HostError::invalid("frames must be PNG, JPEG, WebP or GIF")); }
        let (width, height) = (dim(args, "width")?, dim(args, "height")?);
        let seq = {
            let mut s = self.state.lock();
            s.seq += 1;
            s.frame = Some(Arc::new(SurfaceFrame { bytes, width, height, seq: s.seq }));
            s.seq
        };
        self.changed();
        Ok(seq)
    }

    pub fn set_cursor(&self, args: &Value) -> HResult<()> {
        {
            let mut s = self.state.lock();
            if args.get("visible").and_then(|v| v.as_bool()) == Some(false) && args.get("x").is_none() {
                if let Some(c) = s.cursor.as_mut() { c.visible = false; }
            } else {
                let coord = |key: &str| args.get(key).and_then(|v| v.as_f64()).filter(|v| v.is_finite() && v.abs() <= 100_000.0).ok_or_else(|| HostError::invalid(format!("invalid {key}")));
                s.seq += 1;
                s.cursor = Some(SurfaceCursor {
                    x: coord("x")?, y: coord("y")?,
                    visible: args.get("visible").and_then(|v| v.as_bool()).unwrap_or(true),
                    duration_ms: args.get("durationMs").and_then(|v| v.as_u64()).unwrap_or(0).min(5_000),
                    click: args.get("click").and_then(|v| v.as_bool()).unwrap_or(false),
                    seq: s.seq,
                });
            }
        }
        self.changed();
        Ok(())
    }

    pub fn clear(&self) {
        { let mut s = self.state.lock(); s.frame = None; s.cursor = None; }
        self.changed();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn frames_must_be_pictures_and_dimensions_sane() {
        let s = Surface::default();
        let png = base64::engine::general_purpose::STANDARD.encode(b"\x89PNG\r\n\x1a\nrest");
        assert_eq!(s.push_frame(&json!({"data": png, "width": 800, "height": 600})).unwrap(), 1);
        assert_eq!(s.state.lock().frame.as_ref().unwrap().width, 800.0);
        assert!(s.push_frame(&json!({"data": "aGVsbG8="})).is_err());
        assert!(s.push_frame(&json!({"data": png, "width": -1})).is_err());
        s.set_cursor(&json!({"x": 10, "y": 20, "durationMs": 99999, "click": true})).unwrap();
        let c = s.state.lock().cursor.clone().unwrap();
        assert_eq!((c.x, c.y, c.duration_ms, c.click, c.visible), (10.0, 20.0, 5000, true, true));
        s.set_cursor(&json!({"visible": false})).unwrap();
        assert!(!s.state.lock().cursor.as_ref().unwrap().visible);
    }
}
