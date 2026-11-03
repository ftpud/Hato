// workspace-layout: main window composition, fully script-controlled.
// * Panels (projects, files, viewer, ai, terminal) live in column stacks, a bottom dock, floating
//   panels inside the window, detached OS windows, or are hidden.
// * Splits are natively resizable; dragging a pane past its minimum collapses it.
// * Panel titles are drag handles: drop onto another panel's left/right/top/bottom/center to re-dock.
// * The top and bottom bars are data too: show/hide, reorder/move items by dragging their ⋮ grip.
// The kernel only provides the primitives (split, dragHandle, dropZone, floating, window); all
// policy lives here and is persisted through the persistence service ("layout.v1").
import type { AppModule, ModuleContext, UiNode } from "../../../../sdk/types";
import { exportSettings } from "../../../../sdk/settings";
import { fontOptions, typography } from "../../../../sdk/typography";
import { animePalette, animeTerminal } from "./anime";
import { animeWallpaper } from "./anime-wallpaper";
import { colorScheme } from "../../../../sdk/color-scheme";
import { debounce, errMsg } from "../../../../sdk/runtime";
import { BAR_ITEMS, PANELS, defaultLayout, dropPanel, homeOf, locate, moveBarItem, moveTo, panelSignature, removeBarItem, repair, setPanels, type BarId, type Layout, type PanelDef } from "./model";
import { loadContributions, watchContributions, type Contributions } from "../../../../sdk/plugins";
import { uiIcons } from "../../../../sdk/ui-icons";

let fontFamily = "JetBrains Mono";
let fontSize = "15";
let fontWeight = "400";
/** Appearance preference; "system" leaves the last mode the window used. */
let mode: "light" | "dark" | "system" = "system";
const modeOptions = [{ value: "dark", label: "Dark" }, { value: "light", label: "Light" }, { value: "system", label: "Keep current" }];
const sizeOptions = [{ value: "14", label: "Small" }, { value: "15", label: "Compact" }, { value: "16", label: "Standard" }, { value: "18", label: "Large" }];
const weightOptions = [{ value: "400", label: "Regular" }, { value: "500", label: "Medium" }];
let appearanceTheme = "classic";
let panelOpacity = "balanced";
const themeOptions = [{ value: "classic", label: "Classic" }, { value: "anime", label: "Anime · Sakura Twilight" }];
const opacityOptions = [{ value: "airy", label: "Airy · 40%" }, { value: "balanced", label: "Balanced · 60%" }, { value: "solid", label: "Readable · 85%" }];
let ws: any = null;
let modules: any[] = [];
let showModules = false;
let showLayout = false;
let diag: string | null = null;
let busy: string | null = null;
let upd: Record<string, any> = {};
let updSummary: { available: string[]; errors: string[] } = { available: [], errors: [] };
let scanningUpd = false;
let layout: Layout = defaultLayout();
let save: () => void = () => {};
// Plugin contributions: panels, activity sidebars and overlays come from enabled plugins' manifests.
let contributions: Contributions | null = null;
let stopContributions: (() => void) | null = null;
const sidebarSubscriptions = new Map<string, () => void>();

function applyContributions(c: Contributions) {
  contributions = c;
  const defs: Record<string, PanelDef> = {};
  for (const p of Object.values(c.panels)) defs[p.id] = { slot: p.module, title: p.title, defaultHidden: p.defaultHidden, dockBelow: p.dockBelow, dock: p.dock, pinned: p.pinned };
  const before = panelSignature();
  setPanels(defs);
  return before !== panelSignature();
}

function subscribeSidebars(ctx: ModuleContext) {
  const wanted = new Set((contributions?.sidebars || []).map((s) => s.module));
  for (const [m, stop] of sidebarSubscriptions) if (!wanted.has(m)) { stop(); sidebarSubscriptions.delete(m); }
  for (const m of wanted) if (!sidebarSubscriptions.has(m)) {
    sidebarSubscriptions.set(m, ctx.events.on(`${m}.togglePanel`, (event: any) => toggleSidebarPanel(ctx, event?.id)));
  }
}

const COLLAPSED_ROW = 0;
const COLLAPSED_COL = 0;

async function loadUpdates(ctx: ModuleContext, scan: boolean, full = false) {
  try {
    if (scan) { scanningUpd = true; ctx.ui.invalidate(); }
    const r = await ctx.modules.call("module-dev", scan ? "scanUpdates" : "updates", { full }, { timeoutMs: 300000 });
    upd = {};
    for (const m of r.modules) upd[m.id] = m;
    updSummary = { available: r.available, errors: r.errors };
  } catch (e) { diag = errMsg(e); }
  finally { scanningUpd = false; ctx.ui.invalidate(); }
}

async function loadModules(ctx: ModuleContext) {
  try { modules = await ctx.modules.call("module-dev", "list"); } catch (e) { diag = errMsg(e); }
  ctx.ui.invalidate();
}

function versionsSummary() {
  const ui = modules.filter((m) => m.active).map((m) => m.active.label).sort();
  return ui.length ? ui.join("  ") : "modules: loading…";
}

// ---- panels -------------------------------------------------------------------------------------

function btn(key: string, text: string, action: string, value: any, tooltip: string): UiNode {
  return { type: "button", key, text, action, value, small: true, variant: "ghost", tooltip };
}

function panelHeader(id: string, mode: "dock" | "float" | "window"): UiNode {
  const p = PANELS[id];
  const collapsed = !!layout.collapsed[id];
  const kids: UiNode[] = [];
  if (mode === "dock") {
    kids.push({ type: "dragHandle", key: "drag", payload: { kind: "panel", id }, children: [{ type: "label", key: "title", text: p.title, size: "sm", weight: "semibold", grow: true }], grow: true, tooltip: "Drag onto another panel to re-dock" });
    kids.push(btn("collapse", collapsed ? "+" : "–", "toggleCollapse", id, collapsed ? "Expand" : "Collapse"));
    kids.push(btn("float", "⧉", "float", id, "Float inside the window"));
    kids.push(btn("detach", "⇗", "detach", id, "Open in its own window"));
    kids.push(btn("hide", "×", "hide", id, "Hide (reopen from Layout)"));
  } else {
    kids.push({ type: "spacer", key: "sp" });
    kids.push(btn("dock", "⇙ Dock", "dock", id, "Dock back into the main window"));
    if (mode === "float") kids.push(btn("detach", "⇗", "detach", id, "Open in its own window"));
    else kids.push(btn("float", "⧉", "float", id, "Float inside the main window"));
  }
  return { type: "row", key: "ph", gap: 2, padding: 2, bg: "panel", style: { borderBottom: 1, borderColor: "border" }, align: "center", children: layout.showPanelControls ? kids : kids.filter(node => node.type !== "button") };
}

function panelBody(id: string, mode: "dock" | "float" | "window"): UiNode {
  const collapsed = mode === "dock" && !!layout.collapsed[id];
  return { type: "column", key: "panel-" + id, grow: true, bg: "panel", ...(appearanceTheme === "anime" ? { style: { radius: 16, borderWidth: 1, borderColor: "border", shadow: "lg" as const, padding: 6 } } : {}), children: [
    ...(mode === "dock" || layout.showPanelControls ? [panelHeader(id, mode)] : []),
    ...(collapsed ? [] : [{ type: "slot", key: "slot", module: PANELS[id].slot, grow: true } as UiNode]),
  ] };
}

function dockedPanel(id: string): UiNode {
  return { type: "dropZone", key: "panel:" + id, action: "dropPanel", grow: true, children: [panelBody(id, "dock")] };
}

/** Collapsed panes keep their model index but reserve no width or height. */
function strip(_ids: string[], key: string): UiNode {
  return { type: "column", key, children: [] };
}

function collapsedPanels(): UiNode | null {
  const ids = [
    ...layout.columns.flatMap((col) => col.panels.filter((id) => layout.collapsed[id])),
    ...layout.bottom.panels.filter((id) => layout.bottom.collapsed || layout.collapsed[id]),
  ];
  if (!ids.length) return null;
  return { type: "column", key: "collapsed-panels", maxHeight: 108, scroll: true, bg: "panel", children: [
    { type: "row", key: "restore-buttons", wrap: true, gap: 6, padding: 4, children: [
      { type: "label", key: "caption", text: "Collapsed", size: "xs", color: "muted" },
      ...ids.map((id): UiNode => ({ type: "button", key: "restore-" + id, text: PANELS[id].title, iconSvg: uiIcons["plus"], action: layout.bottom.collapsed && layout.bottom.panels.includes(id) ? "expandBottom" : "toggleCollapse", value: id, small: true, tooltip: `Restore ${PANELS[id].title}` })),
    ] },
  ] };
}

function columnNode(ci: number): UiNode {
  const col = layout.columns[ci];
  if (col.panels.every((p) => layout.collapsed[p])) return strip(col.panels, `col-strip-${ci}`);
  if (col.panels.length === 1) return dockedPanel(col.panels[0]);
  return { type: "split", key: `col:${ci}`, direction: "vertical", sizes: col.sizes, minSize: 80,
    fixed: col.panels.map((p) => (layout.collapsed[p] ? COLLAPSED_ROW : null)), collapsible: col.panels.map(() => true),
    resizeAction: "resize", collapseAction: "collapse", children: col.panels.map(dockedPanel) } as UiNode;
}

function bottomNode(): UiNode | null {
  const b = layout.bottom;
  if (!b.panels.length) return null;
  if (b.collapsed || b.panels.every((p) => layout.collapsed[p])) return null;
  if (b.panels.length === 1) return dockedPanel(b.panels[0]);
  return { type: "split", key: "bottom", direction: "horizontal", sizes: b.sizes, minSize: 120,
    fixed: b.panels.map((p) => (layout.collapsed[p] ? COLLAPSED_COL : null)), collapsible: b.panels.map(() => true),
    resizeAction: "resize", collapseAction: "collapse",
    children: b.panels.map((p) => (layout.collapsed[p] ? strip([p], "bstrip-" + p) : dockedPanel(p))) } as UiNode;
}

function dockArea(): UiNode {
  const cols = layout.columns;
  let top: UiNode;
  if (!cols.length || cols.every((col) => col.panels.every((id) => layout.collapsed[id]))) {
    top = { type: "column", key: "empty", padding: 16, grow: true, children: [{ type: "label", key: "l", text: "Restore a collapsed panel below, or open Layout to dock panels.", color: "muted" }] };
  } else if (cols.length === 1) {
    top = columnNode(0);
  } else {
    top = { type: "split", key: "cols", direction: "horizontal", sizes: cols.map((c) => c.size), minSize: 120,
      fixed: cols.map((c) => (c.panels.every((p) => layout.collapsed[p]) ? COLLAPSED_COL : null)), collapsible: cols.map(() => true),
      resizeAction: "resize", collapseAction: "collapse", children: cols.map((_, i) => columnNode(i)) } as UiNode;
  }
  const bottom = bottomNode();
  if (!bottom) return { type: "column", key: "dock", grow: true, children: [top] };
  const bottomCollapsed = layout.bottom.collapsed || layout.bottom.panels.every((p) => layout.collapsed[p]);
  return { type: "split", key: "main", direction: "vertical", sizes: layout.mainSizes, minSize: 90, grow: true,
    fixed: [null, bottomCollapsed ? 0 : null], collapsible: [false, true],
    resizeAction: "resize", collapseAction: "collapse", children: [top, bottom] } as UiNode;
}

// ---- bars ---------------------------------------------------------------------------------------

function itemContent(it: string): UiNode {
  const where = ws ? `${ws.name}  ·  ${ws.location === "ssh" ? `SSH ${ws.ssh?.user}@${ws.ssh?.host}` : "Local"}  ·  ${ws.rootAbsolutePath}` : "No workspace selected";
  switch (it) {
    case "title": return { type: "label", key: "c", text: "Hato", weight: "bold" };
    case "workspace": return { type: "label", key: "c", text: where, size: "sm", color: "muted", grow: true };
    case "settings": return { type: "button", key: "c", text: "Settings", action: "openSettings", small: true, tooltip: "Appearance and module preferences" };
    case "layoutMenu": return { type: "button", key: "c", text: showLayout ? "Hide layout" : "Layout", action: "toggleLayoutMenu", small: true };
    case "modules": {
      const n = updSummary.available.length;
      return { type: "button", key: "c", text: showModules ? "Hide modules" : n ? `Modules (${n} update${n > 1 ? "s" : ""})` : "Modules", action: "toggleModules", small: true, variant: n && !showModules ? "primary" : "default" };
    }
    case "machine": return { type: "label", key: "c", text: ws ? `files/terminal/agent run on: ${ws.machineId}` : "no workspace", size: "xs", color: "muted" };
    case "versions": return { type: "label", key: "c", text: versionsSummary(), size: "xs", color: "muted", mono: true, grow: true };
    case "approvals": return { type: "approvalPanel", key: "c" };
    default: return { type: "label", key: "c", text: it };
  }
}

function barNode(b: BarId): UiNode | null {
  const bar = layout.bars[b];
  if (!bar.visible) return b === "top" ? { type: "titleBar", key: "window-titlebar", children: [] } : null;
  const items: UiNode[] = bar.items.map((it) => ({
    type: "dropZone", key: `baritem:${b}:${it}`, action: "dropBar", regions: ["left", "right"], grow: !!BAR_ITEMS[it].grow, children: [
      { type: "row", key: "r", gap: 3, align: "center", grow: !!BAR_ITEMS[it].grow, children: [
        { type: "dragHandle", key: "grip", payload: { kind: "item", id: it }, label: "⋮", width: 10, tooltip: `Drag to move "${BAR_ITEMS[it].title}"` },
        itemContent(it),
      ] },
    ] } as UiNode));
  if (!items.length) items.push({ type: "label", key: "empty", text: `${b} bar is empty — drag items here or add them from Layout`, size: "xs", color: "muted", grow: true });
  return { type: "dropZone", key: `bar:${b}`, action: "dropBar", regions: ["center"], grow: false, children: [
    b === "top"
      ? { type: "titleBar", key: "bar-" + b, children: items }
      : { type: "row", key: "bar-" + b, gap: 8, padding: 4, bg: "panel", border: true, align: "center", children: items },
  ] };
}

// ---- layout menu --------------------------------------------------------------------------------

function where(id: string): string {
  const l = locate(layout, id);
  if (!l) return "?";
  if (l.kind === "column") return `column ${l.col + 1}${layout.columns[l.col].panels.length > 1 ? `, #${l.idx + 1}` : ""}${layout.collapsed[id] ? " (collapsed)" : ""}`;
  if (l.kind === "bottom") return `bottom dock${layout.collapsed[id] || layout.bottom.collapsed ? " (collapsed)" : ""}`;
  return l.kind;
}

function layoutMenu(): UiNode {
  const panelRows: UiNode[] = Object.keys(PANELS).map((id) => {
    const k = locate(layout, id)?.kind;
    return { type: "row", key: "p-" + id, gap: 4, align: "center", children: [
      { type: "label", key: "n", text: PANELS[id].title, width: 120, weight: "bold", size: "sm" },
      { type: "label", key: "w", text: where(id), size: "xs", color: "muted", grow: true },
      { type: "button", key: "col", text: "Column", action: "toColumn", value: id, small: true, disabled: k === "column" },
      { type: "button", key: "bot", text: "Bottom", action: "toBottom", value: id, small: true, disabled: k === "bottom" },
      { type: "button", key: "flt", text: "Float", action: "float", value: id, small: true, disabled: k === "floating" },
      { type: "button", key: "win", text: "Window", action: "detach", value: id, small: true, disabled: k === "detached" },
      { type: "button", key: "hid", text: "Hide", action: "hide", value: id, small: true, disabled: k === "hidden" },
    ] } as UiNode;
  });
  const onBars = new Set([...layout.bars.top.items, ...layout.bars.bottom.items]);
  const itemRows: UiNode[] = Object.keys(BAR_ITEMS).map((it) => {
    const bar = layout.bars.top.items.includes(it) ? "top" : layout.bars.bottom.items.includes(it) ? "bottom" : null;
    return { type: "row", key: "i-" + it, gap: 4, align: "center", children: [
      { type: "label", key: "n", text: BAR_ITEMS[it].title, width: 160, size: "sm" },
      { type: "label", key: "w", text: bar ? `${bar} bar` : "hidden", size: "xs", color: "muted", grow: true },
      { type: "button", key: "t", text: "Top", action: "itemToBar", value: { item: it, bar: "top" }, small: true, disabled: bar === "top" },
      { type: "button", key: "b", text: "Bottom", action: "itemToBar", value: { item: it, bar: "bottom" }, small: true, disabled: bar === "bottom" },
      { type: "button", key: "h", text: "Hide", action: "removeItem", value: it, small: true, disabled: !onBars.has(it) },
    ] } as UiNode;
  });
  return { type: "modal", key: "layout-modal", title: "Layout", closeAction: "toggleLayoutMenu", children: [
    { type: "label", key: "hint", text: "Drag panel titles (⠿) onto another panel's edge or center to re-dock. Drag dividers to resize; drag past the minimum to collapse. Drag the ⋮ grips on the bars to reorder or move items. Everything here is the workspace-layout TypeScript module — it can be changed and hot-swapped like any other module.", size: "xs", color: "muted", wrap: true },
    { type: "label", key: "h1", text: "Bars", weight: "bold", size: "sm" },
    { type: "row", key: "bars", gap: 12, children: [
      { type: "toggle", key: "tb", label: "Show top bar", checked: layout.bars.top.visible, action: "toggleBar", value: "top" } as UiNode,
      { type: "toggle", key: "bb", label: "Show bottom bar", checked: layout.bars.bottom.visible, action: "toggleBar", value: "bottom" } as UiNode,
    ] },
    { type: "row", key: "sidebars", gap: 12, wrap: true, children: [
      { type: "toggle", key: "left-sidebar-visible", label: "Show left sidebar", checked: layout.showLeftSidebar, action: "toggleSidebar" },
      { type: "toggle", key: "right-sidebar-visible", label: "Show right sidebar", checked: layout.showRightSidebar, action: "toggleSidebar" },
    ] },
    ...itemRows,
    { type: "divider", key: "d1" },
    { type: "label", key: "h2", text: "Panels", weight: "bold", size: "sm" },
    { type: "toggle", key: "panel-controls", label: "Show panel control buttons", checked: layout.showPanelControls, action: "togglePanelControls", tooltip: "Show collapse, float, detach, hide and dock buttons in panel headers. Panels remain accessible from Layout and the sidebar." },
    ...panelRows,
    { type: "divider", key: "d2" },
    { type: "row", key: "foot", gap: 6, children: [
      { type: "spacer", key: "sp" },
      { type: "button", key: "reset", text: "Reset layout", action: "resetLayout", small: true, variant: "danger" },
      { type: "button", key: "close", text: "Close", action: "toggleLayoutMenu", small: true },
    ] },
  ] };
}

function modulesModal(): UiNode {
  const rank = (m: any) => (upd[m.id]?.status === "update-available" ? 0 : upd[m.id]?.status === "build-error" ? 1 : 2);
  const sorted = [...modules].sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id));
  const rows: UiNode[] = sorted.map((m) => {
    const u = upd[m.id];
    const st = !u ? { t: "checking…", c: "muted" } : u.status === "update-available" ? { t: "● update available (source changed)", c: "warning" } : u.status === "build-error" ? { t: `✖ source does not build: ${(u.diagnostics || "").split("\n")[0]}`, c: "danger" } : { t: "up to date", c: "success" };
    return { type: "row", key: "m-" + m.id, gap: 6, align: "center", children: [
      { type: "label", key: "n", text: m.active ? m.active.label : `${m.id} (inactive)`, mono: true, size: "sm", width: 210 },
      { type: "label", key: "k", text: m.kind, size: "xs", color: "muted", width: 50 },
      { type: "label", key: "u", text: st.t, size: "xs", color: st.c as any, width: 230 },
      { type: "label", key: "e", text: m.lastError ? `⚠ ${m.lastError}` : `${m.versions.length} version(s); previous: ${m.previous.slice(-3).join(",") || "-"}`, size: "xs", color: m.lastError ? "danger" : "muted", grow: true },
      { type: "button", key: "b", text: u && u.status === "update-available" ? "Update" : "Rebuild & activate", action: "rebuild", value: m.id, small: true, variant: u && u.status === "update-available" ? "primary" : "default", disabled: !!busy },
      { type: "button", key: "r", text: "Rollback", action: "rollback", value: m.id, small: true, disabled: !!busy || !(m.previous && m.previous.length) },
    ] } as UiNode;
  });
  return { type: "modal", key: "modules-modal", title: "Modules (hot-swappable TypeScript)", closeAction: "toggleModules", children: [
    { type: "label", key: "hint", text: "Edit sources under modules/, then Rebuild & activate. Builds, activation and rollback each require native approval; the Rust kernel is never rebuilt.", size: "xs", color: "muted", wrap: true },
    { type: "row", key: "upd-bar", gap: 6, align: "center", children: [
      { type: "label", key: "upd-sum", text: scanningUpd ? "Checking module sources for updates…" : updSummary.available.length ? `${updSummary.available.length} module(s) with updates: ${updSummary.available.join(", ")}` : "All modules match their sources.", size: "sm", color: updSummary.available.length ? "warning" : "muted", grow: true },
      { type: "button", key: "upd-all", text: `Activate all updates (${updSummary.available.length})`, action: "activateAll", small: true, variant: "primary", disabled: !!busy || !updSummary.available.length },
      { type: "button", key: "upd-scan", text: "Rescan", action: "rescan", small: true, disabled: scanningUpd || !!busy, tooltip: "Rebuild every module in memory and compare with the active version" },
    ] },
    ...(busy ? [{ type: "progress", key: "busy", indeterminate: true, label: busy } as UiNode] : []),
    ...(diag ? [{ type: "status", key: "diag", text: diag, level: diag.startsWith("✓") ? "success" : "error" } as UiNode] : []),
    { type: "column", key: "list", gap: 2, scroll: true, children: rows },
  ] };
}

// ---- module ---------------------------------------------------------------------------------------

function panelVisible(id: string): boolean {
  const place = locate(layout, id);
  return !!place && place.kind !== "hidden" && !layout.collapsed[id] && !(place.kind === "bottom" && layout.bottom.collapsed);
}
function publishPanels(ctx: ModuleContext) {
  ctx.state.set("workspace-layout.panels", Object.fromEntries(Object.keys(PANELS).map((id) => [id, panelVisible(id)])));
}
function toggleSidebarPanel(ctx: ModuleContext, id: string) {
  if (typeof id !== "string" || !Object.prototype.hasOwnProperty.call(PANELS, id) || PANELS[id].pinned) return;
  const place = locate(layout, id);
  if (!place || place.kind === "hidden") {
    const near = PANELS[id].dockBelow, nearPlace = near ? locate(layout, near) : null;
    set(ctx, nearPlace?.kind === "column" ? dropPanel(layout, id, near!, "bottom") : moveTo(layout, id, homeOf(id)));
    return;
  }
  if (place.kind === "floating" || place.kind === "detached") { set(ctx, moveTo(layout, id, "hidden")); return; }
  const next = { ...layout, collapsed: { ...layout.collapsed, [id]: panelVisible(id) } };
  if (!next.collapsed[id] && place.kind === "bottom") next.bottom = { ...layout.bottom, collapsed: false };
  set(ctx, next);
}

function set(ctx: ModuleContext, next: Layout) {
  layout = next;
  publishPanels(ctx);
  save();
  ctx.ui.invalidate();
}

const mod: AppModule = {
  id: "workspace-layout",
  moduleApiVersion: 1,
  async activate(ctx, prev) {
    save = debounce(() => { ctx.modules.call("persistence", "settings.set", { key: "layout.v1", value: layout as any }).catch((e) => ctx.log.warn("save layout", errMsg(e))); }, 300);
    if (prev) { showModules = !!prev.showModules; showLayout = !!prev.showLayout; }
    // Panels must be known before a persisted layout is repaired against them.
    try { applyContributions(await loadContributions(ctx)); } catch (e) { ctx.log.warn("load plugins", errMsg(e)); }
    try {
      layout = repair(prev && prev.layout ? prev.layout : await ctx.modules.call("persistence", "settings.get", { key: "layout.v1" }));
    } catch (e) { ctx.log.warn("load layout", errMsg(e)); layout = defaultLayout(); }
    const savedFont = await ctx.modules.call("persistence", "settings.get", { key: "appearance.fontFamily" });
    fontFamily = fontOptions.some(option => option.value === savedFont) ? savedFont : "JetBrains Mono";
    const savedSize = await ctx.modules.call("persistence", "settings.get", { key: "appearance.fontSize" });
    const savedWeight = await ctx.modules.call("persistence", "settings.get", { key: "appearance.fontWeight" });
    fontSize = sizeOptions.some(option => option.value === savedSize) ? savedSize : "15";
    fontWeight = weightOptions.some(option => option.value === savedWeight) ? savedWeight : "400";
    const savedMode = await ctx.modules.call("persistence", "settings.get", { key: "appearance.mode" });
    mode = savedMode === "light" || savedMode === "dark" ? savedMode : "system";
    const savedTheme = await ctx.modules.call("persistence", "settings.get", { key: "appearance.theme" });
    appearanceTheme = themeOptions.some(option => option.value === savedTheme) ? savedTheme : "classic";
    const savedOpacity = await ctx.modules.call("persistence", "settings.get", { key: "appearance.panelOpacity" });
    panelOpacity = opacityOptions.some(option => option.value === savedOpacity) ? savedOpacity : "balanced";
    exportSettings(ctx, () => [{ key: "appearance", title: "Appearance", fields: [
      { key: "theme", label: "Theme", type: "select", value: appearanceTheme, options: themeOptions,
        description: "Sakura Twilight pairs an original anime wallpaper with floating indigo glass and pink accents." },
      { key: "panelOpacity", label: "Anime panel opacity", type: "select", value: panelOpacity, options: opacityOptions,
        description: "Keep the scenery visible or increase opacity for easier reading." },
      { key: "mode", label: "Color mode", type: "select", value: mode, options: modeOptions,
        description: "Classic follows this color mode. Sakura Twilight uses its own twilight palette." },
    ] }, { key: "typography", title: "Typography", fields: [
      { key: "fontFamily", label: "Interface font", type: "select", value: fontFamily, options: fontOptions,
        description: "Applies to panels, chat, file previews and terminals. JetBrains Mono is bundled." },
      { key: "fontSize", label: "Text size", type: "select", value: fontSize, options: sizeOptions },
      { key: "fontWeight", label: "Text weight", type: "select", value: fontWeight, options: weightOptions },
    ] }], async (section, key, value) => {
      if (section === "appearance") {
        if (key === "theme" || key === "panelOpacity") {
          const options = key === "theme" ? themeOptions : opacityOptions;
          if (!options.some(option => option.value === value)) throw new Error("Invalid appearance preference");
          await ctx.modules.call("persistence", "settings.set", { key: `appearance.${key}`, value });
          if (key === "theme") appearanceTheme = String(value);
          else panelOpacity = String(value);
          ctx.ui.invalidate();
          return;
        }
        if (key !== "mode" || !modeOptions.some(option => option.value === value)) throw new Error("Invalid appearance preference");
        await ctx.modules.call("persistence", "settings.set", { key: "appearance.mode", value });
        mode = value as typeof mode;
        ctx.ui.invalidate();
        return;
      }
      const options = key === "fontFamily" ? fontOptions : key === "fontSize" ? sizeOptions : key === "fontWeight" ? weightOptions : [];
      if (typeof value !== "string" || !options.some(option => option.value === value)) throw new Error("Invalid typography preference");
      await ctx.modules.call("persistence", "settings.set", { key: `appearance.${key}`, value });
      if (key === "fontFamily") fontFamily = value;
      else if (key === "fontSize") fontSize = value;
      else fontWeight = value;
    });
    ws = ctx.state.get("workspace.selected") || null;
    ctx.state.watch("workspace.selected", (v: any) => { ws = v; ctx.ui.invalidate(); });
    ctx.events.on("agents-panel.openMcps",()=>{
      if(!PANELS.mcps)return;
      let next=layout;
      const place=locate(next,"mcps");
      if(!place||place.kind==="hidden")next=moveTo(next,"mcps",homeOf("mcps"));
      set(ctx,{...next,collapsed:{...next.collapsed,mcps:false}});
    });
    ctx.events.on("ai.chatOpened",()=>{
      if(!PANELS.ai)return;
      let next=layout;
      const place=locate(next,"ai");
      if(!place||place.kind==="hidden")next=moveTo(next,"ai",homeOf("ai"));
      next={...next,collapsed:{...next.collapsed,ai:false}};
      if(locate(next,"ai")?.kind==="bottom")next={...next,bottom:{...next.bottom,collapsed:false}};
      set(ctx,next);
    });
    ctx.events.on("kernel.modules.changed", () => loadModules(ctx));
    ctx.events.on("module-dev.updatesChanged", () => loadUpdates(ctx, false));
    subscribeSidebars(ctx);
    stopContributions = watchContributions(ctx, (c) => {
      const changed = applyContributions(c);
      subscribeSidebars(ctx);
      if (changed) set(ctx, repair(layout));
      else ctx.ui.invalidate();
    });
    publishPanels(ctx);
    await loadModules(ctx);
    loadUpdates(ctx, false);
  },
  deactivate() {
    stopContributions?.();
    for (const stop of sidebarSubscriptions.values()) stop();
    sidebarSubscriptions.clear();
  },
  snapshot: () => ({ showModules, showLayout, layout }),
  methods: {
    getLayout: () => layout,
    setLayout: (ctx, a) => { set(ctx, repair(a.layout)); return layout; },
    resetLayout: (ctx) => { set(ctx, defaultLayout()); return layout; },
  },
  render(): UiNode {
    const kids: UiNode[] = [{ type: "theme", key: "color-scheme", palette: appearanceTheme === "anime" ? animePalette(panelOpacity) : colorScheme, ...(appearanceTheme === "anime" ? { terminal: { light: animeTerminal, dark: animeTerminal } } : {}), typography: typography(fontFamily, fontSize, fontWeight), ...(mode === "system" ? {} : { mode }) }];
    const top = barNode("top");
    if (top) kids.push(top);
    if (!["top", "bottom"].some((b) => layout.bars[b as BarId].visible && layout.bars[b as BarId].items.includes("layoutMenu"))) {
      kids.push({ type: "row", key: "layout-access", children: [btn("open-layout", "Layout", "toggleLayoutMenu", null, "Configure panels and bars")] });
    }
    if (!["top", "bottom"].some((b) => layout.bars[b as BarId].visible && layout.bars[b as BarId].items.includes("settings"))) {
      kids.push({ type: "row", key: "settings-access", children: [btn("settings", "Settings", "openSettings", null, "Appearance and module preferences")] });
    }
    // Overlay plugins (e.g. settings) render modals; their slots must not reserve dock space.
    for (const o of contributions?.overlays || []) {
      kids.push({ type: "column", key: `overlay:${o.module}`, height: 0, children: [{ type: "slot", key: "slot", module: o.module }] });
    }
    const collapsed = collapsedPanels();
    const sidebars = (side: "left" | "right") => (side === "left" ? layout.showLeftSidebar : layout.showRightSidebar)
      ? (contributions?.sidebars || []).filter((s) => s.side === side).map((s) => ({ type: "slot", key: `sidebar:${s.module}`, module: s.module, width: s.width || 44 } as UiNode))
      : [];
    // Bars and sidebars keep classic spacing in every theme; only the panel area floats inset.
    kids.push({ type: "row", key: "workspace-content", grow: true, align: "stretch", children: [
      ...sidebars("left"),
      { type: "column", key: "workspace-panels", grow: true, ...(appearanceTheme === "anime" ? { padding: 8 } : {}), children: [dockArea(), ...(collapsed ? [collapsed] : [])] },
      ...sidebars("right"),
    ] });
    const bottom = barNode("bottom");
    if (bottom) kids.push(bottom);
    for (const [id, g] of Object.entries(layout.floating)) {
      kids.push({ type: "floating", key: "float:" + id, title: PANELS[id].title, x: g.x, y: g.y, width: g.width, height: g.height, moveAction: "moveFloat", children: [panelBody(id, "float")] } as UiNode);
    }
    for (const [id, g] of Object.entries(layout.detached)) {
      kids.push({ type: "window", key: "win:" + id, title: `Hato — ${PANELS[id].title}`, width: g.width, height: g.height, closeAction: "windowClosed", children: [panelBody(id, "window")] } as UiNode);
    }
    if (showLayout) kids.push(layoutMenu());
    if (showModules) kids.push(modulesModal());
    return { type: "column", key: "layout-root", grow: true, ...(appearanceTheme === "anime" ? { backgroundImage: animeWallpaper, style: { background: "#11152b" } } : { bg: "accent" as const }), children: kids };
  },
  async onEvent(ctx, ev) {
    const v: any = ev.value;
    const dockBack = (id: string) => moveTo(layout, id, homeOf(id));
    switch (ev.action) {
      case "toggleSidebar": {
        const side = typeof v === "boolean" ? ev.key === "left-sidebar-visible" ? "left" : ev.key === "right-sidebar-visible" ? "right" : null : v;
        if (side === "left" || side === "right") {
          const field = side === "left" ? "showLeftSidebar" : "showRightSidebar";
          set(ctx, { ...layout, [field]: typeof v === "boolean" ? v : !layout[field] });
        }
        break;
      }
      case "togglePanelControls": set(ctx, { ...layout, showPanelControls: typeof v === "boolean" ? v : !layout.showPanelControls }); break;
      case "openSettings": await ctx.modules.call("settings", "open"); break;
      case "openPlugins": await ctx.modules.call("settings", "open", { category: "plugins" }); break;
      // -- docking / panels
      case "dropPanel": {
        if (v && v.payload && v.payload.kind === "panel" && typeof v.zone === "string" && v.zone.startsWith("panel:")) {
          set(ctx, dropPanel(layout, v.payload.id, v.zone.slice(6), v.region));
        }
        break;
      }
      case "toggleCollapse": {
        const c = { ...layout.collapsed };
        c[v] = !c[v];
        const next = { ...layout, collapsed: c };
        if (!c[v] && layout.bottom.panels.includes(v)) next.bottom = { ...layout.bottom, collapsed: false };
        set(ctx, next);
        break;
      }
      case "expandBottom": {
        const c = { ...layout.collapsed };
        for (const p of layout.bottom.panels) delete c[p];
        set(ctx, { ...layout, collapsed: c, bottom: { ...layout.bottom, collapsed: false } });
        break;
      }
      case "collapse": {
        const i = v && typeof v.index === "number" ? v.index : -1;
        const c = { ...layout.collapsed };
        let next: Layout = { ...layout, collapsed: c };
        if (ev.key === "cols" && layout.columns[i]) for (const p of layout.columns[i].panels) c[p] = true;
        else if (ev.key.startsWith("col:")) { const col = layout.columns[Number(ev.key.slice(4))]; if (col && col.panels[i]) c[col.panels[i]] = true; }
        else if (ev.key === "bottom" && layout.bottom.panels[i]) c[layout.bottom.panels[i]] = true;
        else if (ev.key === "main" && i === 1) next = { ...next, bottom: { ...layout.bottom, collapsed: true } };
        set(ctx, next);
        break;
      }
      case "resize": {
        const s: number[] = v && Array.isArray(v.sizes) ? v.sizes : [];
        const next: Layout = JSON.parse(JSON.stringify(layout));
        if (ev.key === "cols" && s.length === next.columns.length) next.columns.forEach((c, i) => (c.size = s[i]));
        else if (ev.key === "main" && s.length === 2) next.mainSizes = [s[0], s[1]];
        else if (ev.key === "bottom" && s.length === next.bottom.panels.length) next.bottom.sizes = s;
        else if (ev.key.startsWith("col:")) { const col = next.columns[Number(ev.key.slice(4))]; if (col && s.length === col.panels.length) col.sizes = s; }
        set(ctx, next);
        break;
      }
      case "float": set(ctx, moveTo(layout, v, "floating")); break;
      case "detach": set(ctx, moveTo(layout, v, "detached")); break;
      case "hide": set(ctx, moveTo(layout, v, "hidden")); break;
      case "dock": set(ctx, dockBack(v)); break;
      case "toColumn": set(ctx, moveTo(layout, v, "column")); break;
      case "toBottom": set(ctx, moveTo(layout, v, "bottom")); break;
      case "moveFloat": {
        const id = ev.key.slice("float:".length);
        if (layout.floating[id] && v) set(ctx, { ...layout, floating: { ...layout.floating, [id]: { x: v.x, y: v.y, width: v.width, height: v.height } } });
        break;
      }
      case "windowClosed": set(ctx, dockBack(ev.key.slice("win:".length))); break;
      // -- bars
      case "dropBar": {
        if (!v || !v.payload || v.payload.kind !== "item") break;
        const zone: string = v.zone || "";
        if (zone.startsWith("bar:")) set(ctx, moveBarItem(layout, v.payload.id, zone.slice(4) as BarId, null));
        else if (zone.startsWith("baritem:")) {
          const [, bar, target] = zone.split(":");
          if (target !== v.payload.id) set(ctx, moveBarItem(layout, v.payload.id, bar as BarId, target, v.region === "right"));
        }
        break;
      }
      case "toggleBar": {
        const b = typeof v === "boolean" ? (ev.key === "tb" ? "top" : ev.key === "bb" ? "bottom" : null) : v;
        if (b !== "top" && b !== "bottom") break;
        set(ctx, { ...layout, bars: { ...layout.bars, [b]: { ...layout.bars[b], visible: typeof v === "boolean" ? v : !layout.bars[b].visible } } });
        break;
      }
      case "itemToBar": set(ctx, moveBarItem(layout, v.item, v.bar, null)); break;
      case "removeItem": set(ctx, removeBarItem(layout, v)); break;
      case "resetLayout": set(ctx, defaultLayout()); break;
      case "toggleLayoutMenu": showLayout = !showLayout; break;
      // -- modules window
      case "toggleModules": showModules = !showModules; diag = null; if (showModules) { await loadModules(ctx); loadUpdates(ctx, true); } break;
      case "rescan": await loadUpdates(ctx, true, true); break;
      case "activateAll": {
        busy = `Updating ${updSummary.available.join(", ")}…`; diag = null; ctx.ui.invalidate();
        try {
          const r = await ctx.modules.call("module-dev", "activateUpdates", {}, { timeoutMs: 1800000 });
          diag = r.ok ? `✓ updated ${r.results.map((x: any) => x.label).join(", ")}` : r.results.filter((x: any) => !x.ok).map((x: any) => `${x.id}: ${x.error}`).join("\n");
        } catch (e) { diag = errMsg(e); }
        busy = null;
        await loadModules(ctx);
        await loadUpdates(ctx, true);
        break;
      }
      case "rebuild":
      case "rollback": {
        const id = String(v);
        busy = `${ev.action === "rebuild" ? "Building" : "Rolling back"} ${id}…`; diag = null; ctx.ui.invalidate();
        try {
          const r = await ctx.modules.call("module-dev", ev.action === "rebuild" ? "buildAndActivate" : "rollback", { id }, { timeoutMs: 900000 });
          diag = r.ok === false ? `${id}: ${r.error || "failed"}\n${(r.diagnostics || "").slice(0, 2000)}` : `✓ ${r.label || id} active${r.swapMs !== undefined ? ` (swap ${r.swapMs} ms)` : ""}`;
        } catch (e) { diag = `${id}: ${errMsg(e)}`; }
        busy = null;
        await loadModules(ctx);
        await loadUpdates(ctx, true);
        break;
      }
    }
    ctx.ui.invalidate();
  },
};
export default mod;
