/** Contract between the run service (`services/run`), the Run bar / Run panel UI (`ui/run-debug`)
 *  and agents (MCP `run_*`). Launch resolution comes from run configurations (see
 *  sdk/run-configurations.ts); this file only describes running sessions. */
import type { RunCandidate } from "./run-configurations";

export type RunMode = "run" | "debug";
/** `paused` is only reported for debug sessions (P3). */
export type RunState = "starting" | "running" | "paused" | "stopping" | "exited" | "failed";

export interface RunSession {
  id: string;
  workspaceId: string;
  /** Saved configuration id; null when launched from a detected candidate. */
  configId: string | null;
  name: string;
  /** Run configuration type id (e.g. "java-application", "npm-script"), used for the icon. */
  type: string;
  mode: RunMode;
  state: RunState;
  /** Epoch milliseconds. */
  startedAt: number;
  endedAt?: number;
  exitCode?: number | null;
  /** Human-readable failure (spawn error, before-launch step failed, adapter error). */
  error?: string;
  /** Debug only: where the selected thread is suspended. */
  pausedAt?: { path: string; line: number; reason?: string };
  /** Current before-launch step while state is "starting", e.g. "mvn -q compile". */
  phase?: string;
}

export interface RunOutputChunk {
  /** Monotonic per session; use as `after` for the next read. */
  seq: number;
  stream: "stdout" | "stderr" | "system";
  /** Raw text including ANSI escapes. `system` lines are runner notes (command line, exit). */
  text: string;
}

export interface RunOutput { chunks: RunOutputChunk[]; next: number; /** Older output was discarded (bounded buffer). */ truncated: boolean }

/** `services/run` methods. All take `workspaceId`; sessions are scoped to it. */
export interface RunServiceMethods {
  /** What this runner build supports; the UI disables Debug while `debug` is false. */
  capabilities(a: { workspaceId: string }): { debug: boolean; debugTypes: string[] };
  list(a: { workspaceId: string }): RunSession[];
  /** Exactly one of `configId` / `candidate`. Rejects while the same config is already running
   *  unless `restart` is true (then the old session is stopped first). */
  start(a: { workspaceId: string; configId?: string; candidate?: RunCandidate; mode: RunMode; restart?: boolean }): RunSession;
  /** Graceful terminate, then kill after a grace period. Resolves when the session has ended. */
  stop(a: { workspaceId: string; id: string; force?: boolean }): RunSession;
  restart(a: { workspaceId: string; id: string }): RunSession;
  output(a: { workspaceId: string; id: string; after?: number; limit?: number }): RunOutput;
  /** Drop ended sessions (all when `id` is omitted). */
  clear(a: { workspaceId: string; id?: string }): RunSession[];
}

/** Events emitted by `services/run`. */
export const RUN_EVENTS = {
  /** {workspaceId, sessions: RunSession[]} on any session state change. */
  changed: "run.changed",
  /** {workspaceId, id, seq} when new output is available (coalesced, at most ~10/s per session). */
  output: "run.output",
} as const;

/** Events the Run UI publishes. The kernel broker only lets a module emit its own `<moduleId>.*`
 *  topics, so each event is named after its publisher; subscribers (workspace-layout reveals the
 *  matching panel) listen to these names. */
export const RUN_UI_EVENTS = {
  /** Open the configuration editor: {workspaceId, id?} edits a saved config, {workspaceId, candidate}
   *  starts a new one prefilled from a detected candidate (null = blank), {workspaceId} opens the list. */
  editConfiguration: "run-bar.editConfiguration",
  /** Reveal the Run panel on a session: {workspaceId, id}. */
  revealSession: "run-bar.reveal",
  /** Open a source location in the editor: OpenLocation. Handled by the viewer. */
  openLocation: "run-panel.openLocation",
} as const;

/** `path` is workspace-relative or absolute. Without it, `suffix` (e.g. "com/acme/Foo.java" from a Java
 *  frame) is resolved against the workspace; ambiguous matches prefer source roots over tests. */
export interface OpenLocation { workspaceId: string; path?: string; suffix?: string; /** Zero-based. */ line: number; character?: number }

/** A source location found in console output. Java: `at a.b.C.m(C.java:12)`; JS: `at f (/abs/x.ts:12:5)`,
 *  `at /abs/x.js:3:1`, `file:///abs/x.mjs:3:1`. Returns the half-open [start,end) span in `text`. */
export function findLocations(text: string): { start: number; end: number; location: Omit<OpenLocation, "workspaceId"> }[] {
  const out: { start: number; end: number; location: Omit<OpenLocation, "workspaceId"> }[] = [];
  const java = /\bat\s+((?:[\w$]+\.)*)([\w$]+)\.[\w$<>]+\(([\w$]+\.(?:java|kt|groovy|scala)):(\d+)\)/g;
  for (let m; (m = java.exec(text));) {
    const pkg = m[1].replace(/\.$/, "").split(".").filter(Boolean);
    // Inner classes ($) live in the outer file; the file name in the frame is authoritative.
    const start = m.index + m[0].indexOf(m[3]);
    out.push({ start, end: start + m[3].length + 1 + m[4].length, location: { suffix: [...pkg, m[3]].join("/"), line: Number(m[4]) - 1 } });
  }
  const js = /(?:file:\/\/)?((?:\/|[A-Za-z]:[\\/]|\.{1,2}\/)[^\s():'"]+\.(?:[cm]?[jt]sx?|vue|svelte)):(\d+)(?::(\d+))?/g;
  for (let m; (m = js.exec(text));) {
    if (out.some(o => m!.index < o.end && m!.index + m![0].length > o.start)) continue;
    out.push({ start: m.index, end: m.index + m[0].length, location: { path: m[1], line: Number(m[2]) - 1, character: m[3] ? Number(m[3]) - 1 : 0 } });
  }
  return out.sort((a, b) => a.start - b.start);
}

export const runActive = (s: RunSession) => s.state === "starting" || s.state === "running" || s.state === "paused" || s.state === "stopping";
