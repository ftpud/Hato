use super::*;
use gpui_kit::base::{
    MotionMode,
    motion::{
        Easing, SurfaceLeg, SurfaceMotion, SurfaceOffset, SurfacePose, SurfacePresence,
        SurfaceStyles, SurfaceTiming, SurfaceTransition,
    },
    set_motion_mode, surface_motion,
};

#[derive(Default)]
pub(super) struct Motion {
    theme: Value,
    overlays: HashMap<(WindowId, String, String), Overlay>,
    frame: u64,
    order: u64,
}

struct Overlay {
    node: Value,
    presence: SurfacePresence,
    seen: u64,
    focus: FocusHandle,
    previous_focus: Option<FocusHandle>,
    order: u64,
    live: bool,
}

pub(super) struct Toast {
    level: String,
    text: String,
    created: Instant,
    closing: bool,
    presence: SurfacePresence,
}

impl Toast {
    pub(super) fn new(level: String, text: String) -> Self {
        Self {
            level,
            text,
            created: Instant::now(),
            closing: false,
            presence: SurfacePresence::default(),
        }
    }
}

fn number(value: &Value, default: f64, min: f64, max: f64) -> f32 {
    value.as_f64().unwrap_or(default).clamp(min, max) as f32
}

fn timing(value: &Value) -> Option<SurfaceTiming> {
    let duration = value["durationMs"].as_f64()?.clamp(0., 30_000.);
    let curve = value["easing"].as_array()?;
    let [a, b, c, d] = curve.as_slice() else {
        return None;
    };
    let easing = Easing::cubic_bezier(
        a.as_f64()? as f32,
        b.as_f64()? as f32,
        c.as_f64()? as f32,
        d.as_f64()? as f32,
    )
    .ok()?;
    Some(SurfaceTiming {
        duration: Duration::from_secs_f64(duration / 1000.),
        easing,
    })
}

pub(super) fn transition(value: &Value) -> Option<SurfaceTransition> {
    fn leg(value: &Value) -> Option<SurfaceLeg> {
        Some(SurfaceLeg {
            timing: timing(value)?,
            pose: SurfacePose {
                opacity: number(&value["opacity"], 1., 0., 1.),
                offset: point(
                    px(number(&value["offsetPx"][0], 0., -4096., 4096.)),
                    px(number(&value["offsetPx"][1], 0., -4096., 4096.)),
                ),
            },
        })
    }
    let result = SurfaceTransition {
        enter: leg(&value["enter"]),
        exit: leg(&value["exit"]),
    };
    (result.enter.is_some() || result.exit.is_some()).then_some(result)
}

impl Motion {
    pub(super) fn begin(&mut self) {
        self.frame = self.frame.wrapping_add(1);
    }

    pub(super) fn theme(&mut self, value: &Value, cx: &mut App) {
        if self.theme == *value && cx.try_global::<SurfaceStyles>().is_some() {
            return;
        }
        self.theme = value.clone();
        cx.set_global(SurfaceStyles {
            menu: transition(&value["menu"]),
            tooltip: transition(&value["tooltip"]),
            interaction: timing(&value["interaction"]),
        });
        let mode = match value["mode"].as_str() {
            Some("on") => MotionMode::On,
            Some("off") => MotionMode::Off,
            _ => MotionMode::System,
        };
        set_motion_mode(mode, cx);
        cx.refresh_windows();
    }

    pub(super) fn forget_window(&mut self, id: WindowId) {
        self.overlays.retain(|key, _| key.0 != id);
    }

    pub(super) fn dock_enabled(&self) -> bool {
        self.theme["experimentalDockReveal"]
            .as_bool()
            .unwrap_or(false)
    }
}

/// Animated split child. In Full motion the child's real allocation grows or shrinks, so
/// neighbours move continuously like a divider drag, while the child's own content keeps its
/// open extent and slides from its docking edge (no reflow of the revealed pane). Reduced motion
/// snaps the layout and fades the opening pane in; Off is instant.
pub(super) struct Reveal {
    /// Split allocation override: animated size in flight, 0 while closed, None when settled open.
    pub allocation: Option<f32>,
    pub visible: bool,
    pub opacity: f32,
    /// Fixed content extent while sliding; the content is anchored away from `end`.
    pub slide: Option<f32>,
    pub end: bool,
    pub focus: FocusHandle,
    pub measure: Option<std::rc::Rc<std::cell::Cell<Option<f32>>>>,
}

struct RevealState {
    presence: SurfacePresence,
    focus: FocusHandle,
    visible: bool,
    measured: std::rc::Rc<std::cell::Cell<Option<f32>>>,
    held: Option<f32>,
    fresh: bool,
}

pub(super) fn reveal(
    descriptor: &Value,
    id: SharedString,
    window: &mut Window,
    cx: &mut App,
) -> Option<Reveal> {
    let visible = descriptor["visible"].as_bool()?;
    let fallback = descriptor["extentPx"]
        .as_f64()
        .map(|extent| extent as f32)
        .filter(|extent| extent.is_finite() && *extent > 0.);
    let transition = transition(&descriptor["transition"]).unwrap_or_default();
    let state = window.use_keyed_state((ElementId::from(id), "split-reveal"), cx, |_, cx| {
        RevealState {
            presence: SurfacePresence::default(),
            focus: cx.focus_handle(),
            visible: false,
            measured: Default::default(),
            held: None,
            fresh: true,
        }
    });
    let now = cx.background_executor().now();
    let mode = surface_motion(cx);
    let full = mode == SurfaceMotion::Full;
    let (progress, active, focus, extent, measured) = state.update(cx, |state, cx| {
        if state.visible && !visible && state.focus.contains_focused(window, cx) {
            window.blur(cx);
        }
        state.visible = visible;
        // A pane seen for the first time (app start, new layout) appears in place.
        let sample_mode = if std::mem::take(&mut state.fresh) { SurfaceMotion::Off } else { mode };
        let (pose, active) = state.presence.sample(visible, &transition, sample_mode, now);
        // Hold one extent for the whole flight, including reversals.
        state.held = if active { state.held.or_else(|| state.measured.get()).or(fallback) } else { None };
        (pose.opacity.clamp(0., 1.), active, state.focus.clone(), state.held, state.measured.clone())
    });
    if active {
        window.request_animation_frame();
    }
    let sliding = active && full && extent.is_some();
    let allocation = if sliding {
        let size = extent.unwrap_or(0.) * progress;
        Some(if size < 0.5 { 0. } else { size })
    } else if !visible {
        Some(0.)
    } else {
        None
    };
    Some(Reveal {
        allocation,
        visible,
        opacity: if full || !active { 1. } else { progress },
        slide: if sliding { extent } else { None },
        end: descriptor["edge"].as_str() == Some("end"),
        focus,
        // Track the settled open size so the next transition matches what the user sized.
        measure: (visible && !sliding).then_some(measured),
    })
}

impl Shell {
    pub(super) fn queue_popover(
        &mut self,
        module: &str,
        path: &str,
        n: &Value,
        window: &Window,
        cx: &mut App,
    ) {
        let key = (
            window.window_handle().window_id(),
            module.to_owned(),
            path.to_owned(),
        );
        let overlay = self.motion.overlays.entry(key).or_insert_with(|| Overlay {
            node: Value::Null,
            presence: SurfacePresence::default(),
            seen: 0,
            focus: cx.focus_handle(),
            previous_focus: None,
            order: 0,
            live: false,
        });
        overlay.node = n.clone();
        overlay.seen = self.motion.frame;
        if !overlay.live {
            self.motion.order = self.motion.order.wrapping_add(1);
            overlay.order = self.motion.order;
        }
    }

    pub(super) fn render_popovers(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Vec<AnyElement> {
        let id = window.window_handle().window_id();
        let mut keys: Vec<_> = self
            .motion
            .overlays
            .iter()
            .filter(|(key, _)| key.0 == id)
            .map(|(key, overlay)| (overlay.order, key.clone()))
            .collect();
        keys.sort();
        let mut elements = Vec::new();
        for (_, key) in keys {
            let Some(mut overlay) = self.motion.overlays.remove(&key) else {
                continue;
            };
            let live = overlay.seen == self.motion.frame;
            if !live && overlay.live && overlay.focus.contains_focused(window, cx) {
                if let Some(previous) = overlay.previous_focus.take() {
                    previous.focus(window, cx);
                } else {
                    window.blur(cx);
                }
            }
            if live && !overlay.live {
                overlay.previous_focus = window.focused(cx);
                overlay.focus.focus(window, cx);
            }
            overlay.live = live;
            let transition = transition(&overlay.node["transition"]).unwrap_or_default();
            let (pose, active) = overlay.presence.sample(
                live,
                &transition,
                surface_motion(cx),
                cx.background_executor().now(),
            );
            if active {
                window.request_animation_frame();
            }
            if live || active {
                elements.push(self.render_popover_surface(
                    &key.1,
                    &key.2,
                    &overlay.node,
                    &overlay.focus,
                    live,
                    pose,
                    window,
                    cx,
                ));
                self.motion.overlays.insert(key, overlay);
            }
        }
        elements
    }

    pub(super) fn render_popover_surface(
        &mut self,
        module: &str,
        path: &str,
        n: &Value,
        focus: &FocusHandle,
        live: bool,
        pose: SurfacePose,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let kids = if live {
            self.children(module, n, path, 1, window, cx)
        } else {
            passive_children(n, cx)
        };
        let kernel = self.kernel.clone();
        let module = module.to_owned();
        let inputs = self.module_inputs(&module);
        let scroll_id = sid(&module, &format!("{path}/anchored"));
        let action = n["closeAction"].as_str().unwrap_or("").to_owned();
        let key = n["key"].as_str().unwrap_or("").to_owned();
        let close = move |cx: &mut App| {
            Self::fire(
                &kernel,
                &module,
                &inputs,
                &action,
                &key,
                None,
                Value::Null,
                cx,
            )
        };
        let escape = close.clone();
        let overlay = div().absolute().inset_0().when(live, |overlay| {
            overlay
                .occlude()
                .on_mouse_down(MouseButton::Left, move |_, _, cx| close(cx))
        });
        let max_height = px(number(&n["maxHeight"], 420., 40., 4096.));
        let card = self
            .apply_base(v_flex(), n, cx)
            .id(scroll_id)
            .max_h(max_height)
            .opacity(pose.opacity)
            .when(pose.opacity >= 1., |card| card.shadow_lg())
            .when(live, |card| {
                card.role(Role::Dialog)
                    .track_focus(focus)
                    .tab_group()
                    .occlude()
                    .on_key_down(move |event, window, cx| {
                        if event.keystroke.key == "escape" {
                            escape(cx);
                            window.prevent_default();
                            cx.stop_propagation();
                        }
                    })
                    .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            });
        if let (Some(x), Some(y)) = (
            n["windowAnchor"]["x"].as_f64(),
            n["windowAnchor"]["y"].as_f64(),
        ) {
            let viewport = window.viewport_size();
            let position = point(
                px(x as f32).clamp(px(0.), viewport.width),
                px(y as f32).clamp(px(0.), viewport.height),
            );
            let card = card
                .max_w(viewport.width)
                .max_h(viewport.height.min(max_height));
            let card = if live {
                card.overflow_y_scroll().children(kids).into_any_element()
            } else {
                card.overflow_hidden().children(kids).into_any_element()
            };
            return overlay
                .child(deferred(
                    anchored()
                        .position(position)
                        .child(SurfaceOffset::new(card, pose.offset)),
                ))
                .into_any_element();
        }
        overlay
            .child(SurfaceOffset::new(
                card.absolute()
                    .when(n["bottom"].is_number(), |card| {
                        card.bottom(px(number(&n["bottom"], 0., 0., 4096.)))
                    })
                    .when(n["bottom"].is_null(), |card| {
                        card.top(px(number(&n["top"], 52., 0., 4096.)))
                    })
                    .left(px(number(&n["left"], 8., 0., 4096.)))
                    .right(px(number(&n["right"], 8., 0., 4096.)))
                    .when(
                        n["bottom"].is_null() || n["heightFraction"].is_number(),
                        |card| card.h(relative(number(&n["heightFraction"], 0.55, 0.1, 1.))),
                    )
                    .overflow_hidden()
                    .children(kids),
                pose.offset,
            ))
            .into_any_element()
    }

    pub(super) fn render_toasts(&mut self, window: &Window, cx: &App) -> AnyElement {
        let chrome = theme::chrome(cx);
        let toast = &chrome["toasts"];
        let mut container =
            v_flex()
                .absolute()
                .gap_1()
                .w(px(number(&toast["width"], 420., 160., 1200.)));
        container = match toast["position"].as_str() {
            Some("top-right") => container.top(px(44.)).right(px(12.)),
            Some("top-left") => container.top(px(44.)).left(px(12.)),
            Some("bottom-left") => container.bottom(px(36.)).left(px(12.)),
            _ => container.bottom(px(36.)).right(px(12.)),
        };
        let transition = transition(&toast["transition"]).unwrap_or_default();
        let duration =
            Duration::from_secs_f32(number(&toast["durationMs"], 8000., 1000., 120_000.) / 1000.);
        let max = toast["max"].as_u64().unwrap_or(5).clamp(1, 20) as usize;
        let extra = self
            .toasts
            .iter()
            .filter(|toast| !toast.closing)
            .count()
            .saturating_sub(max);
        for toast in self
            .toasts
            .iter_mut()
            .filter(|toast| !toast.closing)
            .take(extra)
        {
            toast.closing = true;
        }
        self.toasts.retain_mut(|toast| {
            toast.closing |= toast.created.elapsed() >= duration;
            let (pose, active) = toast.presence.sample(
                !toast.closing,
                &transition,
                surface_motion(cx),
                cx.background_executor().now(),
            );
            if active {
                window.request_animation_frame();
            }
            if toast.closing && !active {
                return false;
            }
            let c = if toast.level == "error" {
                cx.theme().danger
            } else {
                cx.theme().muted_foreground
            };
            let node = div()
                .p_2()
                .rounded(px(6.))
                .text_xs()
                .bg(cx.theme().background)
                .border_1()
                .border_color(c)
                .text_color(c)
                .opacity(pose.opacity)
                .child(toast.text.clone());
            container = std::mem::replace(&mut container, v_flex())
                .child(SurfaceOffset::new(node, pose.offset));
            true
        });
        container.into_any_element()
    }
}

/// Build visual-only exit content. The exit tree cannot register controls, focus or actions.
pub(super) fn passive_children(n: &Value, cx: &App) -> Vec<AnyElement> {
    n["children"]
        .as_array()
        .into_iter()
        .flatten()
        .take(2000)
        .map(|n| {
            let mut row = match n["type"].as_str().unwrap_or("") {
                "row" => h_flex().items_center(),
                "column" | "scroll" | "dropZone" => v_flex(),
                "label" | "button" | "choice" | "dropdown" | "status" => div()
                    .text_sm()
                    .child(n["text"].as_str().unwrap_or("").to_owned()),
                "textInput" => div()
                    .text_sm()
                    .child(n["placeholder"].as_str().unwrap_or("").to_owned()),
                _ => div(),
            };
            if let Some(gap) = n["gap"].as_f64() {
                row = row.gap(px(gap as f32));
            }
            if let Some(padding) = n["padding"].as_f64() {
                row = row.p(px(padding as f32));
            }
            style::apply(row, &n["style"], cx)
                .children(passive_children(n, cx))
                .into_any_element()
        })
        .collect()
}

pub(super) fn passive_menu<'a>(labels: impl Iterator<Item = &'a str>, cx: &App) -> AnyElement {
    v_flex()
        .min_w(px(112.))
        .p_1()
        .rounded(px(6.))
        .bg(cx.theme().popover)
        .text_sm()
        .children(
            labels
                .take(100)
                .map(|label| div().px_2().py_1().child(label.to_owned())),
        )
        .into_any_element()
}

#[cfg(test)]
mod tests {
    use super::{
        Duration, Instant, Point, SurfaceMotion, SurfacePose, SurfacePresence, SurfaceTransition,
        json, px, transition,
    };

    fn preset() -> SurfaceTransition {
        transition(&json!({
            "enter": { "durationMs": 180, "easing": [0.2, 0, 0, 1], "opacity": 0, "offsetPx": [0, -4] },
            "exit": { "durationMs": 126, "easing": [0.4, 0, 1, 1], "opacity": 0, "offsetPx": [0, -4] }
        })).unwrap()
    }

    #[test]
    fn reverses_from_the_sampled_pose_and_settles_when_off() {
        let mut state = SurfacePresence::default();
        let start = Instant::now();
        let preset = preset();
        let at = |ms| start + Duration::from_millis(ms);
        assert_eq!(
            state
                .sample(true, &preset, SurfaceMotion::Full, at(0))
                .0
                .opacity,
            0.
        );
        let open = state.sample(true, &preset, SurfaceMotion::Full, at(60)).0;
        assert_eq!(
            state.sample(false, &preset, SurfaceMotion::Full, at(60)),
            (open, true)
        );
        let exit = state.sample(false, &preset, SurfaceMotion::Full, at(90)).0;
        assert!(exit.opacity < open.opacity);
        assert_eq!(
            state.sample(true, &preset, SurfaceMotion::Full, at(90)),
            (exit, true)
        );
        assert_eq!(
            state.sample(true, &preset, SurfaceMotion::Off, at(91)),
            (SurfacePose::default(), false)
        );
        assert_eq!(
            state.sample(true, &preset, SurfaceMotion::Full, at(92)),
            (SurfacePose::default(), false)
        );
    }

    #[test]
    fn reduced_motion_keeps_opacity_and_drops_travel_immediately() {
        let mut state = SurfacePresence::default();
        let start = Instant::now();
        let preset = preset();
        assert_eq!(
            state
                .sample(true, &preset, SurfaceMotion::Full, start)
                .0
                .offset
                .y,
            px(-4.)
        );
        let (pose, active) = state.sample(
            true,
            &preset,
            SurfaceMotion::Reduced,
            start + Duration::from_millis(50),
        );
        assert!(active && pose.opacity > 0. && pose.opacity < 1.);
        assert_eq!(pose.offset, Point::default());
        assert!(
            transition(&json!({"enter": {"durationMs": 120, "easing": [-2, 0, 0, 1]}})).is_none()
        );
    }
}

#[cfg(all(test, feature = "snapshot", unix))]
mod visual_tests {
    use super::{Arc, Document, Duration, Kernel, Shell, Value, json};
    use crate::{
        bridge::UiBridge,
        config::Config,
        host::pty::{self, PtySpec},
    };
    use gpui::{Focusable, Modifiers, TestAppContext, VisualTestContext, point, px, size};
    use gpui_kit as gpui;

    #[gpui_kit::test]
    fn side_reveal_keeps_viewports_stable_during_reversal(cx: &mut TestAppContext) {
        check_flexible_dock(cx, true);
    }

    #[gpui_kit::test]
    fn bottom_reveal_keeps_viewports_stable_during_reversal(cx: &mut TestAppContext) {
        check_flexible_dock(cx, false);
    }

    fn check_flexible_dock(cx: &mut TestAppContext, horizontal: bool) {
        cx.update(gpui_kit::init);
        let temp = tempfile::tempdir().unwrap();
        let config = Config::from_args(&[
            "hato".into(),
            "--repo-root".into(),
            temp.path().display().to_string(),
            "--data-dir".into(),
            temp.path().join("data").display().to_string(),
        ])
        .unwrap();
        let kernel = Kernel::new(config, UiBridge::disconnected()).unwrap();
        let terminal = pty::open(PtySpec {
            remote: None,
            program: "/bin/cat".into(),
            args: vec![],
            cwd: None,
            env: vec![],
            cols: 80,
            rows: 24,
            machine_id: "local".into(),
            display_cwd: temp.path().display().to_string(),
            answer_queries: false,
        })
        .unwrap();
        let module = "__motion-probe";
        let pty = kernel
            .handles
            .insert("pty", module, "motion test", terminal.clone());
        let editor = kernel.handles.insert(
            "document",
            module,
            "wrap.txt",
            Arc::new(Document {
                workspace_key: module.into(),
                path: "wrap.txt".into(),
                language: "text".into(),
                text: "A line long enough to exercise soft wrapping. ".repeat(50),
                created_ms: 0,
            }),
        );
        let tree = |visible, fraction: f64| {
            let mut children = [
                json!({"type": "column", "key": "dock", "grow": true, "children": [
                    {"type": "terminal", "key": "terminal", "pty": pty, "grow": true}
                ]}),
                json!({"type": "codeViewer", "key": "editor", "document": editor, "grow": true, "softWrap": true}),
            ];
            let mut sizes = [fraction, 1. - fraction];
            let mut fixed = [if visible { Value::Null } else { json!(0) }, Value::Null];
            if !horizontal {
                children.swap(0, 1);
                sizes.swap(0, 1);
                fixed.swap(0, 1);
            }
            Arc::new(json!({
                "type": "split", "key": "split",
                "direction": if horizontal { "horizontal" } else { "vertical" },
                "sizes": sizes, "fixed": fixed, "children": children,
                "reveal": {"dock": {"visible": visible, "edge": if horizontal { "start" } else { "end" }, "transition": {
                    "enter": {"durationMs": 240, "easing": [0.2, 0, 0, 1], "opacity": 0},
                    "exit": {"durationMs": 168, "easing": [0.4, 0, 1, 1], "opacity": 0}
                }}}
            }))
        };
        let window = cx.open_window(size(px(720.), px(360.)), |window, cx| {
            let mut shell = Shell::new(kernel.clone(), UiBridge::new().1, window, cx);
            shell
                .motion
                .theme(&json!({"mode": "on", "experimentalDockReveal": true}), cx);
            shell.only_module = Some(module.into());
            shell.trees.insert(module.into(), tree(false, 0.33));
            shell
        });
        let mut visual = VisualTestContext::from_window(window.into(), cx);
        let clock = cx.executor();
        let viewport = || {
            let dims = terminal.size.lock();
            (dims.cols, dims.rows)
        };
        let set_split = |visible, fraction, visual: &mut VisualTestContext| {
            visual.update(|window, cx| {
                window
                    .root::<Shell>()
                    .unwrap()
                    .unwrap()
                    .update(cx, |shell, cx| {
                        shell.trees.insert(module.into(), tree(visible, fraction));
                        cx.notify();
                    });
                window.draw(cx).clear(cx);
            })
        };
        set_split(true, 0.33, &mut visual);
        let stable = viewport();
        assert_ne!(stable, (80, 24));
        let editor_size = |visual: &mut VisualTestContext| {
            visual.update(|window, cx| {
                let root = window.root::<Shell>().unwrap().unwrap();
                root.read(cx).editors[&editor]
                    .0
                    .read(cx)
                    .input_bounds()
                    .size
            })
        };
        let stable_editor_size = editor_size(&mut visual);
        assert!(stable_editor_size.width > px(0.) && stable_editor_size.height > px(0.));
        for hz in [120, 60] {
            let mut draw_times = Vec::new();
            for _ in 0..4 {
                clock.advance_clock(Duration::from_secs_f64(1. / hz as f64));
                let started = std::time::Instant::now();
                visual.update(|window, cx| window.draw(cx).clear(cx));
                draw_times.push(started.elapsed());
                assert_eq!(viewport(), stable);
            }
            eprintln!("Dock probe at simulated {hz} Hz: CPU draw samples {draw_times:?}");
            set_split(false, 0.33, &mut visual);
            clock.advance_clock(Duration::from_millis(16));
            visual.update(|window, cx| window.draw(cx).clear(cx));
            set_split(true, 0.33, &mut visual);
            // The revealed pane keeps its open viewport; neighbours follow the animated size.
            assert_eq!(viewport(), stable);
        }
        clock.advance_clock(Duration::from_millis(300));
        visual.update(|window, cx| window.draw(cx).clear(cx));
        assert_eq!(viewport(), stable);
        assert_eq!(editor_size(&mut visual), stable_editor_size, "neighbours settle back to their size");
        // Closing then reopening moves the neighbour continuously instead of jumping.
        let axis = |size: gpui::Size<gpui::Pixels>| if horizontal { size.width } else { size.height };
        set_split(false, 0.33, &mut visual);
        clock.advance_clock(Duration::from_millis(400));
        visual.update(|window, cx| window.draw(cx).clear(cx));
        let closed_editor = axis(editor_size(&mut visual));
        assert!(closed_editor > axis(stable_editor_size));
        set_split(true, 0.33, &mut visual);
        clock.advance_clock(Duration::from_millis(60));
        visual.update(|window, cx| window.draw(cx).clear(cx));
        let midway = axis(editor_size(&mut visual));
        assert!(midway < closed_editor && midway > axis(stable_editor_size), "neighbour mid-flight: {midway:?}");
        assert_eq!(viewport(), stable, "the revealed pane is not reflowed while sliding");
        clock.advance_clock(Duration::from_millis(400));
        visual.update(|window, cx| window.draw(cx).clear(cx));
        assert_eq!(editor_size(&mut visual), stable_editor_size);
        set_split(true, 0.48, &mut visual);
        let resized = viewport();
        assert!(
            if horizontal {
                resized.0 > stable.0
            } else {
                resized.1 > stable.1
            },
            "a settled open pane must follow its flex weight"
        );
        let terminal_focus = visual.update(|window, cx| {
            let root = window.root::<Shell>().unwrap().unwrap();
            root.read(cx)
                .terminals
                .values()
                .next()
                .unwrap()
                .focus_handle(cx)
        });
        let dock_point = point(px(24.), px(if horizontal { 24. } else { 336. }));
        visual.simulate_click(dock_point, Modifiers::default());
        assert!(visual.update(|window, _| terminal_focus.is_focused(window)));
        set_split(false, 0.48, &mut visual);
        assert!(!visual.update(|window, _| terminal_focus.is_focused(window)));
        visual.simulate_click(dock_point, Modifiers::default());
        assert!(!visual.update(|window, _| terminal_focus.is_focused(window)));
        clock.advance_clock(Duration::from_millis(200));
        visual.update(|window, cx| window.draw(cx).clear(cx));
        set_split(true, 0.48, &mut visual);
        assert_eq!(
            viewport(),
            resized,
            "reopening must use the last measured flex extent"
        );
        terminal.kill();
        kernel.shutdown();
    }
}
