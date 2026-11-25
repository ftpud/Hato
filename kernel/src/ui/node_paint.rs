//! Small painted primitives. They use one canvas each and never add per-segment
//! or per-particle elements to the layout tree.
use super::*;
use gpui_kit::base::{
    motion::{self as animate, Interpolate, SurfaceColor, SurfaceMotion},
    surface_motion,
};
use node_motion::{default_timing, policy, random};
use std::{cell::{Cell, RefCell}, rc::Rc};

pub(super) fn meter(n: &Value, id: SharedString, window: &mut Window, cx: &mut App) -> AnyElement {
    let count = n["segments"].as_u64().unwrap_or(1).clamp(1, 256) as usize;
    let width = motion::number(&n["segmentWidth"], 3., 0.5, 256.);
    let height = motion::number(&n["segmentHeight"], 10., 0.5, 256.);
    let gap = motion::number(&n["gap"], 2., 0., 256.);
    let radius = px(motion::number(
        &n["radius"],
        0.,
        0.,
        f64::from(width.min(height)) / 2.,
    ));
    let max = motion::number(
        &n["max"],
        1.,
        f64::from(f32::MIN_POSITIVE),
        f64::from(f32::MAX),
    );
    let target = motion::number(&n["value"], 0., 0., f64::from(max)) / max * count as f32;
    let timing = motion::timing(&n["transition"]).unwrap_or_else(|| default_timing(240));
    let fill_level = animate::transition(
        (id.clone(), "meter-fill"),
        target,
        policy(&timing, cx),
        window,
        cx,
    );
    let filled =
        SurfaceColor(style::color_of(cx, n, "filledColor").unwrap_or(cx.theme().foreground));
    let empty = SurfaceColor(style::color_of(cx, n, "emptyColor").unwrap_or(cx.theme().muted));
    let highlight = style::color_of(cx, n, "highlightColor").map(SurfaceColor);
    let highlight_from = n["highlightFrom"]
        .as_f64()
        .map(|threshold| (threshold / f64::from(max) * count as f64) as f32);
    let full = surface_motion(cx) == SurfaceMotion::Full && !timing.duration.is_zero();
    let now = cx.background_executor().now();
    let flash = highlight.and_then(|_| {
        let state = window.use_keyed_state((ElementId::from(id), "meter-flash"), cx, |_, _| {
            Cell::new((target, target, now))
        });
        let state = state.read(cx);
        let (previous, mut from, mut start) = state.get();
        if previous != target {
            from = previous.min(fill_level);
            start = now;
        }
        let elapsed = now.saturating_duration_since(start);
        if !full {
            from = target;
        }
        state.set((target, from, start));
        if from < target && elapsed < timing.duration {
            { crate::ui::redraw_stats::cause(concat!("anim:", file!(), ":", line!())); window.request_animation_frame(); }
            Some((
                from.max(highlight_from.unwrap_or(0.)),
                1. - elapsed.as_secs_f32() / timing.duration.as_secs_f32(),
            ))
        } else {
            None
        }
    });

    canvas(
        |_, _, _| {},
        move |bounds, _, window, _| {
            for i in 0..count {
                let amount = (fill_level - i as f32).clamp(0., 1.);
                let mut color = empty.interpolate(&filled, amount);
                if let Some((highlight, (from, strength))) = highlight.zip(flash) {
                    let entered = ((i + 1) as f32 - from).clamp(0., 1.);
                    color = color.interpolate(&highlight, amount * strength * entered);
                }
                let segment = Bounds::new(
                    bounds.origin + point(px((width + gap) * i as f32), px(0.)),
                    size(px(width), px(height)),
                );
                window.paint_quad(fill(segment, color.0).corner_radii(radius));
            }
        },
    )
    .w(px(count as f32 * (width + gap) - gap))
    .h(px(height))
    .flex_none()
    .into_any_element()
}

#[derive(Default)]
struct PaintClock {
    last: Cell<Option<Instant>>,
    seconds: Cell<f32>,
    /// A shared spinner clock can paint in several cached views and windows. Each visible
    /// view needs an invalidation; notifying only the first leaves the others frozen.
    scheduled: RefCell<HashSet<(WindowId, EntityId)>>,
}

/// Frame-rate cap for a painted animation: the node's `fps` (1..=120), else `default`. gpui
/// repaints the whole window for any frame, so an ambient effect redrawn at the display's refresh
/// rate (120 Hz on ProMotion) re-laid out and repainted every panel continuously.
fn frame_interval(n: &Value, default: f64) -> Duration {
    let fps = n["fps"].as_f64().filter(|f| f.is_finite()).unwrap_or(default).clamp(1., 120.);
    quantize(Duration::from_secs_f64(1. / fps))
}

/// Throttled redraws land on one shared grid of `GRID` steps: several animated elements (each
/// spinner, the ambient dust) then share frames instead of each adding its own, unsynchronized.
const GRID: Duration = Duration::from_nanos(33_333_333);

fn quantize(interval: Duration) -> Duration {
    if interval <= EVERY_FRAME {
        return interval;
    }
    GRID * (interval.as_nanos().div_ceil(GRID.as_nanos()) as u32)
}

/// Time until the next multiple of `interval` on the shared grid.
fn until_next_tick(interval: Duration) -> Duration {
    static EPOCH: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
    let since = EPOCH.get_or_init(std::time::Instant::now).elapsed().as_nanos();
    let step = interval.as_nanos().max(1);
    Duration::from_nanos((step - since % step) as u64)
}

/// At or above this rate, redraw on the next display frame instead of a timer.
const EVERY_FRAME: Duration = Duration::from_millis(17);

fn elapsed(
    id: SharedString,
    channel: &'static str,
    window: &mut Window,
    cx: &mut App,
) -> (Rc<PaintClock>, bool) {
    let clock = window
        .use_keyed_state((ElementId::from(id), channel), cx, |_, _| {
            Rc::<PaintClock>::default()
        })
        .read(cx)
        .clone();
    let animate = surface_motion(cx) == SurfaceMotion::Full;
    (clock, animate)
}

impl PaintClock {
    /// Seconds of animation time, and the next redraw at most `interval` from now.
    fn sample(self: &Rc<Self>, enabled: bool, interval: Duration, window: &Window, cx: &App) -> f32 {
        if !enabled || !window.is_visible() {
            self.last.set(None);
            return self.seconds.get();
        }
        let now = cx.background_executor().now();
        if let Some(last) = self.last.replace(Some(now)) {
            // Rendering is suspended while hidden. Ignore that gap on the first visible frame.
            let elapsed = now.saturating_duration_since(last);
            if elapsed < Duration::from_millis(150).max(interval * 3) {
                self.seconds.set(self.seconds.get() + elapsed.as_secs_f32());
            }
        }
        if interval <= EVERY_FRAME {
            { crate::ui::redraw_stats::cause(concat!("anim:", file!(), ":", line!())); window.request_animation_frame(); }
        } else {
            let view = window.current_view();
            let key = (window.window_handle().window_id(), view);
            if !self.scheduled.borrow_mut().insert(key) {
                return self.seconds.get();
            }
            let clock = self.clone();
            window.spawn(cx, async move |cx| {
                cx.background_executor().timer(until_next_tick(interval)).await;
                clock.scheduled.borrow_mut().remove(&key);
                let _ = cx.update(|window, _| window.on_next_frame(move |_, cx| { crate::ui::redraw_stats::cause("anim:paint-clock"); cx.notify(view) }));
            }).detach();
        }
        self.seconds.get()
    }
}

pub(super) fn spinner(
    n: &Value,
    id: SharedString,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let extent = motion::number(&n["size"], 14., 1., 512.);
    let thickness = motion::number(&n["thickness"], 1.5, 0.25, f64::from(extent) / 2.);
    let color = style::color_of(cx, n, "color").unwrap_or(cx.theme().foreground);
    let (clock, animate) = elapsed(id, "spinner-clock", window, cx);
    let interval = frame_interval(n, 30.);
    spinner_canvas(clock, animate, interval, extent, thickness, color)
}

/// A spinner for places without a window to keep per-element state (tree rows). All of them
/// share one clock, so they turn in step and cost one throttled redraw between them.
pub(super) fn shared_spinner(extent: f32, color: Hsla, cx: &App) -> AnyElement {
    thread_local! {
        static SHARED: Rc<PaintClock> = Rc::default();
    }
    let animate = surface_motion(cx) == SurfaceMotion::Full;
    let clock = SHARED.with(Rc::clone);
    spinner_canvas(clock, animate, quantize(Duration::from_secs_f64(1. / 30.)), extent, (extent / 8.).max(1.25), color)
}

fn spinner_canvas(clock: Rc<PaintClock>, animate: bool, interval: Duration, extent: f32, thickness: f32, color: Hsla) -> AnyElement {
    canvas(
        |_, _, _| {},
        move |bounds, _, window, cx| {
            let seconds = clock.sample(animate, interval, window, cx);
            let angle = if animate {
                seconds % 0.85 / 0.85 * std::f32::consts::TAU
            } else {
                0.
            };
            let radius = px((extent - thickness) / 2.);
            let mut arc = PathBuilder::stroke(px(thickness));
            for i in 0..=28 {
                let angle = angle + i as f32 / 28. * std::f32::consts::TAU * 0.74;
                let position = bounds.center() + point(radius * angle.cos(), radius * angle.sin());
                if i == 0 {
                    arc.move_to(position);
                } else {
                    arc.line_to(position);
                }
            }
            if let Ok(path) = arc.build() {
                window.paint_path(path, color);
            }
        },
    )
    .size(px(extent))
    .flex_none()
    .into_any_element()
}

struct Glow {
    x: f32,
    y: f32,
    radius: f32,
    color: Hsla,
}

struct Particle {
    x: f32,
    y: f32,
    size: f32,
    drift: f32,
    alpha: f32,
}

pub(super) fn ambient(
    n: &Value,
    id: SharedString,
    window: &mut Window,
    cx: &mut App,
) -> Option<AnyElement> {
    if !n.is_object() || surface_motion(cx) != SurfaceMotion::Full {
        return None;
    }
    let glow: Vec<_> = n["glow"]
        .as_array()
        .into_iter()
        .flatten()
        .take(8)
        .map(|glow| Glow {
            x: motion::number(&glow["x"], 0.5, -2., 3.),
            y: motion::number(&glow["y"], 0., -2., 3.),
            radius: motion::number(&glow["radius"], 120., 1., 4096.),
            color: style::color_of(cx, glow, "color").unwrap_or(transparent_black()),
        })
        .collect();
    let config = &n["particles"];
    let count = config["count"].as_u64().unwrap_or(0).min(120);
    let seed = config["seed"].as_i64().unwrap_or(0) as u64;
    let min_size = motion::number(&config["minSize"], 1., 0.25, 16.);
    let max_size = motion::number(&config["maxSize"], 2., f64::from(min_size), 32.);
    let speed = motion::number(&config["speed"], 3., 0., 128.);
    let color = style::color_of(cx, config, "color").unwrap_or(transparent_black());
    let (clock, animate) = elapsed(id, "ambient-clock", window, cx);
    let interval = frame_interval(n, 30.);
    let particles: Vec<_> = (0..count)
        .map(|i| {
            let sample =
                |offset| random(seed.wrapping_add(i * 5 + offset)) as f32 / u32::MAX as f32;
            Particle {
                x: sample(0),
                y: sample(1),
                size: min_size + (max_size - min_size) * sample(2),
                drift: 0.25 + sample(3),
                alpha: 0.25 + sample(4) * 0.75,
            }
        })
        .collect();
    Some(
        canvas(
            |_, _, _| {},
            move |bounds, _, window, cx| {
                let time =
                    clock.sample(animate && !particles.is_empty() && color.a > 0., interval, window, cx);
                window.with_content_mask(Some(ContentMask { bounds }), |window| {
                    for glow in &glow {
                        let center = bounds.origin
                            + point(bounds.size.width * glow.x, bounds.size.height * glow.y);
                        // Composite concentric quads for a small radial falloff.
                        for ring in (1..=16).rev() {
                            let radius = px(glow.radius * ring as f32 / 16.);
                            let layer = Bounds::new(
                                center - point(radius, radius),
                                size(radius * 2., radius * 2.),
                            );
                            window.paint_quad(
                                fill(layer, glow.color.opacity(0.08)).corner_radii(radius),
                            );
                        }
                    }
                    if animate && bounds.size.width > px(0.) && bounds.size.height > px(0.) {
                        let w = f32::from(bounds.size.width);
                        let h = f32::from(bounds.size.height);
                        for particle in &particles {
                            let x = (particle.x * w + (time * 0.3 + particle.y * 6.).sin() * speed)
                                .rem_euclid(w);
                            let y = (particle.y * h - time * particle.drift * speed).rem_euclid(h);
                            let alpha =
                                particle.alpha * (0.7 + 0.3 * (time + particle.x * 6.).sin());
                            let extent = px(particle.size);
                            let dot = Bounds::new(
                                bounds.origin + point(px(x), px(y)),
                                size(extent, extent),
                            );
                            window.paint_quad(
                                fill(dot, color.opacity(alpha)).corner_radii(extent / 2.),
                            );
                        }
                    }
                });
            },
        )
        .absolute()
        .inset_0()
        .into_any_element(),
    )
}

fn ring_fraction(value: &Value, max: &Value) -> f32 {
    let Some(max) = max.as_f64().filter(|max| *max > 0.) else {
        return 0.;
    };
    (value.as_f64().unwrap_or(0.) / max).clamp(0., 1.) as f32
}

pub(super) fn ring(n: &Value, id: SharedString, window: &mut Window, cx: &mut App) -> AnyElement {
    let extent = motion::number(&n["size"], 22., 1., 512.);
    let thickness = px(motion::number(
        &n["thickness"],
        2.,
        0.25,
        f64::from(extent) / 2.,
    ));
    let target = ring_fraction(&n["value"], &n["max"]);
    let timing = motion::timing(&n["transition"]).unwrap_or_else(|| default_timing(240));
    let fraction = animate::transition((id, "ring-fill"), target, policy(&timing, cx), window, cx)
        .clamp(0., 1.);
    let color = style::color_of(cx, n, "color").unwrap_or(cx.theme().primary);
    let track = style::color_of(cx, n, "trackColor").unwrap_or(cx.theme().muted);
    let paint = canvas(
        |_, _, _| {},
        move |bounds, _, window, _| {
            let radius = (bounds.size.width - thickness) / 2.;
            let center = bounds.center();
            if let Some(path) = gauge_arc(center, radius, thickness, 1.) {
                window.paint_path(path, track);
            }
            if let Some(path) = gauge_arc(center, radius, thickness, fraction) {
                window.paint_path(path, color);
            }
        },
    )
    .absolute()
    .inset_0();
    div()
        .relative()
        .size(px(extent))
        .flex_none()
        .overflow_hidden()
        .flex()
        .items_center()
        .justify_center()
        .child(paint)
        .when_some(
            n["label"].as_str().filter(|label| !label.is_empty()),
            |d, label| {
                d.child(
                    div()
                        .text_size(px((extent * 0.32).clamp(3., 12.)))
                        .line_height(px(extent))
                        .whitespace_nowrap()
                        .text_color(color)
                        .child(label.to_owned()),
                )
            },
        )
        .into_any_element()
}

fn gauge_arc(
    center: Point<Pixels>,
    radius: Pixels,
    thickness: Pixels,
    fraction: f32,
) -> Option<Path<Pixels>> {
    use std::f32::consts::{FRAC_PI_2, PI, TAU};
    if fraction <= 0. || radius <= px(0.) {
        return None;
    }
    let polar = |angle: f32, r: Pixels| point(r * angle.cos(), r * angle.sin());
    let start = -FRAC_PI_2;
    let end = start + fraction * TAU;
    let steps = (fraction * (f32::from(radius) * 2.).clamp(48., 192.)).ceil() as usize;
    if fraction >= 1. {
        let mut path = PathBuilder::stroke(thickness);
        path.move_to(center + polar(start, radius));
        for i in 1..steps {
            path.line_to(center + polar(start + TAU * i as f32 / steps as f32, radius));
        }
        path.close();
        return path.build().ok();
    }

    // One filled contour gives both caps the same alpha as the body.
    let half_width = thickness / 2.;
    let points =
        (0..=steps)
            .map(|i| {
                center
                    + polar(
                        start + (end - start) * i as f32 / steps as f32,
                        radius + half_width,
                    )
            })
            .chain((1..=10).map(|i| {
                center + polar(end, radius) + polar(end + PI * i as f32 / 10., half_width)
            }))
            .chain((0..steps).rev().map(|i| {
                center
                    + polar(
                        start + (end - start) * i as f32 / steps as f32,
                        radius - half_width,
                    )
            }))
            .chain((1..10).map(|i| {
                center + polar(start, radius) + polar(start + PI + PI * i as f32 / 10., half_width)
            }))
            .collect::<Vec<_>>();
    let mut path = PathBuilder::fill().with_style(PathStyle::Fill(
        FillOptions::default().with_fill_rule(FillRule::NonZero),
    ));
    path.add_polygon(&points, true);
    path.build().ok()
}

#[cfg(all(test, feature = "snapshot"))]
mod clock_tests {
    use super::{PaintClock, GRID};
    use gpui_kit::{self as gpui, canvas, div, px, size, AppContext, Context, Entity, IntoElement,
        ParentElement, Render, StyleRefinement, Styled, TestAppContext, VisualTestContext, Window};
    use std::rc::Rc;

    struct Spinner(Rc<PaintClock>);
    impl Render for Spinner {
        fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
            let clock = self.0.clone();
            canvas(|_, _, _| {}, move |_, _, window, cx| {
                clock.sample(true, GRID, window, cx);
            }).size_full()
        }
    }

    struct Pair(Entity<Spinner>, Entity<Spinner>);
    impl Render for Pair {
        fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
            let style = StyleRefinement::default().w(px(14.)).h(px(14.));
            div().size_full().child(gpui::AnyView::from(self.0.clone()).cached(style.clone()))
                .child(gpui::AnyView::from(self.1.clone()).cached(style))
        }
    }

    #[gpui::test]
    fn shared_clock_schedules_every_cached_view(cx: &mut TestAppContext) {
        let clock = Rc::<PaintClock>::default();
        let window = cx.open_window(size(px(100.), px(100.)), |_, cx| {
            let first = cx.new(|_| Spinner(clock.clone()));
            let second = cx.new(|_| Spinner(clock.clone()));
            Pair(first, second)
        });
        let mut visual = VisualTestContext::from_window(window.into(), cx);
        visual.update(|window, cx| window.draw(cx).clear(cx));
        assert_eq!(clock.scheduled.borrow().len(), 2, "each cached view must receive its own tick");
        // A second paint before the scheduled tick must not queue duplicate timers.
        visual.update(|window, cx| { window.refresh(); window.draw(cx).clear(cx); });
        assert_eq!(clock.scheduled.borrow().len(), 2);
    }
}

#[cfg(test)]
mod ring_tests {
    use super::{gauge_arc, ring_fraction};
    use gpui_kit::{point, px};
    use serde_json::json;

    #[test]
    fn ring_clamps_values_and_draws_clockwise_from_twelve() {
        assert_eq!(ring_fraction(&json!(25), &json!(100)), 0.25);
        assert_eq!(ring_fraction(&json!(8), &json!(0)), 0.);
        assert_eq!(ring_fraction(&json!(-1), &json!(4)), 0.);
        assert_eq!(ring_fraction(&json!(5), &json!(4)), 1.);
        let center = point(px(11.), px(11.));
        assert!(gauge_arc(center, px(10.), px(2.), 0.).is_none());
        let quarter = gauge_arc(center, px(10.), px(2.), 0.25).unwrap().bounds;
        assert!(quarter.left() >= px(9.9) && quarter.top() <= px(0.1));
        assert!(quarter.right() >= px(21.9) && quarter.bottom() <= px(12.1));
        let full = gauge_arc(center, px(10.), px(2.), 1.).unwrap().bounds;
        assert!(full.left() <= px(0.1) && full.bottom() >= px(21.9));
    }
}
