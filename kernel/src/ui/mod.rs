//! GPUI shell: one native window that renders the keyed UI trees produced by TS UI modules,
//! hosts native controls (inputs, code viewer, terminal) whose state is keyed by stable keys,
//! and owns the trusted chrome (approval dialogs, safe mode). Never blocks on JS: trees arrive
//! asynchronously through the UI bridge and are cached.
pub mod interact;
pub mod terminal_view;
mod theme;
mod images;
mod chat_style;
mod file_icons;
mod transcript_scroll;

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
use gpui_component::text::{TextView, TextViewStyle};
use gpui_component::scroll::{Scrollbar, ScrollbarMode};
use gpui_kit::base::SelectableText;
use gpui_component::{h_flex, v_flex, ActiveTheme, Disableable, Sizable, TitleBar};
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
    scrolls: HashMap<String, transcript_scroll::TranscriptScroll>,
    toasts: Vec<(String, String, Instant)>,
    modals: Vec<(String, String, Value)>,
    approval_scroll: ScrollHandle,
    show_safe_mode: bool,
    submit_queue: Vec<(String, String, String)>,
    lay: interact::Layout,
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
            lay: Default::default(),
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
                    Some(e) => v_flex().size_full().min_h_0().overflow_hidden().child(self.error_strip(module, &e, cx)).child(div().flex_1().min_h_0().overflow_hidden().flex().flex_col().child(body)).into_any_element(),
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
        let max_h = n.get("maxHeight").and_then(|h| h.as_f64());
        if n.get("grow").and_then(|g| g.as_bool()).unwrap_or(false) {
            d = d.flex_1().min_w_0().min_h_0();
        } else if let Some(h) = max_h {
            // Bounded but allowed to shrink when the panel is short.
            d = d.max_h(px(h as f32)).min_h_0().flex_shrink(1.0);
        } else {
            d = d.flex_shrink_0();
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
        d = match n["borderSide"].as_str() {
            Some("left") => d.border_l_1().border_color(cx.theme().border),
            Some("right") => d.border_r_1().border_color(cx.theme().border),
            _ => d,
        };
        let p = chat_style::Palette::new(cx);
        d = match n["surface"].as_str() {
            Some("sidebar") => d,
            Some("chat") => d.relative().bg(p.base).text_color(p.text).text_sm().font_family(cx.theme().font_family.clone()).rounded(px(10.0)).border_1().border_color(p.border),
            Some("chat-toolbar") => d.bg(p.panel).border_b_1().border_color(p.border).flex_wrap(),
            Some("chat-composer") => d.bg(p.base).border_t_1().border_color(p.border),
            Some("chat-settings") => d.bg(p.base).text_color(p.muted),
            Some("chat-picker") => d.bg(p.base).text_color(p.text).border_1().border_color(p.border).rounded(px(12.0)),
            Some("chat-control") => d.rounded(px(8.0)).text_color(p.text),
            _ => d,
        };
        let style = &n["style"];
        if let Some(token) = style["background"].as_str() { d = d.bg(theme::token(cx, token, cx.theme().background)); }
        if let Some(token) = style["color"].as_str() { d = d.text_color(theme::token(cx, token, cx.theme().foreground)); }
        if let Some(width) = style["borderBottom"].as_f64() { d = d.border_b(px(width.clamp(0.0, 4.0) as f32)); }
        if let Some(token) = style["borderColor"].as_str() { d = d.border_color(theme::token(cx, token, cx.theme().border)); }
        if let Some(radius) = style["radius"].as_f64() { d = d.rounded(px(radius.clamp(0.0, 32.0) as f32)); }
        if let Some(weight) = style["fontWeight"].as_f64() { d = d.font_weight(FontWeight(weight.clamp(100.0, 900.0) as f32)); }
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
            "theme" => { theme::configure(cx, &n["palette"], &n["typography"]); div().into_any_element() }
            "row" | "column" => {
                let mut d = if ty == "row" { h_flex() } else { v_flex() };
                if ty == "row" {
                    if b("wrap") { d = d.flex_wrap(); }
                    d = match n.get("align").and_then(|a| a.as_str()) {
                        Some("stretch") => d.items_stretch(),
                        Some("start") => d.items_start(),
                        Some("end") => d.items_end(),
                        _ => d.items_center(),
                    };
                }
                d = self.apply_base(d, n, cx).min_w_0().overflow_hidden();
                if ty == "column" {
                    d = d.min_h_0();
                }
                let kids = self.children(module, n, &path, depth, window, cx);
                if b("scroll") {
                    let gap = n.get("gap").and_then(|g| g.as_f64()).unwrap_or(0.0) as f32;
                    d.child(div().id(sid(module, &path)).flex_1().min_h_0().w_full().overflow_y_scroll().child(v_flex().w_full().gap(px(gap)).children(kids))).into_any_element()
                } else {
                    d.children(kids).into_any_element()
                }
            }
            "scroll" => {
                let kids = self.children(module, n, &path, depth, window, cx);
                let d = self.apply_base(v_flex(), n, cx).min_h_0().min_w_0().overflow_hidden();
                d.child(div().id(sid(module, &path)).flex_1().min_h_0().w_full().overflow_y_scroll().child(v_flex().w_full().children(kids))).into_any_element()
            }
            "titleBar" => {
                let kids = self.children(module, n, &path, depth, window, cx);
                TitleBar::new()
                    // macOS hides the traffic lights in fullscreen, so reclaim their inset.
                    .when(cfg!(target_os = "macos") && window.is_fullscreen(), |bar| bar.pl_0())
                    .child(h_flex().flex_1().min_w_0().gap_2().px_2().children(kids)).into_any_element()
            }
            "split" => self.render_split(module, n, &path, key, depth, window, cx),
            "dragHandle" => self.render_drag_handle(module, n, &path, key, window, cx),
            "dropZone" => self.render_drop_zone(module, n, &path, key, depth, window, cx),
            "floating" => {
                self.lay.floats.push((module.to_string(), path.clone(), n.clone()));
                div().into_any_element()
            }
            "window" => {
                self.note_window(module, &path, key, n);
                div().into_any_element()
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
                    d = d.child(div().flex_1().min_h_0().overflow_hidden().flex().flex_col().child(el));
                }
                d.into_any_element()
            }
            "slot" => {
                let m = s("module");
                let el = self.render_slot(&m, depth + 1, window, cx);
                self.apply_base(v_flex().flex_1().size_full().min_w_0().min_h_0().overflow_hidden(), n, cx).child(el).into_any_element()
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
                d = match n["weight"].as_str() {
                    Some("bold") => d.font_weight(FontWeight::BOLD),
                    Some("semibold") => d.font_weight(FontWeight::SEMIBOLD),
                    Some("medium") => d.font_weight(FontWeight::MEDIUM),
                    Some("normal") => d.font_weight(FontWeight::NORMAL),
                    _ => d,
                };
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
                let text = s("text");
                let icon_only = text.is_empty() && (n["iconSvg"].as_str().is_some() || n["icon"].as_str().is_some());
                let mut btn = Button::new(sid(module, &path)).disabled(b("disabled"));
                if !text.is_empty() { btn = btn.label(text); }
                btn = match n.get("variant").and_then(|v| v.as_str()) {
                    Some("primary") => btn.primary(),
                    Some("danger") => btn.danger(),
                    Some("ghost") => btn.ghost(),
                    _ => btn,
                };
                if b("small") {
                    btn = btn.small();
                }
                let icon_size = px(n["iconSize"].as_f64().unwrap_or(16.0).clamp(12.0, 32.0) as f32);
                if let Some(svg) = n["iconSvg"].as_str() {
                    btn = btn.icon(gpui_component::Icon::default().data(svg.as_bytes()).with_size(icon_size));
                } else if let Some(icon) = n["icon"].as_str() {
                    btn = btn.icon(chat_style::icon(icon).with_size(icon_size));
                }
                let p = chat_style::Palette::new(cx);
                if n["surface"].as_str() == Some("sidebar-button") {
                    let selected = n["variant"].as_str() == Some("primary");
                    btn = btn.ghost().p_0().flex_shrink_0().rounded(px(10.0)).border_0()
                        .bg(if selected { p.user } else { p.base })
                        // Button registers its own hover style; registering another panics in GPUI.
                        .text_color(if selected { p.accent } else { p.muted });
                } else if n["surface"].as_str() == Some("chat-control") {
                    btn = btn.h(px(32.0)).text_sm().rounded(px(8.0)).bg(p.base).border_color(p.border).text_color(p.text);
                    if icon_only { btn = btn.w(px(32.0)).p_0().flex_shrink_0(); }
                    else { btn = btn.px_3().gap(px(8.0)); }
                    if n["grow"].as_bool().unwrap_or(false) { btn = btn.w_full(); }
                } else if n["surface"].as_str() == Some("chat-primary") {
                    btn = btn.h(px(32.0)).text_sm().rounded(px(8.0)).bg(p.accent).text_color(white()).flex_shrink_0();
                    if icon_only { btn = btn.w(px(32.0)).p_0(); } else { btn = btn.px_3(); }
                } else if n["surface"].as_str() == Some("chat-result") {
                    btn = btn.w_full().h(px(34.0)).text_color(p.text).justify_start();
                }
                let style = &n["style"];
                if let Some(token) = style["background"].as_str() { btn = btn.bg(theme::token(cx, token, cx.theme().background)); }
                if let Some(token) = style["color"].as_str() { btn = btn.text_color(theme::token(cx, token, cx.theme().foreground)); }
                if let Some(radius) = style["radius"].as_f64() { btn = btn.rounded(px(radius.clamp(0.0, 32.0) as f32)); }
                if let Some(weight) = style["fontWeight"].as_f64() { btn = btn.font_weight(FontWeight(weight.clamp(100.0, 900.0) as f32)); }
                if let Some(width) = n["width"].as_f64() { btn = btn.w(px(width as f32)); }
                if let Some(height) = n["height"].as_f64() { btn = btn.h(px(height as f32)); }
                if b("grow") { btn = btn.w_full().min_w_0(); }

                if let Some(t) = n.get("tooltip").and_then(|t| t.as_str()) {
                    btn = btn.tooltip(t.to_string());
                }
                btn.on_click(move |_, _, cx| Self::fire(&k, &m, &inputs, &action, &key2, None, value.clone(), cx)).into_any_element()
            }
            "imagePicker" => {
                let k = self.kernel.clone();
                let m = module.to_string();
                let action = s("action");
                let key2 = key.to_string();
                let inputs = self.module_inputs(module);
                Button::new(sid(module, &path)).icon(chat_style::icon("paperclip").with_size(px(16.0))).h(px(32.0)).w(px(32.0)).p_0().flex_shrink_0().rounded(px(8.0)).bg(chat_style::Palette::new(cx).panel).border_color(chat_style::Palette::new(cx).border).disabled(b("disabled"))
                    .tooltip("Attach pictures (PNG, JPEG, WebP or GIF)")
                    .on_click(move |_, _, cx| {
                        let rx = cx.prompt_for_paths(PathPromptOptions { files: true, directories: false, multiple: true, prompt: Some("Attach pictures".into()) });
                        let (k, m, action, key2, inputs) = (k.clone(), m.clone(), action.clone(), key2.clone(), inputs.clone());
                        cx.spawn(async move |cx| {
                            if let Some(paths) = rx.await.ok().and_then(|r| r.ok()).flatten() {
                                let value = cx.background_executor().spawn(async move { images::files(&paths) }).await;
                                let _ = cx.update(|cx| Self::fire(&k, &m, &inputs, &action, &key2, None, value, cx));
                            }
                        }).detach();
                    }).into_any_element()
            }
            "image" => {
                if let Some(image) = images::preview(&n["image"]) {
                    self.apply_base(div(), n, cx).child(img(image).size_full().object_fit(ObjectFit::Contain)).into_any_element()
                } else { div().text_xs().child("Picture unavailable").into_any_element() }
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
                    let change = n.get("changeAction").and_then(|v| v.as_str()).map(str::to_owned);
                    let slot = if multiline {
                        let st = cx.new(|cx| TextareaState::new(window, cx).placeholder(placeholder).submit_on_enter(submit.is_some()).default_value(value.clone().unwrap_or_default()));
                        let sub = cx.subscribe_in(&st, window, move |this: &mut Shell, _st, ev: &InputEvent, _w, cx| {
                            if let (InputEvent::Change, Some(a)) = (ev, change.as_ref()) {
                                let inputs = this.module_inputs(&m);
                                Shell::fire(&k, &m, &inputs, a, &key2, None, json!(_st.read(cx).value().to_string()), cx);
                            }
                            if let (InputEvent::PressEnter { shift: false, .. }, Some(a)) = (ev, submit.as_ref()) {
                                let inputs = this.module_inputs(&m);
                                Shell::fire(&k, &m, &inputs, a, &key2, None, Value::Null, cx);
                            }
                        });
                        InputSlot { input: AnyInput::Area(st), applied: value.clone(), _sub: sub }
                    } else {
                        let secret = b("secret");
                        let st = cx.new(|cx| InputState::new(window, cx).placeholder(placeholder).masked(secret).default_value(value.clone().unwrap_or_default()));
                        let sub = cx.subscribe_in(&st, window, move |this: &mut Shell, _st, ev: &InputEvent, _w, cx| {
                            if let (InputEvent::Change, Some(a)) = (ev, change.as_ref()) {
                                let inputs = this.module_inputs(&m);
                                Shell::fire(&k, &m, &inputs, a, &key2, None, json!(_st.read(cx).value().to_string()), cx);
                            }
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
                    AnyInput::Line(e) => Input::new(e).small().bg(theme::token(cx, "field", cx.theme().background)).when(b("search"), |input| input.prefix(chat_style::icon("search").with_size(px(16.0)))).disabled(b("disabled")).into_any_element(),
                    AnyInput::Area(e) => Textarea::new(e).text_sm().font_family(cx.theme().font_family.clone()).bg(if n["surface"].as_str() == Some("chat-control") { chat_style::Palette::new(cx).panel } else { cx.theme().background }).disabled(b("disabled")).h(px(n.get("rows").and_then(|r| r.as_f64()).unwrap_or(3.0) as f32 * 20.0 + 12.0)).into_any_element(),
                };
                let k = self.kernel.clone();
                let m = module.to_string();
                let inputs = self.module_inputs(module);
                let key2 = key.to_string();
                let paste = n.get("pasteImageAction").and_then(|v| v.as_str()).map(str::to_owned);
                let (k2, m2, inputs2, key3, paste2) = (k.clone(), m.clone(), inputs.clone(), key2.clone(), paste.clone());
                self.apply_base(div(), n, cx)
                    .capture_key_down(move |ev, window, cx| {
                        if (ev.keystroke.modifiers.control || ev.keystroke.modifiers.platform) && ev.keystroke.key == "v" {
                            if let Some(action) = &paste {
                                if let Some(value) = cx.read_from_clipboard().and_then(images::clipboard) {
                                    Self::fire(&k, &m, &inputs, action, &key2, None, value, cx);
                                    cx.stop_propagation(); window.prevent_default();
                                }
                            }
                        }
                    })
                    .capture_action(move |_: &gpui_component::input::Paste, _, cx| {
                        if let Some(action) = &paste2 {
                            if let Some(value) = cx.read_from_clipboard().and_then(images::clipboard) {
                                Self::fire(&k2, &m2, &inputs2, action, &key3, None, value, cx);
                                cx.stop_propagation();
                            }
                        }
                    }).child(el).into_any_element()
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
                if n["surface"].as_str() == Some("chat-control") {
                    let p = chat_style::Palette::new(cx);
                    btn = btn.w_full().h(px(36.0)).rounded(px(8.0)).bg(p.base).border_color(p.border).text_color(p.text).justify_between();
                }
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
            "usageMeter" => {
                let value = n["value"].as_f64().filter(|v| v.is_finite()).map(|v| v.clamp(0.0, 1.0));
                let label = value.map(|v| format!("{:.0}%", v * 100.0)).unwrap_or_else(|| "—".into());
                Button::new(sid(module, &path)).ghost().small().h(px(32.0)).px_1().gap_1().flex_shrink_0()
                    .icon(chat_style::usage_pie(value, cx.theme().mode.is_dark())).label(label)
                    .text_color(chat_style::Palette::new(cx).muted).tooltip(s("tooltip"))
                    .into_any_element()
            }
            "choice" => {
                let p = chat_style::Palette::new(cx);
                let k = self.kernel.clone();
                let m = module.to_string();
                let inputs = self.module_inputs(module);
                let action = s("action");
                let key2 = key.to_string();
                let value = n["value"].clone();
                let selected = b("selected");
                let mut content = v_flex().gap(px(4.0)).flex_1().min_w_0()
                    .child(div().text_sm().font_weight(FontWeight::MEDIUM).overflow_hidden().whitespace_nowrap().text_ellipsis().child(s("text")));
                if !s("description").is_empty() { content = content.child(div().text_xs().text_color(p.muted).child(s("description"))); }
                Button::new(sid(module, &path)).ghost().w_full().h_auto().px_3().py_2().rounded(px(7.0)).justify_start().text_color(p.text)
                    .bg(if selected { p.user } else { p.base }).border_1().border_color(if selected { p.border } else { p.base })
                    .child(h_flex().gap_3().w_full().min_w_0().child(content)
                        .child(div().w(px(18.0)).flex_shrink_0().text_color(p.accent).child(if selected { "✓" } else { "" })))
                    .on_click(move |_, _, cx| Self::fire(&k, &m, &inputs, &action, &key2, None, value.clone(), cx))
                    .into_any_element()
            }
            "switch" => {
                let k = self.kernel.clone();
                let m = module.to_string();
                let action = s("action");
                let inputs = self.module_inputs(module);
                let key2 = key.to_string();
                h_flex().gap_2().h(px(32.0)).text_sm().text_color(chat_style::Palette::new(cx).muted)
                    .child(s("label"))
                    .child(gpui_component::switch::Switch::new(sid(module, &path)).checked(b("checked")).disabled(b("disabled")).color(chat_style::Palette::new(cx).accent)
                        .tooltip(s("tooltip"))
                        .on_change(move |v, _, cx| Self::fire(&k, &m, &inputs, &action, &key2, None, json!(*v), cx)))
                    .into_any_element()
            }
            "popover" => {
                let kids = self.children(module, n, &path, depth, window, cx);
                let k = self.kernel.clone();
                let m = module.to_string();
                let inputs = self.module_inputs(module);
                let action = s("closeAction");
                let key2 = key.to_string();
                div().absolute().inset_0().occlude()
                    .on_mouse_down(MouseButton::Left, move |_, _, cx| Self::fire(&k, &m, &inputs, &action, &key2, None, Value::Null, cx))
                    .child(self.apply_base(v_flex(), n, cx).absolute().top(px(52.0)).left(px(8.0)).right(px(8.0)).h(relative(0.55)).max_h(px(420.0)).shadow_lg().overflow_hidden().occlude()
                        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation()).children(kids))
                    .into_any_element()
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
            "appearanceControl" => {
                let appearance_path = self.kernel.cfg.data_dir.join("appearance");
                gpui_component::switch::Switch::new(sid(module, &path))
                    .label("Cool dark mode").checked(cx.theme().mode.is_dark())
                    .tooltip("Off: cool light · On: cool dark")
                    .on_change(move |dark, _, cx| {
                        theme::apply(cx, *dark);
                        if let Err(err) = std::fs::write(&appearance_path, if *dark { "dark" } else { "light" }) {
                            log::warn!("cannot save appearance preference: {err}");
                        }
                    }).into_any_element()
            }
            "tree" => {
                let file_tree = n["appearance"].as_str() == Some("files");
                let project_tree = n["appearance"].as_str() == Some("projects");
                let rows = n.get("rows").and_then(|r| r.as_array()).cloned().unwrap_or_default();
                let sel_action = s("selectAction");
                let exp_action = s("expandAction");
                let inputs = self.module_inputs(module);
                let mut list = v_flex().w_full().min_w_0().gap(px(if file_tree || project_tree { 0.0 } else { 1.0 }));
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
                    let mut row = h_flex().id(sid(module, &format!("{path}/row/{rk}"))).w_full().min_w_0().overflow_hidden().pl(px(4.0 + depth_ * 14.0)).pr_1().py(px(3.0)).gap_1().rounded(px(3.0)).cursor_pointer()
                        .hover(|s| s.bg(cx.theme().list_hover))
                        .on_click(move |_, _, cx| Self::fire(&k, &m, &inputs2, &a, &key2, Some(rk2.clone()), Value::Null, cx));
                    if file_tree { row = row.h(px(21.0)).flex_shrink_0().py_0().gap(px(6.0)).rounded(px(5.0)); }
                    if project_tree { row = row.h(px(42.0)).flex_shrink_0().py_0().gap(px(6.0)).rounded(px(5.0)); }
                    if selected {
                        row = row.bg(cx.theme().list_active);
                    }
                    let label = v_flex().flex_1().min_w_0()
                        .child(h_flex().w_full().min_w_0().gap_1().child(div().flex_1().min_w_0().text_sm().when(project_tree && depth_ == 0.0, |d| d.font_weight(FontWeight::SEMIBOLD)).overflow_hidden().whitespace_nowrap().text_ellipsis().child(r["label"].as_str().unwrap_or("").to_string()))
                            .child(div().text_xs().text_color(theme_muted).whitespace_nowrap().child(r["badge"].as_str().map(|b| if project_tree { b.to_string() } else { format!("[{b}]") }).unwrap_or_default())))
                        .when_some(r["detail"].as_str(), |d, detail| d.child(div().text_xs().text_color(theme_muted).overflow_hidden().whitespace_nowrap().text_ellipsis().child(detail.to_string())));
                    let icon_element = if let Some(svg) = r["iconSvg"].as_str() {
                        let color = match r["iconColor"].as_str() {
                            Some("accent") => theme::token(cx, "primary", cx.theme().primary),
                            Some("warning") => theme::token(cx, "warning", cx.theme().warning),
                            Some("success") => theme::token(cx, "success", cx.theme().success),
                            _ => theme_muted,
                        };
                        gpui_component::Icon::default().data(svg.as_bytes()).with_size(px(16.0)).text_color(color).into_any_element()
                    } else if project_tree {
                        let name = match r["icon"].as_str() { Some("task") | Some("git") => "git-branch", Some("remote") => "terminal", Some("warning") => "warning", _ => "folder" };
                        chat_style::icon(name).with_size(px(18.0)).text_color(theme_muted).into_any_element()
                    } else if file_tree { file_icons::icon(r["icon"].as_str().unwrap_or("file"), expanded, cx).into_any_element() }
                        else { div().w(px(12.0)).text_xs().flex_none().child(icon).into_any_element() };
                    let leading = if let Some(connector) = r["connector"].as_str().filter(|c| *c == "branch" || *c == "last") {
                        let stem = div().absolute().left(px(3.0)).top_0().w(px(1.0)).bg(theme_muted.opacity(0.55));
                        div().relative().w(px(16.0)).h_full().flex_none()
                            .child(if connector == "last" { stem.h(relative(0.5)) } else { stem.bottom_0() })
                            .child(div().absolute().left(px(3.0)).top(relative(0.5)).w(px(13.0)).h(px(1.0)).bg(theme_muted.opacity(0.55))).into_any_element()
                    } else { chevron.into_any_element() };
                    row = row.child(leading).child(div().flex_shrink_0().child(icon_element)).child(label);
                    list = list.child(row);
                }
                self.apply_base(v_flex(), n, cx).min_h_0().min_w_0().overflow_hidden().child(div().id(sid(module, &path)).flex_1().min_h_0().w_full().overflow_y_scroll().child(list)).into_any_element()
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
                self.apply_base(v_flex(), n, cx).min_h_0().min_w_0().overflow_hidden().child(div().id(sid(module, &path)).flex_1().min_h_0().w_full().overflow_y_scroll().child(list)).into_any_element()
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
            "markdown" => {
                let document = n["document"].as_str().and_then(|h| self.kernel.handles.get_kernel::<Document>(h, "document"));
                let text = document.map(|d| d.text.clone()).unwrap_or_default();
                self.apply_base(v_flex(), n, cx).min_w_0().min_h_0().overflow_hidden()
                    .child(div().id(sid(module, &path)).flex_1().min_h_0().w_full().overflow_y_scroll()
                        .child(div().w_full().min_w_0().p_3().text_color(cx.theme().foreground)
                            .child(TextView::markdown(sid(module, &format!("{path}/content/{}", s("document"))), text)
                                .selectable(true).w_full().min_w_0().text_sm())))
                    .into_any_element()
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
                self.apply_base(div(), n, cx).flex().flex_col().size_full().min_w_0().min_h_0().overflow_hidden().child(body).into_any_element()
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
                self.apply_base(div(), n, cx).flex().flex_col().size_full().min_w_0().min_h_0().overflow_hidden().child(body).into_any_element()
            }
            "chatTranscript" => {
                let msgs = n.get("messages").and_then(|m| m.as_array()).cloned().unwrap_or_default();
                let scroll_key = format!("{module}::{path}/{}", n["conversationId"].as_str().unwrap_or("default"));
                let state = self.scrolls.entry(scroll_key).or_default();
                let first_message = msgs.first().and_then(|message| message["key"].as_str()).map(str::to_owned);
                let last_message = msgs.last().and_then(|message| message["key"].as_str()).map(str::to_owned);
                let changed = state.first_message != first_message || state.last_message != last_message;
                let preserving = b("preserveScrollOnChange") && changed;
                let prepended = state.first_message != first_message && state.first_message.as_ref().is_some_and(|old| msgs.iter().any(|message| message["key"].as_str() == Some(old.as_str())));
                if preserving || prepended {
                    let positions = state.positions.borrow();
                    let anchor = msgs.iter().filter_map(|message| message["key"].as_str())
                        .find_map(|key| positions.get(key).map(|y| (key.to_string(), *y)));
                    if let Some(base) = state.geometry.get() {
                        *state.anchor_key.borrow_mut() = anchor.as_ref().map(|(key, _)| key.clone());
                        state.prepend.set(Some(transcript_scroll::PrependAnchor { base, last_max: base.max, stable_frames: 0, anchor_y: anchor.map(|(_, y)| y - state.viewport_y.get()) }));
                    }
                    state.following.set(false);
                    state.user_scrolled_up.set(true);
                }
                state.positions.borrow_mut().clear();
                if state.first_message != first_message { state.history_requested.set(false); }
                if state.last_message != last_message { state.bottom_requested.set(false); }
                state.first_message = first_message;
                state.last_message = last_message;
                let last_user = msgs.iter().rev().find(|message| message["role"] == "user").and_then(|message| message["key"].as_str()).map(str::to_owned);
                let reset = n["scrollReset"].as_u64();
                let requested_reset = reset != state.scroll_reset && state.scroll_reset.is_some();
                if requested_reset || (!preserving && !prepended && state.last_user != last_user) {
                    state.following.set(true);
                    state.geometry.set(None);
                    state.prepend.set(None);
                    state.user_scrolled_up.set(false);
                }
                state.scroll_reset = reset;
                state.last_user = last_user;
                let prepend = state.prepend.clone();
                let history_requested = state.history_requested.clone();
                let bottom_requested = state.bottom_requested.clone();
                let user_scrolled_up = state.user_scrolled_up.clone();
                let message_positions = state.positions.clone();
                let anchor_positions = state.positions.clone();
                let anchor_key = state.anchor_key.clone();
                let viewport_y = state.viewport_y.clone();
                let bottom_action = s("bottomAction");
                let has_older = b("hasOlder");
                let loading_older = b("loadingOlder");
                let older_action = s("loadOlderAction");
                let load_kernel = self.kernel.clone();
                let load_module = module.to_string();
                let load_key = key.to_string();
                let handle = state.handle.clone();
                let following = state.following.clone();
                let geometry = state.geometry.clone();
                if following.get() && geometry.get().is_none() { handle.scroll_to_bottom(); }
                let paint_handle = handle.clone();
                let wheel_following = following.clone();
                let wheel_up = user_scrolled_up.clone();
                let wheel_handle = handle.clone();
                let wheel_requested = history_requested.clone();
                let wheel_kernel = load_kernel.clone();
                let wheel_module = load_module.clone();
                let wheel_action = older_action.clone();
                let wheel_key = load_key.clone();
                let follow_layout = canvas(|_, _, _| (), move |bounds, (), window, cx| {
                    viewport_y.set(f32::from(bounds.origin.y));
                    let current = transcript_scroll::Geometry { max: f32::from(paint_handle.max_offset().y), offset: f32::from(paint_handle.offset().y) };
                    if let Some(mut anchor) = prepend.get() {
                        let measured_y = anchor_key.borrow().as_ref().and_then(|key| anchor_positions.borrow().get(key).map(|y| *y - viewport_y.get()));
                        let wanted = match (anchor.anchor_y, measured_y) {
                            (Some(old_y), Some(new_y)) => transcript_scroll::anchored_offset(current, old_y, new_y),
                            _ => transcript_scroll::prepended_offset(anchor.base, current.max),
                        };
                        let settled = (current.max - anchor.last_max).abs() <= 1.0 && (current.offset - wanted).abs() <= 1.0;
                        anchor.stable_frames = if settled { anchor.stable_frames + 1 } else { 0 };
                        anchor.last_max = current.max;
                        if (current.offset - wanted).abs() > 1.0 { paint_handle.set_offset(point(paint_handle.offset().x, px(wanted))); }
                        geometry.set(Some(transcript_scroll::Geometry { max: current.max, offset: wanted }));
                        prepend.set(if anchor.stable_frames >= 2 { None } else { Some(anchor) });
                        window.refresh();
                        return;
                    }
                    if let Some(old) = geometry.get() {
                        if (current.max - old.max).abs() <= 1.0 && (current.offset - old.offset).abs() > 1.0 {
                            user_scrolled_up.set(current.offset > old.offset);
                        }
                    }
                    following.set(transcript_scroll::following_bottom(following.get(), geometry.get(), current));
                    geometry.set(Some(current));
                    if current.offset < -80.0 { history_requested.set(false); }
                    if current.max + current.offset > 80.0 { bottom_requested.set(false); }
                    if following.get() && !user_scrolled_up.get() && !loading_older && !bottom_action.is_empty() && !bottom_requested.replace(true) {
                        Self::fire(&load_kernel, &load_module, &[], &bottom_action, &load_key, None, Value::Null, cx);
                    }
                    if !following.get() && current.offset >= -48.0 && has_older && !loading_older && !older_action.is_empty() && !history_requested.replace(true) {
                        Self::fire(&load_kernel, &load_module, &[], &older_action, &load_key, None, Value::Null, cx);
                    }
                    // Rich text and image layout can finish after the first scroll request.
                    // Correct against the measured extent until the last line is actually visible.
                    if following.get() && current.max + current.offset > 1.0 {
                        paint_handle.scroll_to_bottom();
                        window.refresh();
                    }
                }).absolute().inset_0();
                let p = chat_style::Palette::new(cx);
                let mut list = v_flex().w_full().min_w_0().flex_shrink_0().overflow_hidden().gap(px(6.0)).p(px(8.0)).font_family(cx.theme().font_family.clone()).text_sm().text_color(p.text);
                if has_older {
                    let kernel = self.kernel.clone();
                    let owner = module.to_string();
                    let action = s("loadOlderAction");
                    let event_key = key.to_string();
                    let failed = n["historyError"].as_str();
                    list = list.child(Button::new(sid(module, &format!("{path}/older"))).ghost().small().w_full()
                        .label(if loading_older { "Loading older messages…" } else if failed.is_some() { "Retry loading older messages" } else { "Load older messages" })
                        .disabled(loading_older || action.is_empty()).tooltip(failed.unwrap_or("Load the previous message batch").to_string())
                        .on_click(move |_, _, cx| Self::fire(&kernel, &owner, &[], &action, &event_key, None, Value::Null, cx)));
                }
                for m in msgs.iter() {
                    let role = m["role"].as_str().unwrap_or("system");
                    let text = m["text"].as_str().unwrap_or("").to_string();
                    let message_path = format!("{path}/{}", m["key"].as_str().unwrap_or("message"));
                    if role == "thought" {
                        let thought = v_flex().w_full().min_w_0().overflow_hidden().gap(px(2.0)).border_l_2().border_color(p.border).px_3().py_1().text_sm().text_color(p.muted)
                            .child(div().text_xs().child("REASONING"))
                            .child(TextView::markdown(sid(module, &format!("{message_path}/reasoning")), text).style(TextViewStyle::default().paragraph_gap(rems(0.3))).selectable(true).line_height(px(18.0)).w_full().min_w_0().overflow_hidden().text_sm());
                        list = list.child(Self::measured_message(thought.into_any_element(), m["key"].as_str().unwrap_or("message"), message_positions.clone()));
                        continue;
                    }
                    if role == "tool" {
                        let title = m["title"].as_str().unwrap_or("Tool");
                        let status = m["status"].as_str().unwrap_or("");
                        let summary = chat_style::single_line(title);
                        let copied = if text.is_empty() { title.to_owned() } else { format!("{title}\n{text}") };
                        let tool = h_flex().w_full().min_w_0().h(px(28.0)).flex_shrink_0().overflow_hidden().gap_2().px_3()
                            .rounded(px(7.0)).border_1().border_color(p.border).text_color(p.muted).text_sm()
                            .child(div().flex_shrink_0().text_xs().child("TOOLS"))
                            .child(div().flex_1().min_w_0().overflow_hidden().whitespace_nowrap().text_ellipsis().child(summary))
                            .when(!status.is_empty(), |d| d.child(div().max_w(px(72.0)).overflow_hidden().whitespace_nowrap().text_ellipsis().text_xs().child(chat_style::single_line(status))))
                            .child(Button::new(sid(module, &format!("{message_path}/copy-tool"))).icon(chat_style::icon("copy").with_size(px(14.0))).ghost().small().w(px(22.0)).h(px(22.0)).p_0().flex_shrink_0().tooltip("Copy tool output")
                                .on_click(move |_, _, cx| cx.write_to_clipboard(ClipboardItem::new_string(copied.clone()))));
                        list = list.child(Self::measured_message(tool.into_any_element(), m["key"].as_str().unwrap_or("message"), message_positions.clone()));
                        continue;
                    }
                    let label = match role { "user" => "YOU", "assistant" => n["agentLabel"].as_str().unwrap_or("AGENT"), "plan" => "PLAN", "error" => "ERROR", _ => "SYSTEM" };
                    let edge = match role { "user" => p.accent, "assistant" => p.agent, "error" => cx.theme().danger, _ => p.border };
                    let copied = text.clone();
                    let copy_id = format!("{path}/copy/{}", m["key"].as_str().unwrap_or("message"));
                    let mut card = v_flex().w_full().min_w_0().flex_shrink_0().rounded(px(9.0)).relative().border_1().border_color(p.border).overflow_hidden()
                        .child(h_flex().w_full().min_w_0().overflow_hidden().gap_2().px_3().py(px(2.0)).bg(p.base).border_b_1().border_color(p.border)
                            .child(div().flex_1().min_w_0().text_xs().text_color(p.muted).overflow_hidden().whitespace_nowrap().text_ellipsis().child(label.to_uppercase()))
                            .child(Button::new(sid(module, &copy_id)).icon(chat_style::icon("copy").with_size(px(14.0))).ghost().small().w(px(26.0)).h(px(22.0)).p_0().tooltip("Copy message")
                                .on_click(move |_, _, cx| cx.write_to_clipboard(ClipboardItem::new_string(copied.clone())))));
                    let mut body = v_flex().w_full().min_w_0().overflow_hidden().gap_1().px_3().py(px(4.0)).line_height(px(18.0)).bg(if role == "user" { p.user } else { p.answer }).text_color(p.text);
                    if !text.is_empty() {
                        if role == "assistant" || role == "plan" {
                            body = body.child(TextView::markdown(sid(module, &format!("{message_path}/body")), text).style(TextViewStyle::default().paragraph_gap(rems(0.3))).selectable(true).line_height(px(18.0)).w_full().min_w_0().overflow_hidden().text_sm().text_color(p.text));
                        } else {
                            body = body.child(div().w_full().min_w_0().overflow_hidden().text_sm().line_height(px(18.0)).child(SelectableText::new(sid(module, &format!("{message_path}/body")), text)));
                        }
                    }
                    if let Some(pictures) = m["images"].as_array() {
                        for picture in pictures {
                            if let Some(image) = images::preview(picture) { body = body.child(img(image).w(px(200.0)).max_w_full().h(px(140.0)).object_fit(ObjectFit::Contain)); }
                        }
                    }
                    card = card.child(body).child(div().absolute().top_0().bottom_0().left_0().w(px(2.0)).bg(edge));
                    list = list.child(Self::measured_message(card.into_any_element(), m["key"].as_str().unwrap_or("message"), message_positions.clone()));
                }
                // The transcript must take only the space its parent gives it and scroll internally;
                // flex_1 + min_h_0 (rather than a percentage height) keeps it bounded when messages grow.
                self.apply_base(v_flex(), n, cx).relative().min_w_0().min_h_0().overflow_hidden()
                    .child(div().id(sid(module, &path)).flex_1().min_w_0().min_h_0().w_full().relative().overflow_x_hidden().overflow_y_scroll().track_scroll(&handle)
                        .on_scroll(move |event, _, cx| {
                            let up = event.delta.pixel_delta(px(18.0)).y > px(0.0);
                            wheel_up.set(up);
                            if up {
                                wheel_following.set(false);
                                if f32::from(wheel_handle.offset().y) >= -48.0 && has_older && !loading_older && !wheel_action.is_empty() && !wheel_requested.replace(true) {
                                    Self::fire(&wheel_kernel, &wheel_module, &[], &wheel_action, &wheel_key, None, Value::Null, cx);
                                }
                            }
                        })
                        .child(list))
                    .child(follow_layout)
                    .child(Scrollbar::vertical(&handle).mode(ScrollbarMode::Always).viewport_from_layout())
                    .into_any_element()
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

    fn measured_message(element: AnyElement, key: &str, positions: std::rc::Rc<std::cell::RefCell<HashMap<String, f32>>>) -> Div {
        let key = key.to_string();
        div().relative().w_full().min_w_0().flex_shrink_0().child(element)
            .child(canvas(move |bounds, _, _| { positions.borrow_mut().insert(key, f32::from(bounds.origin.y)); }, |_, _, _, _| {}).absolute().inset_0())
    }

    fn render_modal(&mut self, module: &str, path: &str, n: &Value, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let title = n.get("title").and_then(|t| t.as_str()).unwrap_or("").to_string();
        let close = n.get("closeAction").and_then(|t| t.as_str()).map(|s| s.to_string());
        let kids = self.children(module, n, path, 1, window, cx);
        let k = self.kernel.clone();
        let m = module.to_string();
        let inputs = self.module_inputs(module);
        div().id(sid(module, &format!("{path}/backdrop"))).absolute().top_0().left_0().size_full().occlude().bg(black().opacity(0.35)).flex().items_center().justify_center()
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .on_mouse_down(MouseButton::Right, |_, _, cx| cx.stop_propagation())
            .on_scroll(|_, _, cx| cx.stop_propagation())
            .child(v_flex().id(sid(module, &format!("{path}/card"))).occlude().w(px(640.0)).max_w(relative(0.95)).max_h(relative(0.85)).overflow_y_scroll().gap_2().p_4().rounded(px(8.0))
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
        Some(div().absolute().top_0().left_0().size_full().occlude().bg(black().opacity(0.5)).flex().items_center().justify_center()
            .child(v_flex().w(px(760.0)).max_w(relative(0.95)).max_h(relative(0.9)).gap_2().p_4().rounded(px(10.0)).bg(cx.theme().background).border_2().border_color(cx.theme().warning).shadow_lg()
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
        self.begin_frame();
        let layout_ok = self.trees.contains_key("workspace-layout") || self.kernel.router.active("workspace-layout").is_some();
        let body = if layout_ok && !self.show_safe_mode {
            self.render_slot("workspace-layout", 0, window, cx)
        } else {
            v_flex().size_full().child(TitleBar::new().child("Hato")).child(self.render_safe_mode(cx)).into_any_element()
        };
        // Drop native state for terminals whose PTY handle disappeared.
        let live: HashSet<String> = self.kernel.handles.handles_of_kind("pty").into_iter().collect();
        self.terminals.retain(|h, _| live.contains(h));
        let floats = std::mem::take(&mut self.lay.floats);
        let float_els: Vec<AnyElement> = floats.iter().map(|(m, p, n)| self.render_float(m, p, n, window, cx)).collect();
        let drag_layer = self.drag_overlay(cx);
        self.sync_windows(window, cx);
        let modals = std::mem::take(&mut self.modals);
        let modal_els: Vec<AnyElement> = modals.iter().map(|(m, p, n)| self.render_modal(m, p, n, window, cx)).collect();
        let approvals = self.render_approvals(cx);
        let mut toasts = v_flex().absolute().bottom(px(36.0)).right(px(12.0)).gap_1().w(px(420.0));
        for (level, text, _) in &self.toasts {
            let c = match level.as_str() { "error" => cx.theme().danger, "warn" => cx.theme().warning, _ => cx.theme().info };
            toasts = toasts.child(div().p_2().rounded(px(6.0)).text_xs().bg(cx.theme().background).border_1().border_color(c).text_color(c).child(text.clone()));
        }
        let _ = &self.submit_queue;
        div().size_full().relative().flex().flex_col().overflow_hidden().bg(cx.theme().background).text_color(cx.theme().foreground).font_family(cx.theme().font_family.clone()).font_weight(theme::font_weight(cx))
            .child(div().flex_1().min_h_0().min_w_0().overflow_hidden().flex().flex_col().child(body))
            .children(float_els)
            .children(modal_els)
            .child(toasts)
            .children(approvals)
            .children(drag_layer)
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
        theme::init(cx, &k2.cfg.data_dir);
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
            WindowOptions { window_bounds: Some(WindowBounds::Windowed(bounds)), ..TitleBar::window_options() },
            cx,
            move |window, cx| {
                let rx = rx.borrow_mut().take().unwrap();
                cx.new(|cx| Shell::new(k3.clone(), rx, window, cx))
            },
        );
        let main_id = match &opened {
            Ok((h, _)) => Some(h.window_id()),
            Err(_) => None,
        };
        if let Err(e) = opened {
            eprintln!("hato: cannot open window: {e:#}");
            std::process::exit(1);
        }
        // Quit when the main window closes (detached panel windows close independently).
        cx.on_window_closed(move |cx, _| {
            let main_open = main_id.map(|id| cx.windows().iter().any(|w| w.window_id() == id)).unwrap_or(false);
            if !main_open || cx.windows().is_empty() {
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
