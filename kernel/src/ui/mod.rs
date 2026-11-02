//! GPUI shell: one native window that renders the keyed UI trees produced by TS UI modules,
//! hosts native controls (inputs, code viewer, terminal) whose state is keyed by stable keys,
//! and owns the trusted chrome (approval dialogs, safe mode). Never blocks on JS: trees arrive
//! asynchronously through the UI bridge and are cached.
pub mod terminal_view;

use crate::bridge::{UiBridge, UiMsg};
use crate::config::Config;
use crate::host::pty::PtySession;
use crate::kernel::Kernel;
use crate::ops::Document;
use futures::StreamExt;
use gpui_component::button::{Button, ButtonVariants};
use gpui_component::checkbox::Checkbox;
use gpui_component::input::{Editor, EditorState, Input, InputEvent, InputState, Textarea, TextareaState};
use gpui_component::menu::{DropdownMenu, PopupMenuItem};
use gpui_component::{h_flex, v_flex, ActiveTheme, Disableable, Sizable};
use gpui_kit::*;
use gpui_kit::prelude::FluentBuilder;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::{Duration, Instant};
use terminal_view::TerminalView;

#[derive(Clone)]
enum AnyInput {
    Line(Entity<InputState>),
    Area(Entity<TextareaState>),
}

impl AnyInput {
    fn value(&self, cx: &App) -> String {
        match self {
            AnyInput::Line(e) => e.read(cx).value().to_string(),
            AnyInput::Area(e) => e.read(cx).value().to_string(),
        }
    }
}

struct InputSlot {
    input: AnyInput,
    applied: Option<String>,
    _sub: Subscription,
}

pub struct Shell {
    kernel: Arc<Kernel>,
    trees: HashMap<String, Arc<Value>>,
    render_errors: HashMap<String, String>,
    inputs: HashMap<(String, String), InputSlot>,
    editors: HashMap<String, (Entity<EditorState>, Instant)>,
    terminals: HashMap<String, Entity<TerminalView>>,
    scrolls: HashMap<String, (ScrollHandle, usize)>,
    toasts: Vec<(String, String, Instant)>,
    modals: Vec<(String, String, Value)>,
    approval_scroll: ScrollHandle,
    show_safe_mode: bool,
    submit_queue: Vec<(String, String, String)>,
}

fn sid(module: &str, path: &str) -> SharedString { format!("{module}::{path}").into() }

impl Shell {
    fn new(kernel: Arc<Kernel>, mut rx: futures::channel::mpsc::UnboundedReceiver<UiMsg>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        cx.spawn_in(window, async move |this, cx| {
            while let Some(msg) = rx.next().await {
                let r = this.update_in(cx, |this, window, cx| this.on_msg(msg, window, cx));
                if r.is_err() {
                    break;
                }
            }
        })
        .detach();
        // Toast expiry / periodic refresh.
        cx.spawn(async move |this, cx| loop {
            cx.background_executor().timer(Duration::from_millis(1000)).await;
            if this.update(cx, |this, cx| {
                let before = this.toasts.len();
                this.toasts.retain(|t| t.2.elapsed() < Duration::from_secs(8));
                if before != this.toasts.len() {
                    cx.notify();
                }
            }).is_err() {
                break;
            }
        })
        .detach();
        Shell {
            kernel,
            trees: HashMap::new(),
            render_errors: HashMap::new(),
            inputs: HashMap::new(),
            editors: HashMap::new(),
            terminals: HashMap::new(),
            scrolls: HashMap::new(),
            toasts: Vec::new(),
            modals: Vec::new(),
            approval_scroll: ScrollHandle::new(),
            show_safe_mode: false,
            submit_queue: Vec::new(),
        }
    }

    fn on_msg(&mut self, msg: UiMsg, _window: &mut Window, cx: &mut Context<Self>) {
        match msg {
            UiMsg::Tree { module, tree, .. } => {
                self.render_errors.remove(&module);
                self.trees.insert(module, tree);
                cx.notify();
            }
            UiMsg::RenderError { module, error } => {
                self.render_errors.insert(module, error);
                cx.notify();
            }
            UiMsg::ModulesChanged | UiMsg::ApprovalsChanged => cx.notify(),
            UiMsg::TerminalDirty(h) => {
                if let Some(t) = self.terminals.get(&h) {
                    t.update(cx, |_, cx| cx.notify());
                }
            }
            UiMsg::PickFolder(tx) => {
                let rx = cx.prompt_for_paths(PathPromptOptions { files: false, directories: true, multiple: false, prompt: Some("Choose Folder".into()) });
                cx.spawn(async move |_, _| {
                    let r = rx.await.ok().and_then(|r| r.ok()).flatten().and_then(|v| v.into_iter().next()).map(|p| p.to_string_lossy().into_owned());
                    let _ = tx.send(r);
                })
                .detach();
            }
            UiMsg::Toast { level, text } => {
                self.toasts.push((level, text, Instant::now()));
                if self.toasts.len() > 5 {
                    self.toasts.remove(0);
                }
                cx.notify();
            }
            UiMsg::Quit => cx.quit(),
        }
    }

    /// Fire a UI event to a module, attaching the current text of all its inputs.
    fn fire(kernel: &Arc<Kernel>, module: &str, inputs: &[(String, AnyInput)], action: &str, key: &str, row_key: Option<String>, value: Value, cx: &App) {
        let mut iv = serde_json::Map::new();
        for (k, i) in inputs {
            iv.insert(k.clone(), json!(i.value(cx)));
        }
        let ev = json!({"action": action, "key": key, "rowKey": row_key, "value": value, "inputs": iv});
        kernel.ui_event(module, ev);
    }

    fn module_inputs(&self, module: &str) -> Vec<(String, AnyInput)> {
        self.inputs.iter().filter(|((m, _), _)| m == module).map(|((_, k), s)| (k.clone(), s.input.clone())).collect()
    }

    // ---- node rendering ------------------------------------------------------------------------

    fn render_slot(&mut self, module: &str, depth: usize, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        if depth > 6 {
            return div().child("slot nesting too deep").into_any_element();
        }
        if let Some(err) = self.render_errors.get(module).cloned() {
            if self.trees.get(module).is_none() {
                return self.module_error(module, &err, cx);
            }
        }
        match self.trees.get(module).cloned() {
            Some(tree) => {
                let err = self.render_errors.get(module).cloned();
                let body = self.node(module, &tree, "", depth, window, cx);
                match err {
                    Some(e) => v_flex().size_full().child(self.error_strip(module, &e, cx)).child(div().flex_1().min_h_0().child(body)).into_any_element(),
                    None => body,
                }
            }
            None => {
                let status = self.kernel.router.last_error(module);
                match status {
                    Some(e) => self.module_error(module, &e, cx),
                    None => div().p_2().text_xs().text_color(cx.theme().muted_foreground).child(format!("{module}: loading…")).into_any_element(),
                }
            }
        }
    }

    fn error_strip(&self, module: &str, err: &str, cx: &mut Context<Self>) -> AnyElement {
        div().px_2().py_1().text_xs().bg(cx.theme().danger.opacity(0.15)).text_color(cx.theme().danger)
            .child(format!("{module} render failed (showing last good view): {}", err.lines().next().unwrap_or(""))).into_any_element()
    }

    fn module_error(&self, module: &str, err: &str, cx: &mut Context<Self>) -> AnyElement {
        let k = self.kernel.clone();
        let m = module.to_string();
        v_flex().gap_2().p_3().size_full().bg(cx.theme().danger.opacity(0.08))
            .child(div().text_sm().font_weight(FontWeight::BOLD).text_color(cx.theme().danger).child(format!("Module '{module}' is unavailable")))
            .child(div().text_xs().font_family(cx.theme().mono_font_family.clone()).child(err.chars().take(1500).collect::<String>()))
            .child(h_flex().gap_2()
                .child(Button::new(sid(module, "__retry")).label("Retry render").small().on_click({ let k = k.clone(); let m = m.clone(); move |_, _, _| k.request_render(&m) }))
                .child(Button::new(sid(module, "__rollback")).label("Roll back (native)").small().danger().on_click(move |_, _, _| {
                    let k = k.clone();
                    let m = m.clone();
                    std::thread::spawn(move || {
                        if let Err(e) = k.rollback(None, &m, None, false) {
                            k.ui.send(UiMsg::Toast { level: "error".into(), text: format!("rollback {m}: {e}") });
                        }
                    });
                })))
            .into_any_element()
    }

    fn apply_base(&self, mut d: Div, n: &Value, cx: &App) -> Div {
        if n.get("grow").and_then(|g| g.as_bool()).unwrap_or(false) {
            d = d.flex_1().min_w_0().min_h_0();
        }
        if let Some(w) = n.get("width").and_then(|w| w.as_f64()) {
            d = d.w(px(w as f32)).flex_none();
        }
        if let Some(h) = n.get("height").and_then(|w| w.as_f64()) {
            d = d.h(px(h as f32)).flex_none();
        }
        if let Some(w) = n.get("minWidth").and_then(|w| w.as_f64()) {
            d = d.min_w(px(w as f32));
        }
        if let Some(p) = n.get("padding").and_then(|w| w.as_f64()) {
            d = d.p(px(p as f32));
        }
        if let Some(g) = n.get("gap").and_then(|w| w.as_f64()) {
            d = d.gap(px(g as f32));
        }
        match n.get("bg").and_then(|b| b.as_str()) {
            Some("panel") => d = d.bg(cx.theme().title_bar),
            Some("muted") => d = d.bg(cx.theme().muted),
            Some("accent") => d = d.bg(cx.theme().accent),
            _ => {}
        }
        if n.get("border").and_then(|b| b.as_bool()).unwrap_or(false) {
            d = d.border_1().border_color(cx.theme().border).rounded(px(4.0));
        }
        d
    }

    fn children(&mut self, module: &str, n: &Value, path: &str, depth: usize, window: &mut Window, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let mut out = Vec::new();
        if let Some(arr) = n.get("children").and_then(|c| c.as_array()) {
            for c in arr.iter().take(2000) {
                out.push(self.node(module, c, path, depth, window, cx));
            }
        }
        out
    }

    fn node(&mut self, module: &str, n: &Value, parent: &str, depth: usize, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let ty = n.get("type").and_then(|t| t.as_str()).unwrap_or("");
        let key = n.get("key").and_then(|k| k.as_str()).unwrap_or("_");
        let path = format!("{parent}/{key}");
        let s = |k: &str| n.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
        let b = |k: &str| n.get(k).and_then(|v| v.as_bool()).unwrap_or(false);
        let theme_muted = cx.theme().muted_foreground;
        match ty {
            "row" | "column" => {
                let mut d = if ty == "row" { h_flex() } else { v_flex() };
                if ty == "row" {
                    d = match n.get("align").and_then(|a| a.as_str()) {
                        Some("start") => d.items_start(),
                        Some("end") => d.items_end(),
                        _ => d.items_center(),
                    };
                }
                d = self.apply_base(d, n, cx);
                let kids = self.children(module, n, &path, depth, window, cx);
                if b("scroll") {
                    d.child(div().id(sid(module, &path)).size_full().overflow_y_scroll().child(v_flex().children(kids))).into_any_element()
                } else {
                    d.children(kids).into_any_element()
                }
            }
            "scroll" => {
                let kids = self.children(module, n, &path, depth, window, cx);
                let d = self.apply_base(v_flex(), n, cx);
                d.child(div().id(sid(module, &path)).flex_1().min_h_0().overflow_y_scroll().child(v_flex().children(kids))).into_any_element()
            }
            "split" => {
                let horizontal = s("direction") != "vertical";
                let sizes: Vec<f32> = n.get("sizes").and_then(|s| s.as_array()).map(|a| a.iter().filter_map(|x| x.as_f64().map(|f| f as f32)).collect()).unwrap_or_default();
                let kids = self.children(module, n, &path, depth, window, cx);
                let count = kids.len().max(1);
                let mut d = if horizontal { h_flex() } else { v_flex() };
                d = self.apply_base(d, n, cx).size_full();
                for (i, k) in kids.into_iter().enumerate() {
                    let frac = sizes.get(i).cloned().unwrap_or(1.0 / count as f32);
                    let mut cell = div().overflow_hidden().border_color(cx.theme().border).flex();
                    cell = if horizontal { cell.h_full().w(relative(frac)).flex_none() } else { cell.w_full().h(relative(frac)).flex_none() };
                    if i > 0 {
                        cell = if horizontal { cell.border_l_1() } else { cell.border_t_1() };
                    }
                    d = d.child(cell.child(div().size_full().flex().flex_col().child(k)));
                }
                d.into_any_element()
            }
            "tabs" => {
                let active = s("active");
                let action = s("action");
                let tabs: Vec<(String, String)> = n.get("tabs").and_then(|t| t.as_array()).map(|a| a.iter().map(|t| (t["key"].as_str().unwrap_or("").to_string(), t["label"].as_str().unwrap_or("").to_string())).collect()).unwrap_or_default();
                let inputs = self.module_inputs(module);
                let mut bar = h_flex().gap_1();
                for (tk, label) in tabs {
                    let k = self.kernel.clone();
                    let m = module.to_string();
                    let a = action.clone();
                    let inputs = inputs.clone();
                    let key2 = key.to_string();
                    let mut btn = Button::new(sid(module, &format!("{path}/tab/{tk}"))).label(label).small();
                    btn = if tk == active { btn.primary() } else { btn.ghost() };
                    bar = bar.child(btn.on_click(move |_, _, cx| Self::fire(&k, &m, &inputs, &a, &key2, None, json!(tk), cx)));
                }
                let kids: Vec<Value> = n.get("children").and_then(|c| c.as_array()).cloned().unwrap_or_default();
                let mut d = self.apply_base(v_flex(), n, cx).child(bar);
                if let Some(c) = kids.iter().find(|c| c.get("key").and_then(|k| k.as_str()) == Some(active.as_str())).or(kids.first()) {
                    let el = self.node(module, c, &path, depth, window, cx);
                    d = d.child(div().flex_1().min_h_0().child(el));
                }
                d.into_any_element()
            }
            "slot" => {
                let m = s("module");
                let el = self.render_slot(&m, depth + 1, window, cx);
                self.apply_base(v_flex(), n, cx).size_full().child(el).into_any_element()
            }
            "label" => {
                let text = s("text");
                let mut d = div();
                d = match n.get("size").and_then(|v| v.as_str()) {
                    Some("xs") => d.text_xs(),
                    Some("sm") => d.text_sm(),
                    Some("lg") => d.text_lg(),
                    _ => d.text_sm(),
                };
                if s("weight") == "bold" {
                    d = d.font_weight(FontWeight::BOLD);
                }
                d = match n.get("color").and_then(|v| v.as_str()) {
                    Some("muted") => d.text_color(theme_muted),
                    Some("accent") => d.text_color(cx.theme().primary),
                    Some("danger") => d.text_color(cx.theme().danger),
                    Some("success") => d.text_color(cx.theme().success),
                    Some("warning") => d.text_color(cx.theme().warning),
                    _ => d,
                };
                if b("mono") {
                    d = d.font_family(cx.theme().mono_font_family.clone());
                }
                if !b("wrap") {
                    d = d.overflow_hidden().whitespace_nowrap().text_ellipsis();
                }
                self.apply_base(d, n, cx).child(text).into_any_element()
            }
            "button" => {
                let k = self.kernel.clone();
                let m = module.to_string();
                let action = s("action");
                let value = n.get("value").cloned().unwrap_or(Value::Null);
                let inputs = self.module_inputs(module);
                let key2 = key.to_string();
                let mut btn = Button::new(sid(module, &path)).label(s("text")).disabled(b("disabled"));
                btn = match n.get("variant").and_then(|v| v.as_str()) {
                    Some("primary") => btn.primary(),
                    Some("danger") => btn.danger(),
                    Some("ghost") => btn.ghost(),
                    _ => btn,
                };
                if b("small") {
                    btn = btn.small();
                }
                if let Some(t) = n.get("tooltip").and_then(|t| t.as_str()) {
                    btn = btn.tooltip(t.to_string());
                }
                btn.on_click(move |_, _, cx| Self::fire(&k, &m, &inputs, &action, &key2, None, value.clone(), cx)).into_any_element()
            }
            "textInput" => {
                let ik = (module.to_string(), key.to_string());
                let multiline = b("multiline");
                let value = n.get("value").and_then(|v| v.as_str()).map(|s| s.to_string());
                if !self.inputs.contains_key(&ik) {
                    let placeholder = s("placeholder");
                    let submit = n.get("submitAction").and_then(|v| v.as_str()).map(|s| s.to_string());
                    let k = self.kernel.clone();
                    let m = module.to_string();
                    let key2 = key.to_string();
                    let slot = if multiline {
                        let st = cx.new(|cx| TextareaState::new(window, cx).placeholder(placeholder).submit_on_enter(true).default_value(value.clone().unwrap_or_default()));
                        let sub = cx.subscribe_in(&st, window, move |this: &mut Shell, _st, ev: &InputEvent, _w, cx| {
                            if let (InputEvent::PressEnter { .. }, Some(a)) = (ev, submit.as_ref()) {
                                let inputs = this.module_inputs(&m);
                                Shell::fire(&k, &m, &inputs, a, &key2, None, Value::Null, cx);
                            }
                        });
                        InputSlot { input: AnyInput::Area(st), applied: value.clone(), _sub: sub }
                    } else {
                        let secret = b("secret");
                        let st = cx.new(|cx| InputState::new(window, cx).placeholder(placeholder).masked(secret).default_value(value.clone().unwrap_or_default()));
                        let sub = cx.subscribe_in(&st, window, move |this: &mut Shell, _st, ev: &InputEvent, _w, cx| {
                            if let (InputEvent::PressEnter { .. }, Some(a)) = (ev, submit.as_ref()) {
                                let inputs = this.module_inputs(&m);
                                Shell::fire(&k, &m, &inputs, a, &key2, None, Value::Null, cx);
                            }
                        });
                        InputSlot { input: AnyInput::Line(st), applied: value.clone(), _sub: sub }
                    };
                    self.inputs.insert(ik.clone(), slot);
                }
                // A module may (re)set an input's value by changing `value` (e.g. clear after send).
                let slot = self.inputs.get_mut(&ik).unwrap();
                if value.is_some() && value != slot.applied {
                    let v = value.clone().unwrap();
                    match &slot.input {
                        AnyInput::Line(e) => e.update(cx, |st, cx| st.set_value(v.clone(), window, cx)),
                        AnyInput::Area(e) => e.update(cx, |st, cx| st.set_value(v.clone(), window, cx)),
                    }
                    slot.applied = value.clone();
                }
                let el = match &slot.input {
                    AnyInput::Line(e) => Input::new(e).small().disabled(b("disabled")).into_any_element(),
                    AnyInput::Area(e) => Textarea::new(e).disabled(b("disabled")).h(px(n.get("rows").and_then(|r| r.as_f64()).unwrap_or(3.0) as f32 * 20.0 + 12.0)).into_any_element(),
                };
                self.apply_base(div(), n, cx).child(el).into_any_element()
            }
            "select" => {
                let options: Vec<(String, String, bool)> = n.get("options").and_then(|o| o.as_array()).map(|a| a.iter().map(|o| (o["value"].as_str().unwrap_or("").to_string(), o["label"].as_str().unwrap_or("").to_string(), o["disabled"].as_bool().unwrap_or(false))).collect()).unwrap_or_default();
                let value = n.get("value").and_then(|v| v.as_str()).map(|s| s.to_string());
                let current = options.iter().find(|o| Some(&o.0) == value.as_ref()).map(|o| o.1.clone()).unwrap_or_else(|| s("placeholder"));
                let label = n.get("label").and_then(|l| l.as_str()).map(|l| format!("{l}: ")).unwrap_or_default();
                let disabled = b("disabled") || options.is_empty();
                let reason = n.get("disabledReason").and_then(|r| r.as_str()).map(|s| s.to_string());
                let k = self.kernel.clone();
                let m = module.to_string();
                let action = s("action");
                let inputs = self.module_inputs(module);
                let key2 = key.to_string();
                let mut btn = Button::new(sid(module, &path)).label(format!("{label}{current} ▾")).small().disabled(disabled);
                if let Some(r) = reason.clone().filter(|_| disabled) {
                    btn = btn.tooltip(r);
                }
                let el = if disabled {
                    btn.into_any_element()
                } else {
                    btn.dropdown_menu(move |mut menu, _, _| {
                        for (v, l, dis) in options.iter().cloned() {
                            let k = k.clone();
                            let m = m.clone();
                            let a = action.clone();
                            let inputs = inputs.clone();
                            let key3 = key2.clone();
                            let checked = Some(&v) == value.as_ref();
                            menu = menu.item(PopupMenuItem::new(l).checked(checked).disabled(dis).on_click(move |_, _, cx| {
                                Self::fire(&k, &m, &inputs, &a, &key3, None, json!(v.clone()), cx);
                            }));
                        }
                        menu
                    })
                    .into_any_element()
                };
                self.apply_base(div(), n, cx).child(el).into_any_element()
            }
            "toggle" => {
                let k = self.kernel.clone();
                let m = module.to_string();
                let action = s("action");
                let inputs = self.module_inputs(module);
                let key2 = key.to_string();
                let checked = b("checked");
                Checkbox::new(sid(module, &path)).label(s("label")).checked(checked).disabled(b("disabled"))
                    .on_click(move |v, _, cx| Self::fire(&k, &m, &inputs, &action, &key2, None, json!(*v), cx))
                    .into_any_element()
            }
            "tree" => {
                let rows = n.get("rows").and_then(|r| r.as_array()).cloned().unwrap_or_default();
                let sel_action = s("selectAction");
                let exp_action = s("expandAction");
                let inputs = self.module_inputs(module);
                let mut list = v_flex().gap(px(1.0));
                for r in rows.iter().take(5000) {
                    let rk = r["key"].as_str().unwrap_or("").to_string();
                    let depth_ = r["depth"].as_u64().unwrap_or(0) as f32;
                    let selected = r["selected"].as_bool().unwrap_or(false);
                    let expandable = r["expandable"].as_bool().unwrap_or(false);
                    let expanded = r["expanded"].as_bool().unwrap_or(false);
                    let icon = match r["icon"].as_str() {
                        Some("git") => "⎇",
                        Some("remote") => "⇄",
                        Some("task") => "◦",
                        Some("warning") => "⚠",
                        Some("file") => "·",
                        _ => "▪",
                    };
                    let chevron = {
                        let k = self.kernel.clone();
                        let m = module.to_string();
                        let a = exp_action.clone();
                        let inputs = inputs.clone();
                        let key2 = key.to_string();
                        let rk2 = rk.clone();
                        div().id(sid(module, &format!("{path}/chev/{rk}"))).w(px(16.0)).flex_none().text_xs().text_color(theme_muted).cursor_pointer()
                            .child(if expandable { if expanded { "▾" } else { "▸" } } else { " " })
                            .when(expandable, |d| d.on_click(move |_, _, cx| { cx.stop_propagation(); Self::fire(&k, &m, &inputs, &a, &key2, Some(rk2.clone()), Value::Null, cx); }))
                    };
                    let k = self.kernel.clone();
                    let m = module.to_string();
                    let a = sel_action.clone();
                    let inputs2 = inputs.clone();
                    let key2 = key.to_string();
                    let rk2 = rk.clone();
                    let mut row = h_flex().id(sid(module, &format!("{path}/row/{rk}"))).w_full().pl(px(4.0 + depth_ * 14.0)).pr_1().py(px(3.0)).gap_1().rounded(px(3.0)).cursor_pointer()
                        .hover(|s| s.bg(cx.theme().list_hover))
                        .on_click(move |_, _, cx| Self::fire(&k, &m, &inputs2, &a, &key2, Some(rk2.clone()), Value::Null, cx));
                    if selected {
                        row = row.bg(cx.theme().list_active);
                    }
                    let label = v_flex().flex_1().min_w_0()
                        .child(h_flex().gap_1().child(div().text_sm().overflow_hidden().whitespace_nowrap().text_ellipsis().child(r["label"].as_str().unwrap_or("").to_string()))
                            .child(div().text_xs().text_color(theme_muted).whitespace_nowrap().child(r["badge"].as_str().map(|b| format!("[{b}]")).unwrap_or_default())))
                        .when_some(r["detail"].as_str(), |d, detail| d.child(div().text_xs().text_color(theme_muted).overflow_hidden().whitespace_nowrap().text_ellipsis().child(detail.to_string())));
                    row = row.child(chevron).child(div().w(px(12.0)).text_xs().flex_none().child(icon)).child(label);
                    list = list.child(row);
                }
                self.apply_base(v_flex(), n, cx).child(div().id(sid(module, &path)).size_full().overflow_y_scroll().child(list)).into_any_element()
            }
            "fileList" => {
                let entries = n.get("entries").and_then(|r| r.as_array()).cloned().unwrap_or_default();
                let action = s("action");
                let inputs = self.module_inputs(module);
                let mut list = v_flex();
                for e in entries.iter().take(5000) {
                    let ek = e["key"].as_str().unwrap_or("").to_string();
                    let is_dir = e["kind"].as_str() == Some("dir");
                    let k = self.kernel.clone();
                    let m = module.to_string();
                    let a = action.clone();
                    let inputs = inputs.clone();
                    let key2 = key.to_string();
                    let ek2 = ek.clone();
                    let mut row = h_flex().id(sid(module, &format!("{path}/f/{ek}"))).gap_2().px_1().py(px(2.0)).rounded(px(3.0)).cursor_pointer().hover(|s| s.bg(cx.theme().list_hover))
                        .on_click(move |_, _, cx| Self::fire(&k, &m, &inputs, &a, &key2, Some(ek2.clone()), Value::Null, cx))
                        .child(div().w(px(14.0)).text_xs().text_color(theme_muted).child(if is_dir { "▸" } else { "·" }))
                        .child(div().flex_1().min_w_0().text_sm().overflow_hidden().whitespace_nowrap().text_ellipsis().child(e["name"].as_str().unwrap_or("").to_string()));
                    if !is_dir {
                        if let Some(sz) = e["size"].as_u64() {
                            row = row.child(div().text_xs().text_color(theme_muted).child(human(sz)));
                        }
                    }
                    if e["selected"].as_bool().unwrap_or(false) {
                        row = row.bg(cx.theme().list_active);
                    }
                    list = list.child(row);
                }
                self.apply_base(v_flex(), n, cx).child(div().id(sid(module, &path)).size_full().overflow_y_scroll().child(list)).into_any_element()
            }
            "status" => {
                let color = match n.get("level").and_then(|l| l.as_str()) {
                    Some("error") => cx.theme().danger,
                    Some("warn") => cx.theme().warning,
                    Some("success") => cx.theme().success,
                    _ => cx.theme().info,
                };
                self.apply_base(div(), n, cx).px_2().py_1().rounded(px(4.0)).text_xs().bg(color.opacity(0.12)).text_color(color).child(s("text")).into_any_element()
            }
            "progress" => {
                let label = s("label");
                let bar = match n.get("value").and_then(|v| v.as_f64()) {
                    Some(v) => div().h(px(4.0)).w_full().bg(cx.theme().muted).child(div().h_full().w(relative(v.clamp(0.0, 1.0) as f32)).bg(cx.theme().primary)),
                    None => div().h(px(2.0)).w_full().bg(cx.theme().primary.opacity(0.5)),
                };
                self.apply_base(v_flex(), n, cx).gap_1().child(bar).when(!label.is_empty(), |d| d.child(div().text_xs().text_color(theme_muted).child(label))).into_any_element()
            }
            "codeViewer" => {
                let doc_h = n.get("document").and_then(|d| d.as_str()).map(|s| s.to_string());
                let placeholder = s("placeholder");
                let body = match doc_h.and_then(|h| self.kernel.handles.get_kernel::<Document>(&h, "document").map(|d| (h, d))) {
                    Some((h, doc)) => {
                        let entry = self.editors.entry(h.clone()).or_insert_with(|| {
                            let lang = doc.language.clone();
                            let text = doc.text.clone();
                            (cx.new(|cx| EditorState::new(window, cx).language(lang).line_number(true).default_value(text)), Instant::now())
                        });
                        entry.1 = Instant::now();
                        let st = entry.0.clone();
                        Editor::new(&st).readonly(true).h_full().into_any_element()
                    }
                    None => div().p_3().text_sm().text_color(theme_muted).child(placeholder).into_any_element(),
                };
                if self.editors.len() > 48 {
                    let mut v: Vec<(String, Instant)> = self.editors.iter().map(|(k, (_, t))| (k.clone(), *t)).collect();
                    v.sort_by_key(|x| x.1);
                    for (k, _) in v.into_iter().take(16) {
                        self.editors.remove(&k);
                    }
                }
                self.apply_base(div(), n, cx).size_full().overflow_hidden().child(body).into_any_element()
            }
            "terminal" => {
                let pty = n.get("pty").and_then(|d| d.as_str()).map(|s| s.to_string());
                let body = match pty.and_then(|h| self.kernel.handles.get_kernel::<PtySession>(&h, "pty").map(|p| (h, p))) {
                    Some((h, sess)) => {
                        let view = self.terminals.entry(h).or_insert_with(|| cx.new(|cx| TerminalView::new(sess, cx))).clone();
                        view.into_any_element()
                    }
                    None => div().p_3().text_sm().text_color(theme_muted).child(s("placeholder")).into_any_element(),
                };
                self.apply_base(div(), n, cx).size_full().overflow_hidden().child(body).into_any_element()
            }
            "chatTranscript" => {
                let msgs = n.get("messages").and_then(|m| m.as_array()).cloned().unwrap_or_default();
                let scroll_key = format!("{module}::{path}");
                let count = msgs.len() + msgs.last().map(|m| m["text"].as_str().map(|t| t.len()).unwrap_or(0)).unwrap_or(0);
                let (handle, last) = self.scrolls.entry(scroll_key).or_insert_with(|| (ScrollHandle::new(), usize::MAX)).clone();
                if last != count {
                    handle.scroll_to_bottom();
                    if let Some(e) = self.scrolls.get_mut(&format!("{module}::{path}")) {
                        e.1 = count;
                    }
                }
                let mono = cx.theme().mono_font_family.clone();
                let mut list = v_flex().gap_2().p_1();
                for m in msgs.iter() {
                    let role = m["role"].as_str().unwrap_or("system");
                    let text = m["text"].as_str().unwrap_or("").to_string();
                    let title = m["title"].as_str().map(|s| s.to_string());
                    let status = m["status"].as_str().map(|s| s.to_string());
                    let (bg, label) = match role {
                        "user" => (cx.theme().primary.opacity(0.12), "You"),
                        "assistant" => (cx.theme().muted, "Agent"),
                        "thought" => (cx.theme().muted.opacity(0.5), "Thinking"),
                        "tool" => (cx.theme().info.opacity(0.10), "Tool"),
                        "plan" => (cx.theme().success.opacity(0.10), "Plan"),
                        "error" => (cx.theme().danger.opacity(0.15), "Error"),
                        _ => (cx.theme().warning.opacity(0.10), "System"),
                    };
                    let mut card = v_flex().gap_1().p_2().rounded(px(6.0)).bg(bg)
                        .child(h_flex().gap_2().child(div().text_xs().font_weight(FontWeight::BOLD).child(label))
                            .when_some(title, |d, t| d.child(div().text_xs().overflow_hidden().whitespace_nowrap().text_ellipsis().child(t)))
                            .when_some(status, |d, st| d.child(div().text_xs().text_color(theme_muted).child(st))));
                    if !text.is_empty() {
                        let t = div().text_sm().child(text);
                        card = card.child(if role == "tool" { t.font_family(mono.clone()).text_xs() } else if role == "thought" { t.text_color(theme_muted).text_xs() } else { t });
                    }
                    list = list.child(card);
                }
                self.apply_base(v_flex(), n, cx).child(div().id(sid(module, &path)).size_full().overflow_y_scroll().track_scroll(&handle).child(list)).into_any_element()
            }
            "approvalPanel" => {
                let count = self.kernel.approvals.count();
                let el = if count > 0 {
                    div().px_2().text_xs().rounded(px(4.0)).bg(cx.theme().warning.opacity(0.2)).text_color(cx.theme().warning).child(format!("⚠ {count} approval(s) pending"))
                } else {
                    div().text_xs().text_color(theme_muted).child("no pending approvals")
                };
                el.into_any_element()
            }
            "divider" => div().h(px(1.0)).w_full().bg(cx.theme().border).into_any_element(),
            "spacer" => div().flex_1().into_any_element(),
            "modal" => {
                self.modals.push((module.to_string(), path.clone(), n.clone()));
                div().into_any_element()
            }
            other => div().text_xs().text_color(cx.theme().danger).child(format!("unknown node type '{other}'")).into_any_element(),
        }
    }

    fn render_modal(&mut self, module: &str, path: &str, n: &Value, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let title = n.get("title").and_then(|t| t.as_str()).unwrap_or("").to_string();
        let close = n.get("closeAction").and_then(|t| t.as_str()).map(|s| s.to_string());
        let kids = self.children(module, n, path, 1, window, cx);
        let k = self.kernel.clone();
        let m = module.to_string();
        let inputs = self.module_inputs(module);
        div().absolute().top_0().left_0().size_full().bg(black().opacity(0.35)).flex().items_center().justify_center()
            .child(v_flex().id(sid(module, &format!("{path}/card"))).w(px(640.0)).max_h(relative(0.85)).overflow_y_scroll().gap_2().p_4().rounded(px(8.0))
                .bg(cx.theme().background).border_1().border_color(cx.theme().border).shadow_lg()
                .child(h_flex().child(div().flex_1().font_weight(FontWeight::BOLD).child(title))
                    .when_some(close, |d, a| d.child(Button::new(sid(module, &format!("{path}/close"))).label("✕").ghost().small()
                        .on_click(move |_, _, cx| Self::fire(&k, &m, &inputs, &a, "close", None, Value::Null, cx)))))
                .children(kids))
            .into_any_element()
    }

    /// Trusted approval chrome: rendered by the kernel from its own queue. Only a real click here
    /// can resolve an approval.
    fn render_approvals(&mut self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let reqs = self.kernel.approvals.snapshot();
        let req = reqs.first()?.clone();
        let more = reqs.len() - 1;
        let mono = cx.theme().mono_font_family.clone();
        let mut buttons = h_flex().gap_2();
        for o in &req.options {
            let k = self.kernel.clone();
            let id = req.id.clone();
            let oid = o.id.clone();
            let mut btn = Button::new(SharedString::from(format!("approval::{}::{}", req.id, o.id))).label(o.label.clone());
            btn = match o.kind.as_str() { "allow" => btn.primary(), "deny" => btn.danger(), _ => btn };
            buttons = buttons.child(btn.on_click(move |_, _, _| k.approvals.resolve_from_native_ui(&id, &oid)));
        }
        Some(div().absolute().top_0().left_0().size_full().bg(black().opacity(0.5)).flex().items_center().justify_center()
            .child(v_flex().w(px(760.0)).max_h(relative(0.9)).gap_2().p_4().rounded(px(10.0)).bg(cx.theme().background).border_2().border_color(cx.theme().warning).shadow_lg()
                .child(h_flex().gap_2().child(div().text_xs().px_2().rounded(px(4.0)).bg(cx.theme().warning.opacity(0.25)).child("KERNEL APPROVAL"))
                    .child(div().text_xs().text_color(cx.theme().muted_foreground).child(format!("requested by module '{}' (generation {}) · operation {}", req.module, req.generation, req.operation))))
                .child(div().text_lg().font_weight(FontWeight::BOLD).child(req.title.clone()))
                .when(req.module_supplied, |d| d.child(div().text_xs().text_color(cx.theme().warning).child("The text below was supplied by the module/agent, not verified by the kernel.")))
                .child(div().id("approval-detail").flex_1().min_h(px(80.0)).max_h(px(480.0)).overflow_y_scroll().track_scroll(&self.approval_scroll).p_2().rounded(px(4.0)).bg(cx.theme().muted)
                    .child(div().text_xs().font_family(mono).child(req.detail.clone())))
                .child(h_flex().child(div().flex_1().text_xs().text_color(cx.theme().muted_foreground).child(if more > 0 { format!("{more} more pending") } else { String::new() })).child(buttons)))
            .into_any_element())
    }

    fn render_safe_mode(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let mods = self.kernel.modules_json();
        let mut list = v_flex().gap_1();
        for m in mods.as_array().cloned().unwrap_or_default() {
            let id = m["id"].as_str().unwrap_or("").to_string();
            let label = m["active"]["label"].as_str().map(|s| s.to_string()).unwrap_or_else(|| format!("{id} (inactive)"));
            let err = m["lastError"].as_str().unwrap_or("").to_string();
            let k = self.kernel.clone();
            let id2 = id.clone();
            list = list.child(h_flex().gap_2().child(div().w(px(220.0)).text_sm().font_family(cx.theme().mono_font_family.clone()).child(label))
                .child(div().flex_1().text_xs().text_color(if err.is_empty() { cx.theme().muted_foreground } else { cx.theme().danger }).child(if err.is_empty() { "ok".to_string() } else { err }))
                .child(Button::new(SharedString::from(format!("safe::rb::{id}"))).label("Roll back").small().on_click(move |_, _, _| {
                    let k = k.clone();
                    let id = id2.clone();
                    std::thread::spawn(move || {
                        let r = k.rollback(None, &id, None, false);
                        k.ui.send(UiMsg::Toast { level: if r.is_ok() { "info" } else { "error" }.into(), text: format!("rollback {id}: {}", r.map(|_| "ok".to_string()).unwrap_or_else(|e| e.to_string())) });
                    });
                })));
        }
        let k = self.kernel.clone();
        v_flex().size_full().p_4().gap_3()
            .child(div().text_lg().font_weight(FontWeight::BOLD).child("Hato — safe mode"))
            .child(div().text_sm().text_color(cx.theme().muted_foreground).child("The workspace-layout UI module is unavailable. The kernel keeps running; terminals and agent processes are preserved. Roll back modules below (native action, no approval prompt needed because this is kernel chrome)."))
            .child(Button::new("safe::rerender").label("Retry rendering").on_click(move |_, _, _| k.rerender_all_ui()))
            .child(div().id("safe-list").flex_1().overflow_y_scroll().child(list))
            .into_any_element()
    }
}

fn human(n: u64) -> String {
    if n < 1024 { format!("{n} B") } else if n < 1024 * 1024 { format!("{:.1} KB", n as f64 / 1024.0) } else { format!("{:.1} MB", n as f64 / 1048576.0) }
}

impl Render for Shell {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.modals.clear();
        let layout_ok = self.trees.contains_key("workspace-layout") || self.kernel.router.active("workspace-layout").is_some();
        let body = if layout_ok && !self.show_safe_mode {
            self.render_slot("workspace-layout", 0, window, cx)
        } else {
            self.render_safe_mode(cx)
        };
        // Drop native state for terminals whose PTY handle disappeared.
        let live: HashSet<String> = self.kernel.handles.handles_of_kind("pty").into_iter().collect();
        self.terminals.retain(|h, _| live.contains(h));
        let modals = std::mem::take(&mut self.modals);
        let modal_els: Vec<AnyElement> = modals.iter().map(|(m, p, n)| self.render_modal(m, p, n, window, cx)).collect();
        let approvals = self.render_approvals(cx);
        let mut toasts = v_flex().absolute().bottom(px(36.0)).right(px(12.0)).gap_1().w(px(420.0));
        for (level, text, _) in &self.toasts {
            let c = match level.as_str() { "error" => cx.theme().danger, "warn" => cx.theme().warning, _ => cx.theme().info };
            toasts = toasts.child(div().p_2().rounded(px(6.0)).text_xs().bg(cx.theme().background).border_1().border_color(c).text_color(c).child(text.clone()));
        }
        let _ = &self.submit_queue;
        div().size_full().relative().bg(cx.theme().background).text_color(cx.theme().foreground).font_family(cx.theme().font_family.clone())
            .child(body)
            .children(modal_els)
            .child(toasts)
            .children(approvals)
    }
}

pub fn run(cfg: Config) {
    let (bridge, rx) = UiBridge::new();
    let kernel = match Kernel::new(cfg, bridge) {
        Ok(k) => k,
        Err(e) => {
            eprintln!("hato: kernel init failed: {e:#}");
            std::process::exit(1);
        }
    };
    let t0 = Instant::now();
    let app = gpui_kit::application();
    let k2 = kernel.clone();
    app.run(move |cx| {
        gpui_kit::init(cx);
        cx.on_app_quit({
            let k = k2.clone();
            move |_| {
                k.shutdown();
                async {}
            }
        })
        .detach();
        let bounds = Bounds::centered(None, size(px(1480.0), px(920.0)), cx);
        let rx = std::cell::RefCell::new(Some(rx));
        let k3 = k2.clone();
        let opened = gpui_kit::open_window(
            WindowOptions { window_bounds: Some(WindowBounds::Windowed(bounds)), titlebar: Some(TitlebarOptions { title: Some("Hato".into()), ..Default::default() }), ..Default::default() },
            cx,
            move |window, cx| {
                let rx = rx.borrow_mut().take().unwrap();
                cx.new(|cx| Shell::new(k3.clone(), rx, window, cx))
            },
        );
        if let Err(e) = opened {
            eprintln!("hato: cannot open window: {e:#}");
            std::process::exit(1);
        }
        cx.on_window_closed(|cx, _| {
            if cx.windows().is_empty() {
                cx.quit();
            }
        })
        .detach();
        // Boot modules off the UI thread; trees arrive asynchronously.
        let k4 = k2.clone();
        std::thread::spawn(move || {
            k4.boot();
            if k4.cfg.dev_watch {
                log::warn!("--dev-watch enabled: changed build/modules/*.mjs seeds are activated WITHOUT approval prompts");
                k4.start_dev_watch();
            }
            log::info!("boot completed in {} ms: {}", t0.elapsed().as_millis(), serde_json::to_string(&*k4.boot_report.lock()).unwrap_or_default());
        });
        cx.activate(true);
    });
}
