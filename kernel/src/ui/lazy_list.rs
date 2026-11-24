//! Lazily rendered scroll lists. A scrolling column (or `scroll` node) whose module supplies a
//! fixed `itemHeight` builds only the children inside its viewport, so long lists of ordinary
//! nodes cost the same per frame as a short one. Each child gets a fixed slot of
//! `itemHeight + gap`; taller content is clipped. Children render during layout, so they must not
//! contain frame-collected nodes such as `modal`, `floating` or `window`.
use super::*;
use std::ops::Range;

/// Upper bound on lazily rendered children; eager lists stop at 2000.
const MAX_ITEMS: usize = 100_000;

impl Shell {
    pub(super) fn lazy_list(&mut self, module: &str, n: &Value, path: &str, depth: usize, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        // One owned copy per module snapshot, shared by every frame until the module re-renders.
        let node = self.tree_nodes.entry((module.to_string(), path.to_string()))
            .or_insert_with(|| Arc::new(n.clone())).clone();
        let count = node["children"].as_array().map_or(0, |a| a.len().min(MAX_ITEMS));
        let gap = node["gap"].as_f64().unwrap_or(0.0).clamp(0.0, 64.0) as f32;
        let h = node["itemHeight"].as_f64().unwrap_or(24.0).clamp(8.0, 1024.0) as f32;
        let (module, path) = (module.to_string(), path.to_string());
        let id = sid(&module, &path);
        let handle = window.use_keyed_state((ElementId::from(id.clone()), "uniform-scroll-handle"), cx,
            |_, _| UniformListScrollHandle::new()).read(cx).clone();
        let viewport = uniform_list(id, count, cx.processor(move |this, range: Range<usize>, window, cx| {
            let kids = node["children"].as_array().map(Vec::as_slice).unwrap_or(&[]);
            range.filter_map(|i| kids.get(i)).map(|child| {
                let el = this.node(&module, child, &path, depth, window, cx);
                div().w_full().min_w_0().h(px(h + gap)).flex_none()
                    .child(v_flex().w_full().min_w_0().h(px(h)).overflow_hidden().justify_center().child(el))
                    .into_any_element()
            }).collect::<Vec<_>>()
        })).flex_1().min_h_0().w_full().track_scroll(&handle);
        let base_handle = handle.0.borrow().base_handle.clone();
        scroll_chain::chain(viewport, base_handle, |_, _, _| {})
    }
}
