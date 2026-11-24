use super::{Config, Kernel, Shell, UiBridge, UiMsg};
use gpui_kit::{
    self as gpui, px, rgb, size, Bounds, ScaledPixels, TestAppContext, VisualTestContext,
};
use serde_json::{json, Value};
use std::{
    sync::Arc,
    time::{Duration, Instant},
};

const SLOT_NEIGHBOUR: u32 = 0x5173d9;
const FOLLOWING_ROW: u32 = 0x73bc65;
const MARKER: u32 = 0xf8a231;
const INSERTED: u32 = 0xd25177;

fn background(color: u32) -> String {
    format!("#{color:06x}")
}

fn tree(expanded: bool, mode: &str) -> Arc<Value> {
    let layout = json!({"durationMs":240,"easing":[0.22,1,0.36,1]});
    let indicator = json!({
        "type":"column","key":"marker","layoutId":"shared","layoutTransition":layout,
        "style":{"position":"absolute","left":-5,"top":4,"width":3,"height":14,"background":background(MARKER)},
        "children":[]
    });
    let none = Vec::new();
    let mut items = vec![
        json!({"type":"row","key":"first","height":30,"style":{"position":"relative"},
            "children": if !expanded { vec![indicator.clone()] } else { none.clone() }}),
        json!({"type":"row","key":"second","height":30,"style":{"position":"relative"},
            "children": if expanded { vec![indicator] } else { none }}),
    ];
    if expanded {
        items.push(json!({
            "type":"column","key":"insert","height":40,
            "style":{"background":background(INSERTED)},
            "presence":{"enter":{"durationMs":240,"easing":[0.22,1,0.36,1],"opacity":0,"heightCollapse":true},
                "exit":{"durationMs":240,"easing":[0.22,1,0.36,1],"opacity":0,"heightCollapse":true}},
            "presenceDelayMs":16,
            "children":[{"type":"label","key":"text","text":"Nested","conceal":{"effect":"scramble"}}]
        }));
    }
    items.push(json!({"type":"column","key":"last","height":12,"style":{"background":background(FOLLOWING_ROW)},"children":[]}));
    Arc::new(json!({"type":"column","key":"root","grow":true,"children":[
        {"type":"theme","key":"theme","motion":{"mode":mode}},
        {"type":"row","key":"layout","height":80,"align":"stretch","children":[
            {"type":"slot","key":"slot","module":"__node-motion-content",
                "width":if expanded {216} else {52},"layoutTransition":layout},
            {"type":"column","key":"neighbour","width":80,"style":{"background":background(SLOT_NEIGHBOUR)},"children":[]}
        ]},
        {"type":"column","key":"body","style":{"paddingX":12,"clip":false},"children":items}
    ]}))
}

fn bounds(cx: &mut VisualTestContext, color: u32) -> Option<Bounds<ScaledPixels>> {
    cx.update(|window, _| {
        window
            .painted_quads()
            .into_iter()
            .find(|quad| quad.background == rgb(color).into())
            .map(|quad| quad.bounds)
    })
}

fn draw(cx: &mut VisualTestContext) {
    cx.update(|window, app| {
        window.draw(app).clear(app);
    });
}

#[gpui::test]
fn nodes_interpolate_layout_and_keep_exits_until_they_settle(cx: &mut TestAppContext) {
    cx.update(gpui_kit::init);
    let temp = tempfile::tempdir().unwrap();
    let config = Config::from_args(&[
        "hato".into(),
        "--repo-root".into(),
        temp.path().display().to_string(),
        "--data-dir".into(),
        temp.path().join("data").display().to_string(),
    ])
    .unwrap();
    let kernel = Kernel::new(config, UiBridge::disconnected()).unwrap();
    let window = cx.open_window(size(px(480.), px(320.)), |window, cx| {
        let mut shell = Shell::new(kernel.clone(), UiBridge::new().1, window, cx);
        shell.only_module = Some("__snapshot".into());
        shell.trees.insert("__snapshot".into(), tree(false, "on"));
        shell.trees.insert(
            "__node-motion-content".into(),
            Arc::new(json!({
                "type":"column","key":"content","grow":true,"children":[
                    {"type":"label","key":"label","text":"Width"}
                ]
            })),
        );
        shell
    });
    let clock = cx.executor();
    let mut visual = VisualTestContext::from_window(window.into(), cx);
    let set = |expanded, mode, visual: &mut VisualTestContext| {
        visual.update(|window, cx| {
            window
                .root::<Shell>()
                .unwrap()
                .unwrap()
                .update(cx, |shell, cx| {
                    shell.on_msg(
                        UiMsg::Tree {
                            module: "__snapshot".into(),
                            tree: tree(expanded, mode),
                            generation: 0,
                        },
                        window,
                        cx,
                    );
                });
        });
        draw(visual);
    };
    draw(&mut visual);
    let old_neighbour = bounds(&mut visual, SLOT_NEIGHBOUR).unwrap().origin.x;
    let old_marker = bounds(&mut visual, MARKER).unwrap().origin;
    let old_follower = bounds(&mut visual, FOLLOWING_ROW).unwrap().origin.y;
    set(true, "on", &mut visual);
    assert_eq!(
        old_neighbour,
        bounds(&mut visual, SLOT_NEIGHBOUR).unwrap().origin.x
    );
    assert_eq!(old_marker, bounds(&mut visual, MARKER).unwrap().origin);

    let mut samples = Vec::new();
    for _ in 0..5 {
        clock.advance_clock(Duration::from_secs_f64(1. / 60.));
        let start = Instant::now();
        draw(&mut visual);
        samples.push(start.elapsed());
    }
    let mid_neighbour = bounds(&mut visual, SLOT_NEIGHBOUR).unwrap().origin.x;
    let mid_marker = bounds(&mut visual, MARKER).unwrap().origin;
    let mid_follower = bounds(&mut visual, FOLLOWING_ROW).unwrap().origin.y;
    clock.advance_clock(Duration::from_millis(260));
    draw(&mut visual);
    let end_follower = bounds(&mut visual, FOLLOWING_ROW).unwrap().origin.y;
    assert!(
        old_neighbour < mid_neighbour
            && mid_neighbour < bounds(&mut visual, SLOT_NEIGHBOUR).unwrap().origin.x
    );
    assert!(
        old_marker.y < mid_marker.y && mid_marker.y < bounds(&mut visual, MARKER).unwrap().origin.y
    );
    assert_eq!(mid_marker.x, old_marker.x);
    assert!(old_follower < mid_follower && mid_follower < end_follower);
    assert!(bounds(&mut visual, INSERTED).is_some());

    set(false, "on", &mut visual);
    assert_eq!(
        bounds(&mut visual, FOLLOWING_ROW).unwrap().origin.y,
        end_follower
    );
    clock.advance_clock(Duration::from_millis(120));
    draw(&mut visual);
    let exiting_follower = bounds(&mut visual, FOLLOWING_ROW).unwrap().origin.y;
    assert!(old_follower < exiting_follower && exiting_follower < end_follower);
    clock.advance_clock(Duration::from_millis(180));
    draw(&mut visual);
    assert!(bounds(&mut visual, INSERTED).is_none());
    assert_eq!(
        bounds(&mut visual, FOLLOWING_ROW).unwrap().origin.y,
        old_follower
    );

    set(true, "reduced", &mut visual);
    assert!(bounds(&mut visual, SLOT_NEIGHBOUR).unwrap().origin.x > mid_neighbour);
    assert_eq!(
        bounds(&mut visual, FOLLOWING_ROW).unwrap().origin.y,
        end_follower
    );
    set(false, "off", &mut visual);
    assert_eq!(
        bounds(&mut visual, SLOT_NEIGHBOUR).unwrap().origin.x,
        old_neighbour
    );
    assert_eq!(
        bounds(&mut visual, FOLLOWING_ROW).unwrap().origin.y,
        old_follower
    );
    eprintln!("Native node CPU draw samples at simulated 60 Hz: {samples:?}");
    kernel.shutdown();
}

const POPOVER_MARKER: u32 = 0xa041b8;
const CONTENT_MARKER: u32 = 0x1537e0;

#[gpui::test]
fn popovers_fit_the_nearest_scope_and_preserve_explicit_window_insets(cx: &mut TestAppContext) {
    cx.update(gpui_kit::init);
    let temp = tempfile::tempdir().unwrap();
    let config = Config::from_args(&[
        "hato".into(),
        "--repo-root".into(),
        temp.path().display().to_string(),
        "--data-dir".into(),
        temp.path().join("data").display().to_string(),
    ])
    .unwrap();
    let kernel = Kernel::new(config, UiBridge::disconnected()).unwrap();
    let window = cx.open_window(size(px(500.), px(350.)), |window, cx| {
        let mut shell = Shell::new(kernel.clone(), UiBridge::new().1, window, cx);
        shell.only_module = Some("__snapshot".into());
        shell.trees.insert("__snapshot".into(), Arc::new(json!({
            "type":"column","key":"root","grow":true,"children":[
                {"type":"titleBar","key":"native-title","children":[]},
                {"type":"row","key":"body","grow":true,"align":"stretch","style":{"background":background(CONTENT_MARKER)},"children":[
                    {"type":"column","key":"spacer","width":90,"children":[]},
                    {"type":"slot","key":"slot","width":260,"module":"__popover-test"}
                ]},
                {"type":"theme","key":"theme","motion":{"mode":"off"},"chrome":{"window":{"titlebar":"hidden","trafficLights":{"x":22,"y":22}}}}
            ]
        })));
        shell
    });
    let mut visual = VisualTestContext::from_window(window.into(), cx);
    let set_popover = |relative: bool, props: Value, visual: &mut VisualTestContext| {
        let mut popover = json!({
            "type":"popover","key":"popup","top":8,"closeAction":"close",
            "transition":{"enter":{"durationMs":200,"easing":[0.2,0,0,1],"opacity":0}},
            "style":{"background":background(POPOVER_MARKER)},"children":[]
        });
        popover
            .as_object_mut()
            .unwrap()
            .extend(props.as_object().unwrap().clone());
        let inner = if relative {
            json!({"type":"column","key":"local","width":170,"height":220,"style":{"position":"relative"},"children":[
                {"type":"column","key":"intermediate","children":[popover]}
            ]})
        } else {
            json!({"type":"column","key":"intermediate","grow":true,"children":[popover]})
        };
        visual.update(|window, cx| {
            window.root::<Shell>().unwrap().unwrap().update(cx, |shell, cx| {
                shell.on_msg(UiMsg::Tree {
                    module: "__popover-test".into(),
                    generation: 0,
                    tree: Arc::new(json!({"type":"column","key":"root","grow":true,"children":[inner]})),
                }, window, cx);
            });
        });
        draw(visual);
        draw(visual);
        bounds(visual, POPOVER_MARKER).unwrap()
    };
    let relative = set_popover(true, json!({}), &mut visual);
    let slot = set_popover(false, json!({"transition":null}), &mut visual);
    let fixed = set_popover(
        true,
        json!({"anchorScope":"container","width":380,"left":8}),
        &mut visual,
    );
    let right = set_popover(
        true,
        json!({"anchorScope":"container","width":100,"right":12}),
        &mut visual,
    );
    let limited = set_popover(
        true,
        json!({"anchorScope":"container","width":380,"left":8,"right":12}),
        &mut visual,
    );
    let window = set_popover(true, json!({"width":100,"left":8}), &mut visual);
    let point_anchored = set_popover(
        true,
        json!({"windowAnchor":{"x":24,"y":36},"anchorScope":"container","width":100,"height":40}),
        &mut visual,
    );
    let scale = visual.update(|window, _| window.scale_factor());
    assert_eq!(point_anchored.origin.x, px(24.).scale(scale));
    assert_eq!(limited.size.width, px(150.).scale(scale));
    assert_eq!(relative.origin.x, slot.origin.x);
    assert_eq!(relative.origin.x, fixed.origin.x);
    assert_eq!(slot.origin.x - window.origin.x, px(90.).scale(scale));
    assert_eq!(relative.size.width, px(154.).scale(scale));
    assert_eq!(slot.size.width, px(244.).scale(scale));
    assert_eq!(fixed.size.width, px(162.).scale(scale));
    assert_eq!(right.size.width, px(100.).scale(scale));
    assert_eq!(right.origin.x - relative.origin.x, px(50.).scale(scale));
    if cfg!(target_os = "macos") {
        assert_eq!(
            bounds(&mut visual, CONTENT_MARKER).unwrap().origin.y,
            px(0.).scale(scale)
        );
    }
    kernel.shutdown();
}

#[gpui::test]
fn nested_viewports_scroll_before_the_page_and_yield_at_edges(cx: &mut TestAppContext) {
    use gpui_kit::{point, ScrollDelta, ScrollEvent};

    const PAGE: u32 = 0x647ade;
    const INNER: u32 = 0xda4f5f;
    cx.update(gpui_kit::init);
    let temp = tempfile::tempdir().unwrap();
    let config = Config::from_args(&[
        "hato".into(),
        "--repo-root".into(),
        temp.path().display().to_string(),
        "--data-dir".into(),
        temp.path().join("data").display().to_string(),
    ])
    .unwrap();
    let kernel = Kernel::new(config, UiBridge::disconnected()).unwrap();

    for (kind, lazy) in [
        ("transcript", false),
        ("column", false),
        ("scroll", false),
        ("column", true),
        ("scroll", true),
    ] {
        let items = (0..5).map(|key| json!({
            "type":"column","key":format!("item-{key}"),"height":56,"style":{"background":background(INNER)},
            "children":[{"type":"label","key":"text","text":"Selectable text","selectable":true}]
        })).collect::<Vec<_>>();
        let mut inner = json!({"type":kind,"key":"inner","grow":true,"children":items});
        if kind == "column" {
            inner["scroll"] = json!(true);
        }
        if lazy {
            inner["itemHeight"] = json!(56);
        }
        let tree = json!({"type":"column","key":"page","scroll":true,"grow":true,"children":[
            {"type":"column","key":"lead","height":90,"style":{"background":background(PAGE)},"children":[]},
            {"type":"column","key":"viewport","height":84,"children":[inner]},
            {"type":"column","key":"tail","height":420,"children":[]}
        ]});
        let window = cx.open_window(size(px(370.), px(260.)), |window, cx| {
            let mut shell = Shell::new(kernel.clone(), UiBridge::new().1, window, cx);
            shell.only_module = Some("__snapshot".into());
            shell.trees.insert("__snapshot".into(), Arc::new(tree));
            shell
        });
        let mut visual = VisualTestContext::from_window(window.into(), cx);
        draw(&mut visual);
        let scale = visual.update(|window, _| window.scale_factor());
        let scroll = |visual: &mut VisualTestContext, y, dy| {
            visual.simulate_event(ScrollEvent {
                position: point(px(60.), px(y)),
                delta: ScrollDelta::Pixels(point(px(0.), px(dy))),
                ..Default::default()
            });
            draw(visual);
        };
        scroll(&mut visual, 215., -24.);
        let page = bounds(&mut visual, PAGE).unwrap().origin.y;
        assert_eq!(
            page,
            px(-24.).scale(scale),
            "{kind}, lazy={lazy}: outer-only wheel"
        );
        let inside = bounds(&mut visual, INNER).unwrap().origin.y;
        let movement = if kind == "transcript" { 12. } else { -12. };
        scroll(&mut visual, 110., movement);
        assert_eq!(
            page,
            bounds(&mut visual, PAGE).unwrap().origin.y,
            "{kind}, lazy={lazy}: the inner viewport consumed the wheel"
        );
        assert_eq!(
            bounds(&mut visual, INNER).unwrap().origin.y - inside,
            px(movement).scale(scale),
            "{kind}, lazy={lazy}: inner content moved"
        );

        scroll(&mut visual, 110., -movement * 5.);
        assert_eq!(
            page,
            bounds(&mut visual, PAGE).unwrap().origin.y,
            "{kind}, lazy={lazy}: the inner viewport reached its edge"
        );
        scroll(&mut visual, 110., -movement);
        assert_eq!(
            bounds(&mut visual, PAGE).unwrap().origin.y - page,
            px(-movement).scale(scale),
            "{kind}, lazy={lazy}: the outer viewport took over at the edge"
        );
    }
    kernel.shutdown();
}

#[gpui::test]
fn absolute_row_children_keep_their_insets_and_paint_over_flow(cx: &mut TestAppContext) {
    const OUTER: u32 = 0xd4dbed;
    const INNER: u32 = 0x762fe0;
    cx.update(gpui_kit::init);
    let temp = tempfile::tempdir().unwrap();
    let config = Config::from_args(&[
        "hato".into(),
        "--repo-root".into(),
        temp.path().display().to_string(),
        "--data-dir".into(),
        temp.path().join("data").display().to_string(),
    ])
    .unwrap();
    let kernel = Kernel::new(config, UiBridge::disconnected()).unwrap();
    let window = cx.open_window(size(px(100.), px(100.)), |window, cx| {
        let mut shell = Shell::new(kernel.clone(), UiBridge::new().1, window, cx);
        shell.only_module = Some("__snapshot".into());
        shell.trees.insert("__snapshot".into(), Arc::new(json!({
            "type":"column","key":"root","padding":12,"children":[
                {"type":"row","key":"rings","style":{"position":"relative","width":26,"height":26},"children":[
                    {"type":"ring","key":"inner","size":16,"thickness":2,"value":4,"max":5,"color":"primary","trackColor":"muted",
                     "style":{"position":"absolute","left":5,"top":5,"background":background(INNER)}},
                    {"type":"ring","key":"outer","size":26,"thickness":2.5,"value":3,"max":5,"color":"primary","trackColor":"muted",
                     "style":{"background":background(OUTER)}}
                ]}
            ]
        })));
        shell
    });
    let mut visual = VisualTestContext::from_window(window.into(), cx);
    draw(&mut visual);
    visual.update(|window, _| {
        let scene = window.painted_quads();
        let outer = scene
            .iter()
            .find(|quad| quad.background == rgb(OUTER).into())
            .unwrap();
        let inner = scene
            .iter()
            .find(|quad| quad.background == rgb(INNER).into())
            .unwrap();
        let scale = window.scale_factor();
        assert_eq!(outer.bounds.size.width, px(26.).scale(scale));
        assert_eq!(inner.bounds.size.width, px(16.).scale(scale));
        assert_eq!(
            inner.bounds.origin.x - outer.bounds.origin.x,
            px(5.).scale(scale)
        );
        assert_eq!(
            inner.bounds.origin.y - outer.bounds.origin.y,
            px(5.).scale(scale)
        );
        assert!(inner.order > outer.order);
    });
    kernel.shutdown();
}

#[gpui::test]
fn settled_intrinsic_rows_paint_absolute_children_into_scroll_lane_padding(
    cx: &mut TestAppContext,
) {
    cx.update(gpui_kit::init);
    let temp = tempfile::tempdir().unwrap();
    let config = Config::from_args(&[
        "hato".into(),
        "--repo-root".into(),
        temp.path().display().to_string(),
        "--data-dir".into(),
        temp.path().join("data").display().to_string(),
    ])
    .unwrap();
    let kernel = Kernel::new(config, UiBridge::disconnected()).unwrap();
    let window = cx.open_window(size(px(240.), px(160.)), |window, cx| {
        let mut shell = Shell::new(kernel.clone(), UiBridge::new().1, window, cx);
        shell.only_module = Some("__snapshot".into());
        let layout = json!({"durationMs":240,"easing":[0.2,0,0,1]});
        let indicator = json!({
            "type":"column","key":"indicator","layoutId":"active-indicator",
            "layoutTransition":layout,
            "style":{"position":"absolute","left":-6,"top":9,"width":3,"height":14,"background":background(MARKER)},
            "children":[]
        });
        let row = json!({
            "type":"row","key":"active","action":"activate","layoutTransition":layout,
            "presence":{"enter":{"durationMs":160,"easing":[0.2,0,0,1],"opacity":0}},
            "style":{"position":"relative","minHeight":32,"radius":8,"background":background(CONTENT_MARKER)},
            "hoverStyle":{"background":background(CONTENT_MARKER)},
            "children":[{"type":"label","key":"label","text":"Active"},indicator]
        });
        shell.trees.insert("__snapshot".into(), Arc::new(json!({
            "type":"column","key":"root","grow":true,"style":{"padding":8},"children":[
                {"type":"theme","key":"theme","motion":{"mode":"on"}},
                {"type":"column","key":"viewport","grow":true,"scroll":true,"children":[
                    {"type":"column","key":"lane","style":{"paddingX":6,"clip":false},"children":[row]}
                ]}
            ]
        })));
        shell
    });
    let clock = cx.executor();
    let mut visual = VisualTestContext::from_window(window.into(), cx);
    draw(&mut visual);
    clock.advance_clock(Duration::from_millis(300));
    draw(&mut visual);
    visual.update(|window, _| {
        let scene = window.painted_quads();
        let row = scene
            .iter()
            .find(|quad| quad.background == rgb(CONTENT_MARKER).into())
            .unwrap();
        let indicator = scene
            .iter()
            .find(|quad| quad.background == rgb(MARKER).into())
            .expect("indicator paints outside the row in the viewport's lane padding");
        let scale = window.scale_factor();
        assert_eq!(indicator.bounds.size, size(px(3.), px(14.)).scale(scale));
        assert_eq!(
            row.bounds.origin.x - indicator.bounds.origin.x,
            px(6.).scale(scale)
        );
        assert_eq!(
            indicator.content_mask.bounds.origin.x,
            indicator.bounds.origin.x
        );
    });
    kernel.shutdown();
}

#[gpui::test]
fn clickable_containers_block_selection_from_chrome_but_keep_selectable_labels(
    cx: &mut TestAppContext,
) {
    use gpui_kit::{
        base::{Root, TextSelection},
        point, AppContext, Modifiers, MouseButton,
    };

    cx.update(gpui_kit::init);
    let temp = tempfile::tempdir().unwrap();
    let config = Config::from_args(&[
        "hato".into(),
        "--repo-root".into(),
        temp.path().display().to_string(),
        "--data-dir".into(),
        temp.path().join("data").display().to_string(),
    ])
    .unwrap();
    let kernel = Kernel::new(config, UiBridge::disconnected()).unwrap();
    let window = cx.open_window(size(px(320.), px(160.)), |window, cx: &mut gpui::Context<Root>| {
        let shell = cx.new(|cx| {
            let mut shell = Shell::new(kernel.clone(), UiBridge::new().1, window, cx);
        shell.only_module = Some("__snapshot".into());
        shell.trees.insert("__snapshot".into(), Arc::new(json!({
            "type":"column","key":"root","grow":true,"children":[
                {"type":"theme","key":"theme","motion":{"mode":"on","interaction":{"durationMs":120,"easing":[0.2,0,0,1]}}},
                {"type":"row","key":"row","height":32,"action":"click","hoverStyle":{"background":"hover"},"children":[
                    {"type":"label","key":"plain","text":"Ordinary row text"}
                ]},
                {"type":"column","key":"column","height":32,"action":"click","hoverStyle":{"background":"hover"},"children":[
                    {"type":"label","key":"plain","text":"Ordinary column text"}
                ]},
                {"type":"row","key":"with-opt-in","height":32,"action":"click","hoverStyle":{"background":"hover"},"children":[
                    {"type":"label","key":"selected","text":"Explicitly selectable","selectable":true}
                ]}
            ]
        })));
            shell
        });
        Root::new(shell, window, cx)
    });
    let mut visual = VisualTestContext::from_window(window.into(), cx);
    draw(&mut visual);
    let drag = |visual: &mut VisualTestContext, y| {
        visual.simulate_mouse_down(
            point(px(2.), px(y)),
            MouseButton::Left,
            Modifiers::default(),
        );
        draw(visual);
        visual.simulate_mouse_move(
            point(px(240.), px(80.)),
            Some(MouseButton::Left),
            Modifiers::default(),
        );
        visual.simulate_mouse_up(
            point(px(240.), px(80.)),
            MouseButton::Left,
            Modifiers::default(),
        );
        draw(visual);
        visual.update(TextSelection::selected_text)
    };
    assert!(
        drag(&mut visual, 16.).is_empty(),
        "plain row press must not start selection"
    );
    assert!(
        drag(&mut visual, 43.).is_empty(),
        "plain column press must not start selection"
    );
    visual.simulate_mouse_move(point(px(2.), px(80.)), None, Modifiers::default());
    assert!(visual.update(|window, cx| TextSelection::is_selectable_at(
        point(px(2.), px(80.)),
        window,
        cx
    )));
    let selected = drag(&mut visual, 80.);
    assert!(
        selected.contains("selectable"),
        "explicit label can still be drag-selected, got {selected:?}"
    );
    visual.simulate_mouse_move(point(px(25.), px(80.)), None, Modifiers::default());
    draw(&mut visual);
    assert_eq!(
        visual.update(TextSelection::selected_text),
        selected,
        "the drag ends on mouse up"
    );
    kernel.shutdown();
}

#[gpui::test]
fn trusted_approval_indicator_overlays_the_layout_and_clears_traffic_lights(
    cx: &mut TestAppContext,
) {
    const BODY: u32 = 0x173964;
    cx.update(gpui_kit::init);
    let temp = tempfile::tempdir().unwrap();
    let config = Config::from_args(&[
        "hato".into(),
        "--repo-root".into(),
        temp.path().display().to_string(),
        "--data-dir".into(),
        temp.path().join("data").display().to_string(),
    ])
    .unwrap();
    let kernel = Kernel::new_gui(config, UiBridge::disconnected()).unwrap();
    let window = cx.open_window(size(px(500.), px(350.)), |window, cx| {
        let mut shell = Shell::new(kernel.clone(), UiBridge::new().1, window, cx);
        shell.only_module = Some("__snapshot".into());
        shell.trees.insert("__snapshot".into(), Arc::new(json!({
            "type":"column","key":"root","grow":true,"children":[
                {"type":"theme","key":"theme","chrome":{"window":{"titlebar":"hidden","trafficLights":{"x":22,"y":22}}}},
                {"type":"column","key":"content","grow":true,"style":{"background":background(BODY)},"children":[
                    {"type":"securityPreferences","key":"untrusted"}
                ]}
            ]
        })));
        shell
    });
    let mut visual = VisualTestContext::from_window(window.into(), cx);
    draw(&mut visual);
    let body = bounds(&mut visual, BODY).unwrap();
    assert!(visual.debug_bounds("trusted-security-banner").is_none());
    assert!(visual.debug_bounds("trusted-security-badge").is_none());

    kernel
        .approvals
        .set_auto_approve_from_native_ui(true)
        .unwrap();
    draw(&mut visual);
    let banner = visual.debug_bounds("trusted-security-banner").unwrap();
    assert_eq!(banner.size.width, px(500.));
    if cfg!(target_os = "macos") {
        assert!(
            banner.top() >= px(22. + 16.),
            "banner clears the traffic lights"
        );
    }
    assert_eq!(bounds(&mut visual, BODY).unwrap(), body);
    assert!(visual
        .debug_bounds("trusted-security-warning-banner-setting")
        .is_none());

    kernel
        .approvals
        .set_auto_approve_warning_banner_from_native_ui(false)
        .unwrap();
    draw(&mut visual);
    assert!(visual.debug_bounds("trusted-security-banner").is_none());
    assert!(visual.debug_bounds("trusted-security-badge").is_none());
    assert!(kernel.approvals.auto_approve_enabled());
    assert_eq!(bounds(&mut visual, BODY).unwrap(), body);

    kernel
        .approvals
        .set_auto_approve_warning_banner_from_native_ui(true)
        .unwrap();
    draw(&mut visual);
    assert_eq!(visual.debug_bounds("trusted-security-banner"), Some(banner));

    kernel
        .approvals
        .set_auto_approve_from_native_ui(false)
        .unwrap();
    draw(&mut visual);
    assert!(visual.debug_bounds("trusted-security-banner").is_none());
    assert!(visual.debug_bounds("trusted-security-badge").is_none());
    kernel.shutdown();
}

#[test]
fn hover_fades_keep_the_fill_color_and_identical_selection_fills_stay_exact() {
    use gpui_kit::base::motion::{Interpolate, SurfaceColor};
    use gpui_kit::transparent_black;
    let transparent = SurfaceColor(transparent_black());
    let light = SurfaceColor(rgb(0xecdfd3).into());
    for progress in [0.1, 0.5, 0.9] {
        assert_eq!(
            transparent.interpolate(&light, progress).0,
            light.0.opacity(progress)
        );
        assert_eq!(
            light.interpolate(&transparent, progress).0,
            light.0.opacity(1. - progress)
        );
        assert_eq!(light.interpolate(&light, progress).0, light.0);
    }
}
