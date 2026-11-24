//! Window presentation requested by the active root tree.
use super::*;
use std::sync::Weak;

pub(super) struct WindowChrome {
    owner: WindowId,
    hidden: bool,
    source: Option<Weak<Value>>,
    #[cfg(target_os = "macos")]
    traffic_lights: Point<Pixels>,
}

impl WindowChrome {
    pub(super) fn new(window: &Window) -> Self {
        Self {
            owner: window.window_handle().window_id(),
            hidden: false,
            source: None,
            #[cfg(target_os = "macos")]
            traffic_lights: default_traffic_lights(),
        }
    }

    pub(super) fn update(&mut self, tree: Option<&Arc<Value>>, window: &Window, _cx: &mut App) {
        let unchanged = match (self.source.as_ref(), tree) {
            (Some(previous), Some(tree)) => std::ptr::eq(previous.as_ptr(), Arc::as_ptr(tree)),
            (None, None) => true,
            _ => false,
        };
        if unchanged {
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
        }
        #[cfg(not(target_os = "macos"))]
        let _ = window;
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
