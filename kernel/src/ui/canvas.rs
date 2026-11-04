//! `canvas` — a scrollable surface of absolutely positioned items joined by painted connectors.
//!
//! Modules supply item geometry (content px), item content (ordinary nodes), and edges between
//! item keys with their colors, dashes and labels. Native code owns only high-frequency pointer
//! work and painting: moving items, dragging a new connection out of an item's port, and drawing
//! curves. Each finished gesture is delivered to the module as one event; the module decides what
//! it means (persist a position, create a connection, select something).
//!
//! * `moveAction`    {key, x, y}       an item was dragged (more than 4px) and released
//! * `selectAction`  {key}             an item was clicked without moving
//! * `connectAction` {from, to}        a port drag ended over another item
//!                   {from, to: null, x, y} ... or over empty space
//! * `edgeAction`    {key}             an edge label chip was clicked
//! * `clickAction`   {x, y}            empty space was pressed
//!
//! Without `moveAction` items cannot be dragged (a read-only preview); clicks still select.
//! Items with `pulse` (a color) breathe a glow ring; edges with `active` carry a moving spark.
use super::*;
use std::cell::RefCell;
use std::rc::Rc;

const MAX_ITEMS: usize = 500;
const MAX_EDGES: usize = 2000;
const PORT: f32 = 12.0;

fn f(n: &Value, k: &str) -> Option<f32> { n.get(k).and_then(|v| v.as_f64()).map(|v| v as f32).filter(|v| v.is_finite()) }
fn s(n: &Value, k: &str) -> Option<String> { n.get(k).and_then(|v| v.as_str()).map(|v| v.to_string()) }
fn px_f(p: Pixels) -> f32 { p / px(1.0) }

#[derive(Clone, Copy, PartialEq)]
enum Gesture { Move, Connect }

pub(super) struct CanvasDrag {
    canvas: String,
    item: String,
    gesture: Gesture,
    start: Point<Pixels>,
    pos: Point<Pixels>,
    orig: [f32; 2],
    node: [f32; 2],
    active: bool,
}

/// Per-canvas data from the latest render, used when a gesture ends.
struct CanvasMeta {
    module: String,
    key: String,
    rects: Vec<(String, [f32; 4])>,
    move_action: Option<String>,
    select_action: Option<String>,
    connect_action: Option<String>,
}

#[derive(Default)]
pub(super) struct CanvasState {
    drag: Option<CanvasDrag>,
    /// `canvas#item` -> (position the module sent, position currently shown)
    overrides: HashMap<String, ([f32; 2], [f32; 2])>,
    /// canvas id -> content bounds in window coordinates from the latest paint
    bounds: Rc<RefCell<HashMap<String, Bounds<Pixels>>>>,
    metas: HashMap<String, CanvasMeta>,
    scrolls: HashMap<String, ScrollHandle>,
}

struct Curve { pts: [(f32, f32); 4], color: Hsla, width: f32, dashed: bool, arrow: bool, spark: Option<Hsla> }

// A fitted canvas passes vertical gestures through to its containing page.
// Horizontal gestures stay inside the canvas, including their small vertical drift.
fn capture_canvas_scroll(dx: f32, dy: f32, vertical_overflow: f32) -> bool {
    (dx.abs() > dy.abs() && dx != 0.0) || (dy != 0.0 && vertical_overflow > 1.0)
}

fn anchor(r: [f32; 4], side: &str) -> (f32, f32) {
    match side {
        "left" => (r[0], r[1] + r[3] / 2.0),
        "top" => (r[0] + r[2] / 2.0, r[1]),
        "bottom" => (r[0] + r[2] / 2.0, r[1] + r[3]),
        _ => (r[0] + r[2], r[1] + r[3] / 2.0),
    }
}

fn direction(side: &str) -> (f32, f32) {
    match side {
        "left" => (-1.0, 0.0),
        "top" => (0.0, -1.0),
        "bottom" => (0.0, 1.0),
        _ => (1.0, 0.0),
    }
}

/// Cubic curve leaving `a` along `da` and entering `b` against `db`.
fn curve(a: (f32, f32), da: (f32, f32), b: (f32, f32), db: (f32, f32), offset: Option<f32>) -> [(f32, f32); 4] {
    let dist = ((b.0 - a.0).powi(2) + (b.1 - a.1).powi(2)).sqrt();
    let d = offset.map(|v| v.clamp(0.0, 200.0)).unwrap_or_else(|| (dist / 2.0).clamp(30.0, 200.0));
    [a, (a.0 + da.0 * d, a.1 + da.1 * d), (b.0 + db.0 * d, b.1 + db.1 * d), b]
}

fn midpoint(p: &[(f32, f32); 4]) -> (f32, f32) {
    (0.125 * p[0].0 + 0.375 * p[1].0 + 0.375 * p[2].0 + 0.125 * p[3].0, 0.125 * p[0].1 + 0.375 * p[1].1 + 0.375 * p[2].1 + 0.125 * p[3].1)
}

fn bezier(p: &[(f32, f32); 4], t: f32) -> (f32, f32) {
    let u = 1.0 - t;
    let (a, b, c, d) = (u * u * u, 3.0 * u * u * t, 3.0 * u * t * t, t * t * t);
    (a * p[0].0 + b * p[1].0 + c * p[2].0 + d * p[3].0, a * p[0].1 + b * p[1].1 + c * p[2].1 + d * p[3].1)
}

/// A short bright segment travelling from source to target (phase 0..1).
fn paint_spark(c: &Curve, color: Hsla, phase: f32, origin: Point<Pixels>, window: &mut Window) {
    let pt = |p: (f32, f32)| point(origin.x + px(p.0), origin.y + px(p.1));
    let len = 0.16;
    let head = phase * (1.0 + len);
    let (from, to) = ((head - len).clamp(0.0, 1.0), head.clamp(0.0, 1.0));
    if to - from < 0.01 {
        return;
    }
    let mut b = PathBuilder::stroke(px(c.width + 2.0));
    b.move_to(pt(bezier(&c.pts, from)));
    for i in 1..=8 {
        b.line_to(pt(bezier(&c.pts, from + (to - from) * i as f32 / 8.0)));
    }
    if let Ok(path) = b.build() {
        window.paint_path(path, color);
    }
}

fn paint_curve(c: &Curve, origin: Point<Pixels>, window: &mut Window) {
    let pt = |p: (f32, f32)| point(origin.x + px(p.0), origin.y + px(p.1));
    let mut b = PathBuilder::stroke(px(c.width));
    if c.dashed {
        b = b.dash_array(&[px(6.0), px(4.0)]);
    }
    b.move_to(pt(c.pts[0]));
    b.cubic_bezier_to(pt(c.pts[3]), pt(c.pts[1]), pt(c.pts[2]));
    if let Ok(path) = b.build() {
        window.paint_path(path, c.color);
    }
    if c.arrow {
        let (tip, ctrl) = (c.pts[3], c.pts[2]);
        let (dx, dy) = (tip.0 - ctrl.0, tip.1 - ctrl.1);
        let len = (dx * dx + dy * dy).sqrt().max(0.001);
        let (ux, uy) = (dx / len, dy / len);
        let size = 8.0 + c.width;
        let base = (tip.0 - ux * size, tip.1 - uy * size);
        let mut a = PathBuilder::fill();
        a.move_to(pt(tip));
        a.line_to(pt((base.0 - uy * size * 0.5, base.1 + ux * size * 0.5)));
        a.line_to(pt((base.0 + uy * size * 0.5, base.1 - ux * size * 0.5)));
        a.close();
        if let Ok(path) = a.build() {
            window.paint_path(path, c.color);
        }
    }
}

impl Shell {
    pub(super) fn render_canvas(&mut self, module: &str, n: &Value, path: &str, key: &str, depth: usize, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let id = format!("{module}::{path}");
        let primary = cx.theme().primary;
        let border = cx.theme().border;
        let background = cx.theme().background;
        let muted = cx.theme().muted_foreground;

        // Item geometry, honoring an in-progress (or not yet acknowledged) drag position.
        let mut items: Vec<(String, [f32; 4], Value)> = Vec::new();
        for it in n.get("items").and_then(|v| v.as_array()).map(|a| a.as_slice()).unwrap_or(&[]).iter().take(MAX_ITEMS) {
            let Some(k) = s(it, "key").filter(|k| !k.is_empty()) else { continue };
            let sent = [f(it, "x").unwrap_or(0.0), f(it, "y").unwrap_or(0.0)];
            let ok = format!("{id}#{k}");
            let pos = match self.lay.canvas.overrides.get(&ok) {
                Some((orig, cur)) if *orig == sent => *cur,
                Some(_) => {
                    self.lay.canvas.overrides.remove(&ok);
                    sent
                }
                None => sent,
            };
            let rect = [pos[0].max(0.0), pos[1].max(0.0), f(it, "width").unwrap_or(180.0).clamp(20.0, 2000.0), f(it, "height").unwrap_or(80.0).clamp(16.0, 2000.0)];
            items.push((k, rect, it.clone()));
        }
        let rect_of = |k: &str| items.iter().find(|(ik, _, _)| ik == k).map(|(_, r, _)| *r);
        // Empty space past the last item, so items can be dragged further (smaller for previews).
        let margin = f(n, "margin").unwrap_or(240.0).clamp(0.0, 2000.0);
        let content_w = items.iter().map(|(_, r, _)| r[0] + r[2]).fold(f(n, "contentWidth").unwrap_or(0.0), f32::max) + margin;
        let content_h = items.iter().map(|(_, r, _)| r[1] + r[3]).fold(f(n, "contentHeight").unwrap_or(0.0), f32::max) + margin;

        // Edges and their label chips.
        let mut curves: Vec<Curve> = Vec::new();
        let mut chips: Vec<(String, String, (f32, f32), Hsla)> = Vec::new();
        let mut pair_count: HashMap<(String, String), usize> = HashMap::new();
        for e in n.get("edges").and_then(|v| v.as_array()).map(|a| a.as_slice()).unwrap_or(&[]).iter().take(MAX_EDGES) {
            let (Some(from), Some(to)) = (s(e, "from"), s(e, "to")) else { continue };
            let (Some(ra), Some(rb)) = (rect_of(&from), rect_of(&to)) else { continue };
            let (fs, ts) = (s(e, "fromSide").unwrap_or_else(|| "right".into()), s(e, "toSide").unwrap_or_else(|| "left".into()));
            let pair = if from <= to { (from.clone(), to.clone()) } else { (to.clone(), from.clone()) };
            let nth = { let c = pair_count.entry(pair).or_insert(0); *c += 1; *c - 1 };
            let pts = if from == to {
                // A self connection loops above the item.
                let a = (ra[0] + ra[2] * 0.7, ra[1]);
                let b = (ra[0] + ra[2] * 0.3, ra[1]);
                let lift = 50.0 + nth as f32 * 18.0;
                [a, (a.0 + 30.0, a.1 - lift), (b.0 - 30.0, b.1 - lift), b]
            } else {
                curve(anchor(ra, &fs), direction(&fs), anchor(rb, &ts), direction(&ts), f(e, "curveOffset"))
            };
            let color = s(e, "color").map(|c| theme::color(cx, &c, muted)).unwrap_or(muted);
            let mut mid = midpoint(&pts);
            mid.1 += nth as f32 * 20.0;
            if let Some(label) = s(e, "label").filter(|l| !l.is_empty()) {
                chips.push((s(e, "key").unwrap_or_default(), label, mid, color));
            }
            let spark = e["active"].as_bool().unwrap_or(false).then(|| s(e, "sparkColor").map(|c| theme::color(cx, &c, primary)).unwrap_or(primary));
            curves.push(Curve { pts, color, width: f(e, "width").unwrap_or(1.6).clamp(0.5, 8.0), dashed: e["dashed"].as_bool().unwrap_or(false), arrow: e["arrow"].as_bool().unwrap_or(true), spark });
        }

        // A connection being dragged out of a port follows the pointer.
        let mut dragging = false;
        if let Some(d) = self.lay.canvas.drag.as_ref().filter(|d| d.canvas == id) {
            dragging = true;
            if d.gesture == Gesture::Connect && d.active {
                if let (Some(r), Some(b)) = (rect_of(&d.item), self.lay.canvas.bounds.borrow().get(&id).cloned()) {
                    let to = (px_f(d.pos.x - b.origin.x), px_f(d.pos.y - b.origin.y));
                    let a = anchor(r, "right");
                    let dir = if to.0 >= a.0 { (-1.0, 0.0) } else { (1.0, 0.0) };
                    curves.push(Curve { pts: curve(a, (1.0, 0.0), to, dir, None), color: primary, width: 2.0, dashed: true, arrow: true, spark: None });
                }
            }
        }

        self.lay.canvas.metas.insert(id.clone(), CanvasMeta {
            module: module.to_string(),
            key: key.to_string(),
            rects: items.iter().map(|(k, r, _)| (k.clone(), *r)).collect(),
            move_action: s(n, "moveAction"),
            select_action: s(n, "selectAction"),
            connect_action: s(n, "connectAction"),
        });

        let grid = f(n, "grid").unwrap_or(0.0);
        let grid_color = border.opacity(0.45);
        let weak = cx.entity().downgrade();
        let reg = self.lay.canvas.bounds.clone();
        let id_paint = id.clone();
        let painter = canvas(
            move |b, _, _| {
                reg.borrow_mut().insert(id_paint, b);
                b
            },
            move |_, b, window, _| {
                if grid >= 8.0 {
                    let (w, h) = (px_f(b.size.width), px_f(b.size.height));
                    let mut g = PathBuilder::stroke(px(1.0));
                    let mut x = grid;
                    while x < w {
                        g.move_to(point(b.origin.x + px(x), b.origin.y));
                        g.line_to(point(b.origin.x + px(x), b.origin.y + px(h)));
                        x += grid;
                    }
                    let mut y = grid;
                    while y < h {
                        g.move_to(point(b.origin.x, b.origin.y + px(y)));
                        g.line_to(point(b.origin.x + px(w), b.origin.y + px(y)));
                        y += grid;
                    }
                    if let Ok(path) = g.build() {
                        window.paint_path(path, grid_color);
                    }
                }
                for c in &curves {
                    paint_curve(c, b.origin, window);
                }
                // Active connections animate while they are shown (staggered so parallel ones differ).
                if curves.iter().any(|c| c.spark.is_some()) {
                    let ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
                    for (i, c) in curves.iter().enumerate() {
                        if let Some(color) = c.spark {
                            let phase = ((ms + i as u64 * 337) % 1400) as f32 / 1400.0;
                            paint_spark(c, color, phase, b.origin, window);
                        }
                    }
                    window.request_animation_frame();
                }
                // Pointer tracking for this canvas's gesture works in whichever window shows it.
                if dragging {
                    let w1 = weak.clone();
                    window.on_mouse_event(move |e: &MouseMoveEvent, phase, _w, cx| {
                        if phase == DispatchPhase::Capture {
                            let _ = w1.update(cx, |this, cx| this.canvas_move(e.position, e.pressed_button.is_some(), cx));
                        }
                    });
                    let w2 = weak.clone();
                    window.on_mouse_event(move |e: &MouseUpEvent, phase, _w, cx| {
                        if phase == DispatchPhase::Capture {
                            let _ = w2.update(cx, |this, cx| this.canvas_end(e.position, cx));
                        }
                    });
                }
            },
        )
        .absolute()
        .top_0()
        .left_0()
        .size_full();

        let movable = n.get("moveAction").and_then(|v| v.as_str()).is_some();
        let click_action = s(n, "clickAction");
        let edge_action = s(n, "edgeAction");
        let (m_bg, k_bg, id_bg) = (module.to_string(), key.to_string(), id.clone());
        let mut content = div().relative().flex_none().w(px(content_w)).h(px(content_h)).child(painter)
            .on_mouse_down(MouseButton::Left, cx.listener(move |this, ev: &MouseDownEvent, _w, cx| {
                let Some(a) = click_action.clone() else { return };
                let Some(b) = this.lay.canvas.bounds.borrow().get(&id_bg).cloned() else { return };
                let inputs = this.module_inputs(&m_bg);
                Self::fire(&this.kernel, &m_bg, &inputs, &a, &k_bg, None, json!({"x": px_f(ev.position.x - b.origin.x).round(), "y": px_f(ev.position.y - b.origin.y).round()}), cx);
            }));

        for (ik, r, it) in &items {
            let kids = self.children(module, it, &format!("{path}/item/{ik}"), depth, window, cx);
            let (id_m, ik_m, rect) = (id.clone(), ik.clone(), *r);
            let el = style::apply(div(), &it["style"], cx).id(sid(module, &format!("{path}/item/{ik}"))).absolute()
                .left(px(r[0])).top(px(r[1])).w(px(r[2])).h(px(r[3])).flex().flex_col().overflow_hidden()
                .when(movable, |d| d.cursor_move())
                .when(!movable, |d| d.cursor_pointer())
                .children(kids)
                .on_mouse_down(MouseButton::Left, cx.listener(move |this, ev: &MouseDownEvent, _w, cx| {
                    this.lay.canvas.drag = Some(CanvasDrag { canvas: id_m.clone(), item: ik_m.clone(), gesture: Gesture::Move, start: ev.position, pos: ev.position, orig: [rect[0], rect[1]], node: [rect[0], rect[1]], active: false });
                    cx.stop_propagation();
                    cx.notify();
                }));
            if let Some(pc) = s(it, "pulse") {
                let c = theme::color(cx, &pc, primary);
                let radius = it["style"]["radius"].as_f64().unwrap_or(6.0) as f32 + 3.0;
                content = content.child(
                    div().absolute().left(px(r[0] - 3.0)).top(px(r[1] - 3.0)).w(px(r[2] + 6.0)).h(px(r[3] + 6.0)).rounded(px(radius)).border_2().border_color(c)
                        .with_animation(sid(module, &format!("{path}/pulse/{ik}")), Animation::new(Duration::from_millis(1600)).repeat().with_easing(pulsating_between(0.15, 0.95)),
                            move |d, delta| d.border_color(c.opacity(delta)).bg(c.opacity(delta * 0.14))),
                );
            }
            content = content.child(el);
            if it["port"].as_bool().unwrap_or(false) {
                let (id_p, ik_p) = (id.clone(), ik.clone());
                let sent = [f(it, "x").unwrap_or(0.0), f(it, "y").unwrap_or(0.0)];
                content = content.child(
                    div().id(sid(module, &format!("{path}/port/{ik}"))).absolute()
                        .left(px(r[0] + r[2] - PORT / 2.0)).top(px(r[1] + r[3] / 2.0 - PORT / 2.0)).w(px(PORT)).h(px(PORT))
                        .rounded_full().bg(primary).border_2().border_color(background).cursor_crosshair()
                        .hover(move |st| st.bg(primary.opacity(0.7)))
                        .on_mouse_down(MouseButton::Left, cx.listener(move |this, ev: &MouseDownEvent, _w, cx| {
                            this.lay.canvas.drag = Some(CanvasDrag { canvas: id_p.clone(), item: ik_p.clone(), gesture: Gesture::Connect, start: ev.position, pos: ev.position, orig: sent, node: sent, active: false });
                            cx.stop_propagation();
                            cx.notify();
                        })),
                );
            }
        }

        for (i, (ek, label, mid, color)) in chips.into_iter().enumerate() {
            let (m_e, k_e, a_e, ek2) = (module.to_string(), key.to_string(), edge_action.clone(), ek.clone());
            let chip = div().id(sid(module, &format!("{path}/edge/{i}/{ek}"))).px_1().rounded(px(4.0)).text_xs().whitespace_nowrap()
                .bg(background).border_1().border_color(color).text_color(color).cursor_pointer().child(label)
                .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                .on_click(cx.listener(move |this, _, _w, cx| {
                    if let Some(a) = a_e.clone() {
                        let inputs = this.module_inputs(&m_e);
                        Self::fire(&this.kernel, &m_e, &inputs, &a, &k_e, None, json!({"key": ek2}), cx);
                    }
                }));
            content = content.child(div().absolute().left(px(mid.0 - 80.0)).top(px(mid.1 - 9.0)).w(px(160.0)).flex().justify_center().child(chip));
        }

        let base = self.apply_base(v_flex(), n, cx);
        // A fixed `height` (e.g. an inline preview) wins over filling the parent.
        let base = if n.get("height").is_some() { base.w_full() } else { base.flex_1().size_full() };
        let scroll = self.lay.canvas.scrolls.entry(id.clone()).or_insert_with(ScrollHandle::new).clone();
        let scroll_boundary = scroll.clone();
        // The inner surface scrolls first. Only capture a vertical gesture when it
        // actually has vertical overflow; otherwise the containing page owns it.
        base.id(sid(module, &format!("{path}/scroll-boundary")))
            .min_w_0().min_h_0().overflow_hidden()
            .on_scroll(move |event, window, cx| {
                let delta = event.delta.pixel_delta(window.line_height());
                if capture_canvas_scroll(px_f(delta.x), px_f(delta.y), px_f(scroll_boundary.max_offset().y)) {
                    cx.stop_propagation();
                }
            })
            .child(div().id(sid(module, path)).size_full().overflow_scroll().track_scroll(&scroll).child(content))
            .into_any_element()
    }

    fn canvas_move(&mut self, pos: Point<Pixels>, pressed: bool, cx: &mut Context<Self>) {
        if !pressed {
            self.canvas_end(pos, cx);
            return;
        }
        let Some(d) = self.lay.canvas.drag.as_mut() else { return };
        d.pos = pos;
        let (dx, dy) = (px_f(pos.x - d.start.x), px_f(pos.y - d.start.y));
        if dx.abs() + dy.abs() > 4.0 {
            d.active = true;
        }
        let movable = self.lay.canvas.metas.get(&d.canvas).map(|m| m.move_action.is_some()).unwrap_or(false);
        if d.gesture == Gesture::Move && !movable {
            d.active = false;
        }
        if d.active && d.gesture == Gesture::Move {
            let cur = [(d.orig[0] + dx).max(0.0), (d.orig[1] + dy).max(0.0)];
            let (k, node) = (format!("{}#{}", d.canvas, d.item), d.node);
            // The override is keyed by the position the module last sent for the item.
            let sent = self.lay.canvas.overrides.get(&k).map(|(o, _)| *o).unwrap_or(node);
            self.lay.canvas.overrides.insert(k, (sent, cur));
        }
        cx.notify();
    }

    fn canvas_end(&mut self, pos: Point<Pixels>, cx: &mut Context<Self>) {
        let Some(d) = self.lay.canvas.drag.take() else { return };
        let Some(meta) = self.lay.canvas.metas.get(&d.canvas) else { cx.notify(); return };
        let (module, key) = (meta.module.clone(), meta.key.clone());
        let inputs = self.module_inputs(&module);
        match (d.gesture, d.active) {
            (Gesture::Move, true) => {
                let k = format!("{}#{}", d.canvas, d.item);
                if let (Some(a), Some((_, cur))) = (meta.move_action.clone(), self.lay.canvas.overrides.get(&k).cloned()) {
                    Self::fire(&self.kernel, &module, &inputs, &a, &key, None, json!({"key": d.item, "x": cur[0].round(), "y": cur[1].round()}), cx);
                }
            }
            (Gesture::Move, false) => {
                if let Some(a) = meta.select_action.clone() {
                    Self::fire(&self.kernel, &module, &inputs, &a, &key, None, json!({"key": d.item}), cx);
                }
            }
            (Gesture::Connect, true) => {
                if let (Some(a), Some(b)) = (meta.connect_action.clone(), self.lay.canvas.bounds.borrow().get(&d.canvas).cloned()) {
                    let (x, y) = (px_f(pos.x - b.origin.x), px_f(pos.y - b.origin.y));
                    let target = meta.rects.iter().rev().find(|(_, r)| x >= r[0] && x <= r[0] + r[2] && y >= r[1] && y <= r[1] + r[3]).map(|(k, _)| k.clone());
                    let value = match target {
                        Some(to) => json!({"from": d.item, "to": to}),
                        None => json!({"from": d.item, "to": Value::Null, "x": x.round(), "y": y.round()}),
                    };
                    Self::fire(&self.kernel, &module, &inputs, &a, &key, None, value, cx);
                }
            }
            (Gesture::Connect, false) => {}
        }
        cx.notify();
    }
}

#[cfg(test)]
mod curve_tests {
    use super::{curve, capture_canvas_scroll};
    #[test]
    fn fitted_canvas_passes_vertical_scroll_and_captures_horizontal_gestures() {
        assert!(!capture_canvas_scroll(0.0, 30.0, 0.0));
        assert!(!capture_canvas_scroll(2.0, 30.0, 0.0));
        assert!(!capture_canvas_scroll(0.0, -30.0, 0.5));
        assert!(capture_canvas_scroll(30.0, 2.0, 0.0));
        assert!(capture_canvas_scroll(-30.0, -2.0, 0.0));
        assert!(capture_canvas_scroll(0.0, 30.0, 100.0));
        assert!(!capture_canvas_scroll(0.0, 0.0, 100.0));
    }

    #[test]
    fn compact_handles_fit_between_close_anchors_and_reverse_on_the_same_path() {
        let a = (120.0, 12.0);
        let b = (136.0, 12.0);
        let forward = curve(a, (1.0, 0.0), b, (-1.0, 0.0), Some(8.0));
        assert_eq!(forward, [a, (128.0, 12.0), (128.0, 12.0), b]);
        let mut reverse = curve(b, (-1.0, 0.0), a, (1.0, 0.0), Some(8.0));
        reverse.reverse();
        assert_eq!(forward, reverse);
    }
}
