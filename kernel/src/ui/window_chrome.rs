//! Window presentation requested by the active root tree.
use super::*;
use std::sync::Weak;

pub(super) struct WindowChrome {
    owner: WindowId,
    hidden: bool,
    source: Option<Weak<Value>>,
    #[cfg(target_os = "macos")]
    traffic_lights: Point<Pixels>,
    /// Requested window-button visibility (`trafficLights.hidden`).
    #[cfg(target_os = "macos")]
    buttons: ButtonMode,
    /// Pointer is over the reveal zone around the buttons (`hidden: "hover"`).
    #[cfg(target_os = "macos")]
    pointer_near: bool,
    /// Visibility last applied to AppKit.
    #[cfg(target_os = "macos")]
    buttons_hidden: bool,
}

#[cfg(target_os = "macos")]
#[derive(Clone, Copy, PartialEq, Eq)]
enum ButtonMode { Shown, Hidden, Hover }

/// Reveal zone for `hidden: "hover"`: the three buttons (about 52 px) plus a margin.
#[cfg(target_os = "macos")]
const REVEAL_WIDTH: f32 = 76.;
#[cfg(target_os = "macos")]
const REVEAL_HEIGHT: f32 = 30.;

impl WindowChrome {
    pub(super) fn new(window: &Window) -> Self {
        Self {
            owner: window.window_handle().window_id(),
            hidden: false,
            source: None,
            #[cfg(target_os = "macos")]
            traffic_lights: default_traffic_lights(),
            #[cfg(target_os = "macos")]
            buttons: ButtonMode::Shown,
            #[cfg(target_os = "macos")]
            pointer_near: false,
            #[cfg(target_os = "macos")]
            buttons_hidden: false,
        }
    }

    pub(super) fn update(&mut self, tree: Option<&Arc<Value>>, window: &Window, _cx: &mut App) {
        let unchanged = match (self.source.as_ref(), tree) {
            (Some(previous), Some(tree)) => std::ptr::eq(previous.as_ptr(), Arc::as_ptr(tree)),
            (None, None) => true,
            _ => false,
        };
        if unchanged {
            #[cfg(target_os = "macos")]
            self.apply_buttons(window, _cx); // fullscreen changes re-render without a new tree
            return;
        }
        self.source = tree.map(Arc::downgrade);
        let descriptor = tree.and_then(|tree| find_descriptor(tree));
        self.hidden = descriptor.is_some_and(|value| value["titlebar"] == "hidden");
        #[cfg(target_os = "macos")]
        {
            let position = descriptor
                .filter(|_| self.hidden)
                .and_then(traffic_lights)
                .unwrap_or_else(default_traffic_lights);
            if self.traffic_lights != position {
                self.traffic_lights = position;
                // AppKit can lay out the titlebar synchronously. Finish the current render first.
                window.defer(_cx, move |window, _| {
                    window.set_traffic_light_position(position)
                });
            }
            self.buttons = match descriptor.filter(|_| self.hidden).map(|d| &d["trafficLights"]["hidden"]) {
                Some(Value::Bool(true)) => ButtonMode::Hidden,
                Some(Value::String(mode)) if mode == "hover" => ButtonMode::Hover,
                _ => ButtonMode::Shown,
            };
            self.apply_buttons(window, _cx);
        }
        #[cfg(not(target_os = "macos"))]
        let _ = window;
    }

    pub(super) fn tracks_pointer(&self) -> bool {
        #[cfg(target_os = "macos")]
        return self.buttons == ButtonMode::Hover;
        #[cfg(not(target_os = "macos"))]
        false
    }

    /// Hover mode: show the window buttons while the pointer is near them.
    pub(super) fn pointer_moved(&mut self, _position: Point<Pixels>, _window: &Window, _cx: &mut App) {
        #[cfg(target_os = "macos")]
        if self.buttons == ButtonMode::Hover {
            let near = _position.x < self.traffic_lights.x + px(REVEAL_WIDTH) && _position.y < self.traffic_lights.y + px(REVEAL_HEIGHT);
            if near != self.pointer_near {
                self.pointer_near = near;
                self.apply_buttons(_window, _cx);
            }
        }
    }

    #[cfg(target_os = "macos")]
    fn apply_buttons(&mut self, window: &Window, cx: &mut App) {
        // Fullscreen shows AppKit's own titlebar overlay; never hide its buttons there.
        let hidden = !window.is_fullscreen() && match self.buttons {
            ButtonMode::Shown => false,
            ButtonMode::Hidden => true,
            ButtonMode::Hover => !self.pointer_near,
        };
        if hidden == self.buttons_hidden {
            return;
        }
        self.buttons_hidden = hidden;
        window.defer(cx, move |window, _| set_window_buttons_hidden(window, hidden));
    }

    pub(super) fn hides_titlebar(&self, window: &Window) -> bool {
        self.hidden && self.owner == window.window_handle().window_id()
    }

    /// The banner spans the client area. Keep it below AppKit's traffic lights or a native caption strip.
    pub(super) fn security_banner_top(&self, window: &Window, _height: Pixels) -> Pixels {
        use gpui_component::TITLE_BAR_HEIGHT;

        if window.is_fullscreen() {
            return px(0.);
        }
        #[cfg(target_os = "macos")]
        if self.hides_titlebar(window) {
            let below_lights = self.traffic_lights.y + px(22.);
            // A moved group near the bottom leaves room at the top instead.
            return if below_lights + _height <= window.viewport_size().height {
                below_lights
            } else if self.traffic_lights.y >= _height {
                px(0.)
            } else {
                below_lights
            };
        }
        TITLE_BAR_HEIGHT
    }

    pub(super) fn caption_fallback(&self, window: &Window) -> Option<TitleBar> {
        let needs_client_controls = cfg!(target_os = "windows")
            || (cfg!(target_os = "linux")
                && matches!(window.window_decorations(), Decorations::Client { .. }));
        (needs_client_controls && self.hides_titlebar(window) && !window.is_fullscreen())
            .then(TitleBar::new)
    }
}

fn find_descriptor(node: &Value) -> Option<&Value> {
    if node["type"] == "theme" {
        return node["chrome"]["window"]
            .as_object()
            .map(|_| &node["chrome"]["window"]);
    }
    node["children"]
        .as_array()?
        .iter()
        .take(2000)
        .find_map(find_descriptor)
}

#[cfg(target_os = "macos")]
fn default_traffic_lights() -> Point<Pixels> {
    TitleBar::title_bar_options()
        .traffic_light_position
        .unwrap_or_default()
}

/// AppKit's close/minimise/zoom buttons; GPUI only positions them.
#[cfg(target_os = "macos")]
fn set_window_buttons_hidden(window: &Window, hidden: bool) {
    use objc2_app_kit::{NSView, NSWindowButton};
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};

    let Ok(handle) = HasWindowHandle::window_handle(window) else { return };
    let RawWindowHandle::AppKit(appkit) = handle.as_raw() else { return };
    // SAFETY: GPUI's AppKit handle points at the window's live content NSView; we are on the main thread.
    let view: &NSView = unsafe { appkit.ns_view.cast::<NSView>().as_ref() };
    let Some(ns_window) = view.window() else { return };
    for kind in [NSWindowButton::NSWindowCloseButton, NSWindowButton::NSWindowMiniaturizeButton, NSWindowButton::NSWindowZoomButton] {
        if let Some(button) = ns_window.standardWindowButton(kind) {
            button.setHidden(hidden);
        }
    }
}

#[cfg(target_os = "macos")]
fn traffic_lights(descriptor: &Value) -> Option<Point<Pixels>> {
    let traffic = &descriptor["trafficLights"];
    let x = traffic["x"].as_f64()?;
    let y = traffic["y"].as_f64()?;
    Some(point(
        px(x.clamp(0., 4096.) as f32),
        px(y.clamp(0., 4096.) as f32),
    ))
}
