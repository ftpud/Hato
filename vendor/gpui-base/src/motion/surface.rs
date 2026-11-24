use std::time::{Duration, Instant};

use gpui::{
    AnyElement, App, Bounds, ContentMask, Element, ElementId, GlobalElementId, InspectorElementId,
    IntoElement, LayoutId, Pixels, Point, Window, point, px,
};

use super::Easing;

/// Optional presentation data supplied by the application.
#[derive(Default)]
pub struct SurfaceStyles {
    pub menu: Option<SurfaceTransition>,
    pub tooltip: Option<SurfaceTransition>,
    pub interaction: Option<SurfaceTiming>,
}

impl gpui::Global for SurfaceStyles {}

/// An application-resolved policy. Reduced keeps opacity and drops spatial effects.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum SurfaceMotion {
    #[default]
    Full,
    Reduced,
    Off,
}

#[derive(Clone, Debug)]
pub struct SurfaceTiming {
    pub duration: Duration,
    pub easing: Easing,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SurfacePose {
    pub opacity: f32,
    pub offset: Point<Pixels>,
}

impl Default for SurfacePose {
    fn default() -> Self {
        Self {
            opacity: 1.,
            offset: point(px(0.), px(0.)),
        }
    }
}

#[derive(Clone, Debug)]
pub struct SurfaceLeg {
    pub timing: SurfaceTiming,
    pub pose: SurfacePose,
}

#[derive(Clone, Debug, Default)]
pub struct SurfaceTransition {
    pub enter: Option<SurfaceLeg>,
    pub exit: Option<SurfaceLeg>,
}

struct Flight {
    from: SurfacePose,
    to: SurfacePose,
    started: Instant,
    timing: SurfaceTiming,
}

/// Interruptible presence, with the active timing captured at the start of each leg.
#[derive(Default)]
pub struct SurfacePresence {
    visible: bool,
    flight: Option<Flight>,
}

impl SurfacePresence {
    pub fn sample(
        &mut self,
        visible: bool,
        transition: &SurfaceTransition,
        mode: SurfaceMotion,
        now: Instant,
    ) -> (SurfacePose, bool) {
        let previous = self.flight.as_ref().map(|flight| flight.sample(now));
        if mode == SurfaceMotion::Off {
            self.visible = visible;
            self.flight = None;
        } else if self.visible != visible {
            self.visible = visible;
            let leg = if visible {
                &transition.enter
            } else {
                &transition.exit
            };
            self.flight = leg
                .as_ref()
                .filter(|leg| !leg.timing.duration.is_zero())
                .map(|leg| {
                    let rest = SurfacePose::default();
                    let from = previous.map(|(pose, _)| pose).unwrap_or(if visible {
                        leg.pose
                    } else {
                        rest
                    });
                    let to = if visible { rest } else { leg.pose };
                    Flight {
                        from,
                        to,
                        started: now,
                        timing: leg.timing.clone(),
                    }
                });
        }
        if let Some(flight) = &mut self.flight {
            if mode == SurfaceMotion::Reduced {
                flight.from.offset = point(px(0.), px(0.));
                flight.to.offset = point(px(0.), px(0.));
            }
            let (pose, running) = flight.sample(now);
            if running && flight.from != flight.to {
                return (pose, true);
            }
            self.flight = None;
        }
        (SurfacePose::default(), false)
    }
}

impl Flight {
    fn sample(&self, now: Instant) -> (SurfacePose, bool) {
        let elapsed = now.saturating_duration_since(self.started);
        let t = self
            .timing
            .easing
            .sample((elapsed.as_secs_f32() / self.timing.duration.as_secs_f32()).min(1.))
            .clamp(0., 1.);
        let pose = SurfacePose {
            opacity: self.from.opacity + (self.to.opacity - self.from.opacity) * t,
            offset: self.from.offset + (self.to.offset - self.from.offset) * t,
        };
        (pose, elapsed < self.timing.duration)
    }
}

/// Applies displacement in prepaint so painting and hit testing share the same geometry.
pub struct SurfaceOffset {
    child: AnyElement,
    offset: Point<Pixels>,
    reveal: Option<(f32, bool, bool, Pixels)>,
    clip: Option<Bounds<Pixels>>,
}

impl SurfaceOffset {
    pub fn new(child: impl IntoElement, offset: Point<Pixels>) -> Self {
        Self {
            child: child.into_any_element(),
            offset,
            reveal: None,
            clip: None,
        }
    }

    /// Clip a stable viewport toward an edge and translate its content by up to `travel`.
    pub fn reveal(mut self, progress: f32, horizontal: bool, end: bool, travel: Pixels) -> Self {
        self.reveal = Some((progress.clamp(0., 1.), horizontal, end, travel));
        self
    }
}

impl IntoElement for SurfaceOffset {
    type Element = Self;
    fn into_element(self) -> Self {
        self
    }
}

impl Element for SurfaceOffset {
    type RequestLayoutState = ();
    type PrepaintState = ();

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
    ) {
        let mut offset = self.offset;
        if let Some((progress, horizontal, end, travel)) = self.reveal {
            let mut clip = bounds;
            if horizontal {
                let hidden = bounds.size.width * (1. - progress);
                clip.size.width -= hidden;
                if end {
                    clip.origin.x += hidden;
                }
                let distance = travel.min(bounds.size.width) * (1. - progress);
                offset.x += if end { distance } else { -distance };
            } else {
                let hidden = bounds.size.height * (1. - progress);
                clip.size.height -= hidden;
                if end {
                    clip.origin.y += hidden;
                }
                let distance = travel.min(bounds.size.height) * (1. - progress);
                offset.y += if end { distance } else { -distance };
            }
            self.clip = Some(clip);
        }
        window.with_content_mask(self.clip.map(|bounds| ContentMask { bounds }), |window| {
            window.with_element_offset(offset, |window| self.child.prepaint(window, cx));
        });
    }

    fn paint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        _: Bounds<Pixels>,
        _: &mut (),
        _: &mut (),
        window: &mut Window,
        cx: &mut App,
    ) {
        window.with_content_mask(self.clip.map(|bounds| ContentMask { bounds }), |window| {
            self.child.paint(window, cx);
        });
    }
}
