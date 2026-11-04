import { SPACE_NAMES } from "./defaults";
import { PANELS, dropPanel, homeOf, locate, moveTo, type Layout } from "./model";
export type PanelSharing = Record<string, string>;
export function normalizePanelSharing(value: unknown): PanelSharing {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([, v]) => typeof v === "string" && /^space-[1-9][0-9]{0,2}$/.test(v)));
}
export function sharingOptions(sharing: PanelSharing) {
  const ids = new Set([...Object.keys(PANELS).map((_, i) => `space-${i + 1}`), ...Object.values(sharing)]);
  return [{ value: "", label: "Independent" }, ...[...ids].sort((a, b) => Number(a.slice(6)) - Number(b.slice(6))).map(value => ({ value, label: SPACE_NAMES[value] ? `${SPACE_NAMES[value]} (space ${value.slice(6)})` : `Shared space ${value.slice(6)}` }))];
}
export function visibleIn(l: Layout, id: string) {
  const place = locate(l, id);
  return !!place && place.kind !== "hidden" && !l.collapsed[id] && !(place.kind === "bottom" && l.bottom.collapsed);
}
/** Show one member in the group's existing slot, retaining its size and window geometry. */
export function showPanel(l: Layout, id: string, sharing: PanelSharing): Layout {
  if (!Object.prototype.hasOwnProperty.call(PANELS, id)) return l;
  const group = sharing[id];
  const peers = group ? Object.keys(PANELS).filter(p => p !== id && sharing[p] === group) : [];
  const occupied = peers.find(p => visibleIn(l, p)) || peers.find(p => { const at = locate(l, p); return at && at.kind !== "hidden"; });
  let next = l;
  if (!visibleIn(l, id) && occupied) {
    next = moveTo(l, id, "hidden");
    const at = locate(next, occupied)!;
    if (at.kind === "column") next.columns[at.col].panels[at.idx] = id;
    else if (at.kind === "bottom") next.bottom.panels[at.idx] = id;
    else if (at.kind === "floating") { next.floating[id] = next.floating[occupied]; delete next.floating[occupied]; }
    else if (at.kind === "detached") { next.detached[id] = next.detached[occupied]; delete next.detached[occupied]; }
    next.hidden = next.hidden.filter(p => p !== id);
    next.hidden.push(occupied);
  } else if (!locate(next, id) || locate(next, id)?.kind === "hidden") {
    const near = PANELS[id].dockBelow;
    next = near && locate(next, near)?.kind === "column" ? dropPanel(next, id, near, "bottom") : moveTo(next, id, homeOf(id));
  }
  for (const peer of peers) if (locate(next, peer)?.kind !== "hidden") next = moveTo(next, peer, "hidden");
  next = { ...next, collapsed: { ...next.collapsed, [id]: false } };
  if (locate(next, id)?.kind === "bottom") next.bottom = { ...next.bottom, collapsed: false };
  return next;
}
/** Reconcile settings/restored layouts without opening a group that was entirely closed. */
export function enforcePanelSharing(l: Layout, sharing: PanelSharing): Layout {
  let next = l;
  const done = new Set<string>();
  for (const id of Object.keys(PANELS)) {
    const group = sharing[id];
    if (!group || done.has(group) || !visibleIn(next, id)) continue;
    done.add(group); next = showPanel(next, id, sharing);
  }
  return next;
}
