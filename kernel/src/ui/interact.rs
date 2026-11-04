//! Native layout interaction primitives. High-frequency pointer handling (divider drags, panel
//! drags, floating-window moves) stays in Rust; modules only receive the final result as one UI
//! event, and decide what it means (persist sizes, collapse, re-dock, detach…).
//!
//! Node types handled here:
//! * `split`      — `sizes`, `fixed` (px per child or null), `minSize`, `resizable`, `resizeAction`,
//!                  `collapseAction` (+ `collapsible` per child). Dividers are draggable.
//! * `dragHandle` — `payload`, `label`, optional `clickAction`. Starts a drag after 4px movement.
//! * `dropZone`   — `action`, `regions` (subset of left/right/top/bottom/center). Highlights the
//!                  region under the pointer; on drop fires `action` with {payload, region, zone}.
//! * `floating`   — `x`,`y`,`width`,`height`,`title`,`moveAction`. Native move (title bar) and
//!                  resize (corner grip) inside the main window.
//! * `window`     — `title`,`titlebar`,`width`,`height`,`closeAction`. A real OS window rendering its children.
use super::*;
use std::cell::RefCell;
use std::rc::Rc;

const DIVIDER: f32 = 5.0;
const COLLAPSE_SLACK: f32 = 40.0;

pub(super) struct ZoneMeta {
    pub module: String,
    pub key: String,
    pub action: String,
    pub regions: Vec<String>,
}

pub(super) enum Drag {
    Split {
        id: String,
        module: String,
        key: String,
        horizontal: bool,
        a: usize,
        b: usize,
        start: Point<Pixels>,
        start_sizes: Vec<f32>,
        orig_sizes: Vec<f32>,
        flexible: Vec<bool>,
        fixed_px: f32,
        min: f32,
        resize_action: Option<String>,
        collapse_action: Option<String>,
        collapsible: Vec<bool>,
        collapse_req: Option<usize>,
    },
    Item {
        module: String,
        key: String,
        payload: Value,
        label: String,
        click_action: Option<String>,
        origin: Point<Pixels>,
        pos: Point<Pixels>,
        active: bool,
        hover: Option<(String, String)>,
    },
    Float {
        id: String,
        module: String,
        key: String,
        resize: bool,
        start: Point<Pixels>,
        orig: [f32; 4],
        node: [f32; 4],
        action: Option<String>,
    },
}

#[derive(Default)]
pub(super) struct Layout {
    pub bounds: Rc<RefCell<HashMap<String, Bounds<Pixels>>>>,
    /// split id -> (sizes the module sent, sizes currently shown)
    pub split_overrides: HashMap<String, (Vec<f32>, Vec<f32>)>,
    /// floating id -> (geometry the module sent, geometry currently shown)
    pub float_overrides: HashMap<String, ([f32; 4], [f32; 4])>,
    pub drag: Option<Drag>,
    pub zones: HashMap<String, ZoneMeta>,
    pub floats: Vec<(String, String, Value)>,
    pub windows_wanted: Vec<String>,
    pub window_nodes: HashMap<String, (String, String, Value)>,
    pub windows: HashMap<String, AnyWindowHandle>,
    pub closed_by_user: HashSet<String>,
    pub canvas: super::canvas::CanvasState,
}

fn f(n: &Value, k: &str) -> Option<f32> { n.get(k).and_then(|v| v.as_f64()).map(|v| v as f32) }
fn s(n: &Value, k: &str) -> Option<String> { n.get(k).and_then(|v| v.as_str()).map(|v| v.to_string()) }
fn px_f(p: Pixels) -> f32 { p / px(1.0) }

fn capture(reg: &Rc<RefCell<HashMap<String, Bounds<Pixels>>>>, id: String) -> impl IntoElement {
    let reg = reg.clone();
    canvas(move |b, _, _| { reg.borrow_mut().insert(id, b); }, |_, _, _, _| {}).absolute().top_0().left_0().size_full()
}

/// A real OS window showing the children of a `window` node rendered by the shell.
pub struct Detached {
    shell: Entity<Shell>,
    id: String,
    _obs: Subscription,
}

impl Detached {
    fn new(shell: Entity<Shell>, id: String, cx: &mut Context<Self>) -> Self {
        let obs = cx.observe(&shell, |_, _, cx| cx.notify());
        Detached { shell, id, _obs: obs }
    }
}

impl Render for Detached {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let id = self.id.clone();
        let body = self.shell.update(cx, |sh, cx| sh.render_window_body(&id, window, cx));
        div().size_full().flex().flex_col().overflow_hidden().bg(cx.theme().background).text_color(cx.theme().foreground)
            .font_family(cx.theme().font_family.clone()).child(body)
    }
}

// Flex weights below one leave part of the available space unused in CSS flex layout.
// Normalize only flexible panes; fixed and collapsed panes must not consume their share.
fn split_grow_weights(sizes: &[f32], fixed: &[Option<f32>]) -> Vec<f32> {
    let weights: Vec<f32> = sizes.iter().enumerate().map(|(i, size)| {
        if fixed.get(i).copied().flatten().is_some() { 0.0 }
        else if size.is_finite() { size.max(0.0001) } else { 0.0001 }
    }).collect();
    let total: f32 = weights.iter().sum();
    weights.into_iter().map(|weight| if total > 0.0 { weight / total * 100.0 } else { 0.0 }).collect()
}

impl Shell {
    pub(super) fn begin_frame(&mut self) {
        self.lay.zones.clear();
        self.lay.floats.clear();
        self.lay.windows_wanted.clear();
    }

    // ---- split ---------------------------------------------------------------------------------

    pub(super) fn render_split(&mut self, module: &str, n: &Value, path: &str, key: &str, depth: usize, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let horizontal = n.get("direction").and_then(|d| d.as_str()) != Some("vertical");
        let id = format!("{module}::{path}");
        let kids = self.children(module, n, path, depth, window, cx);
        let count = kids.len().max(1);
        let mut node_sizes: Vec<f32> = n.get("sizes").and_then(|s| s.as_array()).map(|a| a.iter().filter_map(|x| x.as_f64().map(|v| v as f32)).collect()).unwrap_or_default();
        node_sizes.resize(count, 1.0 / count as f32);
        let mut fixed: Vec<Option<f32>> = n.get("fixed").and_then(|s| s.as_array()).map(|a| a.iter().map(|x| x.as_f64().map(|v| v as f32)).collect()).unwrap_or_default();
        fixed.resize(count, None);
        let mut collapsible: Vec<bool> = n.get("collapsible").and_then(|s| s.as_array()).map(|a| a.iter().map(|x| x.as_bool().unwrap_or(false)).collect()).unwrap_or_default();
        collapsible.resize(count, false);
        let sizes = match self.lay.split_overrides.get(&id) {
            Some((orig, cur)) if *orig == node_sizes && cur.len() == count => cur.clone(),
            Some(_) => {
                self.lay.split_overrides.remove(&id);
                node_sizes.clone()
            }
            None => node_sizes.clone(),
        };
        let resizable = n.get("resizable").and_then(|r| r.as_bool()).unwrap_or(true);
        let min = f(n, "minSize").unwrap_or(80.0);
        let resize_action = s(n, "resizeAction");
        let collapse_action = s(n, "collapseAction");
        let visible_count = fixed.iter().filter(|size| !matches!(size, Some(value) if *value <= 0.0)).count();
        let fixed_px: f32 = fixed.iter().flatten().copied().filter(|value| *value > 0.0).sum::<f32>() + DIVIDER * visible_count.saturating_sub(1) as f32;
        let grow_weights = split_grow_weights(&sizes, &fixed);
        let flexible: Vec<bool> = fixed.iter().map(|x| x.is_none()).collect();
        let border = cx.theme().border;
        let accent = cx.theme().primary;
        let mut d = if horizontal { h_flex() } else { v_flex() };
        d = self.apply_base(d, n, cx).flex_1().size_full().min_w_0().min_h_0().overflow_hidden().relative().items_stretch();
        d = d.child(capture(&self.lay.bounds, id.clone()));
        let mut previous_visible: Option<usize> = None;
        for (i, k) in kids.into_iter().enumerate() {
            if matches!(fixed[i], Some(size) if size <= 0.0) { continue; }
            if let Some(previous) = previous_visible {
                let can = resizable && fixed[previous].is_none() && fixed[i].is_none();
                let line = if horizontal { div().w(px(1.0)).h_full().bg(border) } else { div().h(px(1.0)).w_full().bg(border) };
                let mut dv = div().id(sid(module, &format!("{path}/divider{i}"))).flex_none().flex().items_center().justify_center().child(line);
                dv = if horizontal { dv.w(px(DIVIDER)).h_full() } else { dv.h(px(DIVIDER)).w_full() };
                if can {
                    dv = if horizontal { dv.cursor_col_resize() } else { dv.cursor_row_resize() };
                    dv = dv.hover(move |st| st.bg(accent.opacity(0.35)));
                    let (id2, m2, k2) = (id.clone(), module.to_string(), key.to_string());
                    let (ss, os, fl, ra, ca, co) = (sizes.clone(), node_sizes.clone(), flexible.clone(), resize_action.clone(), collapse_action.clone(), collapsible.clone());
                    dv = dv.on_mouse_down(MouseButton::Left, cx.listener(move |this, ev: &MouseDownEvent, _w, cx| {
                        this.lay.drag = Some(Drag::Split {
                            id: id2.clone(), module: m2.clone(), key: k2.clone(), horizontal, a: previous, b: i, start: ev.position,
                            start_sizes: ss.clone(), orig_sizes: os.clone(), flexible: fl.clone(), fixed_px, min,
                            resize_action: ra.clone(), collapse_action: ca.clone(), collapsible: co.clone(), collapse_req: None,
                        });
                        cx.stop_propagation();
                        cx.notify();
                    }));
                }
                d = d.child(dv);
            }
            previous_visible = Some(i);
            let mut cell = div().overflow_hidden().flex().flex_col().min_w_0().min_h_0();
            cell = match fixed[i] {
                Some(p) => if horizontal { cell.w(px(p)).h_full().flex_none() } else { cell.h(px(p)).w_full().flex_none() },
                None => {
                    let c = cell.flex_grow(grow_weights[i]).flex_shrink(1.0).flex_basis(px(0.0));
                    if horizontal { c.h_full() } else { c.w_full() }
                }
            };
            d = d.child(cell.child(div().size_full().min_w_0().min_h_0().overflow_hidden().flex().flex_col().child(k)));
        }
        d.into_any_element()
    }

    // ---- drag & drop -----------------------------------------------------------------------------

    pub(super) fn render_drag_handle(&mut self, module: &str, n: &Value, path: &str, key: &str, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let label = s(n, "label").unwrap_or_default();
        let payload = n.get("payload").cloned().unwrap_or(Value::Null);
        let click = s(n, "clickAction");
        let kids = self.children(module, n, path, 1, window, cx);
        let (m2, k2, l2) = (module.to_string(), key.to_string(), label.clone());
        let base = self.apply_base(div().flex().items_center().gap_1().cursor_grab().min_w_0().overflow_hidden(), n, cx);
        base.id(sid(module, path)).on_mouse_down(MouseButton::Left, cx.listener(move |this, ev: &MouseDownEvent, _w, cx| {
            this.lay.drag = Some(Drag::Item { module: m2.clone(), key: k2.clone(), payload: payload.clone(), label: l2.clone(), click_action: click.clone(), origin: ev.position, pos: ev.position, active: false, hover: None });
            cx.stop_propagation();
        }))
        .when(kids.is_empty(), |d| d.child(div().text_xs().text_color(cx.theme().muted_foreground).overflow_hidden().whitespace_nowrap().text_ellipsis().child(label.clone())))
        .children(kids)
        .into_any_element()
    }

    pub(super) fn render_drop_zone(&mut self, module: &str, n: &Value, path: &str, key: &str, depth: usize, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let id = format!("{module}::{path}");
        let regions: Vec<String> = n.get("regions").and_then(|r| r.as_array()).map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
            .unwrap_or_else(|| ["left", "right", "top", "bottom", "center"].iter().map(|s| s.to_string()).collect());
        self.lay.zones.insert(id.clone(), ZoneMeta { module: module.to_string(), key: key.to_string(), action: s(n, "action").unwrap_or_default(), regions });
        let kids = self.children(module, n, path, depth, window, cx);
        let mut d = self.apply_base(v_flex(), n, cx).relative().min_w_0().min_h_0().overflow_hidden();
        if n.get("grow").is_none() {
            d = d.flex_1().size_full();
        }
        d = d.child(capture(&self.lay.bounds, id.clone())).children(kids);
        if let Some(Drag::Item { active: true, hover, .. }) = &self.lay.drag {
            let primary = cx.theme().primary;
            d = d.child(div().absolute().top_0().left_0().size_full().border_1().border_color(primary.opacity(0.25)));
            if let Some((hid, region)) = hover {
                if *hid == id {
                    let o = div().absolute().bg(primary.opacity(0.22)).border_2().border_color(primary);
                    let o = match region.as_str() {
                        "left" => o.top_0().left_0().h_full().w(relative(0.5)),
                        "right" => o.top_0().right_0().h_full().w(relative(0.5)),
                        "top" => o.top_0().left_0().w_full().h(relative(0.5)),
                        "bottom" => o.bottom_0().left_0().w_full().h(relative(0.5)),
                        _ => o.top(relative(0.15)).left(relative(0.15)).w(relative(0.7)).h(relative(0.7)),
                    };
                    d = d.child(o);
                }
            }
        }
        d.into_any_element()
    }

    fn zone_at(&self, pos: Point<Pixels>) -> Option<(String, String)> {
        let bounds = self.lay.bounds.borrow();
        let mut best: Option<(String, f32, Bounds<Pixels>)> = None;
        for id in self.lay.zones.keys() {
            if let Some(b) = bounds.get(id) {
                if b.contains(&pos) {
                    let area = px_f(b.size.width) * px_f(b.size.height);
                    if best.as_ref().map(|x| area < x.1).unwrap_or(true) {
                        best = Some((id.clone(), area, *b));
                    }
                }
            }
        }
        let (id, _, b) = best?;
        let meta = self.lay.zones.get(&id)?;
        let rx = px_f(pos.x - b.origin.x) / px_f(b.size.width).max(1.0);
        let ry = px_f(pos.y - b.origin.y) / px_f(b.size.height).max(1.0);
        let edges = [("left", rx), ("right", 1.0 - rx), ("top", ry), ("bottom", 1.0 - ry)];
        let near = edges.iter().filter(|(r, _)| meta.regions.iter().any(|x| x == r)).min_by(|a, b| a.1.partial_cmp(&b.1).unwrap()).cloned();
        let has_center = meta.regions.iter().any(|x| x == "center");
        let region = match near {
            Some((r, d)) if d < 0.25 || !has_center => r.to_string(),
            _ if has_center => "center".to_string(),
            Some((r, _)) => r.to_string(),
            None => return None,
        };
        Some((id, region))
    }

    // ---- floating panels -----------------------------------------------------------------------

    pub(super) fn render_float(&mut self, module: &str, path: &str, n: &Value, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let key = n.get("key").and_then(|k| k.as_str()).unwrap_or("_").to_string();
        let id = format!("{module}::{path}");
        let node_g = [f(n, "x").unwrap_or(80.0), f(n, "y").unwrap_or(80.0), f(n, "width").unwrap_or(420.0), f(n, "height").unwrap_or(320.0)];
        let mut g = match self.lay.float_overrides.get(&id) {
            Some((orig, cur)) if *orig == node_g => *cur,
            Some(_) => {
                self.lay.float_overrides.remove(&id);
                node_g
            }
            None => node_g,
        };
        let vp = window.viewport_size();
        let (vw, vh) = (px_f(vp.width), px_f(vp.height));
        g[2] = g[2].clamp(160.0, vw.max(160.0));
        g[3] = g[3].clamp(100.0, vh.max(100.0));
        g[0] = g[0].clamp(0.0, (vw - 60.0).max(0.0));
        g[1] = g[1].clamp(0.0, (vh - 30.0).max(0.0));
        let title = s(n, "title").unwrap_or_default();
        let action = s(n, "moveAction");
        let kids = self.children(module, n, path, 1, window, cx);
        let start = |resize: bool, id: String, module: String, key: String, action: Option<String>| {
            move |this: &mut Shell, ev: &MouseDownEvent, _w: &mut Window, cx: &mut Context<Shell>| {
                this.lay.drag = Some(Drag::Float { id: id.clone(), module: module.clone(), key: key.clone(), resize, start: ev.position, orig: g, node: node_g, action: action.clone() });
                cx.stop_propagation();
            }
        };
        let bar = h_flex().id(sid(module, &format!("{path}/bar"))).h(px(24.0)).flex_none().px_2().gap_2().bg(cx.theme().title_bar).cursor_move()
            .border_b_1().border_color(cx.theme().border)
            .on_mouse_down(MouseButton::Left, cx.listener(start(false, id.clone(), module.to_string(), key.clone(), action.clone())))
            .child(div().text_xs().font_weight(FontWeight::BOLD).overflow_hidden().whitespace_nowrap().text_ellipsis().child(title));
        let grip = div().id(sid(module, &format!("{path}/grip"))).absolute().right_0().bottom_0().w(px(14.0)).h(px(14.0)).cursor_nwse_resize()
            .child(div().absolute().right(px(3.0)).bottom(px(3.0)).w(px(7.0)).h(px(7.0)).border_r_2().border_b_2().border_color(cx.theme().muted_foreground))
            .on_mouse_down(MouseButton::Left, cx.listener(start(true, id.clone(), module.to_string(), key, action)));
        div().absolute().left(px(g[0])).top(px(g[1])).w(px(g[2])).h(px(g[3])).occlude().flex().flex_col().overflow_hidden()
            .bg(cx.theme().background).border_1().border_color(cx.theme().border).rounded(px(6.0)).shadow_lg()
            .child(bar)
            .child(div().flex_1().min_h_0().min_w_0().overflow_hidden().flex().flex_col().children(kids))
            .child(grip)
            .into_any_element()
    }

    // ---- pointer tracking during drags -----------------------------------------------------------

    pub(super) fn drag_overlay(&mut self, cx: &mut Context<Self>) -> Option<AnyElement> {
        self.lay.drag.as_ref()?;
        let weak = cx.entity().downgrade();
        let catcher = canvas(|_, _, _| (), move |_, _, window, _| {
            let w1 = weak.clone();
            window.on_mouse_event(move |e: &MouseMoveEvent, phase, _w, cx| {
                if phase == DispatchPhase::Capture {
                    let _ = w1.update(cx, |this, cx| this.drag_move(e.position, e.pressed_button.is_some(), cx));
                }
            });
            let w2 = weak.clone();
            window.on_mouse_event(move |e: &MouseUpEvent, phase, _w, cx| {
                if phase == DispatchPhase::Capture {
                    let _ = w2.update(cx, |this, cx| this.drag_end(e.position, cx));
                }
            });
        })
        .absolute().top_0().left_0().size_full();
        let mut root = div().absolute().top_0().left_0().size_full().child(catcher);
        if let Some(Drag::Item { active: true, pos, label, .. }) = &self.lay.drag {
            root = root.child(div().absolute().left(pos.x + px(14.0)).top(pos.y + px(10.0)).px_2().py_1().rounded(px(4.0)).text_xs()
                .bg(cx.theme().primary).text_color(cx.theme().primary_foreground).shadow_lg().child(label.clone()));
        }
        Some(root.into_any_element())
    }

    fn drag_move(&mut self, pos: Point<Pixels>, pressed: bool, cx: &mut Context<Self>) {
        if !pressed {
            self.drag_end(pos, cx);
            return;
        }
        let bounds = self.lay.bounds.clone();
        let mut zone_hover = None;
        if let Some(Drag::Item { origin, .. }) = &self.lay.drag {
            let dist = px_f(pos.x - origin.x).abs() + px_f(pos.y - origin.y).abs();
            if dist > 4.0 {
                zone_hover = Some(self.zone_at(pos));
            }
        }
        match self.lay.drag.as_mut() {
            Some(Drag::Split { id, horizontal, a, b, start, start_sizes, orig_sizes, flexible, fixed_px, min, collapsible, collapse_req, .. }) => {
                let Some(bx) = bounds.borrow().get(id.as_str()).cloned() else { return };
                let total = (if *horizontal { px_f(bx.size.width) } else { px_f(bx.size.height) } - *fixed_px).max(1.0);
                let frac_sum: f32 = start_sizes.iter().zip(flexible.iter()).filter(|(_, f)| **f).map(|(s, _)| *s).sum::<f32>().max(0.0001);
                let ppf = total / frac_sum;
                let delta = if *horizontal { px_f(pos.x - start.x) } else { px_f(pos.y - start.y) };
                let pair = (start_sizes[*a] + start_sizes[*b]) * ppf;
                let want_a = start_sizes[*a] * ppf + delta;
                let want_b = pair - want_a;
                *collapse_req = if collapsible[*a] && want_a < *min - COLLAPSE_SLACK { Some(*a) } else if collapsible[*b] && want_b < *min - COLLAPSE_SLACK { Some(*b) } else { None };
                let pa = want_a.clamp(min.min(pair / 2.0), (pair - *min).max(pair / 2.0));
                let mut cur = start_sizes.clone();
                cur[*a] = pa / ppf;
                cur[*b] = (pair - pa) / ppf;
                self.lay.split_overrides.insert(id.clone(), (orig_sizes.clone(), cur));
                cx.notify();
            }
            Some(Drag::Item { pos: p, active, hover, .. }) => {
                *p = pos;
                if let Some(h) = zone_hover {
                    *active = true;
                    *hover = h;
                }
                cx.notify();
            }
            Some(Drag::Float { id, resize, start, orig, node, .. }) => {
                let (dx, dy) = (px_f(pos.x - start.x), px_f(pos.y - start.y));
                let mut g = *orig;
                if *resize {
                    g[2] = (orig[2] + dx).max(160.0);
                    g[3] = (orig[3] + dy).max(100.0);
                } else {
                    g[0] = orig[0] + dx;
                    g[1] = orig[1] + dy;
                }
                self.lay.float_overrides.insert(id.clone(), (*node, g));
                cx.notify();
            }
            None => {}
        }
    }

    fn drag_end(&mut self, _pos: Point<Pixels>, cx: &mut Context<Self>) {
        let Some(drag) = self.lay.drag.take() else { return };
        match drag {
            Drag::Split { id, module, key, collapse_req, collapse_action, resize_action, .. } => {
                if let (Some(i), Some(a)) = (collapse_req, collapse_action) {
                    self.lay.split_overrides.remove(&id);
                    let inputs = self.module_inputs(&module);
                    Self::fire(&self.kernel, &module, &inputs, &a, &key, None, json!({"index": i}), cx);
                } else if let Some(a) = resize_action {
                    if let Some((_, cur)) = self.lay.split_overrides.get(&id) {
                        let inputs = self.module_inputs(&module);
                        Self::fire(&self.kernel, &module, &inputs, &a, &key, None, json!({"sizes": cur}), cx);
                    }
                }
            }
            Drag::Item { module, key, payload, active, hover, click_action, .. } => {
                if active {
                    if let Some((zid, region)) = hover {
                        if let Some(z) = self.lay.zones.get(&zid) {
                            let (zm, zk, za) = (z.module.clone(), z.key.clone(), z.action.clone());
                            let inputs = self.module_inputs(&zm);
                            Self::fire(&self.kernel, &zm, &inputs, &za, &zk, None, json!({"payload": payload, "region": region, "zone": zk}), cx);
                        }
                    }
                } else if let Some(a) = click_action {
                    let inputs = self.module_inputs(&module);
                    Self::fire(&self.kernel, &module, &inputs, &a, &key, None, payload, cx);
                }
            }
            Drag::Float { id, module, key, action, .. } => {
                if let (Some(a), Some((_, g))) = (action, self.lay.float_overrides.get(&id)) {
                    let inputs = self.module_inputs(&module);
                    Self::fire(&self.kernel, &module, &inputs, &a, &key, None, json!({"x": g[0], "y": g[1], "width": g[2], "height": g[3]}), cx);
                }
            }
        }
        cx.notify();
    }

    // ---- OS windows ----------------------------------------------------------------------------

    pub(super) fn note_window(&mut self, module: &str, path: &str, key: &str, n: &Value) {
        let id = format!("{module}::{key}");
        self.lay.window_nodes.insert(id.clone(), (module.to_string(), path.to_string(), n.clone()));
        self.lay.windows_wanted.push(id);
    }

    pub(super) fn render_window_body(&mut self, id: &str, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        match self.lay.window_nodes.get(id).cloned() {
            Some((module, path, n)) => {
                let kids = self.children(&module, &n, &path, 1, window, cx);
                v_flex().size_full().min_h_0().overflow_hidden().children(kids).into_any_element()
            }
            None => div().p_3().text_sm().child("This panel was re-docked.").into_any_element(),
        }
    }

    pub(super) fn sync_windows(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let wanted: HashSet<String> = self.lay.windows_wanted.iter().cloned().collect();
        self.lay.closed_by_user.retain(|id| wanted.contains(id));
        let to_open: Vec<String> = wanted.iter().filter(|id| !self.lay.windows.contains_key(*id) && !self.lay.closed_by_user.contains(*id)).cloned().collect();
        let to_close: Vec<String> = self.lay.windows.keys().filter(|id| !wanted.contains(*id)).cloned().collect();
        if to_open.is_empty() && to_close.is_empty() {
            return;
        }
        let _ = window;
        // Open/close OUTSIDE the Shell's update: a new window renders synchronously and its
        // content (Detached) needs to read the Shell.
        let shell = cx.entity();
        let handles: Vec<(String, AnyWindowHandle)> = to_close.iter().filter_map(|id| self.lay.windows.remove(id).map(|h| (id.clone(), h))).collect();
        let specs: Vec<(String, String, Value)> = to_open.iter().filter_map(|id| self.lay.window_nodes.get(id).map(|(m, _, n)| (id.clone(), m.clone(), n.clone()))).collect();
        let kernel = self.kernel.clone();
        cx.defer(move |cx| {
            for (_, h) in handles {
                let _ = h.update(cx, |_, window, _| window.remove_window());
            }
            for (id, module, n) in specs {
                open_detached(shell.clone(), kernel.clone(), id, module, n, cx);
            }
        });
    }
}

fn open_detached(shell: Entity<Shell>, _kernel: Arc<Kernel>, id: String, module: String, n: Value, cx: &mut App) {
    {
        if shell.read(cx).lay.windows.contains_key(&id) {
            return;
        }
        let (w, h) = (f(&n, "width").unwrap_or(720.0), f(&n, "height").unwrap_or(520.0));
        let title = s(&n, "title").unwrap_or_else(|| "Hato".into());
        let key = n.get("key").and_then(|k| k.as_str()).unwrap_or("_").to_string();
        let close_action = s(&n, "closeAction");
        let bounds = Bounds::centered(None, size(px(w), px(h)), cx);
        let opts = WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(bounds)),
            titlebar: if n["titlebar"].as_bool() == Some(false) { None } else { Some(TitlebarOptions { title: Some(title.into()), ..Default::default() }) },
            ..Default::default()
        };
        let id2 = id.clone();
        let window_shell = shell.clone();
        let r = gpui_kit::open_window(opts, cx, move |window, cx| {
            let (sh, id3, m, k, a) = (window_shell.clone(), id2.clone(), module.clone(), key.clone(), close_action.clone());
            window.on_window_should_close(cx, move |window, cx| {
                let b = window.bounds();
                let (bw, bh) = (px_f(b.size.width), px_f(b.size.height));
                let (id4, m2, k2, a2) = (id3.clone(), m.clone(), k.clone(), a.clone());
                sh.update(cx, |this, cx| {
                    this.lay.windows.remove(&id4);
                    this.lay.closed_by_user.insert(id4.clone());
                    if let Some(a) = a2 {
                        let inputs = this.module_inputs(&m2);
                        Shell::fire(&this.kernel, &m2, &inputs, &a, &k2, None, json!({"width": bw, "height": bh}), cx);
                    }
                    cx.notify();
                });
                true
            });
            cx.new(|cx| Detached::new(window_shell.clone(), id2.clone(), cx))
        });
        match r {
            Ok((handle, _)) => shell.update(cx, |this, _| { this.lay.windows.insert(id, handle); }),
            Err(e) => shell.update(cx, |this, cx| { this.toasts.push(("error".into(), format!("cannot open window: {e}"), Instant::now())); cx.notify(); }),
        }
    }
}

#[cfg(test)]
mod split_tests {
    use super::split_grow_weights;
    #[test]
    fn collapsed_panes_do_not_leave_unused_flex_space() {
        let weights = split_grow_weights(&[0.4, 0.2, 0.2, 0.2], &[None, Some(0.0), Some(0.0), None]);
        assert!((weights.iter().sum::<f32>() - 100.0).abs() < 0.001);
        assert_eq!(weights[1], 0.0);
        assert_eq!(weights[2], 0.0);
        assert!((weights[0] / weights[3] - 2.0).abs() < 0.001);
        assert_eq!(split_grow_weights(&[0.01, 0.99], &[None, Some(36.0)]), vec![100.0, 0.0]);
    }
}
