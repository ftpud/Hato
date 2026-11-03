//! Generic theme token application; application palettes can be supplied by UI modules.
use gpui_component::{ActiveTheme, Theme, ThemeMode};
use gpui_kit::{px, rgb, App, FontWeight, Global, Hsla};
use serde_json::Value;

#[derive(Default)]
struct ModulePalette(Value);
impl Global for ModulePalette {}

fn palette_color(palette: &Value, name: &str) -> Option<Hsla> {
    hex_color(palette.get(name)?.as_str()?)
}

/// `#rrggbb` or `#rrggbbaa`.
pub fn hex_color(text: &str) -> Option<Hsla> {
    let h = text.strip_prefix('#')?;
    match h.len() {
        6 => u32::from_str_radix(h, 16).ok().map(|hex| rgb(hex).into()),
        8 => u32::from_str_radix(h, 16).ok().map(|hex| gpui_kit::rgba(hex).into()),
        _ => None,
    }
}

/// Theme colors every module can name without defining a palette entry.
fn semantic(cx: &App, name: &str) -> Option<Hsla> {
    let t = cx.theme();
    Some(match name {
        "background" => t.background,
        "foreground" | "text" => t.foreground,
        "muted" => t.muted_foreground,
        "raised" => t.muted,
        "panel" => t.title_bar,
        "border" => t.border,
        "primary" | "accent" => t.primary,
        "primaryText" => t.primary_foreground,
        "selection" => t.list_active,
        "hover" => t.list_hover,
        "danger" => t.danger,
        "warning" => t.warning,
        "success" => t.success,
        "info" => t.info,
        "transparent" => gpui_kit::transparent_black(),
        _ => return None,
    })
}

/// Resolve a module color: `#hex`, a palette token from the module theme, or a semantic name.
pub fn color(cx: &App, spec: &str, fallback: Hsla) -> Hsla {
    if spec.starts_with('#') {
        return hex_color(spec).unwrap_or(fallback);
    }
    let alias = if spec == "accent" { "primary" } else { spec };
    if cx.has_global::<ModulePalette>() {
        let mode = if cx.theme().mode.is_dark() { "dark" } else { "light" };
        if let Some(c) = palette_color(&cx.global::<ModulePalette>().0["palette"][mode], alias) {
            return c;
        }
    }
    semantic(cx, alias).unwrap_or(fallback)
}

/// Optional module-supplied 16-color terminal palette for the current mode.
pub fn terminal_palette(cx: &App) -> Option<[u32; 16]> {
    if !cx.has_global::<ModulePalette>() { return None; }
    let mode = if cx.theme().mode.is_dark() { "dark" } else { "light" };
    let arr = cx.global::<ModulePalette>().0["terminal"][mode].as_array()?.clone();
    if arr.len() != 16 { return None; }
    let mut out = [0u32; 16];
    for (i, v) in arr.iter().enumerate() {
        out[i] = u32::from_str_radix(v.as_str()?.strip_prefix('#')?, 16).ok()?;
    }
    Some(out)
}

/// Shell chrome preferences supplied by the root module's theme node (`chrome`).
pub fn chrome(cx: &App) -> Value {
    if cx.has_global::<ModulePalette>() { cx.global::<ModulePalette>().0["chrome"].clone() } else { Value::Null }
}


/// Apply a module theme node. `mode` ("light"/"dark") is the module's appearance preference; the
/// kernel caches the last applied mode in `appearance` only to avoid a flash at the next start.
pub fn configure(cx: &mut App, node: &Value, data_dir: &std::path::Path) {
    let palette = &node["palette"];
    if !palette.is_object() { return; }
    let config = serde_json::json!({ "palette": palette, "typography": node["typography"], "terminal": node["terminal"], "chrome": node["chrome"] });
    let wanted_dark = match node["mode"].as_str() { Some("dark") => Some(true), Some("light") => Some(false), _ => None };
    let dark = cx.theme().mode.is_dark();
    let same = cx.has_global::<ModulePalette>() && cx.global::<ModulePalette>().0 == config;
    if same && wanted_dark.map(|d| d == dark).unwrap_or(true) { return; }
    cx.set_global(ModulePalette(config));
    let next = wanted_dark.unwrap_or(dark);
    apply(cx, next);
    if next != dark {
        if let Err(err) = std::fs::write(data_dir.join("appearance"), if next { "dark" } else { "light" }) {
            log::warn!("cannot cache appearance: {err}");
        }
    }
}

pub fn font_weight(cx: &App) -> FontWeight {
    let weight = if cx.has_global::<ModulePalette>() { cx.global::<ModulePalette>().0["typography"]["fontWeight"].as_f64().unwrap_or(400.0) } else { 400.0 };
    FontWeight(weight.clamp(100.0, 900.0) as f32)
}

pub fn init(cx: &mut App, data_dir: &std::path::Path) {
    if let Err(error) = cx.text_system().add_fonts(vec![
        std::borrow::Cow::Borrowed(include_bytes!("../../../assets/fonts/JetBrainsMono-Regular.ttf")),
        std::borrow::Cow::Borrowed(include_bytes!("../../../assets/fonts/JetBrainsMono-Medium.ttf")),
        std::borrow::Cow::Borrowed(include_bytes!("../../../assets/fonts/JetBrainsMono-SemiBold.ttf")),
        std::borrow::Cow::Borrowed(include_bytes!("../../../assets/fonts/JetBrainsMono-Bold.ttf")),
        std::borrow::Cow::Borrowed(include_bytes!("../../../assets/fonts/JetBrainsMono-Italic.ttf")),
    ]) { log::warn!("cannot register bundled fonts: {error}"); }
    let dark = std::fs::read_to_string(data_dir.join("appearance")).map(|s| s.trim() != "light").unwrap_or(true);
    apply(cx, dark);
}

pub fn apply(cx: &mut App, dark: bool) {
    let config = if cx.has_global::<ModulePalette>() { cx.global::<ModulePalette>().0.clone() } else { Value::Null };
    let palette = &config["palette"][if dark { "dark" } else { "light" }];
    Theme::change(if dark { ThemeMode::Dark } else { ThemeMode::Light }, None, cx);
    Theme::update(cx, |theme| {
        if let Some(family) = config["typography"]["fontFamily"].as_str().filter(|s| !s.is_empty()) { theme.font_family = family.to_owned().into(); }
        if let Some(family) = config["typography"]["monoFontFamily"].as_str().filter(|s| !s.is_empty()) { theme.mono_font_family = family.to_owned().into(); }
        if let Some(size) = config["typography"]["fontSize"].as_f64() { theme.font_size = px(size.clamp(12.0, 24.0) as f32); }
        if let Some(size) = config["typography"]["monoFontSize"].as_f64() { theme.mono_font_size = px(size.clamp(10.0, 22.0) as f32); }
        let color = |hex| -> Hsla { rgb(hex).into() };
        let named = |name: &str, fallback: Hsla| palette_color(&palette, name).unwrap_or(fallback);
        let base = named("background", color(if dark { 0x14151b } else { 0xf7f7fc }));
        let panel = named("panel", color(if dark { 0x1b1c24 } else { 0xeeeef6 }));
        let raised = named("raised", color(if dark { 0x23242f } else { 0xe6e6f1 }));
        let hover = named("hover", color(if dark { 0x2b2c3a } else { 0xdcdcea }));
        let border = named("border", color(if dark { 0x30313f } else { 0xd2d3e2 }));
        let text = named("text", color(if dark { 0xe5e5ee } else { 0x28293b }));
        let muted = named("muted", color(if dark { 0x989aad } else { 0x62657e }));
        let violet = named("primary", color(if dark { 0xb6a0ff } else { 0x6847c7 }));
        let selected = named("selection", color(if dark { 0x343047 } else { 0xe2d9fa }));
        let c = &mut theme.colors;
        c.background = base;
        c.foreground = text;
        c.title_bar = panel;
        c.title_bar_border = border;
        c.status_bar = panel;
        c.status_bar_border = border;
        c.window_border = border;
        c.border = border;
        c.input = border;
        c.muted = raised;
        c.muted_foreground = muted;
        c.accent = selected;
        c.accent_foreground = text;
        c.primary = violet;
        c.primary_hover = named("primaryHover", color(if dark { 0xc8b8ff } else { 0x7958d8 }));
        c.primary_active = named("primaryActive", color(if dark { 0xa48aee } else { 0x5737b3 }));
        c.primary_foreground = named("primaryText", color(if dark { 0x14151b } else { 0xffffff }));
        c.button = raised;
        c.button_hover = hover;
        c.button_active = selected;
        c.button_foreground = text;
        c.button_primary = c.primary;
        c.button_primary_hover = c.primary_hover;
        c.button_primary_active = c.primary_active;
        c.button_primary_foreground = c.primary_foreground;
        c.secondary = raised;
        c.secondary_hover = hover;
        c.secondary_active = selected;
        c.secondary_foreground = text;
        c.button_secondary = raised;
        c.button_secondary_hover = hover;
        c.button_secondary_active = selected;
        c.button_secondary_foreground = text;
        c.list = base;
        c.list_even = panel;
        c.list_head = panel;
        c.list_hover = raised;
        c.list_active = selected;
        c.list_active_border = violet;
        c.sidebar = panel;
        c.sidebar_foreground = text;
        c.sidebar_border = border;
        c.sidebar_accent = selected;
        c.sidebar_accent_foreground = text;
        c.sidebar_primary = violet;
        c.sidebar_primary_foreground = c.primary_foreground;
        c.popover = panel;
        c.popover_foreground = text;
        c.tab = panel;
        c.tab_bar = panel;
        c.tab_bar_segmented = base;
        c.tab_foreground = muted;
        c.tab_active = raised;
        c.tab_active_foreground = text;
        c.group_box = panel;
        c.group_box_foreground = text;
        c.selection = selected;
        c.caret = violet;
        c.ring = violet;
        c.link = violet;
        c.link_hover = c.primary_hover;
        c.link_active = c.primary_active;
        c.scrollbar = base;
        c.scrollbar_thumb = named("scrollbarThumb", color(if dark { 0x3d3e50 } else { 0xb9bbce }));
        c.scrollbar_thumb_hover = named("scrollbarThumbHover", color(if dark { 0x585a70 } else { 0x9699b4 }));
        c.drag_border = violet;
        c.drop_target = selected;
        c.progress_bar = violet;
        c.success = named("success", c.success);
        c.warning = named("warning", c.warning);
        c.danger = named("danger", c.danger);
        c.switch = border;
        c.switch_thumb = color(0xffffff);
        theme.radius = px(6.0);
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn module_colors_accept_hex_and_reject_invalid_values() {
        assert_eq!(palette_color(&json!({ "primary": "#5865f2" }), "primary"), Some(rgb(0x5865f2).into()));
        assert_eq!(palette_color(&json!({ "panel": "#191c3899" }), "panel"), Some(gpui_kit::rgba(0x191c3899).into()));
        for value in [json!(null), json!(42), json!("red"), json!("#fff"), json!("#zzzzzz"), json!("#1234567")] {
            assert!(palette_color(&json!({ "primary": value }), "primary").is_none());
        }
        assert!(palette_color(&json!({}), "primary").is_none());
    }
}
