//! GPUI computes the native wheel delta and applies it before a viewport's
//! bubble listener. Compare the offset from capture with the clamped result
//! to stop the wheel at the first viewport that actually moves.
use gpui_kit::*;
use std::{cell::Cell, rc::Rc};

pub(super) fn handle(id: &SharedString, window: &mut Window, cx: &mut App) -> ScrollHandle {
    window
        .use_keyed_state(
            (ElementId::from(id.clone()), "scroll-handle"),
            cx,
            |_, _| ScrollHandle::new(),
        )
        .read(cx)
        .clone()
}

pub(super) fn viewport(
    id: SharedString,
    content: Div,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let handle = handle(&id, window, cx);
    let viewport = div()
        .id(id)
        .flex_1()
        .min_h_0()
        .w_full()
        .overflow_y_scroll()
        .track_scroll(&handle)
        .child(content);
    chain(viewport, handle, |_, _, _| {})
}

pub(super) fn chain(
    viewport: impl InteractiveElement + IntoElement,
    handle: ScrollHandle,
    on_scroll: impl Fn(&ScrollEvent, &mut Window, &mut App) + 'static,
) -> AnyElement {
    let start = Rc::new(Cell::new(px(0.)));
    let before_scroll = start.clone();
    let capture = handle.clone();
    let child = viewport
        .on_scroll(move |event, window, cx| {
            let offset = handle.offset();
            let min = -handle.max_offset().y;
            let before = before_scroll.get().clamp(min, px(0.));
            let after = offset.y.clamp(min, px(0.));
            if offset.y != after {
                // Another wheel event can arrive before the next layout pass clamps the handle.
                handle.set_offset(point(offset.x, after));
            }
            on_scroll(event, window, cx);
            if before != after {
                cx.stop_propagation();
            }
        })
        .into_any_element();
    ScrollCapture {
        child,
        handle: capture,
        start,
    }
    .into_any_element()
}

struct ScrollCapture {
    child: AnyElement,
    handle: ScrollHandle,
    start: Rc<Cell<Pixels>>,
}

impl IntoElement for ScrollCapture {
    type Element = Self;
    fn into_element(self) -> Self {
        self
    }
}

impl Element for ScrollCapture {
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
        _: Bounds<Pixels>,
        _: &mut (),
        window: &mut Window,
        cx: &mut App,
    ) {
        self.child.prepaint(window, cx);
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
        let handle = self.handle.clone();
        let start = self.start.clone();
        window.on_mouse_event(move |_: &ScrollEvent, phase, _, _| {
            if phase == DispatchPhase::Capture {
                start.set(handle.offset().y);
            }
        });
        self.child.paint(window, cx);
    }
}
