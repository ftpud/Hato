// Pure layout model for workspace-layout (no host calls, unit-testable).
// Every panel lives in exactly one place: a column stack, the bottom dock, floating, a detached
// OS window, or hidden. Bars (top/bottom) hold an ordered list of items.

export interface PanelDef {
  slot: string; title: string; defaultHidden?: boolean;
  /** When shown from hidden, stack below this panel if it is docked in a column. */ dockBelow?: string;
  /** Default placement. */ dock?: "bottom" | { column: number; size?: number };
  /** Cannot be toggled from activity sidebars. */ pinned?: boolean;
}

/** Panels contributed by enabled plugins (manifest `contributes.panels`). Replaced by setPanels. */
export const PANELS: Record<string, PanelDef> = {};

/** Replace the panel registry in place (other modules hold a reference to PANELS). */
export function setPanels(defs: Record<string, PanelDef>) {
  for (const k of Object.keys(PANELS)) delete PANELS[k];
  Object.assign(PANELS, defs);
}

export function panelSignature(): string {
  return JSON.stringify(Object.keys(PANELS).sort().map((id) => [id, PANELS[id].slot]));
}

export interface BarItemDef { title: string; grow?: boolean; spacer?: boolean; /** Contributed: module rendered in a slot. */ slot?: string; width?: number; defaultBar?: BarId }
export const BAR_ITEMS: Record<string, BarItemDef> = {
  toolbarGap: { title: "Toolbar gap", spacer: true },
  toolbarSpace: { title: "Flexible toolbar space", spacer: true, grow: true },
  title: { title: "App title" },
  workspace: { title: "Active workspace", grow: true },
  layoutMenu: { title: "Layout menu" },
  settings: { title: "Settings button" },
  modules: { title: "Modules button" },
  machine: { title: "Execution machine" },
  versions: { title: "Module versions", grow: true },
  approvals: { title: "Approvals indicator" },
};

export type BarId = "top" | "bottom";

/** Replace plugin-contributed bar items in place, keeping built-ins. Returns whether they changed. */
export function setContributedBarItems(defs: Record<string, BarItemDef>): boolean {
  const sig = (o: Record<string, BarItemDef>) => JSON.stringify(Object.keys(o).filter(k => o[k].slot).sort().map(k => [k, o[k].slot, o[k].width, o[k].defaultBar]));
  const before = sig(BAR_ITEMS);
  for (const k of Object.keys(BAR_ITEMS)) if (BAR_ITEMS[k].slot) delete BAR_ITEMS[k];
  for (const [k, d] of Object.entries(defs)) if (!BAR_ITEMS[k] || BAR_ITEMS[k].slot) BAR_ITEMS[k] = { ...d };
  return before !== sig(BAR_ITEMS);
}
const contributedBarIds = () => Object.keys(BAR_ITEMS).filter(k => BAR_ITEMS[k].slot);
/** Place contributed items not seen before on their default bar (bottom: before trailing controls). */
function placeNewBarItems(l: Layout) {
  const seen = new Set(Array.isArray(l.barItemsSeen) ? l.barItemsSeen.filter(x => typeof x === "string") : []);
  for (const id of contributedBarIds()) {
    if (seen.has(id) || l.bars.top.items.includes(id) || l.bars.bottom.items.includes(id)) { seen.add(id); continue; }
    const bar = BAR_ITEMS[id].defaultBar || "bottom";
    const items = l.bars[bar].items;
    const at = bar === "bottom" ? items.indexOf("approvals") : items.indexOf("toolbarGap");
    if (at >= 0) items.splice(at, 0, id); else items.push(id);
    seen.add(id);
  }
  l.barItemsSeen = [...seen].slice(0, 256);
}
export interface Column { panels: string[]; size: number; sizes: number[] }
export interface Layout {
  v: 1;
  settingsButton?: true;
  showPanelControls: boolean;
  /** Show the "Collapsed" tray of restore buttons under the panels. */
  showCollapsedTray: boolean;
  showLeftSidebar: boolean;
  showRightSidebar: boolean;
  columns: Column[];
  bottom: { panels: string[]; sizes: number[]; collapsed: boolean };
  mainSizes: [number, number];
  collapsed: Record<string, boolean>;
  floating: Record<string, { x: number; y: number; width: number; height: number }>;
  detached: Record<string, { width: number; height: number }>;
  hidden: string[];
  bars: Record<BarId, { visible: boolean; items: string[] }>;
  /** Contributed bar items already offered once, so a user's removal sticks. */
  barItemsSeen?: string[];
}

export function defaultLayout(): Layout {
  const d = baseLayout();
  placeNewBarItems(d);
  return d;
}
function baseLayout(): Layout {
  const ids = Object.keys(PANELS).filter((id) => !PANELS[id].defaultHidden);
  const byColumn = new Map<number, { panels: string[]; size: number }>();
  const bottom: string[] = [];
  for (const id of ids) {
    const dock = PANELS[id].dock;
    if (dock === "bottom") { bottom.push(id); continue; }
    const col = dock && Number.isFinite(dock.column) ? dock.column : 1000;
    const entry = byColumn.get(col) || { panels: [], size: 0 };
    entry.panels.push(id);
    entry.size = Math.max(entry.size, dock && typeof dock === "object" && dock.size ? dock.size : 0.25);
    byColumn.set(col, entry);
  }
  const columns = [...byColumn.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => ({ panels: c.panels, size: c.size, sizes: c.panels.map(() => 1 / c.panels.length) }));
  const total = columns.reduce((a, c) => a + c.size, 0) || 1;
  columns.forEach((c) => (c.size = c.size / total));
  return {
    v: 1,
    settingsButton: true,
    showPanelControls: true,
    showCollapsedTray: true,
    showLeftSidebar: true,
    showRightSidebar: true,
    columns,
    bottom: { panels: bottom, sizes: bottom.map(() => 1 / bottom.length), collapsed: false },
    mainSizes: [0.76, 0.24],
    collapsed: {},
    floating: {},
    detached: {},
    hidden: Object.keys(PANELS).filter((id) => PANELS[id].defaultHidden),
    bars: {
      top: { visible: true, items: ["title", "workspace", "toolbarGap", "layoutMenu", "settings"] },
      bottom: { visible: true, items: ["machine", "toolbarSpace", "approvals", "modules"] },
    },
  };
}

/** Where a hidden or re-docked panel goes by default. */
export function homeOf(id: string): "bottom" | "column" { return PANELS[id]?.dock === "bottom" ? "bottom" : "column"; }

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const norm = (xs: number[]) => {
  const weights = xs.map((x) => Number.isFinite(x) && x > 0 ? x : 1);
  const s = weights.reduce((a, b) => a + b, 0);
  return weights.map((x) => x / s);
};

/** Where a panel currently lives. */
export function locate(l: Layout, id: string): { kind: "column"; col: number; idx: number } | { kind: "bottom"; idx: number } | { kind: "floating" } | { kind: "detached" } | { kind: "hidden" } | null {
  for (let c = 0; c < l.columns.length; c++) {
    const i = l.columns[c].panels.indexOf(id);
    if (i >= 0) return { kind: "column", col: c, idx: i };
  }
  const b = l.bottom.panels.indexOf(id);
  if (b >= 0) return { kind: "bottom", idx: b };
  if (l.floating[id]) return { kind: "floating" };
  if (l.detached[id]) return { kind: "detached" };
  if (l.hidden.includes(id)) return { kind: "hidden" };
  return null;
}

/** Remove a panel from wherever it is; drop empty columns; renormalize sizes. */
export function detach(l: Layout, id: string): Layout {
  const n = clone(l);
  for (const c of n.columns) {
    const i = c.panels.indexOf(id);
    if (i >= 0) { c.panels.splice(i, 1); c.sizes.splice(i, 1); c.sizes = norm(c.sizes); }
  }
  const before = n.columns.length;
  n.columns = n.columns.filter((c) => c.panels.length > 0);
  if (n.columns.length !== before) {
    const s = norm(n.columns.map((c) => c.size));
    n.columns.forEach((c, i) => (c.size = s[i]));
  }
  const b = n.bottom.panels.indexOf(id);
  if (b >= 0) { n.bottom.panels.splice(b, 1); n.bottom.sizes.splice(b, 1); n.bottom.sizes = norm(n.bottom.sizes); }
  delete n.floating[id];
  delete n.detached[id];
  n.hidden = n.hidden.filter((h) => h !== id);
  return n;
}

/** Drop `id` relative to panel `target` at `region` (left/right/top/bottom/center). */
export function dropPanel(l: Layout, id: string, target: string, region: string): Layout {
  if (id === target || !PANELS[id]) return l;
  let n = detach(l, id);
  const t = locate(n, target);
  if (!t) return l;
  if (t.kind === "column") {
    const col = n.columns[t.col];
    if (region === "left" || region === "right") {
      const half = col.size / 2;
      col.size = half;
      n.columns.splice(t.col + (region === "right" ? 1 : 0), 0, { panels: [id], size: half, sizes: [1] });
    } else {
      const at = t.idx + (region === "top" ? 0 : 1);
      col.panels.splice(at, 0, id);
      const each = 1 / col.panels.length;
      col.sizes = norm([...col.sizes.slice(0, at).map((x) => x * (1 - each)), each, ...col.sizes.slice(at).map((x) => x * (1 - each))]);
    }
  } else if (t.kind === "bottom") {
    const at = t.idx + (region === "left" || region === "top" ? 0 : 1);
    n.bottom.panels.splice(at, 0, id);
    n.bottom.sizes = norm([...n.bottom.sizes.slice(0, at), 1 / n.bottom.panels.length, ...n.bottom.sizes.slice(at)]);
  } else {
    return l;
  }
  const s = norm(n.columns.map((c) => c.size));
  n.columns.forEach((c, i) => (c.size = s[i]));
  return n;
}

export function moveTo(l: Layout, id: string, where: "column" | "bottom" | "floating" | "detached" | "hidden", geom?: any): Layout {
  if (!PANELS[id]) return l;
  let n = detach(l, id);
  if (where === "bottom") { n.bottom.panels.push(id); n.bottom.sizes = norm([...n.bottom.sizes, 1 / n.bottom.panels.length]); n.bottom.collapsed = false; }
  else if (where === "column") { n.columns.push({ panels: [id], size: 0.25, sizes: [1] }); const s = norm(n.columns.map((c) => c.size)); n.columns.forEach((c, i) => (c.size = s[i])); }
  else if (where === "floating") n.floating[id] = geom || { x: 120, y: 120, width: 520, height: 380 };
  else if (where === "detached") n.detached[id] = geom || { width: 760, height: 540 };
  else n.hidden.push(id);
  return n;
}

export function moveBarItem(l: Layout, item: string, bar: BarId, beforeItem: string | null, after = false): Layout {
  if (!Object.prototype.hasOwnProperty.call(BAR_ITEMS, item) || (bar !== "top" && bar !== "bottom")) return l;
  const n = clone(l);
  for (const b of ["top", "bottom"] as BarId[]) n.bars[b].items = n.bars[b].items.filter((x) => x !== item);
  const list = n.bars[bar].items;
  let at = beforeItem ? list.indexOf(beforeItem) : list.length;
  if (at < 0) at = list.length;
  else if (after) at += 1;
  list.splice(at, 0, item);
  n.bars[bar].visible = true;
  return n;
}

export function removeBarItem(l: Layout, item: string): Layout {
  const n = clone(l);
  for (const b of ["top", "bottom"] as BarId[]) n.bars[b].items = n.bars[b].items.filter((x) => x !== item);
  return n;
}

/** Repair a persisted layout: unknown ids dropped, missing panels docked, sizes normalized. */
export function repair(raw: any): Layout {
  const d = defaultLayout();
  if (!raw || raw.v !== 1) return d;
  const l: Layout = { ...d, ...clone(raw), bars: { top: { ...d.bars.top, ...(raw.bars?.top || {}) }, bottom: { ...d.bars.bottom, ...(raw.bars?.bottom || {}) } } };
  const seen = new Set<string>();
  const keep = (id: string) => { if (!Object.prototype.hasOwnProperty.call(PANELS, id) || seen.has(id)) return false; seen.add(id); return true; };
  l.columns = (Array.isArray(l.columns) ? l.columns : []).map((c: any) => {
    c = c && typeof c === "object" ? c : {};
    const panels = (Array.isArray(c?.panels) ? c.panels : []).filter(keep);
    const sizes = norm(panels.map((_: any, i: number) => (Array.isArray(c.sizes) && c.sizes[i] > 0 ? c.sizes[i] : 1 / Math.max(1, panels.length))));
    return { panels, sizes, size: c.size > 0 ? c.size : 0.25 };
  }).filter((c) => c.panels.length);
  const cs = norm(l.columns.map((c) => c.size));
  l.columns.forEach((c, i) => (c.size = cs[i]));
  const bp = (Array.isArray(l.bottom?.panels) ? l.bottom.panels : []).filter(keep);
  l.bottom = { panels: bp, sizes: norm(bp.map((_: any, i: number) => l.bottom?.sizes?.[i] > 0 ? l.bottom.sizes[i] : 1)), collapsed: !!l.bottom?.collapsed };
  l.floating = l.floating && typeof l.floating === "object" && !Array.isArray(l.floating) ? l.floating : {};
  l.detached = l.detached && typeof l.detached === "object" && !Array.isArray(l.detached) ? l.detached : {};
  for (const k of Object.keys(l.floating)) if (!keep(k)) delete l.floating[k];
  for (const k of Object.keys(l.detached || {})) if (!keep(k)) delete l.detached[k];
  l.hidden = (Array.isArray(l.hidden) ? l.hidden : []).filter(keep);
  for (const id of Object.keys(PANELS)) {
    if (seen.has(id)) continue;
    if (PANELS[id].defaultHidden) l.hidden.push(id);
    else if (homeOf(id) === "bottom") { l.bottom.panels.push(id); l.bottom.sizes = norm([...l.bottom.sizes, 1 / l.bottom.panels.length]); }
    else if (l.columns.length) { const last = l.columns[l.columns.length - 1]; last.panels.push(id); last.sizes = norm([...last.sizes, 0.3]); }
    else l.columns.push({ panels: [id], size: 1, sizes: [1] });
  }
  const ms = Array.isArray(l.mainSizes) && l.mainSizes.length === 2 ? norm(l.mainSizes) : d.mainSizes;
  l.mainSizes = [ms[0], ms[1]];
  for (const b of ["top", "bottom"] as BarId[]) {
    const s2 = new Set<string>();
    l.bars[b].items = (Array.isArray(l.bars[b].items) ? l.bars[b].items : []).filter((x: string) => Object.prototype.hasOwnProperty.call(BAR_ITEMS, x) && !s2.has(x) && s2.add(x) && !(b === "bottom" && l.bars.top.items.includes(x)));
    l.bars[b].visible = l.bars[b].visible !== false;
  }
  l.barItemsSeen = Array.isArray(raw.barItemsSeen) ? raw.barItemsSeen : [];
  placeNewBarItems(l);
  // Add Settings once to layouts saved before the Settings module existed.
  if (!raw.settingsButton && !l.bars.top.items.includes("settings") && !l.bars.bottom.items.includes("settings")) l.bars.top.items.push("settings");
  l.bars.top.visible = true;
  l.settingsButton = true;
  l.showPanelControls = raw.showPanelControls !== false;
  l.showCollapsedTray = raw.showCollapsedTray !== false;
  l.showLeftSidebar = raw.showLeftSidebar !== false;
  l.showRightSidebar = raw.showRightSidebar !== false;
  l.collapsed = l.collapsed && typeof l.collapsed === "object" && !Array.isArray(l.collapsed) ? l.collapsed : {};
  for (const [id, g] of Object.entries(l.floating)) {
    const fallback = { x: 120, y: 120, width: 520, height: 380 };
    l.floating[id] = { ...fallback };
    for (const k of ["x", "y", "width", "height"] as const) {
      if (Number.isFinite(g?.[k]) && (k === "x" || k === "y" || g[k] > 0)) l.floating[id][k] = g[k];
    }
  }
  for (const [id, g] of Object.entries(l.detached)) {
    l.detached[id] = { width: Number.isFinite(g?.width) && g.width > 0 ? g.width : 760, height: Number.isFinite(g?.height) && g.height > 0 ? g.height : 540 };
  }
  return l;
}
