// Plugin contributions: modules describe what they add to the shell (panels, sidebars, overlays,
// bar items) in `manifest.json` → `contributes`. The kernel only forwards this data; layouts and
// sidebars interpret it here, so a user plugin can add a panel without editing the layout.
import type { ModuleContext, PluginInfo } from "./types";

export interface PanelContribution {
  /** Stable panel id used in persisted layouts. */
  id: string;
  title: string;
  /** Module rendered inside the panel (defaults to the contributing plugin). */
  module?: string;
  defaultHidden?: boolean;
  /** When shown from hidden, stack below this panel if it is docked in a column. */
  dockBelow?: string;
  /** Default placement: "bottom" dock, or a column index (columns are ordered by index). */
  dock?: "bottom" | { column: number; size?: number };
  /** Panels that cannot be hidden from activity bars (e.g. the main editor area). */
  pinned?: boolean;
  /** Button in an activity sidebar. `icon` names an SDK sidebar icon; `iconSvg` is inline SVG. */
  activity?: { side: "left" | "right"; order?: number; icon?: string; iconSvg?: string; /** Tooltip label (defaults to the panel title). */ title?: string };
}

export interface SidebarContribution { module: string; side: "left" | "right"; width?: number; order?: number }
export interface OverlayContribution { module: string }

export interface Contributions {
  plugins: PluginInfo[];
  panels: Record<string, PanelContribution & { module: string; plugin: string }>;
  sidebars: SidebarContribution[];
  overlays: OverlayContribution[];
}

const isObj = (x: unknown): x is Record<string, any> => !!x && typeof x === "object" && !Array.isArray(x);
const isId = (x: unknown): x is string => typeof x === "string" && /^[a-z0-9][a-z0-9._-]{0,47}$/i.test(x);

/** Validate contributions of enabled plugins. Malformed entries are skipped, never thrown. */
export function collectContributions(plugins: PluginInfo[]): Contributions {
  const out: Contributions = { plugins, panels: {}, sidebars: [], overlays: [] };
  for (const p of plugins) {
    if (!p.enabled || !isObj(p.contributes)) continue;
    const c = p.contributes;
    for (const panel of Array.isArray(c.panels) ? c.panels : []) {
      if (!isObj(panel) || !isId(panel.id) || out.panels[panel.id]) continue;
      const module = isId(panel.module) ? panel.module : p.id;
      const dock = panel.dock === "bottom" ? "bottom" as const
        : isObj(panel.dock) && Number.isFinite(panel.dock.column) ? { column: Number(panel.dock.column), size: Number.isFinite(panel.dock.size) && panel.dock.size > 0 ? Number(panel.dock.size) : undefined }
        : undefined;
      const activity = isObj(panel.activity) && (panel.activity.side === "left" || panel.activity.side === "right")
        ? { side: panel.activity.side, order: Number.isFinite(panel.activity.order) ? Number(panel.activity.order) : 100,
            icon: typeof panel.activity.icon === "string" ? panel.activity.icon : undefined,
            iconSvg: typeof panel.activity.iconSvg === "string" ? panel.activity.iconSvg : undefined,
            title: typeof panel.activity.title === "string" ? panel.activity.title : undefined } as PanelContribution["activity"]
        : undefined;
      out.panels[panel.id] = {
        id: panel.id, title: typeof panel.title === "string" && panel.title ? panel.title : panel.id, module, plugin: p.id,
        defaultHidden: !!panel.defaultHidden, dockBelow: isId(panel.dockBelow) ? panel.dockBelow : undefined, dock, pinned: !!panel.pinned, activity,
      };
    }
    for (const s of Array.isArray(c.sidebars) ? c.sidebars : []) {
      if (!isObj(s) || (s.side !== "left" && s.side !== "right")) continue;
      out.sidebars.push({ module: isId(s.module) ? s.module : p.id, side: s.side, width: Number.isFinite(s.width) ? Number(s.width) : 44, order: Number.isFinite(s.order) ? Number(s.order) : 100 });
    }
    for (const o of Array.isArray(c.overlays) ? c.overlays : []) {
      if (o === true || isObj(o)) out.overlays.push({ module: isObj(o) && isId(o.module) ? o.module : p.id });
    }
  }
  out.sidebars.sort((a, b) => (a.order! - b.order!) || a.module.localeCompare(b.module));
  return out;
}

/** Panels shown as buttons on one activity sidebar, in order. */
export function activityPanels(c: Contributions, side: "left" | "right") {
  return Object.values(c.panels).filter((p) => p.activity?.side === side).sort((a, b) => (a.activity!.order! - b.activity!.order!) || a.id.localeCompare(b.id));
}

/** Load contributions now and on every plugin/module change. Returns an unsubscribe function. */
export function watchContributions(ctx: ModuleContext, onChange: (c: Contributions) => void): () => void {
  let version = 0;
  const load = async () => {
    const mine = ++version;
    try {
      const r = await ctx.host.plugins.list();
      if (mine === version) onChange(collectContributions(r.plugins));
    } catch (e) { ctx.log.warn("plugins.list failed", String(e)); }
  };
  void load();
  return ctx.events.on("kernel.modules.changed", () => { void load(); });
}

export async function loadContributions(ctx: ModuleContext): Promise<Contributions> {
  return collectContributions((await ctx.host.plugins.list()).plugins);
}
