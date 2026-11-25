// Halo rail: Hato's only sidebar style. A floating card on each side of the workspace that expands
// from an icon rail to labelled navigation. The left rail is the Workspace (project switcher, run,
// panels, machine menu); the right rail is the Assistant (chats, agents, plan usage).
//
// This file is pure presentation: activity-sidebar.ts gathers data into a HaloModel and handles
// the actions named here. Motion and paint come from generic native primitives (layoutTransition,
// presence, layoutId, label reveal/tween, meter, ring, spinner).
import type { Json, UiColor, UiNode, UiStyle, UiTransition } from "./types";
import { resetText, type LimitsSnapshot } from "./usage-limits";
import { haloLogo } from "./halo-logo";
import { dockedCard, fadeLine, glassCard, glassChip, glassWell, glossyTile, glow, type SurfaceEffects } from "./halo-glass";

const svg = (paths: string, width = 1.6) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
export const haloIcons = {
  search: svg(`<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>`),
  sidebar: svg(`<rect x="3.5" y="4.5" width="17" height="15" rx="3"/><path d="M9.5 4.5v15"/>`),
  chevron: svg(`<path d="m9 6 6 6-6 6"/>`),
  updown: svg(`<path d="m8 9 4-4 4 4M8 15l4 4 4-4"/>`),
  file: svg(`<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>`),
  check: svg(`<path d="m5 12.5 4.5 4.5L19 7.5"/>`, 2),
  plus: svg(`<path d="M12 5v14M5 12h14"/>`, 1.8),
  settings: svg(`<circle cx="12" cy="12" r="3"/><path d="M12 2.8v2.4M12 18.8v2.4M4.2 7.5l2 1.2M17.8 15.3l2 1.2M4.2 16.5l2-1.2M17.8 8.7l2-1.2"/><circle cx="12" cy="12" r="7"/>`),
  plug: svg(`<path d="M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0zM12 17v4"/>`),
  layout: svg(`<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M3.5 9.5h17M10 9.5v10"/>`),
  modules: svg(`<path d="M12 3 4 7.5v9L12 21l8-4.5v-9z"/><path d="M4 7.5 12 12l8-4.5M12 12v9"/>`),
  moon: svg(`<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>`),
  chat: svg(`<path d="M5 5h14a1.5 1.5 0 0 1 1.5 1.5v9A1.5 1.5 0 0 1 19 17h-8l-4.5 3.5V17H5a1.5 1.5 0 0 1-1.5-1.5v-9A1.5 1.5 0 0 1 5 5z"/>`),
  history: svg(`<path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1"/><path d="M3.5 4.5v4h4M12 8v4.5l3 2"/>`),
  branch: svg(`<circle cx="6" cy="5.5" r="2"/><circle cx="6" cy="18.5" r="2"/><circle cx="18" cy="8" r="2"/><path d="M6 7.5v9M18 10c0 4-6 3.5-11 7"/>`),
  folder: svg(`<path d="M3.5 7a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>`),
};

type Bezier = [number, number, number, number];
const ease = { out: [0.22, 1, 0.36, 1] as Bezier, in: [0.4, 0, 1, 1] as Bezier, std: [0.2, 0, 0, 1] as Bezier, spring: [0.34, 1.36, 0.64, 1] as Bezier };
export const haloMotion = {
  width: { durationMs: 320, easing: ease.out },
  layout: { durationMs: 260, easing: ease.out },
  indicator: { durationMs: 300, easing: ease.spring },
  /** Labels decode left → right; rows stagger so the list reads top-down. */
  scramble: (row: number) => ({ effect: "scramble" as const, charMs: 22, delayMs: 60 + Math.min(row, 24) * 16, charset: "/>\\=_#%*<+:", on: "mount" as const }),
  rowPresence: { enter: { durationMs: 220, easing: ease.out, opacity: 0, offsetPx: [0, -4], heightCollapse: true },
    exit: { durationMs: 180, easing: ease.in, opacity: 0, heightCollapse: true } } as UiTransition,
  fade: { enter: { durationMs: 160, easing: ease.std, opacity: 0 }, exit: { durationMs: 110, easing: ease.in, opacity: 0 } } as UiTransition,
  menu: { enter: { durationMs: 240, easing: ease.out, opacity: 0, offsetPx: [0, 6] }, exit: { durationMs: 150, easing: ease.in, opacity: 0, offsetPx: [0, 6] } } as UiTransition,
  value: { durationMs: 600, easing: ease.out },
};

/** Card widths. The collapsed left card is wide enough for the macOS window buttons it hosts. */
export const HALO = { inset: 8, expanded: 240, collapsed: { left: 64, right: 48 }, chrome: 24 };
/** Horizontal card padding. Lives on each band (not the card) so the scroll band's padding keeps the
 *  edge indicator inside its clip. */
const PAD = 6;
export const haloSlotWidth = (side: "left" | "right", expanded: boolean) => (expanded ? HALO.expanded : HALO.collapsed[side]) + HALO.inset;
/** Window-button origin (window coordinates) for a card at the top-left inset. */
export const haloTrafficLights = { x: HALO.inset + 6, y: HALO.inset + 6 };

export interface HaloChild {
  id: string; label: string; detail?: string; selected?: boolean; busy?: boolean;
  /** Colored status dot before the label. */ dot?: UiColor;
  action: string; value: Json;
}
export interface HaloTask { id: string; label: string; detail?: string; /** Tile icon while running (default: a file). */ iconSvg?: string; progress?: number | null; state?: "running" | "done" | "error"; action?: string; value?: Json; tooltip?: string }
export interface HaloItem {
  id: string; title: string; action: string; value: Json;
  iconSvg?: string; /** Letter tile instead of an icon (projects). */ tile?: string;
  active?: boolean; badge?: number; busy?: boolean; detail?: string; tooltip?: string;
  /** Accordion children; `open` shows them, `groupAction` toggles from the chevron row. */
  children?: HaloChild[]; open?: boolean; groupAction?: string;
  /** Keep the disclosure affordance when an inline list is empty. */
  expandable?: boolean;
  tasks?: HaloTask[];
}
export interface HaloSection {
  key: string; title: string; items: HaloItem[];
  add?: { action: string; value?: Json; tooltip: string; iconSvg?: string };
  /** Native content placed under the title (e.g. a slot); expanded rails only. */
  embed?: UiNode;
  /** Collapsed rails: show every item, only the active ones, or none. */
  collapsed?: "all" | "active" | "none";
  /** Scroll the section's items on their own beyond this height (px). */
  maxHeight?: number;
  /** Progress rows directly under the title (e.g. working agents). */
  tasks?: HaloTask[];
  /** Filter chips under the title (e.g. project groups). */
  tabs?: { items: { id: string; label: string; count?: number }[]; active: string; action: string };
}
/** One provider's plan usage: up to two windows (5-hour and weekly), drawn as a double bar / double ring. */
export interface HaloUsage { id: string; name: string; windows: { label: string; usedPercent: number }[]; tooltip: string; loading?: boolean }
export interface HaloMenuItem { key: string; label: string; iconSvg: string; action: string; value?: Json; badge?: string }
export interface HaloModel {
  side: "left" | "right";
  expanded: boolean;
  /** Left: workspace header with the pigeon and an embedded branch switcher. Right: a titled header. */
  header: { title: string; subtitle?: string; embed?: UiNode; logo?: boolean };
  primary?: { label: string; iconSvg: string; action: string; tooltip: string };
  search?: { placeholder: string; query: string };
  /** Item id that carries the sliding indicator. */
  focused: string | null;
  sections: HaloSection[];
  busy: number;
  usage: HaloUsage[];
  account?: { initials: string; name: string; detail: string; badge?: number; open: boolean; menu: HaloMenuItem[]; status?: UiNode[]; darkMode: boolean };
  /** Appearance → Effects. The rail card is a large always-visible surface (default "reduced"). */
  effects?: SurfaceEffects;
}

const row = (key: string, children: UiNode[], extra: Record<string, unknown> = {}): UiNode => ({ type: "row", key, align: "center", children, ...extra } as UiNode);
const col = (key: string, children: UiNode[], extra: Record<string, unknown> = {}): UiNode => ({ type: "column", key, children, ...extra } as UiNode);
const spacer = (key = "sp"): UiNode => ({ type: "spacer", key } as UiNode);
const icon = (key: string, svgText: string, size = 16, color: UiColor = "muted", style?: UiStyle): UiNode => ({ type: "icon", key, svg: svgText, size, color, ...(style ? { style } : {}) } as UiNode);
const text = (key: string, value: string, o: { size?: number; color?: UiColor; weight?: number; mono?: boolean; spacing?: number; reveal?: Json; tween?: Json; grow?: boolean } = {}): UiNode => ({
  type: "label", key, text: value, color: o.color || "text", ...(o.grow ? { grow: true } : {}),
  style: { fontSize: o.size ?? 13, ...(o.weight ? { fontWeight: o.weight } : {}), ...(o.mono ? { font: "mono" as const } : {}), ...(o.spacing ? { letterSpacing: o.spacing } : {}) },
  ...(o.reveal ? { reveal: o.reveal } : {}), ...(o.tween ? { tween: o.tween } : {}),
} as UiNode);
const tipSide = (m: HaloModel) => (m.side === "left" ? "right" : "left") as "right" | "left";
/** Rail spinners follow the window-wide Activity animation cap (Appearance). */
const SPINNER_FPS = 60;
const spinner = (key: string, size = 12, color: UiColor = "muted"): UiNode => ({ type: "spinner", key, size, color, thickness: 1.5, fps: SPINNER_FPS } as UiNode);

/** The orange bar on the card's outer edge: one node with a shared layoutId, so it slides. */
const indicator = (m: HaloModel): UiNode => col("indicator", [], {
  layoutId: `halo-indicator-${m.side}`, layoutTransition: haloMotion.indicator,
  style: { position: "absolute", ...(m.side === "left" ? { left: -PAD } : { right: -PAD }), top: 9, width: 3, height: 14, radius: 2, background: "primary", ...glow() },
});

const letterTile = (key: string, letter: string, active: boolean, size = 18): UiNode => row(key, [text("l", letter, { size: size * 0.55, weight: 600, color: active ? "primaryText" : "muted" })], {
  style: { width: size, height: size, radius: 5, justify: "center", noShrink: true, background: active ? "primary" : "raised", borderWidth: 1, borderColor: active ? "primary" : "border" },
});

const badgeNode = (count: number, expanded: boolean): UiNode => expanded
  ? row("badge", [
      col("dot", [], { style: { width: 6, height: 6, radius: 3, background: "primary", ...glow("glow", 6, 1) } }),
      text("n", count > 99 ? "99+" : String(count), { size: 11, color: "primary", mono: true, tween: { format: "int", durationMs: 260 } }),
    ], { gap: 5, style: { noShrink: true } })
  : col("badge", [], { style: { position: "absolute", right: -4, top: -3, width: 8, height: 8, radius: 4, background: "primary", borderWidth: 1.5, borderColor: "panel", ...glow("glow", 7, 1) } });

function itemRow(m: HaloModel, item: HaloItem, index: number): UiNode[] {
  const hasChildren = item.expandable || !!item.children?.length;
  const open = m.expanded && hasChildren && !!item.open;
  const lead = item.tile !== undefined ? letterTile("tile", item.tile, !!item.active) : icon("icon", item.iconSvg || haloIcons.folder, 16, item.active ? "text" : "muted");
  const kids: UiNode[] = [];
  if (m.focused === item.id) kids.push(indicator(m));
  if (m.expanded) kids.push(lead);
  else {
    // Collapsed beacons sit on the icon's corner, so the lead is a positioning box.
    const beacon = item.badge ? badgeNode(item.badge, false)
      : item.busy ? col("busy", [spinner("s", 8, "primary")], { style: { position: "absolute", right: -5, top: -4 } }) : null;
    kids.push(row("lead", [lead, ...(beacon ? [beacon] : [])], { style: { position: "relative", noShrink: true } }));
  }
  if (m.expanded) {
    kids.push(col("text", [
      text("label", item.title, { color: item.active ? "text" : "muted", weight: item.active ? 500 : undefined, reveal: haloMotion.scramble(index) }),
      ...(item.detail ? [text("detail", item.detail, { size: 10.5, color: "faint", reveal: haloMotion.scramble(index + 1) })] : []),
    ], { grow: true, gap: 1, minWidth: 0 }));
    if (item.busy) kids.push(spinner("busy"));
    if (item.badge) kids.push(badgeNode(item.badge, true));
    if (hasChildren) kids.push(row("chev", [icon("chevron", haloIcons.chevron, 12, "faint", { rotate: open ? 90 : 0 })], {
      action: item.groupAction || item.action, value: item.value, hoverStyle: { background: "hover" }, layoutTransition: haloMotion.layout,
      style: { width: 20, height: 20, radius: 5, justify: "center", noShrink: true },
    }));
  }
  const tooltip = item.tooltip || `${item.title}${item.detail ? ` · ${item.detail}` : ""}${item.badge ? ` · ${item.badge} new` : ""}`;
  const out: UiNode[] = [row(`row:${item.id}`, kids, {
    action: item.action, value: item.value, layoutTransition: haloMotion.layout, presence: haloMotion.rowPresence,
    hoverStyle: { background: item.active ? "selection" : "hover" },
    style: {
      position: "relative", minHeight: item.detail && m.expanded ? 40 : 32, radius: 8, paddingX: m.expanded ? 9 : 0, gap: 10, justify: m.expanded ? "start" : "center",
      ...(item.active ? { background: "selection", ...glassChip } : { borderWidth: 1, borderColor: "transparent" }),
    },
    ...(m.expanded ? {} : { tooltip, tooltipPlacement: tipSide(m) }),
  })];
  if (open) out.push(row(`children:${item.id}`, [
    col("guide", [], { style: { width: 1, background: "border", noShrink: true } }),
    col("list", item.children!.map((c, i) => row(`child:${c.id}`, [
      ...(c.dot ? [col("dot", [], { style: { width: 6, height: 6, radius: 3, background: c.dot, noShrink: true } })] : []),
      text("label", c.label, { size: 12.5, color: c.selected ? "text" : "muted", weight: c.selected ? 500 : undefined, reveal: haloMotion.scramble(i), grow: true }),
      ...(c.busy ? [spinner("busy", 10)] : []),
      ...(c.detail ? [text("detail", c.detail, { size: 10.5, color: "faint", mono: true })] : []),
    ], { gap: 7, action: c.action, value: c.value, hoverStyle: { background: "hover" },
      style: { height: 26, radius: 6, paddingX: 9, ...(c.selected ? { background: "selection" } : {}) } })), { grow: true, gap: 1, minWidth: 0 }),
  ], { align: "stretch", gap: 6, presence: haloMotion.rowPresence, layoutTransition: haloMotion.layout, style: { paddingX: 0, gap: 6 } }));
  if (m.expanded) for (const t of item.tasks || []) out.push(taskRow(item.id, t));
  return out;
}

function taskRow(owner: string, t: HaloTask): UiNode {
  const done = t.state === "done", failed = t.state === "error";
  const pct = t.progress == null ? null : Math.max(0, Math.min(1, t.progress));
  return row(`task:${owner}:${t.id}`, [
    row("tile", [icon("i", done ? haloIcons.check : t.iconSvg || haloIcons.file, 14, done ? "success" : "muted")], { style: { width: 28, height: 28, radius: 7, background: "raised", justify: "center", noShrink: true } }),
    col("body", [
      row("top", [
        col("names", [text("name", t.label, { size: 12 }), ...(t.detail ? [text("detail", t.detail, { size: 10.5, color: "faint" })] : [])], { grow: true, gap: 1, minWidth: 0 }),
        done ? text("state", "Done", { size: 10.5, color: "success", mono: true, reveal: { effect: "scramble", charMs: 30, on: "change" } })
          : failed ? text("state", "Failed", { size: 10.5, color: "danger", mono: true })
          : spinner("spin", 10),
      ], { gap: 6 }),
      // Native progress takes a 0–1 fraction and animates value changes with `transition`.
      { type: "progress", key: "bar", value: done ? 1 : pct == null ? undefined : pct, indeterminate: !done && !failed && pct == null,
        color: done ? "success" : failed ? "danger" : "primary", trackColor: "meterOff", height: 2, transition: { durationMs: 420, easing: ease.out },
        ...(!done && !failed && pct !== 0 ? { style: { radius: 1, ...glow("glow", 5) } } : {}) } as UiNode,
    ], { grow: true, gap: 6, minWidth: 0 }),
  ], { gap: 9, presence: haloMotion.rowPresence, layoutTransition: haloMotion.layout,
    ...(t.action ? { action: t.action, value: t.value ?? null, hoverStyle: { borderColor: "activeBorder" }, tooltip: t.tooltip } : {}),
    style: { radius: 10, padding: 6, paddingX: 8, background: "field", ...glassChip } });
}

function sectionHead(m: HaloModel, s: HaloSection, index: number): UiNode {
  if (!m.expanded) return row(`head:${s.key}`, [
    col("rule-l", [], { style: { width: 12, height: 1, ...fadeLine("right") } }), col("rule-r", [], { style: { width: 12, height: 1, ...fadeLine("left") } }),
  ], { style: { height: 13, justify: "center" } });
  return row(`head:${s.key}`, [
    text("t", s.title.toUpperCase(), { size: 9, color: "faint", mono: true, spacing: 1.8, reveal: haloMotion.scramble(index), grow: true }),
    ...(s.add ? [row("add", [icon("i", s.add.iconSvg || haloIcons.plus, 12, "faint")], { action: s.add.action, value: s.add.value ?? null, tooltip: s.add.tooltip,
      hoverStyle: { background: "hover" }, style: { width: 20, height: 20, radius: 5, justify: "center" } })] : []),
  ], { style: { height: 24, paddingX: 9 } });
}

function header(m: HaloModel): UiNode[] {
  const left = m.side === "left";
  // Only the left card needs a strip above its header: it hosts the macOS window buttons. The right
  // card starts with its header, whose title area drags the window.
  const chrome: UiNode[] = left ? [row("chrome", [], { windowDrag: true, visibleWhen: "windowed", style: { height: HALO.chrome, noShrink: true } })] : [{ type: "column", key: "chrome", height: 6, children: [] } as UiNode];
  if (!m.expanded) {
    const top = left
      ? row("logo", [{ type: "image", key: "pigeon", image: haloLogo, width: 30, height: 30 } as UiNode], {
          action: "expand", value: true, tooltip: `${m.header.title} · Expand`, tooltipPlacement: "right", style: { width: 30, height: 30, radius: 9, clip: true, ...glossyTile } })
      : row("expand", [icon("i", haloIcons.sidebar, 16, "muted")], { action: "expand", value: true, tooltip: "Expand", tooltipPlacement: "left", hoverStyle: { background: "hover" },
          style: { width: 32, height: 30, radius: 8, justify: "center" } });
    return [...chrome, row("header", [top], { style: { height: 40, justify: "center" } })];
  }
  const collapse: UiNode = row("collapse", [icon("i", haloIcons.sidebar, 15, "faint")], { action: "expand", value: false, tooltip: "Collapse", hoverStyle: { background: "hover" },
    style: { width: 28, height: 28, radius: 8, justify: "center", noShrink: true, background: "raised", ...glassChip } });
  const title = col("title", [
    text("name", m.header.title, { size: 14, weight: 600, reveal: haloMotion.scramble(0) }),
    ...(m.header.subtitle ? [text("sub", m.header.subtitle, { size: 10.5, color: "faint", reveal: haloMotion.scramble(1) })] : []),
  ], { grow: true, gap: 1, minWidth: 0, ...(left ? {} : { windowDrag: true }) });
  const head = row("header", [
    ...(m.header.logo ? [row("logo", [{ type: "image", key: "pigeon", image: haloLogo, width: 30, height: 30 } as UiNode], { style: { width: 30, height: 30, radius: 9, clip: true, noShrink: true, ...glossyTile } })] : []),
    title, collapse,
  ], { gap: 10, style: { height: 40, paddingX: 3 } });
  return [...chrome, head, ...(m.header.embed ? [row("header-embed", [m.header.embed], { style: { paddingX: 0, height: 28, justify: "start" } })] : [])];
}

function searchNode(m: HaloModel): UiNode | null {
  if (!m.search) return null;
  if (!m.expanded) return row("search", [icon("i", haloIcons.search, 15)], { action: "expand", value: true, tooltip: m.search.placeholder, tooltipPlacement: tipSide(m),
    hoverStyle: { background: "hover" }, style: { height: 32, radius: 9, justify: "center", background: "raised", ...glassChip } });
  return row("search", [
    icon("i", haloIcons.search, 15, "faint"),
    { type: "textInput", key: "q", value: m.search.query, placeholder: m.search.placeholder, bare: true, grow: true, minWidth: 0,
      changeAction: "query", submitAction: "querySubmit", cancelAction: "queryClear" } as UiNode,
    row("key", [text("k", m.search.query ? "esc" : "↵", { size: 10, color: "faint", mono: true })], {
      style: { height: 20, paddingX: 6, radius: 6, noShrink: true, background: "raised", borderWidth: 1, borderColor: "glassEdge", shadows: [{ y: 1, color: "highlight", inset: true }] } }),
  ], { gap: 8, style: { height: 36, radius: 10, paddingX: 10, background: "field", ...glassChip } });
}

function primaryNode(m: HaloModel): UiNode | null {
  if (!m.primary) return null;
  const p = m.primary;
  return m.expanded
    ? row("primary", [icon("i", p.iconSvg, 15, "primaryText"), text("l", p.label, { size: 13, weight: 500, color: "primaryText", reveal: haloMotion.scramble(1) })], {
        gap: 9, action: p.action, value: null, tooltip: p.tooltip, hoverStyle: { background: "primaryHover" }, pressedStyle: { background: "primaryActive" },
        style: { height: 34, radius: 9, paddingX: 10, background: "primary", shadows: [{ y: 1, color: "#ffffff26", inset: true }, { y: 3, blur: 10, color: "glow" }] } })
    : row("primary", [icon("i", p.iconSvg, 16, "primaryText")], { action: p.action, value: null, tooltip: p.tooltip, tooltipPlacement: tipSide(m),
        hoverStyle: { background: "primaryHover" }, style: { height: 32, radius: 9, justify: "center", background: "primary", shadows: [{ y: 1, color: "#ffffff26", inset: true }, { y: 2, blur: 8, color: "glow" }] } });
}

const usageTone = (used: number): UiColor => used >= 90 ? "danger" : used >= 70 ? "warning" : "meterOn";
const clampPct = (n: number) => Math.max(0, Math.min(100, n));

/** Collapsed: concentric rings, outer = 5 h window, inner = weekly. */
function usageRings(u: HaloUsage): UiNode {
  const [outer, inner] = u.windows;
  const ring = (key: string, w: { usedPercent: number }, size: number, thickness: number, style: Record<string, unknown> = {}): UiNode =>
    ({ type: "ring", key, value: clampPct(w.usedPercent), max: 100, size, thickness, color: usageTone(w.usedPercent), trackColor: "meterOff", transition: haloMotion.value, style } as UiNode);
  return row(`ring:${u.id}`, [
    row("rings", [
      ring("outer", outer!, 26, 2.5),
      ...(inner ? [ring("inner", inner, 16, 2, { position: "absolute", left: 5, top: 5 })] : []),
    ], { style: { position: "relative", width: 26, height: 26 } }),
  ], { action: "usage", value: u.id, tooltip: u.tooltip, tooltipPlacement: "left", hoverStyle: { background: "hover" }, style: { height: 34, radius: 8, justify: "center" } });
}

/** Expanded: provider title, then one segmented bar per window with its label and value. */
function usageBars(u: HaloUsage, i: number): UiNode {
  return col(`meter:${u.id}`, [
    row("head", [
      text("t", u.name.toUpperCase(), { size: 9, color: "faint", mono: true, spacing: 1.6, reveal: haloMotion.scramble(i), grow: true }),
      ...(u.loading ? [spinner("s", 9)] : []),
    ], { gap: 6 }),
    ...u.windows.map((w, k): UiNode => row(`w${k}`, [
      text("l", w.label.toUpperCase(), { size: 9, color: "faint", mono: true }),
      { type: "meter", key: "bar", value: clampPct(w.usedPercent), max: 100, segments: k === 0 ? 28 : 28, filledColor: usageTone(w.usedPercent), emptyColor: "meterOff", highlightColor: "primary",
        segmentWidth: 3, segmentHeight: k === 0 ? 10 : 6, gap: 2.2, radius: 1.5, transition: haloMotion.value, grow: true } as UiNode,
      text("v", `${Math.round(clampPct(w.usedPercent))}%`, { size: 9, color: "muted", mono: true, tween: { format: "percent", durationMs: 500 } }),
    ], { gap: 7 })),
  ], { gap: 5, action: "usage", value: u.id, tooltip: u.tooltip, hoverStyle: { background: "hover" }, style: { radius: 8, padding: 6 } });
}

function usageNode(m: HaloModel): UiNode | null {
  if (!m.usage.length) return null;
  return col("usage", m.expanded ? m.usage.map(usageBars) : m.usage.map(usageRings),
    { gap: m.expanded ? 4 : 2, presence: haloMotion.fade, style: { paddingY: 6, borderTop: 1, borderColor: "border" } });
}

function avatar(initials: string, badge?: number): UiNode {
  return row("avatar", [
    text("i", initials, { size: 10, weight: 600, mono: true }),
    col("presence", [], { style: { position: "absolute", right: -1, bottom: -1, width: 8, height: 8, radius: 4, background: "success", borderWidth: 2, borderColor: "panel" } }),
    ...(badge ? [col("badge", [], { style: { position: "absolute", right: -2, top: -2, width: 8, height: 8, radius: 4, background: "primary", borderWidth: 2, borderColor: "panel", ...glow("glow", 7, 1) } })] : []),
  ], { style: { position: "relative", width: 28, height: 28, radius: 14, background: "raised", borderWidth: 1, borderColor: "border", justify: "center", noShrink: true } });
}

function accountMenu(a: NonNullable<HaloModel["account"]>): UiNode {
  const enter = { enter: { ...haloMotion.fade.enter!, offsetPx: [0, 4] as [number, number] } };
  const item = (it: HaloMenuItem, i: number): UiNode => row(it.key, [
    icon("i", it.iconSvg, 15), text("l", it.label, { size: 12.5, grow: true }),
    ...(it.badge ? [text("b", it.badge, { size: 10.5, color: "primary", mono: true })] : []),
  ], { gap: 10, action: it.action, value: it.value ?? null, hoverStyle: { background: "hover" }, presence: enter, presenceDelayMs: 30 * i, style: { height: 30, radius: 7, paddingX: 8 } });
  return { type: "popover", key: "account-menu", closeAction: "account", bottom: 52, left: 0, right: 0, anchorScope: "container", transition: haloMotion.menu, clipReveal: true,
    children: [col("menu", [
      ...a.menu.map(item),
      ...(a.status?.length ? [col("rule-1", [], { style: { height: 1, background: "border" } }), col("status", a.status, { gap: 4, style: { paddingX: 8, paddingY: 4 } })] : []),
      col("rule-2", [], { style: { height: 1, background: "border" } }),
      row("dark", [
        icon("i", haloIcons.moon, 15), text("l", "Dark mode", { size: 12.5, grow: true }),
        { type: "switch", key: "s", label: "", checked: a.darkMode, action: "darkMode", accent: "meterOn" } as UiNode,
      ], { gap: 10, presence: enter, presenceDelayMs: 30 * a.menu.length, style: { height: 32, radius: 7, paddingX: 8 } }),
    ], { gap: 2, style: { padding: 5, radius: 12, background: "panel", borderWidth: 1, borderColor: "glassEdge", ...glassCard } })],
  } as UiNode;
}

function footer(m: HaloModel): UiNode[] {
  const out: UiNode[] = [];
  if (!m.expanded && m.busy && m.side === "right") out.push(row("busy", [spinner("s", 14, "text")], { presence: haloMotion.fade, tooltip: `${m.busy} agent${m.busy === 1 ? "" : "s"} working`, tooltipPlacement: tipSide(m), style: { height: 28, justify: "center" } }));
  const a = m.account;
  if (!a) return out;
  if (!m.expanded) {
    out.push(row("account", [avatar(a.initials, a.badge)], { action: "expand", value: true, tooltip: `${a.name} · ${a.detail}`, tooltipPlacement: tipSide(m), style: { height: 44, justify: "center" } }));
    return out;
  }
  out.push(col("footer", [
    ...(a.open ? [accountMenu(a)] : []),
    row("account", [
      avatar(a.initials, a.badge),
      col("who", [text("n", a.name, { size: 12.5, weight: 500, reveal: haloMotion.scramble(1) }), text("d", a.detail, { size: 10.5, color: "faint", reveal: haloMotion.scramble(2) })], { grow: true, gap: 1, minWidth: 0 }),
      icon("ud", haloIcons.updown, 13, "faint"),
    ], { gap: 9, action: "account", value: !a.open, hoverStyle: { background: "hover" },
      style: { height: 46, radius: 11, paddingX: 6, ...glassWell } }),
  ], { style: { position: "relative" } }));
  return out;
}

function tabsNode(s: HaloSection): UiNode {
  const t = s.tabs!;
  return row(`tabs:${s.key}`, t.items.map((it): UiNode => {
    const on = it.id === t.active;
    return row(`tab:${it.id}`, [
      text("l", it.label, { size: 11.5, color: on ? "text" : "muted", weight: on ? 500 : undefined }),
      ...(it.count != null ? [text("n", String(it.count), { size: 10, color: "faint", mono: true })] : []),
    ], { gap: 5, action: t.action, value: it.id, hoverStyle: { background: on ? "selection" : "hover" }, layoutTransition: haloMotion.layout,
      style: { height: 24, radius: 7, paddingX: 8, ...(on ? { background: "selection", ...glassChip } : { borderWidth: 1, borderColor: "transparent" }) } });
  }), { wrap: true, gap: 3, style: { paddingX: 3, paddingY: 2 } });
}

export function haloRail(m: HaloModel): UiNode {
  let index = 2;
  const top: UiNode[] = [...header(m)];
  const search = searchNode(m); if (search) top.push(search);
  const primary = primaryNode(m); if (primary) top.push(primary);
  // Each section is a padded lane: scroll views clip to their content box, and the edge indicator
  // draws in the lane's padding. A section with maxHeight scrolls on its own.
  const lane = (key: string, kids: UiNode[]): UiNode => col(key, kids, { gap: 2, style: { paddingX: PAD, clip: false } });
  const list: UiNode[] = [];
  for (const s of m.sections) {
    const items = m.expanded ? s.items : s.collapsed === "none" ? [] : s.collapsed === "active" ? s.items.filter(i => i.active) : s.items;
    const tasks = m.expanded ? s.tasks || [] : [];
    if (!items.length && !tasks.length && !(m.expanded && (s.embed || s.add))) continue;
    const head: UiNode[] = [sectionHead(m, s, index++)];
    if (m.expanded && s.tabs && s.tabs.items.length > 1) head.push(tabsNode(s));
    if (m.expanded && s.embed) head.push(row(`embed:${s.key}`, [s.embed], { style: { paddingX: 3 } }));
    for (const t of tasks) head.push(taskRow(s.key, t));
    const rows = items.flatMap(item => itemRow(m, item, index++));
    if (m.expanded && s.maxHeight) list.push(lane(`lane:${s.key}`, head), col(`scroll:${s.key}`, [lane(`lane:${s.key}:items`, rows)], { scroll: true, maxHeight: s.maxHeight, style: { noShrink: true } }));
    else list.push(lane(`lane:${s.key}`, [...head, ...rows]));
  }
  const bottom: UiNode[] = [];
  const usage = usageNode(m); if (usage) bottom.push(usage);
  bottom.push(...footer(m));
  const card = col("halo-card", [
    col("top", top, { gap: 3, style: { paddingX: PAD, noShrink: true } }),
    // The middle band scrolls; header and footer stay put.
    col("sections", list, { grow: true, scroll: true, gap: 2, style: { paddingY: 4 } }),
    col("bottom", bottom, { gap: 3, style: { paddingX: PAD, noShrink: true } }),
  ], { grow: true, gap: 0, style: { position: "relative", radius: 16, background: "panel", borderWidth: 1, borderColor: "glassEdge", clip: true, ...dockedCard(m.effects ?? "reduced") } });
  const gutter = col("gutter", [], { width: HALO.inset, style: { width: HALO.inset, noShrink: true } });
  return row("halo", m.side === "left" ? [gutter, card] : [card, gutter], { grow: true, align: "stretch", style: { paddingY: HALO.inset } });
}

/** Usage per provider from `acp.limits`: the first two windows (5 h, then weekly). */
export function haloUsage(limits: Record<string, LimitsSnapshot | null> | null | undefined): HaloUsage[] {
  const out: HaloUsage[] = [];
  for (const [provider, snap] of Object.entries(limits || {})) {
    const all = snap?.windows || [];
    const hours = all.find(w => /five_hour|5h|5-hour/i.test(`${w.id} ${w.label}`)) || all[0];
    const week = all.find(w => w !== hours && /^(wk|week|weekly)$|seven_day$/i.test(String(w.label).trim()) || w.id === "seven_day") || all.find(w => w !== hours && /wk|week/i.test(w.label));
    const windows = [hours, week].filter((w): w is NonNullable<typeof w> => !!w).map(w => ({ label: /wk|week/i.test(w.label) ? "wk" : /5/.test(w.label) ? "5h" : w.label.slice(0, 3), usedPercent: Number(w.usedPercent) || 0 }));
    if (!windows.length) continue;
    const name = provider === "claude" ? "Claude" : provider === "codex" ? "Codex" : provider[0]!.toUpperCase() + provider.slice(1);
    const lines = [`${name} plan usage`, ...snap!.windows.map(x => {
      const reset = resetText(x);
      return `${x.label}: ${Math.round(x.usedPercent)}% used · ${Math.round(Math.max(0, 100 - x.usedPercent))}% left${reset ? ` · ${reset}` : ""}`;
    })];
    if (snap!.error) lines.push(`⚠ ${snap!.error}`);
    lines.push(snap!.loading ? "Checking…" : "Click to refresh");
    out.push({ id: provider, name, windows, tooltip: lines.join("\n"), loading: !!snap!.loading });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
