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
    // Positioning parent for absolutely placed children such as popovers.
    if st.get("position").and_then(|v| v.as_str()) == Some("relative") { e = e.relative(); }
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
    e
}
