//! Scrollbar animation is a sibling of cached panel content. Fades/hover-width changes notify
//! this layer; offset changes from native pointer events also notify the owning content view.
use super::*;
use std::{cell::{Cell, RefCell}, rc::Rc};

pub(super) type Geometry = Rc<Cell<Option<(Bounds<Pixels>, ContentMask<Pixels>)>>>;
pub(super) type Registry = Rc<RefCell<HashMap<String, Binding>>>;

#[derive(Clone)]
pub(super) struct Binding {
    pub handle: ScrollHandle,
    pub mode: ScrollbarMode,
    pub geometry: Geometry,
}

pub(super) struct Layer {
    owner: EntityId,
    registry: Registry,
    origin: Point<Pixels>,
}

impl Layer {
    pub(super) fn new(owner: EntityId, registry: Registry) -> Self {
        Self { owner, registry, origin: Point::default() }
    }
}

impl Render for Layer {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        let mut bindings: Vec<_> = self.registry.borrow().iter().map(|(key, b)| (key.clone(), b.clone())).collect();
        bindings.sort_by(|a, b| a.0.cmp(&b.0));
        if !bindings.is_empty() { redraw_stats::cause("view:scrollbars"); }
        let origin = self.origin;
        let bars = bindings.into_iter().filter_map(move |(key, binding)| {
            let (bounds, mask) = binding.geometry.get()?;
            let clip = ContentMask { bounds }.intersect(&mask).bounds;
            Some(div().id(SharedString::from(key)).absolute()
                .left(clip.origin.x - origin.x).top(clip.origin.y - origin.y)
                .w(clip.size.width).h(clip.size.height).overflow_hidden()
                .child(div().absolute().left(bounds.origin.x - clip.origin.x).top(bounds.origin.y - clip.origin.y)
                    .w(bounds.size.width).h(bounds.size.height)
                    .child(Scrollbar::vertical(&binding.handle).mode(binding.mode).viewport_bounds(bounds))))
        });
        let registry = self.registry.clone();
        let owner = self.owner;
        // Defer until native scrollbar handlers have applied their offset changes. Unlike
        // observing the scrollbar view, this does not invalidate content for decorative ticks.
        let watch = canvas(|_, _, _| {}, move |_, _, window, _| {
            let check = {
                let registry = registry.clone();
                move |cx: &mut App| {
                    let before: Vec<_> = registry.borrow().values().map(|b| (b.handle.clone(), b.handle.offset())).collect();
                    cx.defer(move |cx| {
                        if before.iter().any(|(handle, offset)| handle.offset() != *offset) {
                            cx.notify(owner);
                        }
                    });
                }
            };
            let down = check.clone();
            window.on_mouse_event(move |_: &MouseDownEvent, phase, _, cx| { if phase == DispatchPhase::Capture { down(cx); } });
            let moved = check.clone();
            window.on_mouse_event(move |event: &MouseMoveEvent, phase, _, cx| {
                if phase == DispatchPhase::Capture && event.pressed_button.is_some() { moved(cx); }
            });
            let up = check.clone();
            window.on_mouse_event(move |_: &MouseUpEvent, phase, _, cx| { if phase == DispatchPhase::Capture { up(cx); } });
            let scroll = check.clone();
            window.on_mouse_event(move |_: &ScrollEvent, phase, _, cx| { if phase == DispatchPhase::Capture { scroll(cx); } });
            window.on_mouse_event(move |_: &TouchDragEvent, phase, _, cx| { if phase == DispatchPhase::Capture { check(cx); } });
        }).absolute().inset_0();
        div().size_full().children(bars).child(watch)
    }
}

/// Render after the cached panel's prepaint, when current viewport bounds and bindings exist.
/// A normal uncached view would render during layout, before a dirty cached panel is rendered.
pub(super) fn late(view: Entity<Layer>) -> AnyElement {
    div().absolute().inset_0().child(LateLayer(view)).into_any_element()
}

struct LateLayer(Entity<Layer>);
impl IntoElement for LateLayer {
    type Element = Self;
    fn into_element(self) -> Self { self }
}
impl Element for LateLayer {
    type RequestLayoutState = ();
    type PrepaintState = AnyElement;
    fn id(&self) -> Option<ElementId> { None }
    fn source_location(&self) -> Option<&'static std::panic::Location<'static>> { None }
    fn request_layout(&mut self, _: Option<&GlobalElementId>, _: Option<&InspectorElementId>, window: &mut Window, cx: &mut App) -> (LayoutId, ()) {
        let mut style = Style::default();
        style.size.width = relative(1.).into();
        style.size.height = relative(1.).into();
        (window.request_layout(style, None, cx), ())
    }
    fn prepaint(&mut self, _: Option<&GlobalElementId>, _: Option<&InspectorElementId>, bounds: Bounds<Pixels>, _: &mut (), window: &mut Window, cx: &mut App) -> AnyElement {
        let empty = self.0.read(cx).registry.borrow().is_empty();
        let mut element = if empty {
            Empty.into_any_element()
        } else {
            self.0.update(cx, |layer, _| layer.origin = bounds.origin);
            self.0.clone().into_any_element()
        };
        element.layout_as_root(bounds.size.into(), window, cx);
        element.prepaint_at(bounds.origin, window, cx);
        element
    }
    fn paint(&mut self, _: Option<&GlobalElementId>, _: Option<&InspectorElementId>, _: Bounds<Pixels>, _: &mut (), element: &mut AnyElement, window: &mut Window, cx: &mut App) {
        element.paint(window, cx);
    }
}

#[cfg(all(test, feature = "snapshot"))]
mod tests {
    use super::super::{panel_view, Shell};
    use crate::{bridge::{UiBridge, UiMsg}, config::Config, kernel::Kernel};
    use gpui_kit::{self as gpui, point, px, size, Modifiers, MouseButton, TestAppContext, VisualTestContext};
    use serde_json::json;
    use std::sync::Arc;

    fn history(prepend: bool) -> Arc<serde_json::Value> {
        let mut rows: Vec<_> = (0..20).map(|i| json!({
            "type":"column", "key":format!("message-{i}"), "height":40,
            "style":{"background":"#254321"}, "children":[{"type":"label", "text":format!("Message {i}")}]
        })).collect();
        if prepend { rows.insert(0, json!({"type":"column", "key":"older", "height":50})); }
        Arc::new(json!({"type":"transcript", "key":"history", "grow":true,
            "scrollbarMode":"always", "children":rows}))
    }

    #[gpui::test]
    fn scrollbar_ticks_reuse_content_but_pointer_scrolling_repaints_it(cx: &mut TestAppContext) {
        cx.update(gpui_kit::init);
        let temp = tempfile::tempdir().unwrap();
        let cfg = Config::from_args(&[
            "hato".into(), "--repo-root".into(), temp.path().display().to_string(),
            "--data-dir".into(), temp.path().join("data").display().to_string(),
        ]).unwrap();
        let kernel = Kernel::new(cfg, UiBridge::disconnected()).unwrap();
        let module = "__scrollbar-panel";
        let window = cx.open_window(size(px(400.), px(220.)), |window, cx| {
            let mut shell = Shell::new(kernel.clone(), UiBridge::new().1, window, cx);
            shell.only_module = Some(module.into());
            shell.trees.insert(module.into(), history(false));
            shell
        });
        let mut visual = VisualTestContext::from_window(window.into(), cx);
        let draw = |visual: &mut VisualTestContext| visual.update(|window, cx| window.draw(cx).clear(cx));
        for _ in 0..4 { draw(&mut visual); }
        let (handle, bounds) = visual.update(|window, cx| {
            let shell = window.root::<Shell>().unwrap().unwrap();
            let shell = shell.read(cx);
            let state = shell.scrolls.values().next().unwrap();
            (state.handle.clone(), state.handle.bounds())
        });
        let bottom = handle.offset().y;
        assert!(bottom < px(-100.));
        let before = panel_view::render_count(module);
        let thumb = point(bounds.right() - px(7.), bounds.bottom() - px(20.));
        visual.simulate_mouse_move(thumb, None, Modifiers::default());
        draw(&mut visual);
        let mut ticks = 0;
        for _ in 0..8 {
            ticks += visual.update(|window, cx| window.simulate_next_frame(cx));
            draw(&mut visual);
        }
        assert!(ticks > 0, "native scrollbar animation must actually request frames");
        assert_eq!(panel_view::render_count(module), before, "decorative ticks must not rebuild the transcript");

        let track = point(bounds.right() - px(7.), bounds.top() + px(20.));
        visual.simulate_mouse_down(track, MouseButton::Left, Modifiers::default());
        visual.simulate_mouse_up(track, MouseButton::Left, Modifiers::default());
        draw(&mut visual);
        draw(&mut visual);
        assert!(handle.offset().y > bottom + px(1.), "native track click must scroll towards history");
        assert!(panel_view::render_count(module) > before, "scrolling must repaint content despite the cache");

        let anchor = |visual: &mut VisualTestContext| visual.update(|window, cx| {
            let shell = window.root::<Shell>().unwrap().unwrap();
            let shell = shell.read(cx);
            let state = shell.scrolls.values().next().unwrap();
            let y = state.positions.borrow()["message-0"] - state.viewport_y.get();
            y
        });
        let old_anchor = anchor(&mut visual);
        visual.update(|window, cx| window.root::<Shell>().unwrap().unwrap().update(cx, |shell, cx| {
            shell.on_msg(UiMsg::Tree { module:module.into(), generation:0, tree:history(true) }, window, cx);
        }));
        for _ in 0..6 {
            visual.update(|window, cx| window.simulate_next_frame(cx));
            draw(&mut visual);
        }
        assert!((anchor(&mut visual) - old_anchor).abs() <= 1., "prepending history must retain the visible anchor");

        // Removing a transcript removes the sibling scrollbar's live bindings immediately.
        visual.update(|window, cx| window.root::<Shell>().unwrap().unwrap().update(cx, |shell, cx| {
            shell.on_msg(UiMsg::Tree { module:module.into(), generation:0,
                tree:Arc::new(json!({"type":"column", "key":"empty", "grow":true})) }, window, cx);
        }));
        draw(&mut visual);
        draw(&mut visual);
        let empty = panel_view::render_count(module);
        visual.simulate_mouse_down(track, MouseButton::Left, Modifiers::default());
        visual.simulate_mouse_up(track, MouseButton::Left, Modifiers::default());
        draw(&mut visual);
        assert_eq!(panel_view::render_count(module), empty);
        kernel.shutdown();
    }
}
