// Shared activity sidebar: one button per panel whose plugin contributes `activity.side` for this
// side. Sidebars know nothing about specific panels; adding a plugin with a panel adds a button.
import type { AppModule, ModuleContext, UiNode } from "./types";
import { sidebarIcons } from "./sidebar-icons";
import { sidebarButtonStyle } from "./chat-style";
import { activityPanels, loadContributions, watchContributions, type Contributions } from "./plugins";

const fallbackIcon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="3"/></svg>`;

export function activitySidebar(id: string, side: "left" | "right"): AppModule {
  let visible: Record<string, boolean> = {};
  let contributions: Contributions | null = null;
  let stop: (() => void) | null = null;
  const buttons = () => contributions ? activityPanels(contributions, side) : [];
  return {
    id, moduleApiVersion: 1,
    async activate(ctx: ModuleContext) {
      visible = ctx.state.get("workspace-layout.panels") || {};
      ctx.state.watch("workspace-layout.panels", (value: any) => { visible = value || {}; ctx.ui.invalidate(); });
      try { contributions = await loadContributions(ctx); } catch (e) { ctx.log.warn("plugins.list failed", String(e)); }
      stop = watchContributions(ctx, (c) => { contributions = c; ctx.ui.invalidate(); });
    },
    deactivate() { stop?.(); },
    render(): UiNode {
      return { type: "column", key: "activity-sidebar", grow: true, bg: "panel", padding: 3, gap: 4, borderSide: side === "left" ? "right" : "left", children: buttons().map((panel) => {
        const title = panel.activity?.title || panel.title;
        const iconSvg = panel.activity?.iconSvg || (panel.activity?.icon && (sidebarIcons as Record<string, string>)[panel.activity.icon]) || fallbackIcon;
        return {
          type: "button", key: panel.id, text: "", iconSvg, iconSize: 22, width: 36, height: 36, style: sidebarButtonStyle(!!visible[panel.id]),
          variant: visible[panel.id] ? "primary" : "ghost", action: "toggle", value: panel.id,
          tooltip: `${visible[panel.id] ? "Hide" : "Show"} ${title}`,
        } as UiNode;
      }) };
    },
    onEvent(ctx, ev) {
      if (ev.action === "toggle" && buttons().some((panel) => panel.id === ev.value)) ctx.events.emit(`${id}.togglePanel`, { id: ev.value });
    },
  };
}
