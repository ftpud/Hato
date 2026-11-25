//! Native cache boundaries for module bodies. Frame-collected nodes keep the eager path:
//! Shell must register their overlays/lifetimes before it builds the window's overlay layers.
use super::*;

pub(super) struct Plan {
    tree: Arc<Value>,
    cacheable: bool,
}

/// An allowlist makes new native node kinds eager until their frame/lifecycle effects have
/// been audited. Walk actual UI children only, not menus or arbitrary module event payloads.
fn cacheable(node: &Value) -> bool {
    if node["presence"].is_object() || node["style"]["position"] == "absolute" || node["itemHeight"].is_number() {
        return false;
    }
    if !matches!(node["type"].as_str(), Some(
        "column" | "row" | "scroll" | "split" | "transcript" | "label" | "markdown" | "icon" | "image" |
        "button" | "textInput" | "imagePicker" | "select" | "choice" | "toggle" | "switch" |
        "tree" | "progress" | "meter" | "ring" | "spinner" | "status" | "divider" | "spacer"
    )) {
        return false;
    }
    node["children"].as_array().is_none_or(|children| children.iter().all(cacheable))
}

#[cfg(test)]
mod plan_tests {
    use super::cacheable;
    use serde_json::json;

    #[test]
    fn frame_registrations_and_trusted_controls_keep_the_eager_path() {
        for ty in ["popover", "modal", "floating", "window", "slot", "theme", "titleBar",
            "dropZone", "canvas", "codeViewer", "securityPreferences", "approvals", "futureNode"] {
            assert!(!cacheable(&json!({"type":"column", "children":[{"type":ty}]})), "{ty}");
        }
        assert!(!cacheable(&json!({"type":"column", "children":[{"type":"label", "presence":{}}]})));
        assert!(!cacheable(&json!({"type":"scroll", "itemHeight":24, "children":[]})));
        // Event payloads are data, not rendered children.
        assert!(cacheable(&json!({"type":"button", "value":{"type":"modal"}})));
        assert!(cacheable(&json!({"type":"split", "children":[
            {"type":"transcript", "children":[{"type":"markdown", "text":"Hello"}]},
            {"type":"textInput", "key":"draft"}
        ]})));
    }
}

#[cfg(all(test, feature = "snapshot"))]
mod tests {
    use super::Shell;
    use crate::{bridge::{UiBridge, UiMsg}, config::Config, kernel::Kernel};
    use gpui_kit::{self as gpui, point, px, rgb, size, Modifiers, MouseButton, TestAppContext, VisualTestContext};
    use serde_json::json;
    use std::{cell::RefCell, collections::HashMap, sync::Arc};

    thread_local! { static RENDERS: RefCell<HashMap<String, usize>> = RefCell::default(); }
    pub(super) fn record(module: &str) {
        RENDERS.with(|counts| *counts.borrow_mut().entry(module.to_owned()).or_default() += 1);
    }
    pub(super) fn count(module: &str) -> usize {
        RENDERS.with(|counts| counts.borrow().get(module).copied().unwrap_or(0))
    }

    #[gpui::test]
    fn sibling_panels_reuse_paint_and_keep_input_handles(cx: &mut TestAppContext) {
        cx.update(gpui_kit::init);
        let temp = tempfile::tempdir().unwrap();
        let cfg = Config::from_args(&[
            "hato".into(), "--repo-root".into(), temp.path().display().to_string(),
            "--data-dir".into(), temp.path().join("data").display().to_string(),
        ]).unwrap();
        let kernel = Kernel::new(cfg, UiBridge::disconnected()).unwrap();
        let panel = |color: &str| Arc::new(json!({"type":"column", "key":"root", "grow":true,
            "style":{"background":color}, "children":[
                {"type":"button", "key":"save", "text":"Save", "action":"save"},
                {"type":"textInput", "key":"draft", "value":"Initial text"}
            ]}));
        let window = cx.open_window(size(px(600.), px(300.)), |window, cx| {
            let mut shell = Shell::new(kernel.clone(), UiBridge::new().1, window, cx);
            shell.only_module = Some("__snapshot".into());
            shell.trees.insert("__snapshot".into(), Arc::new(json!({"type":"row", "key":"layout", "grow":true,
                "children":[{"type":"slot", "key":"a", "module":"__panel-a", "grow":true},
                    {"type":"slot", "key":"b", "module":"__panel-b", "grow":true}]})));
            shell.trees.insert("__panel-a".into(), panel("#125634"));
            shell.trees.insert("__panel-b".into(), panel("#563412"));
            shell
        });
        let mut visual = VisualTestContext::from_window(window.into(), cx);
        let draw = |visual: &mut VisualTestContext| visual.update(|window, cx| window.draw(cx).clear(cx));
        draw(&mut visual);
        draw(&mut visual);
        let before = count("__panel-b");
        assert!(before > 0);
        visual.update(|window, cx| {
            let shell = window.root::<Shell>().unwrap().unwrap();
            assert_eq!(shell.read(cx).inputs[&("__panel-a".into(), "draft".into())].input.value(cx), "Initial text");
            shell.update(cx, |shell, cx| shell.on_msg(UiMsg::Tree {
                module:"__panel-a".into(), generation:0, tree:panel("#341256"),
            }, window, cx));
        });
        draw(&mut visual);
        draw(&mut visual);
        assert_eq!(count("__panel-b"), before, "a sibling snapshot must not render this panel again");
        assert!(visual.update(|window, _| window.painted_quads().iter().any(|q| q.background == rgb(0x563412).into())));
        assert!(visual.update(|window, _| window.painted_quads().iter().any(|q| q.background == rgb(0x341256).into())));

        // Native split overrides change without a module snapshot while a divider is dragged.
        visual.update(|window, cx| {
            window.root::<Shell>().unwrap().unwrap().update(cx, |shell, cx| shell.on_msg(UiMsg::Tree {
                module:"__panel-a".into(), generation:0,
                tree:Arc::new(json!({"type":"split", "key":"split", "direction":"horizontal", "minSize":20,
                    "sizes":[0.5,0.5], "children":[
                        {"type":"column", "key":"left", "grow":true, "style":{"background":"#256341"}},
                        {"type":"column", "key":"right", "grow":true, "style":{"background":"#634125"}}
                    ]})),
            }, window, cx));
        });
        draw(&mut visual);
        draw(&mut visual);
        let width = |visual: &mut VisualTestContext| visual.update(|window, _| {
            window.painted_quads().iter().find(|q| q.background == rgb(0x256341).into()).unwrap().bounds.size.width
        });
        let original = width(&mut visual);
        let bounds = visual.update(|window, cx| {
            let shell = window.root::<Shell>().unwrap().unwrap();
            let bounds = shell.read(cx).lay.bounds.borrow()["__panel-a::/split"];
            bounds
        });
        let start = point(bounds.origin.x + bounds.size.width / 2., bounds.origin.y + px(20.));
        visual.simulate_mouse_down(start, MouseButton::Left, Modifiers::default());
        draw(&mut visual);
        let end = start + point(px(40.), px(0.));
        visual.simulate_mouse_move(end, MouseButton::Left, Modifiers::default());
        draw(&mut visual);
        let resized = width(&mut visual);
        assert!(resized > original, "cached split must apply native drag geometry");
        visual.simulate_mouse_up(end, MouseButton::Left, Modifiers::default());
        draw(&mut visual);
        draw(&mut visual);
        assert_eq!(width(&mut visual), resized, "release must retain the final native geometry");
        kernel.shutdown();
    }
}

#[cfg(all(test, feature = "snapshot"))]
pub(super) fn render_count(module: &str) -> usize { tests::count(module) }

struct PanelView {
    shell: WeakEntity<Shell>,
    module: String,
    tree: Arc<Value>,
    controls: Value,
    depth: usize,
    fullscreen: bool,
    dragging: bool,
    scrollbars: scrollbar_layer::Registry,
    _subscriptions: Vec<Subscription>,
}

impl Render for PanelView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        redraw_stats::cause(format!("panel:{}", self.module));
        #[cfg(all(test, feature = "snapshot"))]
        tests::record(&self.module);
        self.shell.update(cx, |shell, cx| {
            let controls = std::mem::replace(&mut shell.control_style, self.controls.clone());
            self.scrollbars.borrow_mut().clear();
            let scrollbars = shell.scrollbar_layer.replace(self.scrollbars.clone());
            shell.prepare_panel_inputs(&self.module, &self.tree, window, cx);
            let body = shell.node(&self.module, &self.tree, "", self.depth, window, cx);
            shell.control_style = controls;
            shell.scrollbar_layer = scrollbars;
            v_flex().size_full().min_w_0().min_h_0().child(body).into_any_element()
        }).unwrap_or_else(|_| Empty.into_any_element())
    }
}

impl Shell {
    fn prepare_panel_inputs(&mut self, module: &str, node: &Value, window: &mut Window, cx: &mut Context<Self>) {
        if !visible_in(node, window.is_fullscreen()) { return; }
        if node["type"] == "textInput" {
            self.ensure_input_slot(module, node["key"].as_str().unwrap_or("_"), node, window, cx);
        }
        for (index, child) in node["children"].as_array().into_iter().flatten().take(2000).enumerate() {
            if node["type"] == "split" && node["fixed"][index].as_f64().is_some_and(|size| size <= 0.) { continue; }
            self.prepare_panel_inputs(module, child, window, cx);
        }
    }

    pub(super) fn panel_cacheable(&mut self, module: &str, tree: &Arc<Value>, window: &Window) -> bool {
        let plan = self.panel_plans.entry(module.to_owned()).or_insert_with(|| Plan {
            tree: tree.clone(), cacheable: cacheable(tree),
        });
        if !Arc::ptr_eq(&plan.tree, tree) {
            *plan = Plan { tree: tree.clone(), cacheable: cacheable(tree) };
        }
        // A previous snapshot may still have exiting children. Keep rendering it eagerly
        // until its presence state has finished; otherwise the shell's pruning would drop it.
        plan.cacheable && !self.motion.has_module_presence(module, window)
    }

    pub(super) fn cached_panel(&mut self, module: &str, mount: &str, tree: Arc<Value>, depth: usize, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let shell = cx.weak_entity();
        let fullscreen = window.is_fullscreen();
        let dragging = self.lay.drag.is_some();
        let view = window.use_keyed_state((ElementId::from(sid(module, &format!("__panel/{mount}"))), "panel-view"), cx, |_, cx| {
            let subscriptions = vec![
                cx.observe_global::<gpui_component::Theme>(|_, cx| cx.notify()),
                cx.observe_global::<gpui_kit::base::motion::SurfaceStyles>(|_, cx| cx.notify()),
            ];
            PanelView { shell, module: module.to_owned(), tree: tree.clone(), controls: self.control_style.clone(), depth, fullscreen, dragging, scrollbars: Default::default(), _subscriptions: subscriptions }
        });
        view.update(cx, |view, cx| {
            if !Arc::ptr_eq(&view.tree, &tree) || view.controls != self.control_style || view.depth != depth || view.fullscreen != fullscreen || dragging || view.dragging {
                view.tree = tree;
                view.controls = self.control_style.clone();
                view.depth = depth;
                view.fullscreen = fullscreen;
                view.dragging = dragging;
                cx.notify();
            }
        });
        let registry = view.read(cx).scrollbars.clone();
        let owner = view.entity_id();
        let bars = window.use_keyed_state((ElementId::from(sid(module, &format!("__panel/{mount}"))), "scrollbar-layer"), cx, |_, _| {
            scrollbar_layer::Layer::new(owner, registry)
        });
        v_flex().relative().size_full().flex_1().min_w_0().min_h_0()
            .child(AnyView::from(view).cached(StyleRefinement::default().size_full().flex_1().min_w_0().min_h_0()))
            .child(scrollbar_layer::late(bars))
            .into_any_element()
    }
}
