// workspace-layout: script-controlled docking/resizing/collapse/float/window/bars + persistence.
// Run twice on the same data dir: first run sets things up (HATO_T_PHASE=1), second checks restore (=2).
export default {
  id: "__driver", moduleApiVersion: 1,
  async activate(ctx) {
    try { (await T("test.env", { name: "HATO_T_PHASE" })) === "2" ? await phase2(ctx) : await phase1(ctx); }
    catch (e) { check("uncaught", false, e.message + "\n" + e.stack); }
    await finish();
  },
};
const R = () => T("test.render", { module: "workspace-layout" });
const L = (ctx) => ctx.modules.call("workspace-layout", "getLayout");

async function phase1(ctx) {
  let ui = await R();
  check("top bar with draggable items", !!find(ui, (n) => n.key === "bar:top") && !!find(ui, (n) => n.key === "baritem:top:modules"));
  const cols = find(ui, (n) => n.key === "cols");
  check("columns are a resizable split with collapse support", cols && cols.type === "split" && cols.resizeAction === "resize" && cols.collapseAction === "collapse" && cols.children.length === 4, cols && Object.keys(cols));
  check("each panel is a drop zone with a drag handle", ["projects", "files", "viewer", "ai", "terminal"].every((p) => find(ui, (n) => n.key === "panel:" + p && n.type === "dropZone")) && !!find(ui, (n) => n.type === "dragHandle" && n.payload && n.payload.id === "ai"));
  // divider drag end on the columns split
  await ev("workspace-layout", "resize", { key: "cols", value: { sizes: [0.1, 0.2, 0.4, 0.3] } });
  check("resize persisted into the model", JSON.stringify((await L(ctx)).columns.map((c) => c.size)) === JSON.stringify([0.1, 0.2, 0.4, 0.3]));
  // drag terminal onto the right edge of the viewer
  await ev("workspace-layout", "dropPanel", { key: "panel:viewer", value: { payload: { kind: "panel", id: "terminal" }, region: "right", zone: "panel:viewer" } });
  let l = await L(ctx);
  check("terminal re-docked as a column right of the viewer", l.bottom.panels.length === 0 && l.columns.map((c) => c.panels.join("+")).join("|") === "projects|files|viewer|terminal|ai", l.columns.map((c) => c.panels));
  ui = await R();
  check("no bottom dock split when bottom is empty", !find(ui, (n) => n.key === "main"));
  // drag files below projects (stack)
  await ev("workspace-layout", "dropPanel", { key: "panel:projects", value: { payload: { kind: "panel", id: "files" }, region: "bottom", zone: "panel:projects" } });
  ui = await R();
  const col0 = find(ui, (n) => n.key === "col:0");
  check("stacked column renders as a vertical resizable split", col0 && col0.direction === "vertical" && col0.children.length === 2);
  // collapse by dragging past minimum (kernel fires collapse {index})
  await ev("workspace-layout", "collapse", { key: "col:0", value: { index: 1 } });
  ui = await R();
  const col0b = find(ui, (n) => n.key === "col:0");
  check("collapsed panel gets a fixed header-only row", col0b.fixed[1] === 30 && !find(find(ui, (n) => n.key === "panel:files"), (n) => n.type === "slot"));
  await ev("workspace-layout", "toggleCollapse", { value: "files" });
  check("expand restores the panel", !(await L(ctx)).collapsed.files);
  // float the AI panel, move it natively, detach the viewer into a window
  await ev("workspace-layout", "float", { value: "ai" });
  await ev("workspace-layout", "moveFloat", { key: "float:ai", value: { x: 300, y: 140, width: 500, height: 360 } });
  await ev("workspace-layout", "detach", { value: "viewer" });
  ui = await R();
  const fl = find(ui, (n) => n.type === "floating");
  const win = find(ui, (n) => n.type === "window");
  check("floating panel rendered with stored geometry", fl && fl.key === "float:ai" && fl.x === 300 && fl.width === 500 && !!find(fl, (n) => n.type === "slot" && n.module === "ai"), fl && { x: fl.x, w: fl.width });
  check("detached OS window rendered for the viewer", win && win.key === "win:viewer" && win.closeAction === "windowClosed" && !!find(win, (n) => n.module === "viewer"));
  // bars: move module versions to the top bar before the workspace label; hide the bottom bar
  await ev("workspace-layout", "dropBar", { key: "baritem:top:workspace", value: { payload: { kind: "item", id: "versions" }, region: "left", zone: "baritem:top:workspace" } });
  await ev("workspace-layout", "toggleBar", { value: "bottom" });
  l = await L(ctx);
  check("bar item moved between bars by drag", l.bars.top.items.join(",") === "title,versions,workspace,layoutMenu,modules" && !l.bars.bottom.items.includes("versions"), l.bars);
  ui = await R();
  check("hidden bottom bar not rendered", !find(ui, (n) => n.key === "bar:bottom"));
  // Native checkbox events carry checked state, with the bar identified by its key.
  await ev("workspace-layout", "toggleBar", { key: "tb", value: false });
  ui = await R();
  check("both bars can be hidden and Layout remains accessible", !find(ui, (n) => n.key === "bar:top") && !!find(ui, (n) => n.key === "layout-access"));
  await ev("workspace-layout", "toggleBar", { key: "tb", value: true });
  await ev("workspace-layout", "removeItem", { value: "layoutMenu" });
  ui = await R();
  check("removing Layout item preserves a recovery control", !!find(ui, (n) => n.key === "layout-access"));
  await ev("workspace-layout", "itemToBar", { value: { item: "layoutMenu", bar: "top" } });
  // layout menu
  await ev("workspace-layout", "toggleLayoutMenu");
  ui = await R();
  check("Layout menu lists panels and bar items", !!find(ui, (n) => n.key === "layout-modal") && !!find(ui, (n) => n.key === "p-viewer") && !!find(ui, (n) => n.key === "i-approvals"));
  await ev("workspace-layout", "toggleLayoutMenu");
  await sleep(600); // debounce save
  console.log("LAYOUT1 " + JSON.stringify(await L(ctx)));
}

async function phase2(ctx) {
  const l = await until(async () => { const x = await L(ctx); return x.floating.ai ? x : null; }, 5000);
  check("layout restored after restart", l && l.floating.ai.x === 300 && l.detached.viewer && l.bars.bottom.visible === false && l.columns[0].panels.join("+") === "projects+files", l);
  // closing the detached window (kernel fires closeAction) docks it back
  await ev("workspace-layout", "windowClosed", { key: "win:viewer", value: { width: 800, height: 600 } });
  const l2 = await L(ctx);
  check("closing a detached window re-docks the panel", !l2.detached.viewer && l2.columns.some((c) => c.panels.includes("viewer")));
  await ev("workspace-layout", "resetLayout");
  const l3 = await L(ctx);
  check("reset restores the default layout", l3.columns.length === 4 && l3.bottom.panels[0] === "terminal" && l3.bars.bottom.visible);
}
