import type { AppModule, UiNode } from "../../../../sdk/types";
import { sidebarIcons } from "../../../../sdk/sidebar-icons";
let visible: Record<string, boolean> = {};
const panels = [
  { id: "projects", title: "Projects", iconSvg: sidebarIcons.projects },
  { id: "files", title: "Files", iconSvg: sidebarIcons.files },
  { id: "git", title: "Git changes", iconSvg: sidebarIcons.git },
];
const mod: AppModule = {
  id: "sidebar", moduleApiVersion: 1,
  activate(ctx) {
    visible = ctx.state.get("workspace-layout.panels") || {};
    ctx.state.watch("workspace-layout.panels", (value: any) => { visible = value || {}; ctx.ui.invalidate(); });
  },
  render(): UiNode {
    return { type: "column", key: "activity-sidebar", grow: true, bg: "panel", padding: 3, gap: 4, borderSide: "left", children: panels.map(({ id, title, iconSvg }) => ({
      type: "button", key: id, text: "", iconSvg, iconSize: 22, width: 36, height: 36, surface: "sidebar-button",
      variant: visible[id] ? "primary" : "ghost", action: "toggle", value: id,
      tooltip: `${visible[id] ? "Hide" : "Show"} ${title}`,
    })) };
  },
  onEvent(ctx, ev) {
    if (ev.action === "toggle" && panels.some(panel => panel.id === ev.value)) ctx.events.emit("sidebar.togglePanel", { id: ev.value });
  },
};
export default mod;
