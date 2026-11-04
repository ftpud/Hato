// User choices override plugin defaults without changing panel docking or enablement.
import type { Contributions, PanelContribution } from "./plugins";
export const SIDEBAR_POSITIONS = ["left-top", "left-bottom", "right-top", "right-bottom", "hidden"] as const;
export type SidebarPosition = typeof SIDEBAR_POSITIONS[number];
export type SidebarButtons = Record<string, SidebarPosition>;
export const sidebarPositionOptions = [
  { value: "left-top", label: "Left top" }, { value: "left-bottom", label: "Left bottom" },
  { value: "right-top", label: "Right top" }, { value: "right-bottom", label: "Right bottom" },
  { value: "hidden", label: "Hidden" },
];
export function normalizeSidebarButtons(value: unknown): SidebarButtons {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([, p]) => SIDEBAR_POSITIONS.includes(p as SidebarPosition))) as SidebarButtons;
}
export function sidebarPosition(panel: PanelContribution, choices: SidebarButtons): SidebarPosition {
  const choice = choices[panel.id];
  return SIDEBAR_POSITIONS.includes(choice) ? choice : panel.activity ? `${panel.activity.side}-top` : "hidden";
}
export function configurableSidebarPanels(c: Contributions): PanelContribution[] {
  return Object.values(c.panels).sort((a, b) =>
    (a.activity?.order ?? 100) - (b.activity?.order ?? 100) || a.id.localeCompare(b.id));
}
export function sidebarPanels(c: Contributions, choices: SidebarButtons, side: "left" | "right") {
  return configurableSidebarPanels(c).filter(p => sidebarPosition(p, choices).startsWith(`${side}-`));
}

export type SidebarOrder = Record<string, string[]>;
export function normalizeSidebarOrder(raw: any): SidebarOrder {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return Object.fromEntries(Object.entries(raw).filter(([key, items]) => SIDEBAR_POSITIONS.includes(key as SidebarPosition) && key !== "hidden" && Array.isArray(items)).map(([key, items]) => [key, [...new Set((items as any[]).filter(i => typeof i === "string" && i.length < 160))].slice(0, 512)]));
}
export function orderedSidebarItems(c: Contributions, choices: SidebarButtons, order: SidebarOrder, position: string): string[] {
  const panels = configurableSidebarPanels(c).filter(p => sidebarPosition(p, choices) === position).map(p => p.id);
  const existing = (order[position] || []).filter(id => panels.includes(id) || id.startsWith("@spacer:"));
  return [...existing, ...panels.filter(id => !existing.includes(id))];
}
