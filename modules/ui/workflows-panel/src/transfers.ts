// Playback is based solely on daemon transfer records, never block status. Each
// boundary gets one native spark cycle; responses traverse the same edge backwards.
import type { CanvasEdge } from "../../../../sdk/types";
import type { WorkflowRun, WorkflowTransfer } from "../../../../sdk/workflows";
const DURATION = 1400;
interface Pulse { event: WorkflowTransfer; start: number; end: number }
const runs = new Map<string, { seen: number; pulses: Pulse[] }>();
export function transferEdges(edges: CanvasEdge[], run?: WorkflowRun, now = Date.now()): CanvasEdge[] {
  if (!run?.transfers?.length) return edges;
  let state = runs.get(run.id);
  const fresh = !state;
  if (!state) {
    state = { seen: 0, pulses: [] }; runs.set(run.id, state);
    if (runs.size > 100) runs.delete(runs.keys().next().value!);
  }
  state.pulses = state.pulses.filter(p => p.end > now);
  for (const event of run.transfers) {
    if (event.seq <= state.seen) continue;
    state.seen = event.seq;
    // Opening an old run must not replay its history as if it were live.
    if (fresh && now - Date.parse(event.at) > 5000) continue;
    const same = state.pulses.filter(p => p.event.edgeId === event.edgeId);
    const last = same[same.length - 1];
    const start = Math.max(now, last?.end ?? now);
    state.pulses.push({ event, start, end: start + DURATION });
  }
  const overlays: CanvasEdge[] = [];
  for (const { event, start, end } of state.pulses) {
    if (now < start || now >= end) continue;
    const edge = edges.find(e => e.key === event.edgeId); if (!edge) continue;
    const reverse = event.phase === "return";
    overlays.push({ ...edge, key: `transfer:${event.seq}`, label: undefined, arrow: false,
      ...(reverse ? { from: edge.to, to: edge.from, fromSide: edge.toSide || "left", toSide: edge.fromSide || "right" } : {}),
      active: true, sparkColor: event.error ? "danger" : reverse ? "success" : "primary",
    });
  }
  return [...edges, ...overlays];
}
/** Refresh only during finite playback, including one final frame to clear the last pulse. */
export function tickTransfers(now = Date.now()): boolean {
  let dirty = false;
  for (const state of runs.values()) {
    if (state.pulses.length) dirty = true;
    state.pulses = state.pulses.filter(p => p.end > now);
  }
  return dirty;
}
export function clearTransfers() { runs.clear(); }
