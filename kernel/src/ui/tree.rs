//! Lazy rendering for module-supplied tree rows. Only fixed-height rows can use
//! GPUI's uniform list; content-sized trees retain their ordinary flex layout.
use super::*;
use std::{cell::RefCell, ops::Range, rc::Rc};

#[derive(Clone)]
pub(super) struct TreeNavigation {
    focus: FocusHandle,
    scroll: UniformListScrollHandle,
    cursor: Rc<RefCell<Option<String>>>,
}

impl Shell {
    pub(super) fn tree(&mut self, module: &str, n: &Value, path: &str, cx: &mut Context<Self>) -> AnyElement {
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
        let mut tree = self.apply_base(v_flex(), n, cx).min_h_0().min_w_0().overflow_hidden().child(body);
        if let Some(nav) = navigation {
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
            let label = v_flex().flex_1().min_w_0()
                .child(h_flex().w_full().min_w_0().gap_1().child(div().flex_1().min_w_0().text_sm().when_some(weight, |d, w| d.font_weight(w)).overflow_hidden().whitespace_nowrap().text_ellipsis().child(r["label"].as_str().unwrap_or("").to_string()))
                    .when(busy, |d| d.child(div().flex_none().child(Spinner::new().xsmall().color(theme::color(cx, "primary", cx.theme().primary)))))
                    .children(r["badges"].as_array().into_iter().flatten().take(8).map(|badge| {
                        let color = badge["color"].as_str().map(|c| theme::color(cx, c, theme_muted)).unwrap_or(theme_muted);
                        div().flex_none().text_xs().text_color(color).whitespace_nowrap().child(badge["text"].as_str().unwrap_or("").to_string())
                    }))
                    .child(div().text_xs().text_color(theme_muted).whitespace_nowrap().child(r["badge"].as_str().unwrap_or("").to_string())))
                .when_some(r["detail"].as_str(), |d, detail| d.child(div().text_xs().text_color(theme_muted).overflow_hidden().whitespace_nowrap().text_ellipsis().child(detail.to_string())));
            let icon_element = match r["iconSvg"].as_str() {
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
