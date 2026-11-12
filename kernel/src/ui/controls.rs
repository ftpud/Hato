//! Native `slider` and `colorPicker` nodes. Modules supply ranges, values, swatches and actions;
//! the renderer owns drag and popover state and reports committed values back as module events.
//! Which preference a control edits, its bounds and its presentation stay in TypeScript.
use super::*;
use gpui_component::color_picker::{ColorPicker, ColorPickerEvent, ColorPickerState};
use gpui_component::slider::{Slider, SliderEvent, SliderState, SliderValue};

pub(super) struct SliderSlot {
    state: Entity<SliderState>,
    /// Last `value` the module supplied, so a re-render only moves the thumb when it changes.
    applied: Option<f64>,
    bounds: (f32, f32, f32),
    /// Current thumb position for the live value label (updated while dragging).
    live: Option<f32>,
    _subs: Vec<Subscription>,
}

pub(super) struct ColorSlot {
    state: Entity<ColorPickerState>,
    applied: Option<String>,
    _sub: Subscription,
}

fn decimals(step: f32) -> usize {
    let text = format!("{step}");
    text.split('.').nth(1).map(|d| d.trim_end_matches('0').len()).unwrap_or(0).min(4)
}

fn snap(v: f32, (min, max, step): (f32, f32, f32)) -> f64 {
    let n = if step > 0.0 { ((v - min) / step).round() * step + min } else { v };
    let d = decimals(step) as i32;
    let p = 10f64.powi(d);
    ((n.clamp(min, max) as f64) * p).round() / p
}

/// `#RRGGBB`, or `#RRGGBBAA` when translucent.
pub(super) fn hex_string(color: Hsla) -> String {
    let c = Rgba::from(color);
    let ch = |v: f32| (v.clamp(0.0, 1.0) * 255.0).round() as u8;
    if c.a < 0.999 {
        format!("#{:02X}{:02X}{:02X}{:02X}", ch(c.r), ch(c.g), ch(c.b), ch(c.a))
    } else {
        format!("#{:02X}{:02X}{:02X}", ch(c.r), ch(c.g), ch(c.b))
    }
}

impl Shell {
    /// `slider`: `action` fires once on release with the snapped number; `changeAction` (optional)
    /// fires while dragging. `showValue` paints the live value (with `unit`) beside the track, and
    /// `emptyLabel` is shown while `value` is null (e.g. "Default").
    pub(super) fn render_slider(&mut self, module: &str, key: &str, n: &Value, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let num = |k: &str| n.get(k).and_then(|v| v.as_f64());
        let min = num("min").unwrap_or(0.0) as f32;
        let max = (num("max").unwrap_or(100.0) as f32).max(min + f32::EPSILON);
        let step = num("step").unwrap_or(1.0).max(0.0) as f32;
        let bounds = (min, max, step);
        let value = num("value");
        let ik = (module.to_string(), key.to_string());
        let stale = self.sliders.get(&ik).map_or(true, |s| s.bounds != bounds);
        if stale {
            let st = cx.new(|_| SliderState::new().min(min).max(max).step(step.max(f32::EPSILON)).default_value(value.unwrap_or(min as f64) as f32));
            let (k, m, key2, ik2) = (self.kernel.clone(), module.to_string(), key.to_string(), ik.clone());
            let action = n["action"].as_str().unwrap_or("").to_string();
            let change = n["changeAction"].as_str().map(str::to_owned);
            let sub = cx.subscribe_in(&st, window, move |this: &mut Shell, _st, ev: &SliderEvent, _w, cx| {
                let (SliderEvent::Change(v) | SliderEvent::Release(v)) = ev;
                let SliderValue::Single(raw) = *v else { return };
                let snapped = snap(raw, bounds);
                if let Some(slot) = this.sliders.get_mut(&ik2) { slot.live = Some(snapped as f32); }
                let inputs = this.module_inputs(&m);
                match ev {
                    SliderEvent::Change(_) => if let Some(a) = change.as_ref() { Shell::fire(&k, &m, &inputs, a, &key2, None, json!(snapped), cx) },
                    SliderEvent::Release(_) => {
                        // The module will echo this value; don't move the thumb when it does.
                        if let Some(slot) = this.sliders.get_mut(&ik2) { slot.applied = Some(snapped); }
                        if !action.is_empty() { Shell::fire(&k, &m, &inputs, &action, &key2, None, json!(snapped), cx) }
                    }
                }
                cx.notify();
            });
            self.sliders.insert(ik.clone(), SliderSlot { state: st, applied: value, bounds, live: value.map(|v| v as f32), _subs: vec![sub] });
        }
        let slot = self.sliders.get_mut(&ik).unwrap();
        if value != slot.applied {
            if let Some(v) = value { slot.state.update(cx, |st, cx| st.set_value(v as f32, window, cx)); }
            slot.applied = value;
            slot.live = value.map(|v| v as f32);
        }
        let state = slot.state.clone();
        let label = match slot.live {
            Some(v) => format!("{:.*}{}", decimals(step), v, n["unit"].as_str().unwrap_or("")),
            None => n["emptyLabel"].as_str().unwrap_or("—").to_string(),
        };
        let muted = theme::color(cx, "muted", cx.theme().muted_foreground);
        let text = theme::color(cx, "text", cx.theme().foreground);
        let empty = slot.live.is_none();
        let disabled = n["disabled"].as_bool().unwrap_or(false);
        let mut row = self.apply_base(h_flex().gap_3().items_center().min_w(px(80.0)), n, cx)
            .child(div().flex_1().min_w(px(60.0)).px(px(8.0)).child(Slider::new(&state).horizontal().disabled(disabled)
                .bg(theme::color(cx, n["accent"].as_str().unwrap_or("primary"), cx.theme().primary))));
        if n["showValue"].as_bool().unwrap_or(false) {
            row = row.child(div().flex_shrink_0().min_w(px(44.0)).text_right().text_sm().font_weight(FontWeight::MEDIUM)
                .text_color(if empty { muted } else { text }).child(label));
        }
        row.into_any_element()
    }

    /// `colorPicker`: a swatch button opening a native picker (featured `swatches`, hex field and
    /// HSLA sliders). `action` fires with `#RRGGBB` / `#RRGGBBAA`, or null when cleared.
    pub(super) fn render_color_picker(&mut self, module: &str, key: &str, n: &Value, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let value = n["value"].as_str().filter(|v| theme::hex_color(v).is_some()).map(str::to_owned);
        let ik = (module.to_string(), key.to_string());
        if !self.colors.contains_key(&ik) {
            let initial = value.as_deref().and_then(theme::hex_color);
            let st = cx.new(|cx| { let s = ColorPickerState::new(window, cx); match initial { Some(c) => s.default_value(c), None => s } });
            let (k, m, key2, ik2) = (self.kernel.clone(), module.to_string(), key.to_string(), ik.clone());
            let action = n["action"].as_str().unwrap_or("").to_string();
            let sub = cx.subscribe_in(&st, window, move |this: &mut Shell, _st, ev: &ColorPickerEvent, _w, cx| {
                let ColorPickerEvent::Change(color) = ev;
                let hex = color.map(hex_string);
                if let Some(slot) = this.colors.get_mut(&ik2) { slot.applied = hex.clone(); }
                if action.is_empty() { return; }
                let inputs = this.module_inputs(&m);
                Shell::fire(&k, &m, &inputs, &action, &key2, None, hex.map(Value::String).unwrap_or(Value::Null), cx);
            });
            self.colors.insert(ik.clone(), ColorSlot { state: st, applied: value.clone(), _sub: sub });
        }
        let slot = self.colors.get_mut(&ik).unwrap();
        let same = |a: &Option<String>, b: &Option<String>| a.as_deref().map(str::to_ascii_uppercase) == b.as_deref().map(str::to_ascii_uppercase);
        if !same(&value, &slot.applied) {
            match value.as_deref().and_then(theme::hex_color) {
                Some(c) => slot.state.update(cx, |st, cx| st.set_value(c, window, cx)),
                None => slot.state.update(cx, |st, cx| st.clear_value(window, cx)),
            }
            slot.applied = value;
        }
        let swatches: Vec<Hsla> = n["swatches"].as_array().map(|a| a.iter().filter_map(|v| v.as_str().and_then(theme::hex_color)).collect()).unwrap_or_default();
        let mut picker = ColorPicker::new(&slot.state).small();
        if !swatches.is_empty() { picker = picker.featured_colors(swatches); }
        if let Some(label) = n["label"].as_str() { picker = picker.label(label.to_string()); }
        self.apply_base(h_flex().items_center(), n, cx).child(picker).into_any_element()
    }
}
