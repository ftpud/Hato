// Prompt history: every prompt sent in a project with the files its turn edited, for diff review.
// Sources (ai-sessions chats, persistent-agents background agents) group their transcripts with
// `promptTurns`; the prompt-history panel merges them and opens `promptPatch` in a Viewer diff tab.
import type { ChatDiff } from "./types";

export interface PromptFile {
  path: string; added: number; removed: number; newFile?: boolean;
  /** Some edit was cut to fit (see ChatDiff.truncated). */
  truncated?: boolean;
  /** Each tool edit to this file during the turn, in order. */
  edits: ChatDiff[];
}
export interface PromptEntry {
  /** Stable across refreshes: `${source}:${sessionId}:${prompt message key}`. */
  id: string;
  source: "chat" | "agent" | "workspace";
  sessionId: string;
  sessionTitle: string;
  /** Provider/profile label, e.g. "Claude". */
  agent: string;
  prompt: string;
  /** Epoch ms when the prompt was sent, when known. */
  at: number | null;
  /** Latest captured edit, when newer than the prompt. */
  updatedAt?: number;
  files: PromptFile[];
}
export interface PromptHistorySource { entries: PromptEntry[]; error?: string }

/** One transcript message as a source sees it: `role` "user" starts a turn; tool diffs join it. */
export interface PromptTurnMessage { key: string; role: string; text?: string; diffs?: ChatDiff[]; at?: number | null }

const PROMPT_CHARS = 600;

/** Group a session's messages (oldest first) into prompt entries (oldest first). */
export function promptTurns(messages: PromptTurnMessage[], base: Pick<PromptEntry, "source" | "sessionId" | "sessionTitle" | "agent">): PromptEntry[] {
  const out: PromptEntry[] = [];
  let current: PromptEntry | null = null;
  let byPath = new Map<string, PromptFile>();
  for (const m of messages) {
    if (m.role === "user") {
      const prompt = String(m.text || "").trim();
      if (!prompt) continue;
      current = { ...base, id: `${base.source}:${base.sessionId}:${m.key}`, prompt: prompt.slice(0, PROMPT_CHARS), at: m.at ?? null, files: [] };
      byPath = new Map();
      out.push(current);
      continue;
    }
    if (!current || !Array.isArray(m.diffs)) continue;
    for (const d of m.diffs) {
      if (!d || typeof d.path !== "string") continue;
      let file = byPath.get(d.path);
      if (!file) { file = { path: d.path, added: 0, removed: 0, edits: [], ...(d.newFile ? { newFile: true } : {}) }; byPath.set(d.path, file); current.files.push(file); }
      file.added += Number(d.added) || 0; file.removed += Number(d.removed) || 0;
      if (d.truncated) file.truncated = true;
      file.edits.push(d);
    }
  }
  return out;
}

/** Newest first; entries without a time keep their source order after timed ones. */
export function mergePromptEntries(lists: PromptEntry[][]): PromptEntry[] {
  return lists.flat().map((e, i) => ({ e, i })).sort((a, b) => (b.e.updatedAt ?? b.e.at ?? -1) - (a.e.updatedAt ?? a.e.at ?? -1) || a.i - b.i).map(x => x.e);
}

/** Path shown to the user: relative to the workspace root when inside it. */
export function relativePromptPath(path: string, root?: string | null) {
  const r = root?.replace(/\/+$/, "");
  return r && path.startsWith(r + "/") ? path.slice(r.length + 1) : path;
}

/** A unified patch the native `diff` node parses: one file section per edit. */
export function promptPatch(files: PromptFile[], root?: string | null): string {
  const out: string[] = [];
  for (const f of files) {
    const p = relativePromptPath(f.path, root);
    f.edits.forEach((d, i) => {
      if (!d.lines.length) return;
      const created = i === 0 && !!d.newFile;
      out.push(`diff --git a/${p} b/${p}`, ...(d.deletedFile ? ["deleted file mode 100644"] : []), ...(created ? ["new file mode 100644", "--- /dev/null"] : [`--- a/${p}`]), d.deletedFile ? "+++ /dev/null" : `+++ b/${p}`, ...d.lines);
    });
  }
  return out.length ? out.join("\n") + "\n" : "";
}

/** "now", "5m", "3h", "2d", or a date. */
export function promptAge(at: number | null, now = Date.now()): string {
  if (at == null || !Number.isFinite(at)) return "";
  const s = Math.max(0, (now - at) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d`;
  return new Date(at).toLocaleDateString();
}

/** Persistence timestamps may be ISO strings or epoch numbers. */
export function epochOf(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value;
  if (typeof value === "string" && value) { const n = Date.parse(value); return Number.isFinite(n) ? n : null; }
  return null;
}
