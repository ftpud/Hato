use super::*;
use gpui_component::menu::PopupMenu;
use std::{cell::RefCell, rc::Rc};

/// Event routing shared by native context menus. Submenus carry the same owning node and row.
#[derive(Clone)]
pub(super) struct MenuDispatch {
    pub kernel: Arc<Kernel>,
    pub module: String,
    pub inputs: Vec<(String, AnyInput)>,
    pub key: String,
    pub row: Option<String>,
}

impl MenuDispatch {
    pub fn build(&self, mut menu: PopupMenu, items: &[Value], window: &mut Window, cx: &mut Context<PopupMenu>) -> PopupMenu {
        for item in items {
            if item["separator"].as_bool() == Some(true) {
                menu = menu.separator();
                continue;
            }
            let Some(label) = item["text"].as_str() else { continue; };
            if let Some(children) = item["children"].as_array() {
                let (dispatch, children) = (self.clone(), children.clone());
                menu = menu.submenu(label.to_owned(), window, cx, move |menu, window, cx| dispatch.build(menu, &children, window, cx));
            } else if let Some(action) = item["action"].as_str() {
                let (dispatch, action, value) = (self.clone(), action.to_owned(), item["value"].clone());
                let copy = item["copyText"].as_str().map(str::to_owned);
                menu = menu.item(PopupMenuItem::new(label.to_owned())
                    .disabled(item["disabled"].as_bool() == Some(true))
                    .when_some(item["checked"].as_bool(), |item, checked| item.checked(checked))
                    .on_click(move |_, _, cx| {
                        if let Some(text) = &copy { cx.write_to_clipboard(ClipboardItem::new_string(text.clone())); }
                        if !action.is_empty() {
                            Shell::fire(&dispatch.kernel, &dispatch.module, &dispatch.inputs, &action, &dispatch.key, dispatch.row.clone(), value.clone(), cx);
                        }
                    }));
            }
        }
        menu
    }
}

#[derive(Clone)]
pub(super) struct TabStrip {
    focus: FocusHandle,
    scroll: ScrollHandle,
    cursor: Rc<RefCell<String>>,
    rendered: String,
}

struct TabDrag { owner: String, key: String, label: String }
impl Render for TabDrag {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        div().px_2().py_1().rounded(px(4.0)).bg(cx.theme().background)
            .border_1().border_color(cx.theme().border).text_sm().child(self.label.clone())
    }
}

impl Shell {
    pub(super) fn tab_strip(&mut self, module: &str, n: &Value, path: &str, cx: &mut Context<Self>) -> AnyElement {
        let active = n["active"].as_str().unwrap_or_default();
        let action = n["action"].as_str().unwrap_or_default().to_owned();
        let double_click = n["doubleClickAction"].as_str().unwrap_or_default().to_owned();
        let reorder = n["reorderAction"].as_str().unwrap_or_default().to_owned();
        let drag_owner = format!("{module}:{path}");
        let mut keys = Vec::new();
        let state = self.tab_strips.entry((module.to_owned(), path.to_owned())).or_insert_with(|| TabStrip {
            focus: cx.focus_handle().tab_stop(true), scroll: ScrollHandle::new(), cursor: Rc::default(), rendered: String::new(),
        });
        let active_changed = state.rendered != active;
        if active_changed {
            state.rendered = active.to_owned();
            *state.cursor.borrow_mut() = active.to_owned();
        }
        let state = state.clone();
        let dispatch = MenuDispatch { kernel: self.kernel.clone(), module: module.to_owned(), inputs: self.module_inputs(module),
            key: n["key"].as_str().unwrap_or_default().to_owned(), row: None };
        let mut bar = h_flex().id(sid(module, path)).gap_1().min_w_0().overflow_x_scroll().track_scroll(&state.scroll);
        for tab in n["tabs"].as_array().into_iter().flatten() {
            let (Some(key), Some(label)) = (tab["key"].as_str(), tab["label"].as_str()) else { continue; };
            let key = key.to_owned();
            if active_changed && key == active { state.scroll.scroll_to_item(keys.len()); }
            keys.push(key.clone());
            let (click, focus, cursor, select, click_key) = (dispatch.clone(), state.focus.clone(), state.cursor.clone(), action.clone(), key.clone());
            let rename = if tab["draggable"].as_bool() == Some(true) { double_click.clone() } else { String::new() };
            let button = Button::new(sid(module, &format!("{path}/{key}"))).h(px(28.0)).small().ghost()
                .when_some(tab["tooltip"].as_str(), |button, tip| button.tooltip(tip.to_owned()))
                .child(div().text_sm().when(key == active, |d| d.font_weight(FontWeight::BOLD)).child(label.to_owned()))
                .on_click(move |event, window, cx| {
                    window.focus(&focus, cx);
                    *cursor.borrow_mut() = click_key.clone();
                    let action = if event.click_count() >= 2 && !rename.is_empty() { &rename } else { &select };
                    Self::fire(&click.kernel, &click.module, &click.inputs, action, &click.key, None, json!(click_key), cx);
                });
            let mut item = div().id(sid(module, &format!("{path}/item/{key}"))).flex_none().child(button)
                .when(key == active, |d| d.border_b_2().border_color(cx.theme().primary));
            if !reorder.is_empty() && tab["draggable"].as_bool() == Some(true) {
                let drag = TabDrag { owner: drag_owner.clone(), key: key.clone(), label: label.to_owned() };
                let (owner, target, drop_action, drop) = (drag_owner.clone(), key.clone(), reorder.clone(), dispatch.clone());
                item = item.on_drag(drag, |drag, _, _, cx| cx.new(|_| TabDrag { owner: drag.owner.clone(), key: drag.key.clone(), label: drag.label.clone() }))
                    .on_drop(move |drag: &TabDrag, _, cx| {
                        if drag.owner != owner || drag.key == target { return; }
                        Self::fire(&drop.kernel, &drop.module, &drop.inputs, &drop_action, &drop.key, None, json!({"from": drag.key, "to": target}), cx);
                    });
            }
            bar = if let Some(menu) = tab["contextMenu"].as_array().filter(|items| !items.is_empty()) {
                let (mut dispatch, menu) = (dispatch.clone(), menu.clone());
                dispatch.row = Some(key);
                bar.child(item.context_menu(move |popup, window, cx| dispatch.build(popup, &menu, window, cx)))
            } else { bar.child(item) };
        }
        let focus = state.focus.clone();
        self.apply_base(div(), n, cx).min_w_0().track_focus(&focus)
            .capture_key_down(move |ev, window, cx| {
                let mods = ev.keystroke.modifiers;
                if !focus.contains_focused(window, cx) || mods.platform || mods.control || mods.alt || mods.shift { return; }
                if keys.is_empty() { return; }
                let i = keys.iter().position(|key| *key == *state.cursor.borrow()).unwrap_or(0);
                let next = match ev.keystroke.key.as_str() {
                    "left" => i.checked_sub(1).unwrap_or(keys.len() - 1),
                    "right" => (i + 1) % keys.len(),
                    "enter" => i,
                    _ => return,
                };
                *state.cursor.borrow_mut() = keys[next].clone();
                state.scroll.scroll_to_item(next);
                window.prevent_default();
                cx.stop_propagation();
                Self::fire(&dispatch.kernel, &dispatch.module, &dispatch.inputs, &action, &dispatch.key, None, json!(keys[next]), cx);
            }).child(bar).into_any_element()
    }
}
