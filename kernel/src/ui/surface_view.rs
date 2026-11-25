//! Native element for a pushed-frame `surface` node. Frames are decoded off the UI thread into
//! uncached render images (the previous texture is dropped from the atlas), so streaming does not
//! grow the asset cache. Pointer, wheel and keyboard input are reported to the owning UI module in
//! the frame's logical coordinates; the module decides what they mean. The pointer overlay
//! (drawing supplied by the module) glides to targets the owning service sets on the handle.
use crate::host::surface::{Surface, SurfaceCursor};
use crate::kernel::Kernel;
use gpui_component::{ActiveTheme, Sizable};
use gpui_kit::*;
use serde_json::{json, Value};
use std::cell::Cell as StdCell;
use std::rc::Rc;
use std::sync::Arc;
use std::time::{Duration, Instant};

const MOVE_INTERVAL: Duration = Duration::from_millis(33);
const RIPPLE: Duration = Duration::from_millis(450);

pub(super) fn init(cx: &mut App) {
    // Keep Tab inside the surface instead of moving app focus.
    cx.bind_keys([
        KeyBinding::new("tab", NoAction, Some("Surface")),
        KeyBinding::new("shift-tab", NoAction, Some("Surface")),
    ]);
}

/// Per-render binding from the module's node.
#[derive(Clone, Default, PartialEq)]
pub struct Binding {
    pub module: String,
    pub key: String,
    pub pointer: Option<String>,
    pub wheel: Option<String>,
    pub keys: Option<String>,
    pub resize: Option<String>,
    pub cursor_svg: Option<String>,
    pub cursor_label: Option<String>,
    pub cursor_color: Option<String>,
    pub placeholder: Option<String>,
}

impl Binding {
    pub fn from_node(module: &str, key: &str, n: &Value) -> Self {
        let s = |k: &str| n[k].as_str().filter(|v| !v.is_empty()).map(str::to_owned);
        Binding { module: module.into(), key: key.into(), pointer: s("pointerAction"), wheel: s("wheelAction"), keys: s("keyAction"),
            resize: s("resizeAction"), cursor_svg: s("cursorSvg"), cursor_label: s("cursorLabel"), cursor_color: s("cursorColor"), placeholder: s("placeholder") }
    }
}

struct Glide { from: (f64, f64), to: (f64, f64), start: Instant, duration: Duration, click: bool, visible: bool, seq: u64 }

impl Glide {
    fn progress(&self) -> f64 {
        if self.duration.is_zero() { return 1.0; }
        (self.start.elapsed().as_secs_f64() / self.duration.as_secs_f64()).min(1.0)
    }
    fn position(&self) -> (f64, f64) {
        let t = self.progress();
        let e = if t < 0.5 { 4.0 * t * t * t } else { 1.0 - (-2.0 * t + 2.0).powi(3) / 2.0 };
        (self.from.0 + (self.to.0 - self.from.0) * e, self.from.1 + (self.to.1 - self.from.1) * e)
    }
    /// Ripple age once the glide has arrived.
    fn ripple(&self) -> Option<f32> {
        if !self.click { return None; }
        let arrived = self.start + self.duration;
        let age = Instant::now().checked_duration_since(arrived)?;
        (age < RIPPLE).then(|| age.as_secs_f32() / RIPPLE.as_secs_f32())
    }
}

pub struct SurfaceView {
    surface: Arc<Surface>,
    kernel: Arc<Kernel>,
    pub binding: Binding,
    focus: FocusHandle,
    image: Option<Arc<RenderImage>>,
    /// Logical frame size (input/overlay coordinate space).
    logical: (f64, f64),
    decoded_seq: u64,
    decoding: bool,
    glide: Option<Glide>,
    bounds: Rc<StdCell<Option<Bounds<Pixels>>>>,
    reported: Rc<StdCell<(f32, f32, f32)>>,
    last_move: Option<Instant>,
    pending_move: Option<Value>,
    move_scheduled: bool,
    wheel: (f64, f64, f64, f64),
    wheel_scheduled: bool,
    buttons: u8,
}

fn modifiers(m: &Modifiers) -> Value {
    json!({"shift": m.shift, "ctrl": m.control, "alt": m.alt, "meta": m.platform})
}

fn button_name(b: MouseButton) -> &'static str {
    match b { MouseButton::Right => "right", MouseButton::Middle => "middle", _ => "left" }
}

impl SurfaceView {
    pub fn new(surface: Arc<Surface>, kernel: Arc<Kernel>, binding: Binding, cx: &mut Context<Self>) -> Self {
        let mut view = SurfaceView { surface, kernel, binding, focus: cx.focus_handle(), image: None, logical: (0.0, 0.0), decoded_seq: 0, decoding: false,
            glide: None, bounds: Rc::new(StdCell::new(None)), reported: Rc::new(StdCell::new((0.0, 0.0, 0.0))), last_move: None, pending_move: None,
            move_scheduled: false, wheel: (0.0, 0.0, 0.0, 0.0), wheel_scheduled: false, buttons: 0 };
        view.refresh(cx);
        view
    }

    /// Pick up a new frame or pointer target from the shared surface state.
    pub fn refresh(&mut self, cx: &mut Context<Self>) {
        let (frame, cursor) = { let s = self.surface.state.lock(); (s.frame.clone(), s.cursor.clone()) };
        match frame {
            None if self.image.is_some() => { if let Some(old) = self.image.take() { cx.drop_image(old, None); } self.decoded_seq = 0; }
            Some(f) if f.seq != self.decoded_seq && !self.decoding => {
                self.decoding = true;
                let target = f.clone();
                let seq = f.seq;
                let task = cx.background_spawn(async move { decode(&target.bytes).map(|img| (img, target)) });
                cx.spawn(async move |this, cx| {
                    let result = task.await;
                    let _ = this.update(cx, |this, cx| {
                        this.decoding = false;
                        if let Some((img, frame)) = result {
                            let size = img.size(0);
                            let (pw, ph) = (size.width.0 as f64, size.height.0 as f64);
                            this.logical = (if frame.width > 0.0 { frame.width } else { pw }, if frame.height > 0.0 { frame.height } else { ph });
                            if let Some(old) = this.image.replace(img) { cx.drop_image(old, None); }
                        }
                        this.decoded_seq = seq;
                        // A newer frame may have arrived while decoding.
                        this.refresh(cx);
                        cx.notify();
                    });
                }).detach();
            }
            _ => {}
        }
        if let Some(c) = cursor { self.set_glide(c); }
        cx.notify();
    }

    fn set_glide(&mut self, c: SurfaceCursor) {
        if self.glide.as_ref().is_some_and(|g| g.seq == c.seq) { return; }
        if self.glide.as_ref().is_some_and(|g| g.seq > c.seq) { return; }
        let from = self.glide.as_ref().filter(|g| g.visible).map(|g| g.position()).unwrap_or((c.x, c.y));
        self.glide = Some(Glide { from, to: (c.x, c.y), start: Instant::now(), duration: Duration::from_millis(c.duration_ms), click: c.click, visible: c.visible, seq: c.seq });
    }

    /// Picture rectangle inside the element (object-fit: contain).
    fn content_rect(&self) -> Option<Bounds<Pixels>> {
        let b = self.bounds.get()?;
        let (fw, fh) = self.logical;
        if fw <= 0.0 || fh <= 0.0 { return None; }
        let (bw, bh) = (b.size.width.as_f32() as f64, b.size.height.as_f32() as f64);
        let scale = (bw / fw).min(bh / fh);
        let (w, h) = (fw * scale, fh * scale);
        Some(Bounds { origin: b.origin + point(px(((bw - w) / 2.0) as f32), px(((bh - h) / 2.0) as f32)), size: size(px(w as f32), px(h as f32)) })
    }

    fn to_logical(&self, p: Point<Pixels>) -> Option<(f64, f64)> {
        let r = self.content_rect()?;
        let x = (p.x - r.origin.x).as_f32() as f64 / r.size.width.as_f32() as f64 * self.logical.0;
        let y = (p.y - r.origin.y).as_f32() as f64 / r.size.height.as_f32() as f64 * self.logical.1;
        Some((x.clamp(0.0, self.logical.0), y.clamp(0.0, self.logical.1)))
    }

    fn fire(&self, action: &Option<String>, value: Value) {
        let Some(action) = action else { return };
        let ev = json!({"action": action, "key": self.binding.key, "rowKey": null, "value": value, "inputs": {}});
        self.kernel.ui_event(&self.binding.module, ev);
    }

    fn pointer(&mut self, kind: &str, p: Point<Pixels>, button: Option<MouseButton>, clicks: usize, m: &Modifiers) {
        let Some((x, y)) = self.to_logical(p) else { return };
        let value = json!({"kind": kind, "x": x, "y": y, "button": button.map(button_name), "buttons": self.buttons, "clickCount": clicks, "modifiers": modifiers(m)});
        self.fire(&self.binding.pointer.clone(), value);
    }

    fn moved(&mut self, p: Point<Pixels>, m: &Modifiers, cx: &mut Context<Self>) {
        let Some((x, y)) = self.to_logical(p) else { return };
        let value = json!({"kind": "move", "x": x, "y": y, "button": null, "buttons": self.buttons, "clickCount": 0, "modifiers": modifiers(m)});
        if self.last_move.is_none_or(|t| t.elapsed() >= MOVE_INTERVAL) {
            self.last_move = Some(Instant::now());
            self.pending_move = None;
            self.fire(&self.binding.pointer.clone(), value);
            return;
        }
        self.pending_move = Some(value);
        if self.move_scheduled { return; }
        self.move_scheduled = true;
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(MOVE_INTERVAL).await;
            let _ = this.update(cx, |this, _| {
                this.move_scheduled = false;
                if let Some(v) = this.pending_move.take() { this.last_move = Some(Instant::now()); this.fire(&this.binding.pointer.clone(), v); }
            });
        }).detach();
    }

    fn flush_move(&mut self) {
        if let Some(v) = self.pending_move.take() { self.fire(&self.binding.pointer.clone(), v); }
    }

    fn scrolled(&mut self, ev: &ScrollEvent, cx: &mut Context<Self>) {
        let Some((x, y)) = self.to_logical(ev.position) else { return };
        let d = ev.delta.pixel_delta(px(20.0));
        // Scale view pixels into logical pixels.
        let scale = self.content_rect().map(|r| self.logical.0 / r.size.width.as_f32().max(1.0) as f64).unwrap_or(1.0);
        self.wheel = (x, y, self.wheel.2 - d.x.as_f32() as f64 * scale, self.wheel.3 - d.y.as_f32() as f64 * scale);
        if self.wheel_scheduled { return; }
        self.wheel_scheduled = true;
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(Duration::from_millis(25)).await;
            let _ = this.update(cx, |this, _| {
                this.wheel_scheduled = false;
                let (x, y, dx, dy) = std::mem::take(&mut this.wheel);
                if dx != 0.0 || dy != 0.0 { this.fire(&this.binding.wheel.clone(), json!({"x": x, "y": y, "deltaX": dx, "deltaY": dy})); }
            });
        }).detach();
    }

    fn key(&mut self, kind: &str, k: &Keystroke, cx: &mut Context<Self>) -> bool {
        let m = &k.modifiers;
        // App-level Cmd shortcuts (close tab, switch panel…) keep working; editing ones go to the surface.
        if m.platform && !["a", "c", "v", "x", "z", "y", "left", "right", "up", "down", "backspace", "delete"].contains(&k.key.as_str()) { return false; }
        if kind == "down" && k.key == "v" && (m.platform || (m.control && !cfg!(target_os = "macos"))) {
            if let Some(text) = cx.read_from_clipboard().and_then(|c| c.text()) {
                self.fire(&self.binding.keys.clone(), json!({"kind": "paste", "text": text}));
            }
            return true;
        }
        self.fire(&self.binding.keys.clone(), json!({"kind": kind, "key": k.key, "text": k.key_char, "modifiers": modifiers(m)}));
        true
    }
}

fn decode(bytes: &[u8]) -> Option<Arc<RenderImage>> {
    let mut data = image::load_from_memory(bytes).ok()?.into_rgba8();
    for pixel in data.chunks_exact_mut(4) { pixel.swap(0, 2); }
    Some(Arc::new(RenderImage::new(vec![image::Frame::new(data)])))
}

impl Focusable for SurfaceView {
    fn focus_handle(&self, _: &App) -> FocusHandle { self.focus.clone() }
}

impl Render for SurfaceView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        crate::ui::redraw_stats::cause("view:surface");
        let interactive = self.binding.pointer.is_some() || self.binding.keys.is_some() || self.binding.wheel.is_some();
        let bounds = self.bounds.clone();
        let reported = self.reported.clone();
        let kernel = self.kernel.clone();
        let (module, key, resize) = (self.binding.module.clone(), self.binding.key.clone(), self.binding.resize.clone());
        let muted = cx.theme().muted_foreground;
        let mut root = div().id("surface").key_context("Surface").relative().size_full().overflow_hidden()
            .child(canvas(move |b, window, _| {
                bounds.set(Some(b));
                let scale = window.scale_factor();
                let now = (b.size.width.as_f32().round(), b.size.height.as_f32().round(), scale);
                if now != reported.get() && now.0 > 0.0 && now.1 > 0.0 {
                    reported.set(now);
                    if let Some(action) = &resize {
                        kernel.ui_event(&module, json!({"action": action, "key": key, "rowKey": null, "value": {"width": now.0, "height": now.1, "scale": scale}, "inputs": {}}));
                    }
                }
            }, |_, _, _, _| {}).absolute().inset_0());
        root = match &self.image {
            Some(image) => root.child(img(image.clone()).size_full().object_fit(ObjectFit::Contain)),
            None => root.child(div().size_full().flex().items_center().justify_center().text_sm().text_color(muted)
                .child(self.binding.placeholder.clone().unwrap_or_default())),
        };
        // Pointer overlay.
        let mut animating = false;
        if let (Some(g), Some(r)) = (self.glide.as_ref().filter(|g| g.visible), self.content_rect()) {
            animating = g.progress() < 1.0 || g.ripple().is_some();
            let (x, y) = g.position();
            let sx = r.size.width.as_f32() / self.logical.0.max(1.0) as f32;
            let sy = r.size.height.as_f32() / self.logical.1.max(1.0) as f32;
            let origin = self.bounds.get().map(|b| b.origin).unwrap_or_default();
            let left = r.origin.x - origin.x + px(x as f32 * sx);
            let top = r.origin.y - origin.y + px(y as f32 * sy);
            if let Some(t) = g.ripple() {
                let d = 12.0 + 36.0 * t;
                root = root.child(div().absolute().left(left - px(d / 2.0)).top(top - px(d / 2.0)).w(px(d)).h(px(d)).rounded_full()
                    .border_2().border_color(Hsla { a: 0.8 * (1.0 - t), ..cx.theme().primary }));
            }
            let tint = super::theme::color(cx, self.binding.cursor_color.as_deref().unwrap_or("primary"), cx.theme().primary);
            let pointer = match &self.binding.cursor_svg {
                // SVGs paint as a single-color mask: a white halo keeps the pointer visible on any page.
                Some(svg) => div().relative().w(px(22.0)).h(px(22.0))
                    .child(div().absolute().left(px(-1.0)).top(px(-1.0)).child(gpui_component::Icon::default().data(svg.as_bytes()).with_size(px(24.0)).text_color(white())))
                    .child(div().absolute().left(px(1.0)).top(px(1.0)).child(gpui_component::Icon::default().data(svg.as_bytes()).with_size(px(20.0)).text_color(tint)))
                    .into_any_element(),
                None => div().w(px(12.0)).h(px(12.0)).rounded_full().bg(tint).border_2().border_color(white()).into_any_element(),
            };
            let mut marker = div().absolute().left(left).top(top).flex().items_start().gap_1().child(pointer);
            if let Some(label) = &self.binding.cursor_label {
                marker = marker.child(div().mt(px(16.0)).px_1().rounded_sm().text_xs().bg(tint).text_color(white()).shadow_sm().child(label.clone()));
            }
            root = root.child(marker);
        }
        if animating { { crate::ui::redraw_stats::cause(concat!("anim:", file!(), ":", line!())); window.request_animation_frame(); } }
        if !interactive { return root; }
        root.track_focus(&self.focus)
            .on_mouse_down(MouseButton::Left, cx.listener(|this, ev: &MouseDownEvent, window, cx| {
                window.focus(&this.focus, cx);
                this.flush_move();
                this.buttons |= 1;
                this.pointer("down", ev.position, Some(MouseButton::Left), ev.click_count, &ev.modifiers);
            }))
            .on_mouse_down(MouseButton::Right, cx.listener(|this, ev: &MouseDownEvent, window, cx| {
                window.focus(&this.focus, cx);
                this.buttons |= 2;
                this.pointer("down", ev.position, Some(MouseButton::Right), ev.click_count, &ev.modifiers);
                cx.stop_propagation();
            }))
            .on_mouse_up(MouseButton::Left, cx.listener(|this, ev: &MouseUpEvent, _, _| {
                this.flush_move();
                this.buttons &= !1;
                this.pointer("up", ev.position, Some(MouseButton::Left), ev.click_count, &ev.modifiers);
            }))
            .on_mouse_up_out(MouseButton::Left, cx.listener(|this, ev: &MouseUpEvent, _, _| {
                if this.buttons & 1 == 0 { return; }
                this.buttons &= !1;
                this.pointer("up", ev.position, Some(MouseButton::Left), ev.click_count, &ev.modifiers);
            }))
            .on_mouse_up(MouseButton::Right, cx.listener(|this, ev: &MouseUpEvent, _, _| {
                this.buttons &= !2;
                this.pointer("up", ev.position, Some(MouseButton::Right), ev.click_count, &ev.modifiers);
            }))
            .on_mouse_move(cx.listener(|this, ev: &MouseMoveEvent, _, cx| { this.moved(ev.position, &ev.modifiers, cx); }))
            .on_scroll(cx.listener(|this, ev: &ScrollEvent, _, cx| { this.scrolled(ev, cx); }))
            .on_key_down(cx.listener(|this, ev: &KeyDownEvent, _, cx| { if this.key("down", &ev.keystroke, cx) { cx.stop_propagation(); } }))
            .on_key_up(cx.listener(|this, ev: &KeyUpEvent, _, cx| { if this.key("up", &ev.keystroke, cx) { cx.stop_propagation(); } }))
    }
}
