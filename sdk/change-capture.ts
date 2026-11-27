import type { ChatDiff, ChatMessage, ModuleContext } from "./types";
import { promptTurns, type PromptEntry } from "./prompt-history";

export const CAPTURE_SETTING = "files.changesEnabled";
export const CAPTURE_STATE = "files.changeCapture";
export interface CapturedChange {
  id: string;
  at: number;
  diffs: ChatDiff[];
  owner?: { source: "chat" | "agent"; sessionId: string; prompt: string; key: string };
}
export interface CaptureState { workspaceId: string; records: CapturedChange[]; warning?: string | null; ready?: boolean }
export const captureEnabled = (ctx: ModuleContext) => ctx.state.get(CAPTURE_SETTING) !== false;
export function capturedChanges(ctx: ModuleContext, workspaceId: string): CapturedChange[] {
  const state = ctx.state.get(CAPTURE_STATE) as CaptureState | null;
  return captureEnabled(ctx) && state?.workspaceId === workspaceId ? state.records : [];
}
/** Overlay captured edits onto their prompt, retaining unattributed changes as project entries. */
export function capturedEntries(records: CapturedChange[], entries: PromptEntry[] = []): PromptEntry[] {
  const merged = new Map(entries.map(entry => [entry.id, entry]));
  const groups = new Map<string, CapturedChange[]>();
  for (const record of records) {
    const owner = record.owner;
    const id = owner ? owner.source + ":" + owner.sessionId + ":" + owner.key : "workspace::" + record.id;
    const group = groups.get(id) || [];
    group.push(record); groups.set(id, group);
  }
  for (const [id, group] of groups) {
    const record = group[0], owner = record.owner, current = merged.get(id);
    const captured = promptTurns([
      { key: owner?.key || record.id, role: "user", text: owner?.prompt || "Project file changes", at: current?.at ?? record.at },
      ...group.map(change => ({ key: change.id, role: "tool", diffs: change.diffs })),
    ], { source: owner?.source || "workspace", sessionId: owner?.sessionId || "", sessionTitle: current?.sessionTitle || "Project", agent: current?.agent || "File capture" })[0];
    const updatedAt = Math.max(current?.updatedAt ?? current?.at ?? 0, ...group.map(change => change.at));
    const paths = new Set(captured.files.map(file => file.path));
    merged.set(id, current ? { ...current, updatedAt, files: [...current.files.filter(file => !paths.has(file.path)), ...captured.files] } : { ...captured, updatedAt });
  }
  return [...merged.values()];
}
const normalizePath = (path: string) => path.replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/^(\.\/)+/, "").replace(/\/$/, "");
const isWindowsPath = (path: string) => /^[a-zA-Z]:\//.test(path);
/** Providers report absolute paths and capture reports workspace-relative ones: the same file when
 *  one path equals the other or ends with it at a path boundary (case-insensitive for Windows). */
function pathMatcher(paths: Iterable<string>): (path: string) => boolean {
  const wanted = [...paths].map(normalizePath).filter(Boolean);
  return path => {
    const p = normalizePath(path);
    return wanted.some(w => {
      const fold = isWindowsPath(p) || isWindowsPath(w);
      const a = fold ? p.toLowerCase() : p, b = fold ? w.toLowerCase() : w;
      return a === b || a.endsWith("/" + b) || b.endsWith("/" + a);
    });
  };
}
/** Captured file changes have their own tool card, with provider duplicates removed per turn. */
export function capturedTranscript(messages: ChatMessage[], records: CapturedChange[], source: "chat" | "agent", sessionId: string): ChatMessage[] {
  const result: ChatMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    result.push(message);
    if (message.role !== "user") continue;
    let end = i + 1;
    while (end < messages.length && messages[end].role !== "user") end++;
    const changes = records.filter(r => r.owner?.source === source && r.owner.sessionId === sessionId && r.owner.key === message.key);
    const paths = new Set(changes.flatMap(r => r.diffs.map(d => d.path)));
    const captured = pathMatcher(paths);
    const anchored = new Map<number, CapturedChange[]>();
    for (const change of changes) {
      const changed = pathMatcher(change.diffs.map(diff => diff.path));
      let anchor = i;
      let matching = -1;
      for (let j = i + 1; j < end; j++) {
        const candidate = messages[j];
        if (candidate.role !== "tool") continue;
        const at = candidate.at;
        const timestamp = typeof at === "string" ? Date.parse(at) : at;
        if (timestamp !== undefined && timestamp > change.at) continue;
        anchor = j;
        if (candidate.diffs?.some(diff => changed(diff.path))) matching = j;
      }
      if (matching >= 0) anchor = matching;
      const group = anchored.get(anchor) || [];
      group.push(change); anchored.set(anchor, group);
    }
    const cards = (index: number): ChatMessage[] => (anchored.get(index) || []).map(change => ({
      key: "capture:" + change.id, role: "tool", title: "Project file changes", text: "", status: "completed", diffs: change.diffs,
    }));
    result.push(...cards(i));
    for (let j = i + 1; j < end; j++) {
      const original = messages[j];
      result.push(paths.size && original.diffs ? { ...original, diffs: original.diffs.filter(d => !captured(d.path)) } : original);
      result.push(...cards(j));
    }
    i = end - 1;
  }
  return result;
}
