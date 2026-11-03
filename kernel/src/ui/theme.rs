//! Generic theme token application; application palettes can be supplied by UI modules.
use gpui_component::{ActiveTheme, Theme, ThemeMode};
use gpui_kit::{px, rgb, App, Global, Hsla};
use serde_json::Value;

#[derive(Default)]
struct ModulePalette(Value);
impl Global for ModulePalette {}

fn palette_color(palette: &Value, name: &str) -> Option<Hsla> {
    let text = palette.get(name)?.as_str()?.strip_prefix("#")?;
    if text.len() != 6 { return None; }
    u32::from_str_radix(text, 16).ok().map(|hex| rgb(hex).into())
}

pub fn token(cx: &App, name: &str, fallback: Hsla) -> Hsla {
    if !cx.has_global::<ModulePalette>() { return fallback; }
    let mode = if cx.theme().mode.is_dark() { "dark" } else { "light" };
    palette_color(&cx.global::<ModulePalette>().0[mode], name).unwrap_or(fallback)
}

pub fn configure(cx: &mut App, palette: &Value) {
    if !palette.is_object() { return; }
    if cx.has_global::<ModulePalette>() && cx.global::<ModulePalette>().0 == *palette { return; }
    let dark = cx.theme().mode.is_dark();
    cx.set_global(ModulePalette(palette.clone()));
    apply(cx, dark);
}

pub fn init(cx: &mut App, data_dir: &std::path::Path) {
    let dark = std::fs::read_to_string(data_dir.join("appearance")).map(|s| s.trim() != "light").unwrap_or(true);
    apply(cx, dark);
}

pub fn apply(cx: &mut App, dark: bool) {
    let palette = if cx.has_global::<ModulePalette>() { cx.global::<ModulePalette>().0[if dark { "dark" } else { "light" }].clone() } else { Value::Null };
    Theme::change(if dark { ThemeMode::Dark } else { ThemeMode::Light }, None, cx);
    Theme::update(cx, |theme| {
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
        for value in [json!(null), json!(42), json!("red"), json!("#fff"), json!("#zzzzzz"), json!("#1234567")] {
            assert!(palette_color(&json!({ "primary": value }), "primary").is_none());
        }
        assert!(palette_color(&json!({}), "primary").is_none());
    }
}
