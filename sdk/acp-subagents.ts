import { scanProgressChunk } from "./persistent-agents";

/** Display projection only. Child sessions never gain root-session mutation rights. */
export interface AcpSubagent {
  id: string;
  parentId: string;
  title?: string;
  description?: string;
  sessionTitle?: string;
  state: "running" | "requires_action" | "idle" | "unknown";
  stopReason?: string;
  activity?: string;
  progress?: { percent: number; note?: string; at: number };
  progressTail?: string;
}
export type AcpSubagents = Record<string, AcpSubagent>;
const validId = (id: unknown): id is string => typeof id === "string" && id.length > 0 && id.length <= 4096;
const own = (children: AcpSubagents, id: string) => Object.prototype.hasOwnProperty.call(children, id);
const label = (v: unknown) => typeof v === "string" ? v.slice(0, 200) : undefined;
export const hasWorkingSubagents = (children?: AcpSubagents) => Object.values(children || {}).some(c => c.state === "running" || c.state === "requires_action");
export const knownSubagent = (children: AcpSubagents, id: unknown): id is string => validId(id) && own(children, id);
export function disconnectSubagents(children?: AcpSubagents): AcpSubagents {
  return Object.fromEntries(Object.entries(children || {}).map(([id, c]) => [id, { ...c, state: "unknown", stopReason: undefined, progress: undefined, progressTail: undefined }]));
}
// OpenCode lifecycle words (legacy tag and `opencode/session/child_update` status events).
const LEGACY_STATES: Record<string, string> = { created: "running", busy: "running", waiting: "requires_action", completed: "idle", done: "idle", error: "idle", failed: "idle", interrupted: "idle" };
const LEGACY_STOPS: Record<string, string> = { completed: "end_turn", done: "end_turn", error: "error", failed: "error", interrupted: "cancelled" };
/** OpenCode sends child lifecycle and traffic on this extension once the client opts in. */
export const OPENCODE_CHILD_UPDATE = "opencode/session/child_update";
export const OPENCODE_CHILD_OPT_IN = { "opencode/child-session-updates": true };
/** Translate one `opencode/session/child_update` into ordinary root `session/update` params:
 *  status events become a child-session tag with a status; traffic is replayed as the tagged
 *  update OpenCode would otherwise have sent on the root session. */
export function openCodeChildUpdate(params: any): { sessionId: string; update: any } | null {
  const root = params?.rootSessionId, id = params?.childSessionId;
  if (!validId(root) || !validId(id)) return null;
  const tag = { id, parentID: params.parentSessionId, depth: params.depth, ...(typeof params.title === "string" ? { title: params.title } : {}) };
  if (params.type === "status" && typeof params.status === "string")
    return { sessionId: root, update: { sessionUpdate: "_hato_child_status", _meta: { "opencode/child-session": { ...tag, status: params.status } } } };
  if (params.type === "update" && params.update && typeof params.update === "object" && !Array.isArray(params.update)) {
    const u = params.update, meta = u._meta && typeof u._meta === "object" ? u._meta : {};
    return { sessionId: root, update: { ...u, _meta: { ...meta, "opencode/child-session": { ...tag, ...meta["opencode/child-session"] } } } };
  }
  return null;
}
/** Accept only announced descendants on this connection; never infer parentage from tool names. */
export function updateSubagents(children: AcpSubagents, rootId: string | null, params: any, replayed = false): boolean {
  const parent = params?.sessionId;
  if (!validId(parent) || (parent !== rootId && !knownSubagent(children, parent))) return false;
  const u = params.update || {};
  if (typeof u !== "object" || Array.isArray(u)) return false;
  const meta = u._meta?.["opencode/child-session"] || params._meta?.["opencode/child-session"];
  const legacy = meta && typeof meta === "object" && !Array.isArray(meta) ? meta : null;
  if (u.sessionUpdate === "subagent_update" || legacy) {
    const patch = legacy || u, id = legacy ? patch.id : patch.sessionId;
    if (!validId(id) || id === rootId || id === parent || (!own(children, id) && Object.keys(children).length >= 200)) return false;
    if (own(children, id) && children[id].parentId !== parent) return false;
    const child: AcpSubagent = own(children, id) ? { ...children[id] } : { id, parentId: parent, state: "unknown" };
    for (const key of ["title", "description"] as const) if (key in patch) child[key] = label(patch[key]);
    if (legacy && "name" in patch && !("title" in patch)) child.title = label(patch.name);
    if ("state" in patch || legacy && "status" in patch) {
      const state = patch.state ?? patch.status;
      const value = typeof state === "string" ? state : state?.state;
      const next = legacy ? LEGACY_STATES[value] || value : value;
      child.state = !replayed && ["running", "requires_action", "idle"].includes(next) ? next : "unknown";
      child.stopReason = replayed ? undefined : label(state?.stopReason) || (legacy ? LEGACY_STOPS[value] : undefined);
      if (child.state === "running" && children[id]?.state !== "running") { child.progress = undefined; child.progressTail = undefined; }
    }
    Object.defineProperty(children, id, { value: child, enumerable: true, writable: true, configurable: true });
    return true;
  }
  if (!knownSubagent(children, parent)) return false;
  const child = { ...children[parent] };
  if (u.sessionUpdate === "session_info_update" && "title" in u) child.sessionTitle = label(u.title);
  else if (u.sessionUpdate === "state_update") {
    child.state = !replayed && ["running", "requires_action", "idle"].includes(u.state) ? u.state : "unknown";
    child.stopReason = replayed ? undefined : label(u.stopReason);
  } else if (!replayed && ["tool_call", "tool_call_update"].includes(u.sessionUpdate) && u.title) child.activity = label(u.title);
  else if (!replayed && u.sessionUpdate === "agent_message_chunk" && u.content?.type === "text") {
    const scan = scanProgressChunk(child.progressTail || "", String(u.content.text || ""));
    child.progressTail = scan.tail;
    if (scan.progress) child.progress = scan.progress;
  }
  children[parent] = child;
  return true;
}
/** Strip parser state from cross-service display projections. */
export function subagentList(children?: AcpSubagents): AcpSubagent[] {
  return Object.values(children || {}).slice(0, 200).map(({ progressTail, ...child }) => child);
}
/** Final child states of a root that just left a working list. */
export interface FinishedSubagents { id: string; children: AcpSubagent[]; at: number }
/** Working lists are debounced or polled, so subagents finishing just before their parent can be
 *  missed. Remember the final children of roots that left `now` (kept `ttl` ms, dropped when they
 *  work again). Returns whether the store changed. */
export function trackFinishedSubagents(store: Map<string, FinishedSubagents>, prev: ReadonlySet<string>, now: ReadonlySet<string>, childrenOf: (id: string) => AcpSubagent[] | undefined, at = Date.now(), ttl = 15000): boolean {
  let changed = false;
  for (const id of prev) if (!now.has(id)) {
    const children = childrenOf(id);
    if (children?.length) { store.set(id, { id, children, at }); changed = true; }
  }
  for (const [id, entry] of store) if (now.has(id) || at - entry.at > ttl) { store.delete(id); changed = true; }
  return changed;
}
