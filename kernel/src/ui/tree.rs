//! Lazy rendering for module-supplied tree rows. Only fixed-height rows can use
//! GPUI's uniform list; content-sized trees retain their ordinary flex layout.
use super::*;
use std::{cell::RefCell, ops::Range, rc::Rc};

/// Tree controls do not register shell overlays or child slots. They can be rendered lazily
/// behind a native view boundary without skipping the shell's frame bookkeeping.
struct CachedTree {
    shell: WeakEntity<Shell>,
    module: String,
    path: String,
    node: Arc<Value>,
    controls: Value,
    _subscriptions: Vec<Subscription>,
}

impl CachedTree {
    fn new(shell: WeakEntity<Shell>, module: String, path: String, node: Arc<Value>, controls: Value, cx: &mut Context<Self>) -> Self {
        let subscriptions = vec![
            cx.observe_global::<gpui_component::Theme>(|_, cx| cx.notify()),
            cx.observe_global::<gpui_kit::base::motion::SurfaceStyles>(|_, cx| cx.notify()),
        ];
        Self { shell, module, path, node, controls, _subscriptions: subscriptions }
    }
}

impl Render for CachedTree {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        #[cfg(all(test, feature = "snapshot"))]
        tests::RENDERS.with(|count| count.set(count.get() + 1));
        self.shell.update(cx, |shell, cx| {
            // Other modules can configure controls later in Shell::render. Use the settings
            // that applied at this tree's original position, even when it renders lazily.
            let previous = std::mem::replace(&mut shell.control_style, self.controls.clone());
            let body = shell.tree(&self.module, &self.node, &self.path, true, window, cx);
            shell.control_style = previous;
            body
        }).unwrap_or_else(|_| Empty.into_any_element())
    }
}

#[derive(Clone)]
pub(super) struct TreeNavigation {
    focus: FocusHandle,
    scroll: UniformListScrollHandle,
    cursor: Rc<RefCell<Option<String>>>,
}

impl Shell {
    pub(super) fn cached_tree(&mut self, module: &str, n: &Value, path: &str, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        // Cached views need a layout allocation independent of their contents. Preserve
        // intrinsic sizing (including maxHeight-only lists) on the existing renderer path.
        if n["grow"] != true && !n["height"].is_number() && !n["style"]["height"].is_number() {
            return self.tree(module, n, path, false, window, cx);
        }
        let node = self.tree_nodes.entry((module.to_owned(), path.to_owned()))
            .or_insert_with(|| Arc::new(n.clone())).clone();
        let shell = cx.weak_entity();
        let view = window.use_keyed_state((ElementId::from(sid(module, path)), "tree-view"), cx, |_, cx| {
            CachedTree::new(shell, module.to_owned(), path.to_owned(), node.clone(), self.control_style.clone(), cx)
        });
        view.update(cx, |view, cx| {
            if !Arc::ptr_eq(&view.node, &node) || view.controls != self.control_style {
                view.node = node;
                view.controls = self.control_style.clone();
                cx.notify();
            }
        });
        let mut layout = self.apply_base(v_flex(), n, cx).min_h_0().min_w_0().overflow_hidden();
        AnyView::from(view).cached(layout.style().clone()).into_any_element()
    }

    fn tree(&mut self, module: &str, n: &Value, path: &str, allocated: bool, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        // Hold one copy per module snapshot, not one deep copy on every native
        // refresh (window movement, cursor blinking, hover, etc.).
        let node = self.tree_nodes.entry((module.to_string(), path.to_string()))
            .or_insert_with(|| Arc::new(n.clone())).clone();
        let count = node["rows"].as_array().map_or(0, Vec::len);
        let row_h = node["rowHeight"].as_f64().or_else(|| self.control_style["listRowHeight"].as_f64());
        let navigation = node["activateAction"].as_str().filter(|action| !action.is_empty()).map(|_| {
            self.tree_navigation.entry((module.to_string(), path.to_string())).or_insert_with(|| TreeNavigation {
                focus: cx.focus_handle().tab_stop(true),
                scroll: UniformListScrollHandle::default(),
                cursor: Rc::default(),
            }).clone()
        });
        let body = if row_h.is_some() {
            let (module, path, node) = (module.to_string(), path.to_string(), node.clone());
            uniform_list(sid(&module, &path), count, cx.processor(move |this, range: Range<usize>, _, cx| {
                // Lazy paging: the last row became visible. Fire once per list length and first row
                // so repaints (cursor blink, hover) do not repeat it while the module loads.
                let end_action = node["endReachedAction"].as_str().unwrap_or("");
                if !end_action.is_empty() && range.end >= count {
                    let mark = (count, node["rows"][0]["key"].as_str().unwrap_or("").to_string());
                    let slot = (module.clone(), path.clone());
                    if this.tree_end_fired.get(&slot) != Some(&mark) {
                        this.tree_end_fired.insert(slot, mark);
                        let key = node["key"].as_str().unwrap_or("_");
                        Self::fire(&this.kernel, &module, &this.module_inputs(&module), end_action, key, None, json!({"rows": count}), cx);
                    }
                }
                this.tree_rows(&module, &node, &path, range, cx)
            })).when_some(navigation.as_ref(), |list, nav| list.track_scroll(&nav.scroll)).flex_1().min_h_0().w_full().into_any_element()
        } else {
            let gap = node["rowGap"].as_f64().unwrap_or(1.0).clamp(0.0, 16.0) as f32;
            let rows = self.tree_rows(module, &node, path, 0..count.min(5000), cx);
            div().id(sid(module, path)).flex_1().min_h_0().w_full().overflow_y_scroll()
                .child(v_flex().w_full().min_w_0().gap(px(gap)).children(rows)).into_any_element()
        };
        let mut tree = self.apply_base(v_flex(), n, cx).min_h_0().min_w_0().overflow_hidden()
            // The cached view already received its flex allocation from the parent. Its
            // separately laid-out root must fill those bounds rather than measure at basis 0.
            .when(allocated, |d| d.size_full()).child(body);
        if let Some(nav) = navigation {
            let view = window.current_view();
            let (k, m, inputs) = (self.kernel.clone(), module.to_string(), self.module_inputs(module));
            let rows = node.clone();
            tree = tree.track_focus(&nav.focus).capture_key_down(cx.listener(move |_, ev: &KeyDownEvent, window, cx| {
                if !nav.focus.is_focused(window) { return; }
                let mods = ev.keystroke.modifiers;
                if mods.control || mods.alt || mods.platform || mods.shift { return; }
                let pressed = ev.keystroke.key.as_str();
                if !matches!(pressed, "up" | "down" | "enter") { return; }
                let key = |row: &Value| row["key"].as_str().filter(|key| !key.is_empty()).map(str::to_owned);
                let Some(items) = rows["rows"].as_array() else { return; };
                let current = nav.cursor.borrow().clone();
                let exact = current.as_ref().and_then(|current| items.iter().position(|row| key(row).as_ref() == Some(current)));
                let selected = exact.or_else(|| items.iter().position(|row| key(row).is_some() && row["selected"].as_bool() == Some(true)));
                let target = match pressed {
                    "up" => (0..selected.unwrap_or(items.len())).rev().find(|i| key(&items[*i]).is_some()),
                    "down" => (selected.map_or(0, |i| i + 1)..items.len()).find(|i| key(&items[*i]).is_some()),
                    _ => selected,
                };
                let Some(index) = target else { return; };
                let Some(row_key) = key(&items[index]) else { return; };
                let action = if pressed == "enter" { "activateAction" } else { "selectAction" };
                let Some(action) = rows[action].as_str().filter(|a| !a.is_empty()) else { return; };
                *nav.cursor.borrow_mut() = Some(row_key.clone());
                nav.scroll.scroll_to_item(index, ScrollStrategy::Nearest);
                window.prevent_default();
                cx.stop_propagation();
                Self::fire(&k, &m, &inputs, action, rows["key"].as_str().unwrap_or("_"), Some(row_key), Value::Null, cx);
                App::notify(cx, view);
                cx.notify();
            }));
        }
        let hover_action = node["hoverAction"].as_str().unwrap_or("").to_string();
        if hover_action.is_empty() { return tree.into_any_element(); }
        // Rows report the row entered; leaving the whole list reports no row, so moving between
        // rows never flickers through an empty state.
        let (k, m, inputs, key) = (self.kernel.clone(), module.to_string(), self.module_inputs(module), node["key"].as_str().unwrap_or("_").to_string());
        tree.id(sid(module, &format!("{path}/hover"))).on_hover(move |hovered, _, cx| {
            if !*hovered { Self::fire(&k, &m, &inputs, &hover_action, &key, None, Value::Null, cx); }
        }).into_any_element()
    }

    fn tree_rows(&self, module: &str, n: &Value, path: &str, range: Range<usize>, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let s = |key: &str| n[key].as_str().unwrap_or("").to_string();
        let key = n["key"].as_str().unwrap_or("_");
        let theme_muted = cx.theme().muted_foreground;
        let rows = n["rows"].as_array().map(Vec::as_slice).unwrap_or(&[]);
        let sel_action = s("selectAction");
        let exp_action = s("expandAction");
        let act_action = s("activateAction");
        let hover_action = s("hoverAction");
        let inputs = self.module_inputs(module);
        let navigation = self.tree_navigation.get(&(module.to_string(), path.to_string()));
        // Geometry is module data; defaults match a compact list.
        let row_h = n["rowHeight"].as_f64().or_else(|| self.control_style["listRowHeight"].as_f64()).map(|h| h.clamp(12.0, 96.0) as f32);
        let indent = n["indent"].as_f64().unwrap_or(14.0).clamp(0.0, 64.0) as f32;
        let row_gap = n["rowGap"].as_f64().unwrap_or(1.0).clamp(0.0, 16.0) as f32;
        let icon_size = n["iconSize"].as_f64().unwrap_or(16.0).clamp(8.0, 48.0) as f32;
        // Optional non-square icon box (e.g. a commit graph spanning the full row height).
        let icon_w = n["iconWidth"].as_f64().map(|w| w.clamp(8.0, 320.0) as f32);
        let icon_h = n["iconHeight"].as_f64().map(|h| h.clamp(8.0, 96.0) as f32);
        // Row hover fill is module presentation: a color token and its opacity.
        let hover_bg = n["hoverBackground"].as_str().map(|c| theme::color(cx, c, cx.theme().list_hover)).unwrap_or(cx.theme().list_hover)
            .opacity(n["hoverOpacity"].as_f64().unwrap_or(1.0).clamp(0.0, 1.0) as f32);
        let mut list = Vec::with_capacity(range.len());
        for row_index in range {
            let r = &rows[row_index];
            let rk = r["key"].as_str().unwrap_or("").to_string();
            if rk.is_empty() {
                let heading = div().w_full().pl_2().text_xs().text_color(theme_muted).font_weight(FontWeight::SEMIBOLD)
                    .child(r["label"].as_str().unwrap_or("").to_string());
                list.push(div().w_full().when_some(row_h, |d, h| d.h(px(h + row_gap))).flex().items_center().child(heading).into_any_element());
                continue;
            }
            let depth_ = r["depth"].as_u64().unwrap_or(0) as f32;
            let selected = r["selected"].as_bool().unwrap_or(false);
            let expandable = r["expandable"].as_bool().unwrap_or(false);
            let expanded = r["expanded"].as_bool().unwrap_or(false);
            let busy = r["busy"].as_bool().unwrap_or(false);
            let chevron = {
                let k = self.kernel.clone();
                let m = module.to_string();
                let a = exp_action.clone();
                let inputs = inputs.clone();
                let key2 = key.to_string();
                let rk2 = rk.clone();
                div().id(sid(module, &format!("{path}/chev/{rk}"))).w(px(16.0)).flex_none().text_xs().text_color(theme_muted).cursor_pointer()
                    .child(if expandable {
                        if let Some(svg) = n[if expanded { "expandedIconSvg" } else { "collapsedIconSvg" }].as_str() {
                            gpui_component::Icon::default().data(svg.as_bytes()).with_size(px(14.0)).into_any_element()
                        } else { div().child(if expanded { "▾" } else { "▸" }).into_any_element() }
                    } else { div().into_any_element() })
                    .when(expandable, |d| d.on_click(move |_, _, cx| { cx.stop_propagation(); Self::fire(&k, &m, &inputs, &a, &key2, Some(rk2.clone()), Value::Null, cx); }))
            };
            let k = self.kernel.clone();
            let m = module.to_string();
            let a = sel_action.clone();
            let inputs2 = inputs.clone();
            let key2 = key.to_string();
            let rk2 = rk.clone();
            let act = act_action.clone();
            let nav = navigation.cloned();
            let mouse_key = rk.clone();
            let mut row = h_flex().id(sid(module, &format!("{path}/row/{rk}"))).w_full().min_w_0().overflow_hidden().pl(px(4.0 + depth_ * indent)).pr_1().py(px(3.0)).gap_1().rounded(px(4.0)).cursor_pointer()
                .hover(move |s| s.bg(hover_bg))
                .on_mouse_down(MouseButton::Left, move |_, window, cx| {
                    window.prevent_default();
                    if let Some(nav) = &nav {
                        window.focus(&nav.focus, cx);
                        *nav.cursor.borrow_mut() = Some(mouse_key.clone());
                    }
                    cx.stop_propagation();
                })
                .on_click(move |ev, _, cx| {
                    // A double click fires the first click as a selection, then the activation.
                    let action = if ev.click_count() >= 2 && !act.is_empty() { &act } else { &a };
                    if ev.click_count() >= 2 && act.is_empty() { return; }
                    Self::fire(&k, &m, &inputs2, action, &key2, Some(rk2.clone()), Value::Null, cx)
                });
            if let Some(h) = row_h { row = row.h(px(h)).flex_shrink_0().py_0().gap(px(6.0)); }
            if let Some(tip) = r["tooltip"].as_str().filter(|t| !t.is_empty()) {
                let tip = tip.to_string();
                row = row.tooltip(move |window, cx| gpui_component::tooltip::Tooltip::new(tip.clone()).build(window, cx));
            }
            if !hover_action.is_empty() {
                let (k, m, inputs, key, rk, action) = (self.kernel.clone(), module.to_string(), inputs.clone(), key.to_string(), rk.clone(), hover_action.clone());
                row = row.on_hover(move |hovered, _, cx| { if *hovered { Self::fire(&k, &m, &inputs, &action, &key, Some(rk.clone()), Value::Null, cx); } });
            }
            if self.control_style["rowDividers"].as_bool().unwrap_or(false) { row = row.border_b_1().border_color(cx.theme().border); }
            if self.control_style["stripedRows"].as_bool().unwrap_or(false) && row_index % 2 == 1 { row = row.bg(cx.theme().muted.opacity(0.35)); }
            if let Some(background) = r["background"].as_str() {
                row = row.bg(theme::color(cx, background, cx.theme().transparent));
            }
            if selected {
                row = row.bg(cx.theme().list_active);
            }
            let weight = match r["weight"].as_str() { Some("semibold") => Some(FontWeight::SEMIBOLD), Some("bold") => Some(FontWeight::BOLD), Some("medium") => Some(FontWeight::MEDIUM), _ => None };
            let value = r["value"].as_str().filter(|value| !value.is_empty());
            let name = div().min_w_0().text_sm().when_some(weight, |d, w| d.font_weight(w))
                .when(value.is_none(), |d| d.flex_1())
                .overflow_hidden().whitespace_nowrap().text_ellipsis()
                .child(r["label"].as_str().unwrap_or("").to_string());
            let label = v_flex().flex_1().min_w_0()
                .child(h_flex().w_full().min_w_0().gap_1().child(name)
                    .when_some(value, |d, value| {
                        let color = r["valueColor"].as_str().map(|c| theme::color(cx, c, theme_muted)).unwrap_or(theme_muted);
                        d.child(div().flex_1().min_w_0().text_sm().font_family(cx.theme().mono_font_family.clone())
                            .text_color(color).overflow_hidden().whitespace_nowrap().text_ellipsis().child(value.to_owned()))
                    })
                    .when(busy, |d| d.child(div().flex_none().child(node_paint::shared_spinner(12., theme::color(cx, "primary", cx.theme().primary), cx))))
                    .children(r["badges"].as_array().into_iter().flatten().take(8).map(|badge| {
                        let color = badge["color"].as_str().map(|c| theme::color(cx, c, theme_muted)).unwrap_or(theme_muted);
                        div().flex_none().text_xs().text_color(color).whitespace_nowrap().child(badge["text"].as_str().unwrap_or("").to_string())
                    }))
                    .child(div().text_xs().text_color(theme_muted).whitespace_nowrap().child(r["badge"].as_str().unwrap_or("").to_string())))
                .when_some(r["detail"].as_str(), |d, detail| d.child(div().text_xs().text_color(theme_muted).overflow_hidden().whitespace_nowrap().text_ellipsis().child(detail.to_string())));
            #[cfg(all(test, feature = "snapshot"))]
            let label = label.debug_selector(|| format!("tree-content/{rk}"));
            let icon_busy = r["iconBusy"].as_bool().unwrap_or(false);
            let icon_element = match r["iconSvg"].as_str() {
                // Activity in place of the icon, drawn natively at a capped frame rate (a module
                // rotating an SVG re-sent its whole tree for every step).
                _ if icon_busy => {
                    let color = r["iconColor"].as_str().map(|c| theme::color(cx, c, theme_muted)).unwrap_or(theme_muted);
                    let extent = icon_w.unwrap_or(icon_size).min(icon_h.unwrap_or(icon_size));
                    div().w(px(icon_w.unwrap_or(icon_size))).h(px(icon_h.unwrap_or(icon_size))).flex_none().flex().items_center().justify_center()
                        .child(node_paint::shared_spinner(extent * 0.8, color, cx)).into_any_element()
                }
                Some(svg) => {
                    let color = r["iconColor"].as_str().map(|c| theme::color(cx, c, theme_muted)).unwrap_or(theme_muted);
                    let icon = gpui_component::Icon::default().data(svg.as_bytes()).text_color(color);
                    if icon_w.is_some() || icon_h.is_some() {
                        icon.w(px(icon_w.unwrap_or(icon_size))).h(px(icon_h.unwrap_or(icon_size))).into_any_element()
                    } else { icon.with_size(px(icon_size)).into_any_element() }
                }
                None => div().w(px(4.0)).flex_none().into_any_element(),
            };
            let leading = if let Some(connector) = r["connector"].as_str().filter(|c| *c == "branch" || *c == "last") {
                let stem = div().absolute().left(px(3.0)).top_0().w(px(1.0)).bg(theme_muted.opacity(0.55));
                div().relative().w(px(16.0)).h_full().flex_none()
                    .child(if connector == "last" { stem.h(relative(0.5)) } else { stem.bottom_0() })
                    .child(div().absolute().left(px(3.0)).top(relative(0.5)).w(px(13.0)).h(px(1.0)).bg(theme_muted.opacity(0.55))).into_any_element()
            } else { chevron.into_any_element() };
            row = row.child(leading).child(div().flex_shrink_0().child(icon_element)).child(label);
            let menu_items = r["contextMenu"].as_array().cloned().unwrap_or_default();
            let item = if menu_items.is_empty() { row.into_any_element() } else {
                // Per-row native context menu; items fire with the row key, like selection.
                let dispatch = tab_strip::MenuDispatch { kernel: self.kernel.clone(), module: module.to_string(), inputs: inputs.clone(), key: key.to_string(), row: Some(rk.clone()) };
                div().id(sid(module, &format!("{path}/menu/{rk}"))).w_full().min_w_0().child(row)
                    .context_menu(move |menu, window, cx| dispatch.build(menu, &menu_items, window, cx)).into_any_element()
            };
            list.push(if let Some(h) = row_h {
                div().w_full().min_w_0().h(px(h + row_gap)).child(item).into_any_element()
            } else { item });
        }
        list
    }
}

#[cfg(all(test, feature = "snapshot"))]
mod tests {
    use super::Shell;
    use crate::{bridge::UiBridge, config::Config, kernel::Kernel};
    use gpui_kit as gpui;
    use gpui::{px, rgb, size, BorrowAppContext, TestAppContext, VisualTestContext};
    use serde_json::json;
    use std::sync::Arc;

    thread_local! { pub(super) static RENDERS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) }; }

    #[gpui_kit::test]
    fn cached_tree_reuses_other_frames_and_updates_its_snapshot_and_theme(cx: &mut TestAppContext) {
        cx.update(gpui_kit::init);
        let temp = tempfile::tempdir().unwrap();
        let cfg = Config::from_args(&[
            "hato".into(), "--repo-root".into(), temp.path().display().to_string(),
            "--data-dir".into(), temp.path().join("data").display().to_string(),
        ]).unwrap();
        let kernel = Kernel::new(cfg, UiBridge::disconnected()).unwrap();
        let tree = |color: &str| Arc::new(json!({
            "type":"tree", "key":"rows", "grow":true, "rowHeight":26, "hoverBackground":color,
            "activateAction":"open", "selectAction":"select",
            "rows":[{"key":"row", "label":"Row", "background":color}]
        }));
        let window = cx.open_window(size(px(360.), px(180.)), |window, cx| {
            let mut shell = Shell::new(kernel.clone(), UiBridge::new().1, window, cx);
            shell.only_module = Some("__cached-tree".into());
            shell.trees.insert("__cached-tree".into(), tree("#125634"));
            shell
        });
        let mut visual = VisualTestContext::from_window(window.into(), cx);
        let draw = |visual: &mut VisualTestContext| visual.update(|window, cx| window.draw(cx).clear(cx));
        draw(&mut visual);
        let initial = RENDERS.with(|count| count.get());
        assert!(initial > 0);
        assert!(visual.update(|window, _| window.painted_quads().iter().any(|q| q.background == rgb(0x125634).into())), "initial row must paint");

        // A redraw requested by another view must reuse the tree's layout and paint data.
        visual.update(|window, cx| {
            window.root::<Shell>().unwrap().unwrap().update(cx, |_, cx| cx.notify());
        });
        draw(&mut visual);
        draw(&mut visual);
        assert_eq!(RENDERS.with(|count| count.get()), initial);
        assert!(visual.update(|window, _| window.painted_quads().iter().any(|q| q.background == rgb(0x125634).into())));

        // Cached paint must retain native focus and key listeners, even without a new snapshot.
        visual.update(|window, cx| {
            let shell = window.root::<Shell>().unwrap().unwrap();
            let nav = shell.read(cx).tree_navigation[&("__cached-tree".into(), "/rows".into())].clone();
            window.focus(&nav.focus, cx);
        });
        draw(&mut visual);
        visual.simulate_keystrokes("down");
        draw(&mut visual);
        visual.update(|window, cx| {
            let shell = window.root::<Shell>().unwrap().unwrap();
            assert_eq!(shell.read(cx).tree_navigation[&("__cached-tree".into(), "/rows".into())].cursor.borrow().as_deref(), Some("row"));
        });

        visual.update(|window, cx| {
            window.root::<Shell>().unwrap().unwrap().update(cx, |shell, cx| {
                shell.on_msg(crate::bridge::UiMsg::Tree {
                    module:"__cached-tree".into(), generation:0, tree:tree("#563412"),
                }, window, cx);
            });
        });
        draw(&mut visual);
        draw(&mut visual);
        let changed = RENDERS.with(|count| count.get());
        assert!(changed > initial);
        assert!(visual.update(|window, _| window.painted_quads().iter().any(|q| q.background == rgb(0x563412).into())));

        visual.update(|_, cx| cx.update_global::<gpui_component::Theme, _>(|_, _| {}));
        draw(&mut visual);
        draw(&mut visual);
        assert!(RENDERS.with(|count| count.get()) > changed);
        kernel.shutdown();
    }

    #[gpui_kit::test]
    fn tree_description_is_metadata_and_value_stays_inline(cx: &mut TestAppContext) {
        cx.update(gpui_kit::init);
        let temp = tempfile::tempdir().unwrap();
        let cfg = Config::from_args(&[
            "hato".into(),
            "--repo-root".into(),
            temp.path().display().to_string(),
            "--data-dir".into(),
            temp.path().join("data").display().to_string(),
        ]).unwrap();
        let kernel = Kernel::new(cfg, UiBridge::disconnected()).unwrap();
        let window = cx.open_window(size(px(360.), px(180.)), |window, cx| {
            let mut shell = Shell::new(kernel.clone(), UiBridge::new().1, window, cx);
            let module = "__tree-test".to_owned();
            shell.trees.insert(module.clone(), Arc::new(json!({
                "type": "tree", "key": "rows", "height": 100, "rowHeight": 26, "rowGap": 0,
                "rows": [
                    {"key": "plain", "label": "Plain.java"},
                    {"key": "class", "label": "Example.java", "description": "Java class"},
                    {"key": "count", "label": "count", "value": "42", "badge": "number"}
                ]
            })));
            shell.only_module = Some(module);
            shell
        });
        let mut cx = VisualTestContext::from_window(window.into(), cx);
        cx.update(|window, cx| window.draw(cx).clear(cx));
        let plain = cx.debug_bounds("tree-content/plain").unwrap();
        let class = cx.debug_bounds("tree-content/class").unwrap();
        let count = cx.debug_bounds("tree-content/count").unwrap();
        assert_eq!(class.size.height, plain.size.height);
        assert_eq!(count.size.height, plain.size.height);
        assert!(plain.size.height <= px(26.));
        kernel.shutdown();
    }
}
