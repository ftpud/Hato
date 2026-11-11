// Shared activity sidebar: plugin defaults plus user-selected button visibility and placement.
// Sidebars know nothing about specific panels; contributions supply their titles and icons.
import type { AppModule, ModuleContext, UiNode } from "./types";
import { normalizeSidebarButtons, normalizeSidebarOrder, orderedSidebarItems, sidebarPanels, type SidebarButtons, type SidebarOrder } from "./sidebar-placement";
import { sidebarIcons } from "./sidebar-icons";
import { sidebarButtonStyle } from "./chat-style";
import { loadContributions, watchContributions, type Contributions } from "./plugins";

const fallbackIcon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="3"/></svg>`;

export function activitySidebar(id: string, side: "left" | "right"): AppModule {
  let visible: Record<string, boolean> = {};
  let choices: SidebarButtons = {};
  let order: SidebarOrder = {};
  /** null until workspace-layout publishes sharing; grouping waits for it. */
  let sharing: Record<string, string> | null = null;
  let grouping = true;
  let contributions: Contributions | null = null;
  let stop: (() => void) | null = null;
  /** Panels publish positive counts at `<owning-module>.panelBadge.<panel-id>`.
   * Counts are transient state; zero clears the beacon, and large counts show 99+. */
  const badges: Record<string, unknown> = {};
  const badgeStops = new Map<string, () => void>();
  const syncBadges = (ctx: ModuleContext) => {
    const panels = Object.values(contributions?.panels || {});
    const wanted = new Set(panels.map(p => p.id));
    for (const [id, stop] of badgeStops) if (!wanted.has(id)) { stop(); badgeStops.delete(id); delete badges[id]; }
    for (const panel of panels) if (!badgeStops.has(panel.id)) {
      const key = `${panel.module}.panelBadge.${panel.id}`;
      badges[panel.id] = ctx.state.get(key);
      badgeStops.set(panel.id, ctx.state.watch(key, value => { badges[panel.id] = value; ctx.ui.invalidate(); }));
    }
  };
  const buttons = () => contributions ? sidebarPanels(contributions, choices, side) : [];
  return {
    id, moduleApiVersion: 1,
    async activate(ctx: ModuleContext) {
      order = normalizeSidebarOrder(ctx.state.get("workspace-layout.sidebarOrder"));
      ctx.state.watch("workspace-layout.sidebarOrder", (value: unknown) => { order = normalizeSidebarOrder(value); ctx.ui.invalidate(); });
      choices = normalizeSidebarButtons(ctx.state.get("workspace-layout.sidebarButtons"));
      ctx.state.watch("workspace-layout.sidebarButtons", (value: unknown) => { choices = normalizeSidebarButtons(value); ctx.ui.invalidate(); });
      const asSharing = (value: any) => value && typeof value === "object" && !Array.isArray(value) ? value : null;
      sharing = asSharing(ctx.state.get("workspace-layout.panelSharing"));
      ctx.state.watch("workspace-layout.panelSharing", (value: any) => { sharing = asSharing(value); ctx.ui.invalidate(); });
      grouping = ctx.state.get("workspace-layout.sidebarGrouping") !== false;
      ctx.state.watch("workspace-layout.sidebarGrouping", (value: any) => { grouping = value !== false; ctx.ui.invalidate(); });
      visible = ctx.state.get("workspace-layout.panels") || {};
      ctx.state.watch("workspace-layout.panels", (value: any) => { visible = value || {}; ctx.ui.invalidate(); });
      try { contributions = await loadContributions(ctx); } catch (e) { ctx.log.warn("plugins.list failed", String(e)); }
      syncBadges(ctx);
      stop = watchContributions(ctx, (c) => { contributions = c; syncBadges(ctx); ctx.ui.invalidate(); });
    },
    deactivate() { stop?.(); for (const stop of badgeStops.values()) stop(); badgeStops.clear(); },
    render(): UiNode {
      return { type: "column", key: "activity-sidebar", grow: true, bg: "panel", padding: 3, gap: 4, borderSide: side === "left" ? "right" : "left", children: (() => {
        const panels = buttons();
        const top = contributions ? orderedSidebarItems(contributions, choices, order, `${side}-top`) : [];
        const bottom = contributions ? orderedSidebarItems(contributions, choices, order, `${side}-bottom`) : [];
        const button = (panel: typeof panels[number]): UiNode => {
          const count = badges[panel.id];
          const badge = typeof count === "number" && Number.isFinite(count) && count > 0 ? (count > 99 ? "99+" : String(Math.floor(count))) : undefined;
          const title = panel.activity?.title || panel.title;
          const iconSvg = panel.activity?.iconSvg || (panel.activity?.icon && (sidebarIcons as Record<string, string>)[panel.activity.icon]) || fallbackIcon;
          return {
            type: "button", key: panel.id, text: "", iconSvg, badge, iconSize: 22, width: 36, height: 36, style: sidebarButtonStyle(!!visible[panel.id]),
            variant: visible[panel.id] ? "primary" : "ghost", action: "toggle", value: panel.id,
            tooltip: `${visible[panel.id] && !panel.pinned ? "Hide" : "Show"} ${title}${badge ? ` · ${count}` : ""}`,
          } as UiNode;
        };
        const item = (id: string): UiNode => id.startsWith("@spacer:") ? { type: "column", key: id, height: 12, children: [] } : button(panels.find(p => p.id === id)!);
        // Buttons whose panels share a space replace each other on screen. Draw a short rule where
        // adjacent buttons switch to a different space (unless the user placed a spacer there).
        const space = (id: string) => sharing?.[id] || `solo:${id}`;
        const grouped = (ids: string[]): UiNode[] => {
          if (!grouping || !sharing) return ids.map(item);
          const out: UiNode[] = [];
          ids.forEach((id, i) => {
            const prev = ids[i - 1];
            if (prev && !prev.startsWith("@spacer:") && !id.startsWith("@spacer:") && space(prev) !== space(id))
              out.push({ type: "row", key: `group-rule:${id}`, height: 9, align: "center", style: { justify: "center" }, children: [
                { type: "column", key: "rule", width: 18, height: 1, style: { background: "border", width: 18, height: 1 }, children: [] },
              ] } as UiNode);
            out.push(item(id));
          });
          return out;
        };
        return [...grouped(top), ...(bottom.length ? [{ type: "spacer", key: "sidebar-spacer" } as UiNode] : []), ...grouped(bottom)];
      })() };
    },
    onEvent(ctx, ev) {
      if (ev.action === "toggle" && buttons().some((panel) => panel.id === ev.value)) ctx.events.emit(`${id}.togglePanel`, { id: ev.value });
    },
  };
}
