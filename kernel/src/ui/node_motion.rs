//! Motion for module-owned nodes. Window element state holds channels, while parent
//! state retains the descriptions of exiting children long enough to paint them.
use super::*;
use gpui_kit::base::{
    motion::{
        self as animate, Easing, SurfaceColor, SurfaceMotion, SurfaceOffset, SurfacePose,
        SurfacePresence, SurfaceStyles, SurfaceTiming, Transition,
    },
    surface_motion, TextSelection,
};
use std::{
    borrow::Cow,
    cell::{Cell, RefCell},
    rc::Rc,
};

pub(super) fn default_timing(ms: u64) -> SurfaceTiming {
    SurfaceTiming {
        duration: Duration::from_millis(ms),
        easing: Easing::cubic_bezier(0.2, 0., 0., 1.).expect("valid easing"),
    }
}

pub(super) fn policy(timing: &SurfaceTiming, cx: &App) -> Transition {
    let duration = match surface_motion(cx) {
        SurfaceMotion::Full => timing.duration,
        _ => Duration::ZERO,
    };
    Transition::new(duration).easing(timing.easing.clone())
}

pub(super) fn layout_id(module: &str, path: &str, n: &Value) -> ElementId {
    match n["layoutId"].as_str() {
        Some(shared) if !shared.is_empty() => {
            ElementId::Name(format!("{module}::layout::{shared}").into())
        }
        _ => ElementId::Name(sid(module, path)),
    }
}

fn dimensions<'a>(
    n: &'a Value,
    id: &ElementId,
    timing: &SurfaceTiming,
    window: &mut Window,
    cx: &mut App,
) -> (Cow<'a, Value>, bool) {
    let mut node = Cow::Borrowed(n);
    let mut resizing = false;
    for dim in ["width", "height"] {
        if n["type"] == "progress" && dim == "height" {
            continue;
        }
        let in_style = n["style"][dim].is_number();
        if let Some(target) = if in_style { &n["style"][dim] } else { &n[dim] }.as_f64() {
            let sample = animate::transition_with_status(
                (id.clone(), dim),
                target.clamp(0., 8192.) as f32,
                policy(timing, cx),
                window,
                cx,
            );
            let v = sample.value;
            resizing |= matches!(
                sample.status,
                animate::MotionStatus::Running | animate::MotionStatus::Delayed
            );
            if v != target.clamp(0., 8192.) as f32 {
                if in_style {
                    node.to_mut()["style"][dim] = json!(v.max(0.));
                } else {
                    node.to_mut()[dim] = json!(v.max(0.));
                }
            }
        }
    }
    (node, resizing)
}

pub(super) fn rotation(n: &Value, id: SharedString, window: &mut Window, cx: &mut App) -> f32 {
    let target = motion::number(&n["style"]["rotate"], 0., -36_000., 36_000.);
    let timing = motion::timing(&n["layoutTransition"]).or_else(|| {
        cx.try_global::<SurfaceStyles>()
            .and_then(|style| style.interaction.clone())
    });
    timing.map_or(target, |timing| {
        animate::transition((id, "rotation"), target, policy(&timing, cx), window, cx)
    })
}

#[derive(Default)]
struct Geometry {
    rect: Option<Bounds<Pixels>>,
    revision: u64,
    from: Point<Pixels>,
    start: Option<Instant>,
}

impl Geometry {
    fn offset(
        &mut self,
        bounds: Bounds<Pixels>,
        revision: u64,
        timing: &SurfaceTiming,
        now: Instant,
        full_motion: bool,
    ) -> (Point<Pixels>, bool) {
        if !full_motion || timing.duration.is_zero() {
            self.start = None;
        } else if let Some(old) = self
            .rect
            .filter(|old| self.revision != revision && old.origin != bounds.origin)
        {
            let offset = self.sample(old.origin, timing, now).0;
            self.from = old.origin + offset;
            self.start = Some(now);
        }
        self.rect = Some(bounds);
        self.revision = revision;
        self.sample(bounds.origin, timing, now)
    }

    fn sample(
        &mut self,
        target: Point<Pixels>,
        timing: &SurfaceTiming,
        now: Instant,
    ) -> (Point<Pixels>, bool) {
        if let Some(start) = self.start {
            let elapsed = now.saturating_duration_since(start);
            if elapsed < timing.duration {
                let t = timing
                    .easing
                    .sample(elapsed.as_secs_f32() / timing.duration.as_secs_f32());
                return ((self.from - target) * (1. - t), true);
            }
            self.start = None;
        }
        (Point::default(), false)
    }
}

#[cfg(test)]
mod geometry_tests {
    use super::{default_timing, motion, Geometry};
    use gpui_kit::{point, px, size, Bounds, Point};
    use std::time::{Duration, Instant};

    #[test]
    fn another_modules_tree_does_not_restart_a_layout_move() {
        let mut motion = motion::Motion::default();
        let mut geometry = Geometry::default();
        let timing = default_timing(280);
        let now = Instant::now();
        let rect = |x| Bounds::new(point(px(x), px(0.)), size(px(100.), px(30.)));
        geometry.offset(rect(0.), motion.revision("panel"), &timing, now, true);

        // A parent resize can move this panel without a new snapshot from its owner.
        // A simultaneous update from another module must not animate that movement.
        motion.tree_changed("other");
        let (offset, active) = geometry.offset(
            rect(20.), motion.revision("panel"), &timing, now, true,
        );
        assert_eq!(offset, Point::default());
        assert!(!active);

        // Moves caused by a snapshot from the owner still animate.
        motion.tree_changed("panel");
        let (offset, active) = geometry.offset(
            rect(40.), motion.revision("panel"), &timing, now, true,
        );
        assert_eq!(offset.x, px(-20.));
        assert!(active);
        let started = geometry.start;

        motion.tree_changed("other");
        geometry.offset(
            rect(42.), motion.revision("panel"), &timing,
            now + Duration::from_millis(20), true,
        );
        assert_eq!(geometry.start, started);
    }
}

struct NodeGeometry {
    child: AnyElement,
    timing: SurfaceTiming,
    geometry: Rc<RefCell<Geometry>>,
    height: Option<Rc<Cell<Option<f32>>>>,
    clip: bool,
    resizing: bool,
    revision: u64,
}

impl IntoElement for NodeGeometry {
    type Element = Self;
    fn into_element(self) -> Self {
        self
    }
}

impl Element for NodeGeometry {
    type RequestLayoutState = ();
    type PrepaintState = Option<ContentMask<Pixels>>;

    fn id(&self) -> Option<ElementId> {
        None
    }
    fn source_location(&self) -> Option<&'static std::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, ()) {
        (self.child.request_layout(window, cx), ())
    }

    fn prepaint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _: &mut (),
        window: &mut Window,
        cx: &mut App,
    ) -> Self::PrepaintState {
        if let Some(height) = &self.height {
            let measured = f32::from(bounds.size.height);
            if height.replace(Some(measured)) != Some(measured) {
                { crate::ui::redraw_stats::cause(concat!("anim:", file!(), ":", line!())); window.request_animation_frame(); }
            }
        }
        let (offset, active) = self.geometry.borrow_mut().offset(
            bounds,
            self.revision,
            &self.timing,
            cx.background_executor().now(),
            surface_motion(cx) == SurfaceMotion::Full,
        );
        if active {
            { crate::ui::redraw_stats::cause(concat!("anim:", file!(), ":", line!())); window.request_animation_frame(); }
        }
        let mask = (self.clip && (active || self.resizing)).then(|| ContentMask {
            bounds: Bounds::new(bounds.origin + offset, bounds.size),
        });
        window.with_content_mask(mask, |window| {
            window.with_element_offset(offset, |window| self.child.prepaint(window, cx));
        });
        mask
    }

    fn paint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        _: Bounds<Pixels>,
        _: &mut (),
        mask: &mut Self::PrepaintState,
        window: &mut Window,
        cx: &mut App,
    ) {
        window.with_content_mask(*mask, |window| self.child.paint(window, cx));
    }
}

#[derive(Default)]
pub(super) struct PresenceList {
    seen: u64,
    children: HashMap<SharedString, PresenceChild>,
}

#[derive(Default)]
struct PresenceChild {
    node: Value,
    index: usize,
    presence: SurfacePresence,
    height_motion: SurfacePresence,
    height: Rc<Cell<Option<f32>>>,
    left: Option<Instant>,
}

impl Shell {
    pub(super) fn motion_node(
        &mut self,
        module: &str,
        n: &Value,
        parent: &str,
        depth: usize,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let timing = motion::timing(&n["layoutTransition"]);
        if timing.is_none() && !n["layoutId"].is_string() {
            return self.render_node(module, n, parent, depth, window, cx);
        }
        let key = n["key"].as_str().unwrap_or("_");
        let path = format!("{parent}/{key}");
        let id = layout_id(module, &path, n);
        let timing = timing.unwrap_or_else(|| default_timing(280));
        let (target, resizing) = dimensions(n, &id, &timing, window, cx);
        let geometry = window
            .use_keyed_state((id.clone(), "layout-geometry"), cx, |_, _| {
                Rc::<RefCell<Geometry>>::default()
            })
            .read(cx)
            .clone();

        // An intrinsic height stays owned by the contents. The outer box reserves the
        // interpolated height, and the unclamped inner box measures the next target.
        let intrinsic = matches!(n["type"].as_str(), Some("column" | "row"))
            && n["layoutTransition"].is_object()
            && n["height"].is_null()
            && n["style"]["height"].is_null()
            && n["grow"] != true
            && n["style"]["position"] != "absolute";
        let height = intrinsic.then(|| {
            window
                .use_keyed_state((id.clone(), "intrinsic-height"), cx, |_, _| {
                    Rc::<Cell<Option<f32>>>::default()
                })
                .read(cx)
                .clone()
        });
        let child = self.render_node(module, &target, parent, depth, window, cx);
        let child = NodeGeometry {
            child,
            geometry,
            timing: timing.clone(),
            height: height.clone(),
            clip: n["style"]["clip"] != false,
            resizing,
            revision: self.motion.revision(module),
        };
        if let Some(height) = height {
            let show = surface_motion(cx) == SurfaceMotion::Full;
            let allocation = height.get().map(|target| {
                animate::transition_with_status(
                    (id, "intrinsic-allocation"),
                    target,
                    policy(&timing, cx),
                    window,
                    cx,
                )
            });
            return group_frame(&target)
                .when_some(allocation.filter(|_| show), |d, sample| {
                    let sizing = matches!(
                        sample.status,
                        animate::MotionStatus::Running | animate::MotionStatus::Delayed
                    );
                    // Once the height settles, the child and its ancestors own clipping.
                    d.h(px(sample.value.max(0.)))
                        .when(sizing && n["style"]["clip"] != false, |d| {
                            d.overflow_hidden()
                        })
                })
                .child(child)
                .into_any_element();
        }
        child.into_any_element()
    }

    pub(super) fn presence_children(
        &mut self,
        module: &str,
        nodes: &[Value],
        path: &str,
        depth: usize,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Vec<(bool, AnyElement)> {
        let id = (window.window_handle().window_id(), sid(module, path));
        let mut state = self.motion.children.remove(&id).unwrap_or_default();
        let now = cx.background_executor().now();
        let mode = surface_motion(cx);
        let mut out = Vec::with_capacity(nodes.len());
        let mut live = HashSet::new();
        for (index, node) in nodes.iter().enumerate() {
            let absolute = node["style"]["position"] == "absolute";
            let descriptor = &node["presence"];
            let mut visual = Cow::Borrowed(node);
            if descriptor.is_object() && node["style"]["position"] == "absolute" {
                visual.to_mut()["style"]["position"] = json!("relative");
            }
            let element = self.node(module, &visual, path, depth, window, cx);
            if let Some(key) = node["key"].as_str().filter(|_| descriptor.is_object()) {
                let key: SharedString = key.into();
                let child = state.children.entry(key.clone()).or_default();
                if child.node != *node {
                    child.node = node.clone();
                }
                child.index = index;
                child.left = None;
                live.insert(key);
                out.push((
                    absolute,
                    child.frame(element, true, mode, now, window).unwrap(),
                ));
            } else {
                out.push((absolute, element));
            }
        }
        let mut exits = Vec::new();
        state.children.retain(|key, child| {
            if live.contains(key) {
                return true;
            }
            if nodes
                .iter()
                .any(|node| node["key"].as_str() == Some(key.as_ref()))
                || mode == SurfaceMotion::Off
                || !child.node["presence"]["exit"].is_object()
            {
                return false;
            }
            let elapsed = now.saturating_duration_since(*child.left.get_or_insert(now));
            let element = self.passive_node(&child.node, elapsed, mode, 0, cx);
            if let Some(exit) = child.frame(element, false, mode, now, window) {
                exits.push((
                    child.index,
                    key.clone(),
                    (child.node["style"]["position"] == "absolute", exit),
                ));
                return true;
            }
            false
        });
        exits.sort_by(|a, b| (a.0, &a.1).cmp(&(b.0, &b.1)));
        for (index, _, exit) in exits {
            out.insert(index.min(out.len()), exit);
        }
        if !state.children.is_empty() {
            state.seen = self.motion.frame;
            self.motion.children.insert(id, state);
        }
        out
    }

    pub(super) fn prune_presence(&mut self, window: &Window) {
        let id = window.window_handle().window_id();
        self.motion
            .children
            .retain(|key, children| key.0 != id || children.seen == self.motion.frame);
    }

    fn passive_node(
        &self,
        n: &Value,
        elapsed: Duration,
        mode: SurfaceMotion,
        depth: usize,
        cx: &App,
    ) -> AnyElement {
        let ty = n["type"].as_str().unwrap_or("");
        let mut box_node = match ty {
            "row" => h_flex().items_center(),
            "button" => h_flex().items_center().gap_1().text_sm(),
            "label" => label_style(div(), n, cx, false),
            _ => v_flex(),
        };
        if depth < 64 {
            box_node = box_node.children(
                n["children"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .take(2000)
                    .map(|child| self.passive_node(child, elapsed, mode, depth + 1, cx)),
            );
        }
        let mut base = Cow::Borrowed(n);
        if n["windowDrag"] == true {
            base.to_mut()["windowDrag"] = Value::Bool(false);
        }
        if depth == 0 && n["presence"].is_object() && n["style"]["position"] == "absolute" {
            base.to_mut()["style"]["position"] = json!("relative");
        }
        box_node = self.apply_base(box_node, &base, cx);
        match ty {
            "label" | "button" | "status" | "choice" | "switch" => {
                let text = n["text"].as_str().or(n["label"].as_str()).unwrap_or("");
                let text = if mode == SurfaceMotion::Full {
                    scramble(text, &n["conceal"], elapsed, true).0
                } else {
                    text.to_owned()
                };
                if let Some(svg) = n["iconSvg"].as_str() {
                    box_node = box_node.child(icon(
                        svg,
                        n["iconSize"].as_f64(),
                        n["iconColor"].as_str(),
                        0.,
                        cx,
                    ));
                }
                spaced_label(box_node, n, text).into_any_element()
            }
            "textInput" => box_node
                .child(
                    n["value"]
                        .as_str()
                        .or(n["placeholder"].as_str())
                        .unwrap_or("")
                        .to_owned(),
                )
                .into_any_element(),
            "icon" => box_node
                .child(icon(
                    n["svg"].as_str().unwrap_or(""),
                    n["size"].as_f64(),
                    n["color"].as_str(),
                    motion::number(&n["style"]["rotate"], 0., -36_000., 36_000.),
                    cx,
                ))
                .into_any_element(),
            "progress" => box_node
                .child(progress_bar(
                    n,
                    n["value"].as_f64().map(|v| v.clamp(0., 1.) as f32),
                    style::color_of(cx, n, "color").unwrap_or(cx.theme().primary),
                    style::color_of(cx, n, "trackColor").unwrap_or(cx.theme().muted),
                ))
                .into_any_element(),
            _ => box_node.into_any_element(),
        }
    }
}

impl PresenceChild {
    fn frame(
        &mut self,
        element: AnyElement,
        live: bool,
        mode: SurfaceMotion,
        now: Instant,
        window: &Window,
    ) -> Option<AnyElement> {
        let descriptor = &self.node["presence"];
        let mut transition = motion::transition(descriptor).unwrap_or_default();
        let delay = if mode == SurfaceMotion::Full {
            Duration::from_secs_f32(
                motion::number(&self.node["presenceDelayMs"], 0., 0., 30_000.) / 1000.,
            )
        } else {
            Duration::ZERO
        };
        let (pose, active) = self
            .presence
            .sample_delayed(live, &transition, mode, now, delay);
        let (extent, sizing) = extent_pose(
            &mut self.height_motion,
            live,
            &mut transition,
            mode,
            now,
            delay,
            |leg| descriptor[leg]["heightCollapse"] == true,
        );
        if !live && !active && !sizing {
            return None;
        }
        if active || sizing {
            { crate::ui::redraw_stats::cause(concat!("anim:", file!(), ":", line!())); window.request_animation_frame(); }
        }
        let height = self.height.clone();
        let measured = height.get();
        let measure = self.node["presence"]["enter"]["heightCollapse"] == true
            || self.node["presence"]["exit"]["heightCollapse"] == true;
        let mut frame = group_frame(&self.node).opacity(pose.opacity);
        if self.node["style"]["position"] != "absolute" && self.node["layoutTransition"].is_object()
        {
            // A width animated by the child must still participate in normal flex sizing.
            frame = if self.node["style"]["fullWidth"] == true {
                frame.w_full()
            } else {
                frame.w_auto()
            };
        }
        if sizing {
            frame = frame
                .h(px(measured.unwrap_or(0.) * extent))
                .overflow_hidden();
        }
        if measure && live {
            frame = frame.on_children_prepainted(move |children, window, _| {
                if let Some(child) = children.first() {
                    let target = f32::from(child.size.height);
                    if height.replace(Some(target)) != Some(target) && sizing {
                        { crate::ui::redraw_stats::cause(concat!("anim:", file!(), ":", line!())); window.request_animation_frame(); }
                    }
                }
            });
        }
        Some(
            frame
                .child(SurfaceOffset::new(element, pose.offset))
                .into_any_element(),
        )
    }
}

pub(super) fn extent_pose(
    state: &mut SurfacePresence,
    live: bool,
    transition: &mut animate::SurfaceTransition,
    mode: SurfaceMotion,
    now: Instant,
    delay: Duration,
    collapse: impl Fn(&str) -> bool,
) -> (f32, bool) {
    // The underlying presence sampler interpolates independent scalar channels.
    // Use opacity for the visible fraction so this flight can share its reversal semantics.
    for (name, leg) in [
        ("enter", &mut transition.enter),
        ("exit", &mut transition.exit),
    ] {
        if let Some(leg) = leg {
            leg.pose = SurfacePose {
                opacity: if collapse(name) { 0. } else { 1. },
                offset: Point::default(),
            };
        }
    }
    let mode = if mode == SurfaceMotion::Full {
        mode
    } else {
        SurfaceMotion::Off
    };
    let (pose, active) = state.sample_delayed(live, transition, mode, now, delay);
    (pose.opacity, active)
}

fn group_frame(n: &Value) -> Div {
    let mut d = style::position(v_flex().min_h_0().min_w_0(), &n["style"]);
    if n["grow"] == true {
        d = d.flex_1();
    } else {
        d = d.flex_shrink_0();
    }
    if n["style"]["fullWidth"] == true {
        d = d.w_full();
    }
    if let Some(width) = n["style"]["width"].as_f64().or(n["width"].as_f64()) {
        d = d.w(px(width.clamp(0., 8192.) as f32));
    }
    if let Some(width) = n["minWidth"].as_f64() {
        d = d.min_w(px(width.clamp(0., 8192.) as f32));
    }
    d
}

pub(super) fn label_style(mut d: Div, n: &Value, cx: &App, wrap: bool) -> Div {
    d = match n["size"].as_str() {
        Some("xs") => d.text_xs(),
        Some("md") => d.text_base(),
        Some("lg") => d.text_lg(),
        _ => d.text_sm(),
    };
    d = match n["weight"].as_str() {
        Some("bold") => d.font_weight(FontWeight::BOLD),
        Some("semibold") => d.font_weight(FontWeight::SEMIBOLD),
        Some("medium") => d.font_weight(FontWeight::MEDIUM),
        Some("normal") => d.font_weight(FontWeight::NORMAL),
        _ => d,
    };
    if let Some(color) = n["color"].as_str().filter(|c| *c != "default") {
        d = d.text_color(theme::color(cx, color, cx.theme().foreground));
    }
    if n["mono"] == true {
        d = d.font_family(cx.theme().mono_font_family.clone());
    }
    if wrap {
        d.min_w_0()
    } else {
        d.overflow_hidden().whitespace_nowrap().text_ellipsis()
    }
}

pub(super) fn icon(
    svg: &str,
    size: Option<f64>,
    color: Option<&str>,
    angle: f32,
    cx: &App,
) -> gpui_component::Icon {
    let mut icon = gpui_component::Icon::default()
        .data(svg.as_bytes())
        .with_size(px(size.unwrap_or(16.).clamp(1., 512.) as f32));
    if let Some(color) = color {
        icon = icon.text_color(theme::color(cx, color, cx.theme().foreground));
    }
    if angle != 0. {
        icon = icon.rotate(radians(angle.to_radians()));
    }
    icon
}

#[derive(Default)]
struct LabelState {
    text: Option<String>,
    started: Option<Instant>,
}

pub(super) fn label_text(n: &Value, id: SharedString, window: &mut Window, cx: &mut App) -> String {
    let text = n["text"].as_str().unwrap_or("");
    let tween = &n["tween"];
    if let Some((format, target, suffix)) = number_target(tween, text) {
        let from = tween["from"]
            .as_f64()
            .map(|n| n as f32)
            .filter(|n| n.is_finite());
        let fresh = window.use_keyed_state(
            (ElementId::from(id.clone()), "number-mounted"),
            cx,
            |_, _| Cell::new(true),
        );
        let first = fresh.read(cx).replace(false);
        if let Some(from) = from.filter(|_| first) {
            animate::transition(
                (id.clone(), "number"),
                from,
                Transition::new(Duration::ZERO),
                window,
                cx,
            );
        }
        let timing = SurfaceTiming {
            duration: Duration::from_secs_f32(
                motion::number(&tween["durationMs"], 180., 0., 30_000.) / 1000.,
            ),
            ..default_timing(180)
        };
        let value = animate::transition((id, "number"), target, policy(&timing, cx), window, cx);
        return match format {
            "fixed1" => format!("{value:.1}{suffix}"),
            "percent" => format!("{value:.0}%{suffix}"),
            _ => format!("{value:.0}{suffix}"),
        };
    }
    let reveal = &n["reveal"];
    if reveal["effect"] != "scramble" {
        return text.to_owned();
    }
    let now = cx.background_executor().now();
    let mode = surface_motion(cx);
    let state = window.use_keyed_state((ElementId::from(id), "scramble"), cx, |_, _| {
        LabelState::default()
    });
    let started = state.update(cx, |state, _| {
        if state.text.as_deref() != Some(text) {
            let animate = if reveal["on"] == "change" {
                state.text.is_some()
            } else {
                state.text.is_none()
            };
            state.text = Some(text.to_owned());
            state.started = animate.then_some(now);
        }
        if mode != SurfaceMotion::Full {
            state.started = None;
        }
        state.started
    });
    let Some(started) = started else {
        return text.to_owned();
    };
    let (sample, active) = scramble(text, reveal, now.saturating_duration_since(started), false);
    if active {
        { crate::ui::redraw_stats::cause(concat!("anim:", file!(), ":", line!())); window.request_animation_frame(); }
    } else {
        state.update(cx, |state, _| state.started = None);
    }
    sample
}

fn number_target<'a>(tween: &'a Value, text: &'a str) -> Option<(&'a str, f32, &'a str)> {
    let format = tween["format"].as_str()?;
    let text = text.trim_start();
    let (end, _) = text
        .char_indices()
        .find(|(_, ch)| !matches!(ch, '0'..='9' | '.' | '-' | '+'))
        .unwrap_or((text.len(), ' '));
    let target = text[..end].parse::<f32>().ok().filter(|n| n.is_finite())?;
    let suffix = &text[end..];
    let suffix = if format == "percent" {
        suffix.strip_prefix('%').unwrap_or(suffix)
    } else {
        suffix
    };
    Some((format, target, suffix))
}

fn scramble(text: &str, config: &Value, elapsed: Duration, reverse: bool) -> (String, bool) {
    if config["effect"] != "scramble" || text.is_empty() {
        return (text.to_owned(), false);
    }
    let delay = motion::number(&config["delayMs"], 0., 0., 30_000.);
    let step = motion::number(&config["charMs"], 22., 1., 1000.);
    let extent = text.chars().count();
    let duration = motion::number(
        &config["durationMs"],
        (extent as f32 * step).into(),
        0.,
        30_000.,
    );
    let elapsed_ms = elapsed.as_secs_f32() * 1000.;
    let playback = elapsed_ms - delay;
    if playback >= duration || duration == 0. {
        return (
            if reverse {
                text.chars().map(|_| ' ').collect()
            } else {
                text.to_owned()
            },
            false,
        );
    }
    if reverse && playback < 0. {
        return (text.to_owned(), true);
    }
    if playback < 0. {
        return (text.chars().map(|_| ' ').collect(), true);
    }
    let resolved = (extent as f32 * (playback / duration)) as usize;
    let charset: Vec<char> = config["charset"]
        .as_str()
        .filter(|s| !s.is_empty())
        .unwrap_or("/>\\=_#%*")
        .chars()
        .take(256)
        .collect();
    let frame = (playback.max(0.) / step) as u64;
    let sample = text
        .chars()
        .enumerate()
        .map(|(index, ch)| {
            if ch.is_whitespace()
                || if reverse {
                    index < extent - resolved
                } else {
                    index < resolved
                }
            {
                ch
            } else {
                charset[(random(frame.wrapping_mul(4099).wrapping_add(index as u64)) as usize)
                    % charset.len()]
            }
        })
        .collect();
    (sample, true)
}

pub(super) fn spaced_label(d: Div, n: &Value, text: String) -> Div {
    let spacing = motion::number(&n["style"]["letterSpacing"], 0., -8., 32.);
    if spacing == 0. || n["wrap"] == true || n["selectable"] == true {
        return d.child(text);
    }
    let runs = text.chars().enumerate().map(|(i, ch)| {
        div()
            .flex_none()
            .when(i > 0, |d| d.ml(px(spacing)))
            .child(ch.to_string())
    });
    d.child(h_flex().children(runs))
}

pub(super) fn progress_bar(n: &Value, value: Option<f32>, color: Hsla, track: Hsla) -> Div {
    let height = motion::number(
        &n["height"],
        if value.is_some() { 4. } else { 2. },
        0.,
        256.,
    );
    let bar = div().h(px(height)).w_full().overflow_hidden();
    if let Some(value) = value {
        bar.bg(track)
            .child(div().h_full().w(relative(value.clamp(0., 1.))).bg(color))
    } else {
        bar.bg(if n["trackColor"].is_string() {
            track
        } else {
            color.opacity(0.5)
        })
    }
}

impl Shell {
    pub(super) fn render_progress(
        &self,
        n: &Value,
        id: SharedString,
        window: &mut Window,
        cx: &mut App,
    ) -> AnyElement {
        let label = n["label"].as_str().unwrap_or("");
        let mut value = n["value"].as_f64().map(|v| v.clamp(0., 1.) as f32);
        let mut color = SurfaceColor(style::color_of(cx, n, "color").unwrap_or(cx.theme().primary));
        let mut track =
            SurfaceColor(style::color_of(cx, n, "trackColor").unwrap_or(cx.theme().muted));
        if let Some(timing) = motion::timing(&n["transition"]) {
            let timing = policy(&timing, cx);
            value = value.map(|v| {
                animate::transition(
                    (id.clone(), "progress-value"),
                    v,
                    timing.clone(),
                    window,
                    cx,
                )
            });
            color = animate::transition(
                (id.clone(), "progress-color"),
                color,
                timing.clone(),
                window,
                cx,
            );
            track = animate::transition((id, "progress-track"), track, timing, window, cx);
        }
        // On progress, height describes the track. style.height still sizes the wrapper.
        let mut base = Cow::Borrowed(n);
        if n["height"].is_number() {
            base.to_mut().as_object_mut().unwrap().remove("height");
        }
        self.apply_base(v_flex(), &base, cx)
            .gap_1()
            .child(progress_bar(n, value, color.0, track.0))
            .when(!label.is_empty(), |d| {
                d.child(
                    div()
                        .text_xs()
                        .text_color(cx.theme().muted_foreground)
                        .child(label.to_owned()),
                )
            })
            .into_any_element()
    }
}

pub(super) fn random(mut seed: u64) -> u32 {
    seed = (seed ^ (seed >> 30)).wrapping_mul(0xbf58476d1ce4e5b9);
    seed = (seed ^ (seed >> 27)).wrapping_mul(0x94d049bb133111eb);
    (seed ^ (seed >> 31)) as u32
}

pub(super) struct TooltipSpec {
    text: String,
    keys: Vec<String>,
    pub placement: Option<gpui_component::Placement>,
}

pub(super) fn tooltip(n: &Value) -> Option<TooltipSpec> {
    use gpui_component::Placement;
    Some(TooltipSpec {
        text: n["tooltip"]
            .as_str()
            .filter(|text| !text.is_empty())?
            .to_owned(),
        keys: n["tooltipKeys"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .filter(|key| !key.is_empty())
            .take(16)
            .map(str::to_owned)
            .collect(),
        placement: match n["tooltipPlacement"].as_str() {
            Some("top") => Some(Placement::Top),
            Some("right") => Some(Placement::Right),
            Some("bottom") => Some(Placement::Bottom),
            Some("left") => Some(Placement::Left),
            _ => None,
        },
    })
}

impl TooltipSpec {
    pub(super) fn build(&self, window: &mut Window, cx: &mut App) -> AnyView {
        use gpui_component::tooltip::Tooltip;
        if self.keys.is_empty() {
            return Tooltip::new(self.text.clone()).build(window, cx);
        }
        let text = self.text.clone();
        let keys = self.keys.clone();
        Tooltip::element(move |_, cx| {
            h_flex()
                .items_center()
                .gap_1()
                .child(div().mr_1().child(text.clone()))
                .children(keys.iter().map(|key| {
                    div()
                        .text_xs()
                        .font_family(cx.theme().mono_font_family.clone())
                        .rounded(px(3.))
                        .px_1()
                        .border_1()
                        .border_color(cx.theme().border)
                        .bg(cx.theme().muted)
                        .child(key.clone())
                }))
        })
        .build(window, cx)
    }
}

#[derive(Default)]
struct PointerState {
    hover: Cell<bool>,
    down: Cell<bool>,
}

impl Shell {
    pub(super) fn interactive_container(
        &self,
        mut d: Div,
        n: &Value,
        module: &str,
        path: &str,
        window: &mut Window,
        cx: &mut App,
    ) -> AnyElement {
        use gpui_component::tooltip::ManagedTooltipExt;
        let action = n["action"].as_str().filter(|a| !a.is_empty());
        let tip = tooltip(n);
        let stateful = n["hoverStyle"].is_object() || n["pressedStyle"].is_object();
        if action.is_none() && tip.is_none() && !stateful {
            return d.into_any_element();
        }
        let id = sid(module, path);
        let mut hover_style = style::apply(StyleRefinement::default(), &n["hoverStyle"], cx);
        let mut pressed_style = style::apply(StyleRefinement::default(), &n["pressedStyle"], cx);
        let timing = cx
            .try_global::<SurfaceStyles>()
            .and_then(|style| style.interaction.clone());
        let view = window.current_view();
        let hover = if let Some(timing) = timing.filter(|_| stateful) {
            let state = window
                .use_keyed_state((ElementId::from(id.clone()), "pointer"), cx, |_, _| {
                    Rc::<PointerState>::default()
                })
                .read(cx)
                .clone();
            // A gradient fill has no single colour: hover interpolates from the style's solid
            // `background` instead, and the gradient stays painted whenever the row is at rest.
            let gradient = n["style"]["gradient"].is_object();
            let idle = if gradient {
                style::color_of(cx, &n["style"], "background").unwrap_or(transparent_black())
            } else {
                d.style()
                    .background
                    .as_ref()
                    .and_then(Fill::color)
                    .and_then(|bg| bg.as_solid())
                    .unwrap_or(transparent_black())
            };
            let over = style::color_of(cx, &n["hoverStyle"], "background").unwrap_or(idle);
            let down = style::color_of(cx, &n["pressedStyle"], "background").unwrap_or(over);
            let target = match (state.hover.get(), state.down.get()) {
                (true, true) => down,
                (true, false) => over,
                _ => idle,
            };
            let bg = animate::transition(
                (id.clone(), "interaction"),
                SurfaceColor(target),
                policy(&timing, cx),
                window,
                cx,
            );
            let resting = gradient && !state.hover.get() && !state.down.get() && bg.0 == idle;
            if !resting {
                d = d.bg(bg.0);
            }
            hover_style.background = None;
            pressed_style.background = None;

            let press = state.clone();
            let release = state.clone();
            let release_out = state.clone();
            d = d
                .on_mouse_down(MouseButton::Left, move |_, _, cx| {
                    press.hover.set(true);
                    press.down.set(true);
                    cx.notify(view);
                })
                .on_mouse_up(MouseButton::Left, move |_, _, cx| {
                    release.down.set(false);
                    cx.notify(view);
                })
                .on_mouse_up_out(MouseButton::Left, move |_, _, cx| {
                    release_out.down.set(false);
                    cx.notify(view);
                });
            Some(
                Rc::new(move |hovered: &bool, _: &mut Window, cx: &mut App| {
                    state.hover.set(*hovered);
                    cx.notify(view);
                }) as Rc<dyn Fn(&bool, &mut Window, &mut App)>,
            )
        } else {
            None
        };
        let mut d = d
            .id(id)
            .when(n["hoverStyle"].is_object(), |d| d.hover(|_| hover_style))
            .when(n["pressedStyle"].is_object(), |d| {
                d.active(|_| pressed_style)
            });
        if let Some(action) = action {
            let id = ElementId::from(sid(module, path));
            let focus = window.use_keyed_state((id.clone(), "container-focus"), cx, |_, cx| {
                cx.focus_handle().tab_stop(true)
            });
            let text_press =
                window.use_keyed_state((id, "container-text-press"), cx, |_, _| Cell::new(false));
            let track_text_press = text_press.clone();
            let focus = focus.read(cx).clone();
            let kernel = self.kernel.clone();
            let module = module.to_owned();
            let inputs = self.module_inputs(&module);
            let action = action.to_owned();
            let key = n["key"].as_str().unwrap_or("").to_owned();
            let value = n["value"].clone();
            let activate = move |cx: &mut App| {
                Self::fire(
                    &kernel,
                    &module,
                    &inputs,
                    &action,
                    &key,
                    None,
                    value.clone(),
                    cx,
                );
                cx.stop_propagation();
            };
            let click = activate.clone();
            let keyboard_focus = focus.clone();
            d = d
                .role(Role::Button)
                .track_focus(&focus)
                .block_mouse_except_scroll()
                .cursor_pointer()
                .on_mouse_down(MouseButton::Left, move |event, window, cx| {
                    // Selection can use blank space as an anchor. Claim the press unless
                    // it hits selectable text in the foreground of this control.
                    let selectable = TextSelection::is_selectable_at(event.position, window, cx);
                    track_text_press.read(cx).set(selectable);
                    if !selectable {
                        GlobalState::suppress_text_selection(cx);
                    }
                })
                .on_click(move |event, _, cx| {
                    if !matches!(event, ClickEvent::Mouse(_)) || !text_press.read(cx).get() {
                        click(cx);
                    }
                })
                .on_key_down(move |event, window, cx| {
                    if keyboard_focus.is_focused(window)
                        && matches!(event.keystroke.key.as_str(), "enter" | "space")
                    {
                        window.prevent_default();
                        activate(cx);
                    }
                });
        }
        if let Some(tip) = tip {
            d = d.managed_tooltip_with_hover(
                tip.placement,
                None,
                move |window, cx| tip.build(window, cx),
                hover,
            );
        } else if let Some(hover) = hover {
            d = d.on_hover(move |active, window, cx| hover(active, window, cx));
        }
        d.into_any_element()
    }
}
