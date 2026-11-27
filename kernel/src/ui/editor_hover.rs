//! Delayed editor hover events and interactive module-provided content.
use super::*;
use gpui_component::input::RopeExt;
use std::{
    cell::RefCell,
    ops::Range,
    rc::Rc,
    sync::atomic::{AtomicU64, Ordering},
};

#[derive(Clone, Default)]
struct EditorHover(Rc<RefCell<Option<HoverRequest>>>);

pub(super) struct HoverBinding {
    document: String,
    hover: EditorHover,
    events: HoverEvents,
}

struct HoverRequest {
    id: u64,
    range: Range<usize>,
    source: Bounds<Pixels>,
    anchor_x: Pixels,
    value: Value,
    sent: bool,
    popup: Option<Bounds<Pixels>>,
}

impl EditorHover {
    fn cancel(&self) -> Option<u64> {
        self.0
            .borrow_mut()
            .take()
            .filter(|request| request.sent)
            .map(|request| request.id)
    }
}

#[derive(Clone)]
struct HoverEvents {
    kernel: Arc<Kernel>,
    module: String,
    key: String,
    action: String,
    dismiss: String,
    shell: EntityId,
}

impl HoverEvents {
    fn dismiss(&self, hover: &EditorHover, cx: &mut App) -> bool {
        let Some(id) = hover.cancel() else {
            return false;
        };
        if !self.dismiss.is_empty() {
            Shell::fire(
                &self.kernel,
                &self.module,
                &[],
                &self.dismiss,
                &self.key,
                None,
                json!({"requestId": id}),
                cx,
            );
        }
        cx.notify(self.shell);
        true
    }
}

impl Shell {
    pub(super) fn editor_hover(
        &mut self,
        surface: Div,
        state: &Entity<EditorState>,
        module: &str,
        key: &str,
        path: &str,
        document: &str,
        n: &Value,
        depth: usize,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Div {
        let action = n["hoverAction"]
            .as_str()
            .filter(|action| !action.is_empty());
        let slot = (module.to_owned(), path.to_owned());
        let Some(action) = action else {
            if let Some(binding) = self.editor_hovers.remove(&slot) {
                binding.hover.cancel();
            }
            return surface;
        };
        self.rendered_editor_hovers.insert(slot.clone());
        let events = HoverEvents {
            kernel: self.kernel.clone(),
            module: module.to_owned(),
            key: key.to_owned(),
            action: action.to_owned(),
            dismiss: n["hoverDismissAction"]
                .as_str()
                .unwrap_or_default()
                .to_owned(),
            shell: cx.entity_id(),
        };
        let binding = self
            .editor_hovers
            .entry(slot)
            .or_insert_with(|| HoverBinding {
                document: document.to_owned(),
                hover: EditorHover::default(),
                events: events.clone(),
            });
        if binding.document != document || binding.events.action != action {
            binding.hover.cancel();
            binding.document = document.to_owned();
        }
        binding.events = events.clone();
        let hover = binding.hover.clone();
        let anchor = hover
            .0
            .borrow()
            .as_ref()
            .filter(|r| r.sent && n["hoverPopover"]["requestId"].as_u64() == Some(r.id))
            .map(|r| (r.id, r.source, r.anchor_x));
        let popup = anchor.and_then(|(id, source, anchor_x)| {
            let node = &n["hoverPopover"]["node"];
            node["type"].as_str()?;
            let card = self.node(
                module,
                node,
                &format!("{path}/hover"),
                depth + 1,
                window,
                cx,
            );
            let viewport = window.viewport_size();
            let measure = {
                let hover = hover.clone();
                canvas(
                    move |bounds, _, _| {
                        if let Some(request) = hover.0.borrow_mut().as_mut().filter(|r| r.id == id)
                        {
                            request.popup = Some(bounds);
                        }
                    },
                    |_, _, _, _| {},
                )
                .size_full()
            };
            let card = div()
                .id(sid(module, &format!("{path}/hover-content")))
                .relative()
                .occlude()
                .max_w((viewport.width - px(16.)).max(px(1.)))
                .max_h((viewport.height - px(16.)).max(px(1.)))
                .overflow_y_scroll()
                .child(div().absolute().inset_0().child(measure))
                .child(card);
            Some(deferred(
                anchored()
                    .position(point(anchor_x, source.bottom()))
                    .child(card),
            ))
        });
        if popup.is_none() {
            if let Some(request) = hover.0.borrow_mut().as_mut() {
                request.popup = None;
            }
        }
        let watcher = hover_watcher(
            state.clone(),
            hover.clone(),
            events.clone(),
            document.to_owned(),
        );
        surface
            .child(watcher)
            .children(popup)
            .capture_key_down(move |ev, window, cx| {
                if ev.keystroke.key == "escape" && events.dismiss(&hover, cx) {
                    window.prevent_default();
                    cx.stop_propagation();
                }
            })
    }

    pub(super) fn dismiss_open_editor_hover(&self, cx: &mut App) -> bool {
        self.editor_hovers.values().any(|binding| {
            let open = binding
                .hover
                .0
                .borrow()
                .as_ref()
                .is_some_and(|r| r.popup.is_some());
            open && binding.events.dismiss(&binding.hover, cx)
        })
    }

    pub(super) fn prune_editor_hovers(&mut self) {
        self.editor_hovers.retain(|slot, binding| {
            let keep = self.rendered_editor_hovers.contains(slot);
            if !keep {
                binding.hover.cancel();
            }
            keep
        });
    }
}

fn hover_watcher(
    state: Entity<EditorState>,
    hover: EditorHover,
    events: HoverEvents,
    document: String,
) -> impl IntoElement {
    div().absolute().inset_0().child(canvas(
        |bounds, window, _| window.insert_hitbox(bounds, HitboxBehavior::Normal),
        move |_, hitbox, window, _| {
            let (hover, events) = (hover.clone(), events.clone());
            window.on_mouse_event({
                let (hover, events) = (hover.clone(), events.clone());
                move |_: &MouseExitEvent, phase, _, cx| {
                    if phase.capture() { events.dismiss(&hover, cx); }
                }
            });
            window.on_mouse_event({
                let (hover, events) = (hover.clone(), events.clone());
                move |event: &ScrollEvent, phase, _, cx| {
                    if phase.capture() && !hover.0.borrow().as_ref().and_then(|r| r.popup).is_some_and(|b| b.contains(&event.position)) {
                        events.dismiss(&hover, cx);
                    }
                }
            });
            window.on_mouse_event({
                let (hover, events) = (hover.clone(), events.clone());
                move |event: &MouseDownEvent, phase, _, cx| {
                    if phase.capture() && !hover.0.borrow().as_ref().and_then(|r| r.popup).is_some_and(|b| b.contains(&event.position)) {
                        events.dismiss(&hover, cx);
                    }
                }
            });
            window.on_mouse_event(move |event: &MouseMoveEvent, phase, window, cx| {
                if !phase.capture() { return; }
                let at = event.position;
                let inside_popup = hover.0.borrow().as_ref().and_then(|r| r.popup).is_some_and(|b| b.contains(&at));
                if inside_popup { return; }
                let editor = state.read(cx);
                let offset = (hitbox.is_hovered(window) && event.pressed_button.is_none())
                    .then(|| editor.text_offset_at(at)).flatten();
                if offset.is_some_and(|offset| hover.0.borrow().as_ref().is_some_and(|r| r.range.contains(&offset) && r.source.contains(&at))) {
                    return;
                }
                events.dismiss(&hover, cx);
                let Some(offset) = offset else { return };
                let editor = state.read(cx);
                let rope = editor.text();
                if offset >= rope.len() { return; }
                let range = rope.word_range(offset).filter(|r| r.contains(&offset))
                    .unwrap_or_else(|| offset..offset + rope.chars_at(offset).next().map_or(0, char::len_utf8));
                let text = rope.slice(range.clone()).to_string();
                if text.trim().is_empty() { return; }
                let Some(source) = editor.range_to_bounds(&range) else { return };
                let source = if source.contains(&at) { source } else {
                    let Some(glyph) = editor.range_to_bounds(&(offset..offset)) else { return };
                    Bounds::new(point(at.x - px(3.), glyph.top()), size(px(6.), glyph.size.height))
                };
                // Rope positions are bytes. Module strings and editor protocol positions are UTF-16.
                let line = rope.offset_to_point(offset).row;
                let utf16 = |end| rope.byte_to_utf16_idx(end);
                let units = utf16(offset);
                let origin = editor.input_bounds().origin;
                static NEXT_ID: AtomicU64 = AtomicU64::new(1);
                let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
                *hover.0.borrow_mut() = Some(HoverRequest {
                    id, range: range.clone(), source, anchor_x: at.x,
                    value: json!({
                        "requestId": id, "document": document, "offset": units, "line": line,
                        "column": units - utf16(rope.line_start_offset(line)),
                        "range": {"start": utf16(range.start), "end": utf16(range.end)}, "text": text,
                        "x": f32::from(at.x - origin.x), "y": f32::from(at.y - origin.y),
                    }),
                    sent: false, popup: None,
                });
                let (hover, events) = (hover.clone(), events.clone());
                cx.spawn(async move |cx| {
                    cx.background_executor().timer(Duration::from_millis(350)).await;
                    let _ = cx.update(|cx| {
                        let mut current = hover.0.borrow_mut();
                        let Some(request) = current.as_mut().filter(|r| r.id == id) else { return };
                        request.sent = true;
                        Shell::fire(&events.kernel, &events.module, &[], &events.action, &events.key, None, request.value.clone(), cx);
                    });
                }).detach();
            });
        },
    ).size_full())
}

#[cfg(all(test, feature = "snapshot"))]
mod tests {
    use super::Shell;
    use crate::{bridge::UiBridge, config::Config, kernel::Kernel, ops::Document};
    use gpui::{
        point, px, size, Bounds, Modifiers, MouseButton, Pixels, ScrollDelta, ScrollEvent,
        ScrollSource, TestAppContext, TouchPhase, VisualTestContext,
    };
    use gpui_kit as gpui;
    use serde_json::json;
    use std::{
        sync::Arc,
        time::{Duration, Instant},
    };

    #[gpui_kit::test]
    fn hover_tree_scrolls_and_dispatches_row_key_without_dismissing(cx: &mut TestAppContext) {
        cx.update(gpui_kit::init);
        let temp = tempfile::tempdir().unwrap();
        let cfg = Config {
            repo_root: temp.path().to_owned(),
            data_dir: temp.path().join("data"),
            initial_root: None,
            initial_root_explicit: false,
            safe_mode: false,
            dev_watch: false,
            headless: false,
            headless_script: None,
            snapshot: None,
        };
        std::fs::create_dir_all(cfg.repo_root.join("Hato-plugins/modules")).unwrap();
        let module_dir = cfg.modules_dir().join("ui/probe");
        let build_dir = cfg.seed_dir();
        std::fs::create_dir_all(&module_dir).unwrap();
        std::fs::create_dir_all(&build_dir).unwrap();
        std::fs::write(module_dir.join("manifest.json"), r#"{"schemaVersion":2,"id":"probe","kind":"ui","entry":"src/index.ts","moduleApiVersion":1}"#).unwrap();
        let (bridge, mut rx) = UiBridge::new();
        let kernel = Kernel::new(cfg, bridge).unwrap();
        let document = kernel.handles.insert(
            "document",
            "probe",
            "demo.ts",
            Arc::new(Document {
                workspace_key: "test".into(),
                path: "demo.ts".into(),
                language: "typescript".into(),
                text: "object.field".into(),
                created_ms: 0,
            }),
        );
        let seed = r#"
            let request, rowKey;
            export default {
                id: 'probe', moduleApiVersion: 1,
                onEvent(_, event) {
                    if (event.action === 'hover') request = event.value.requestId;
                    if (event.action === 'expand') rowKey = event.rowKey;
                    if (event.action === 'dismiss') request = null;
                },
                render() {
                    const rows = Array.from({ length: 40 }, (_, i) => ({
                        key: 'row-' + i, label: 'Variable ' + i, value: '42',
                        depth: 0, expandable: true, expanded: rowKey === 'row-' + i, selected: false,
                    }));
                    if (rowKey) rows.splice(rows.findIndex(row => row.key === rowKey) + 1, 0, {
                        key: 'child', label: 'Expanded child', depth: 1, expandable: false,
                    });
                    return { type: 'codeViewer', key: 'editor', document: DOCUMENT, hoverAction: 'hover',
                        hoverDismissAction: 'dismiss', hoverPopover: request ? { requestId: request,
                            node: { type: 'column', key: 'card', width: 360, children: [
                                { type: 'tree', key: 'fields', rows, rowHeight: 22, rowGap: 0, height: 236,
                                  selectAction: '', expandAction: 'expand' },
                            ] },
                        } : undefined };
                },
            };
        "#.replace("DOCUMENT", &json!(document).to_string());
        std::fs::write(build_dir.join("probe.mjs"), seed).unwrap();
        kernel.boot();
        assert!(
            kernel.router.active("probe").is_some(),
            "{:?}",
            kernel.router.last_error("probe")
        );
        kernel.request_render("probe");

        let window = cx.open_window(size(px(720.), px(480.)), |window, cx| {
            window.activate_window();
            let mut shell = Shell::new(kernel.clone(), UiBridge::new().1, window, cx);
            shell.only_module = Some("probe".into());
            shell
        });
        let executor = cx.executor();
        let mut cx = VisualTestContext::from_window(window.into(), cx);
        // Feed worker messages on the GPUI test thread.
        let draw =
            |cx: &mut VisualTestContext,
             rx: &mut futures::channel::mpsc::UnboundedReceiver<crate::bridge::UiMsg>| {
                while let Ok(msg) = rx.try_recv() {
                    window
                        .update(cx, |shell, window, cx| shell.on_msg(msg, window, cx))
                        .unwrap();
                }
                cx.run_until_parked();
                cx.update(|window, cx| window.draw(cx).clear(cx));
            };
        let wait_for =
            |cx: &mut VisualTestContext,
             rx: &mut futures::channel::mpsc::UnboundedReceiver<crate::bridge::UiMsg>,
             stage: &str,
             probe: &mut dyn FnMut(&mut VisualTestContext) -> Option<Bounds<Pixels>>| {
                let start = Instant::now();
                loop {
                    draw(cx, rx);
                    if let Some(bounds) = probe(cx) {
                        break bounds;
                    }
                    assert!(
                        start.elapsed() < Duration::from_secs(2),
                        "expected bounds were never rendered ({stage})"
                    );
                    std::thread::sleep(Duration::from_millis(5));
                }
            };
        let symbol = wait_for(&mut cx, &mut rx, "editor", &mut |cx| {
            window
                .update(cx, |shell, _, cx| {
                    shell
                        .editors
                        .get(&document)?
                        .0
                        .read(cx)
                        .range_to_bounds(&(0..6))
                })
                .unwrap()
        });
        cx.simulate_mouse_move(symbol.center(), None, Modifiers::default());
        window
            .update(&mut cx, |shell, _, cx| {
                let state = shell.editors.get(&document).unwrap().0.read(cx);
                assert!(
                    state.text_offset_at(symbol.center()).is_some(),
                    "hover point {symbol:?} missed the glyph"
                );
                assert!(
                    shell
                        .editor_hovers
                        .values()
                        .next()
                        .unwrap()
                        .hover
                        .0
                        .borrow()
                        .is_some(),
                    "pointer motion did not create a hover request"
                );
            })
            .unwrap();
        executor.advance_clock(Duration::from_millis(400));

        let popup_bounds = |cx: &mut VisualTestContext| {
            window
                .update(cx, |shell, _, _| {
                    shell
                        .editor_hovers
                        .values()
                        .next()?
                        .hover
                        .0
                        .borrow()
                        .as_ref()?
                        .popup
                })
                .unwrap()
        };
        let popup = wait_for(&mut cx, &mut rx, "initial hover", &mut |cx| {
            popup_bounds(cx)
        });
        assert_eq!(popup.size, size(px(360.), px(236.)));
        let row = popup.origin + point(px(10.), px(11.));
        cx.simulate_mouse_move(row, None, Modifiers::default());
        cx.simulate_event(ScrollEvent {
            position: row,
            delta: ScrollDelta::Pixels(point(px(0.), px(-180.))),
            modifiers: Modifiers::default(),
            touch_phase: TouchPhase::Moved,
            source: ScrollSource::default(),
        });
        draw(&mut cx, &mut rx);
        cx.simulate_mouse_down(row, MouseButton::Left, Modifiers::default());
        cx.simulate_mouse_up(row, MouseButton::Left, Modifiers::default());

        wait_for(&mut cx, &mut rx, "expanded hover", &mut |cx| {
            window
                .update(cx, |shell, _, _| {
                    let rows = shell
                        .trees
                        .get("probe")?
                        .get("hoverPopover")?
                        .get("node")?
                        .get("children")?
                        .get(0)?
                        .get("rows")?
                        .as_array()?;
                    let index = rows.iter().position(|row| row["key"] == "child")?;
                    assert!(
                        index > 1,
                        "the click reached the first row despite scrolling"
                    );
                    shell
                        .editor_hovers
                        .values()
                        .next()?
                        .hover
                        .0
                        .borrow()
                        .as_ref()?
                        .popup
                })
                .unwrap()
        });
        assert_eq!(popup_bounds(&mut cx), Some(popup));
        cx.simulate_mouse_move(point(px(710.), px(470.)), None, Modifiers::default());
        draw(&mut cx, &mut rx);
        assert_eq!(popup_bounds(&mut cx), None);
        kernel.shutdown();
    }
}
