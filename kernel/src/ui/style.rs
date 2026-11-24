//! Generic, data-driven styling for every styleable node. Modules describe presentation with a
//! `style` object (colors are theme tokens or `#hex`); the renderer only applies it. Values are
//! clamped so a module cannot produce degenerate layouts.
use super::theme;
use gpui_kit::{px, App, FontWeight, Hsla, Styled};
use serde_json::Value;

fn num(st: &Value, k: &str, lo: f64, hi: f64) -> Option<f32> {
    st.get(k).and_then(|v| v.as_f64()).filter(|v| v.is_finite()).map(|v| v.clamp(lo, hi) as f32)
}

pub fn color_of(cx: &App, st: &Value, k: &str) -> Option<Hsla> {
    st.get(k).and_then(|v| v.as_str()).map(|spec| theme::color(cx, spec, cx_fallback(cx)))
}

fn cx_fallback(_cx: &App) -> Hsla { gpui_kit::transparent_black() }

/// Text-only part of a style (also used for nodes that are not boxes).
pub fn apply_text<E: Styled>(mut e: E, st: &Value, cx: &App) -> E {
    if !st.is_object() {
        return e;
    }
    if let Some(c) = color_of(cx, st, "color") { e = e.text_color(c); }
    if let Some(w) = num(st, "fontWeight", 100.0, 900.0) { e = e.font_weight(FontWeight(w)); }
    if let Some(s) = num(st, "fontSize", 8.0, 48.0) { e = e.text_size(px(s)); }
    if let Some(l) = num(st, "lineHeight", 8.0, 96.0) { e = e.line_height(px(l)); }
    match st.get("font").and_then(|f| f.as_str()) {
        Some("mono") => { let f = gpui_component::ActiveTheme::theme(cx).mono_font_family.clone(); e = e.font_family(f); }
        Some("ui") => { let f = gpui_component::ActiveTheme::theme(cx).font_family.clone(); e = e.font_family(f); }
        _ => {}
    }
    if st.get("italic").and_then(|v| v.as_bool()).unwrap_or(false) { e = e.italic(); }
    e
}

/// Full box style: colors, borders (per side), radius, padding, size, alignment, shadow, opacity.
pub fn apply<E: Styled>(mut e: E, st: &Value, cx: &App) -> E {
    if !st.is_object() {
        return e;
    }
    e = apply_text(e, st, cx);
    if let Some(c) = color_of(cx, st, "background") { e = e.bg(c); }
    if let Some(w) = num(st, "borderWidth", 0.0, 8.0) { e = e.border(px(w)); }
    if let Some(w) = num(st, "borderTop", 0.0, 8.0) { e = e.border_t(px(w)); }
    if let Some(w) = num(st, "borderBottom", 0.0, 8.0) { e = e.border_b(px(w)); }
    if let Some(w) = num(st, "borderLeft", 0.0, 8.0) { e = e.border_l(px(w)); }
    if let Some(w) = num(st, "borderRight", 0.0, 8.0) { e = e.border_r(px(w)); }
    if let Some(c) = color_of(cx, st, "borderColor") { e = e.border_color(c); }
    if let Some(r) = num(st, "radius", 0.0, 64.0) { e = e.rounded(px(r)); }
    if let Some(p) = num(st, "padding", 0.0, 256.0) { e = e.p(px(p)); }
    if let Some(p) = num(st, "paddingX", 0.0, 256.0) { e = e.px(px(p)); }
    if let Some(p) = num(st, "paddingY", 0.0, 256.0) { e = e.py(px(p)); }
    if let Some(g) = num(st, "gap", 0.0, 256.0) { e = e.gap(px(g)); }
    if let Some(w) = num(st, "width", 0.0, 8192.0) { e = e.w(px(w)).flex_none(); }
    if let Some(h) = num(st, "height", 0.0, 8192.0) { e = e.h(px(h)).flex_none(); }
    if let Some(h) = num(st, "minHeight", 0.0, 8192.0) { e = e.min_h(px(h)); }
    if let Some(w) = num(st, "maxWidth", 0.0, 8192.0) { e = e.max_w(px(w)); }
    if let Some(o) = num(st, "opacity", 0.0, 1.0) { e = e.opacity(o); }
    if st.get("fullWidth").and_then(|v| v.as_bool()).unwrap_or(false) { e = e.w_full(); }
    e = position(e, st);
    if st["clip"] == true { e = e.overflow_hidden(); }
    if st.get("wrap").and_then(|v| v.as_bool()).unwrap_or(false) { e = e.flex_wrap(); }
    if st.get("noShrink").and_then(|v| v.as_bool()).unwrap_or(false) { e = e.flex_shrink_0(); }
    match st.get("justify").and_then(|v| v.as_str()) {
        Some("start") => e = e.justify_start(),
        Some("center") => e = e.justify_center(),
        Some("end") => e = e.justify_end(),
        Some("between") => e = e.justify_between(),
        _ => {}
    }
    match st.get("shadow").and_then(|v| v.as_str()) {
        Some("sm") => e = e.shadow_sm(),
        Some("md") => e = e.shadow_md(),
        Some("lg") => e = e.shadow_lg(),
        _ => {}
    }
    if let Some(bg) = gradient(st, cx) { e = e.bg(bg); }
    if let Some(list) = shadows(st, cx) { e = e.shadow(list); }
    e
}

/// `gradient: { angle, from, to, fromAt?, toAt? }`: a two-stop linear gradient (angle in degrees,
/// 0 = towards the top, clockwise; stops 0–1). Replaces `background`.
pub fn gradient(st: &Value, cx: &App) -> Option<gpui_kit::Background> {
    let g = st.get("gradient")?;
    let from = color_spec(cx, g.get("from")?.as_str()?)?;
    let to = color_spec(cx, g.get("to")?.as_str()?)?;
    let angle = g.get("angle").and_then(Value::as_f64).unwrap_or(180.0).rem_euclid(360.0) as f32;
    let at = |key: &str, default: f32| g.get(key).and_then(Value::as_f64).map(|v| v.clamp(0.0, 1.0) as f32).unwrap_or(default);
    Some(gpui_kit::linear_gradient(angle, gpui_kit::linear_color_stop(from, at("fromAt", 0.0)), gpui_kit::linear_color_stop(to, at("toAt", 1.0))))
}

/// `shadows: [{ x, y, blur, spread, color, inset }]` (at most 4): soft depth, colored glows and
/// inset highlights such as a glass top edge. Replaces the `shadow` preset.
pub fn shadows(st: &Value, cx: &App) -> Option<Vec<gpui_kit::BoxShadow>> {
    let list = st.get("shadows")?.as_array()?;
    let out: Vec<_> = list.iter().take(4).filter_map(|s| {
        let color = color_spec(cx, s.get("color")?.as_str()?)?;
        let n = |key: &str, lo: f64, hi: f64| s.get(key).and_then(Value::as_f64).unwrap_or(0.0).clamp(lo, hi) as f32;
        Some(gpui_kit::BoxShadow {
            color,
            offset: gpui_kit::point(px(n("x", -64.0, 64.0)), px(n("y", -64.0, 64.0))),
            blur_radius: px(n("blur", 0.0, 128.0)),
            spread_radius: px(n("spread", -64.0, 64.0)),
            inset: s.get("inset").and_then(Value::as_bool).unwrap_or(false),
        })
    }).collect();
    (!out.is_empty()).then_some(out)
}

fn color_spec(cx: &App, spec: &str) -> Option<Hsla> {
    let probe = gpui_kit::transparent_black();
    let c = super::theme::color(cx, spec, probe);
    (c != probe || spec == "transparent").then_some(c)
}

pub(super) fn position<E: Styled>(mut e: E, st: &Value) -> E {
    match st["position"].as_str() {
        Some("relative") => e.relative(),
        Some("absolute") => {
            e = e.absolute();
            if let Some(v) = num(st, "top", -8192., 8192.) { e = e.top(px(v)); }
            if let Some(v) = num(st, "right", -8192., 8192.) { e = e.right(px(v)); }
            if let Some(v) = num(st, "bottom", -8192., 8192.) { e = e.bottom(px(v)); }
            if let Some(v) = num(st, "left", -8192., 8192.) { e = e.left(px(v)); }
            e
        }
        _ => e,
    }
}
