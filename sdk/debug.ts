/** Contract of the `debug` service (DAP sessions, breakpoints) for the editor, the Debug panel and
 *  agents (MCP `debug_*`, `breakpoints_*`). Debug sessions share their id with the run session
 *  (sdk/run.ts) that started them; console output and the paused location also appear there. */

/** Zero-based `line`, workspace-relative `path`. */
export interface Breakpoint {
  id: string; path: string; line: number; enabled: boolean;
  /** Suspend only when this expression is true. */ condition?: string;
  /** Adapter hit-count expression, e.g. "5" or ">= 5" (Java) / "% 2" (JS). */ hitCondition?: string;
  /** Log instead of suspending; {expr} interpolates. */ logMessage?: string;
}
/** Adapter verification for the running sessions: false with a message when it cannot bind. */
export interface BreakpointStatus { id: string; verified: boolean; line?: number; message?: string }
export interface ExceptionBreakpoints { uncaught: boolean; caught: boolean }

export type DebugState = "starting" | "running" | "paused" | "ended";
export interface DebugSessionInfo {
  id: string; workspaceId: string; name: string; kind: "js" | "java"; state: DebugState;
  /** Where the focused thread is suspended (zero-based line). `path` is workspace-relative when inside
   *  the workspace, else absolute; null for sources without a file (e.g. JDK classes). */
  stopped?: { conn: number; threadId: number; reason: string; description?: string; path: string | null; line: number; frameId: number };
  /** Adapter features that enable UI actions. */
  supports: { restartFrame: boolean; stepInTargets: boolean; setVariable: boolean; hitConditions: boolean; logPoints: boolean; conditionalBreakpoints: boolean; hotCodeReplace: boolean };
  breakpoints: BreakpointStatus[];
}
export interface DebugThread { conn: number; id: number; name: string; stopped: boolean }
export interface DebugFrame { conn: number; id: number; name: string; path: string | null; source: string; line: number; column: number; library: boolean }
export interface DebugScope { name: string; variablesReference: number; expensive: boolean }
export interface DebugVariablePresentationHint {
  kind?: string;
  attributes?: string[];
  visibility?: string;
  lazy?: boolean;
}
export interface DebugVariable {
  name: string;
  value: string;
  variablesReference: number;
  type?: string;
  evaluateName?: string;
  namedVariables?: number;
  indexedVariables?: number;
  presentationHint?: DebugVariablePresentationHint;
  memoryReference?: string;
}

/** Select an identifier or a dotted member chain at a zero-based UTF-16 offset. */
export function debugExpressionAt(text: string, offset: number): { start: number; end: number; text: string } | null {
  if (!Number.isInteger(offset) || offset < 0 || offset >= text.length) return null;
  const lineStart = offset === 0 ? 0 : text.lastIndexOf("\n", offset - 1) + 1;
  const newline = text.indexOf("\n", offset);
  const line = text.slice(lineStart, newline === -1 ? undefined : newline);
  const identifier = String.raw`[$_\p{ID_Start}][$\u200c\u200d\p{ID_Continue}]*`;
  const chains = new RegExp(String.raw`(?<![$\u200c\u200d\p{ID_Continue}])${identifier}(?:[ \t]*\.[ \t]*${identifier})*`, "gu");
  for (const match of line.matchAll(chains)) {
    const start = lineStart + match.index;
    if (start > offset) break;
    const end = start + match[0].length;
    if (offset < end) return { start, end, text: match[0] };
  }
  return null;
}

/** Run configuration types each adapter debugs. Node types launch through js-debug; Java types run
 *  with a JDWP agent that java-debug attaches to. */
export const DEBUG_TYPES = { js: ["node", "npm-script", "jest", "vitest"], java: ["java-application", "spring-boot", "junit"] } as const;
export const debugKind = (type: string): "js" | "java" | null =>
  (DEBUG_TYPES.js as readonly string[]).includes(type) ? "js" : (DEBUG_TYPES.java as readonly string[]).includes(type) ? "java" : null;

export const DEBUG_EVENTS = {
  /** {workspaceId, sessions: DebugSessionInfo[]} on session state changes. */
  changed: "debug.changed",
  /** {workspaceId, breakpoints: Breakpoint[], exceptions: ExceptionBreakpoints} when the set changes. */
  breakpoints: "debug.breakpoints",
} as const;

/** Debug UI events (named after their publisher; see the broker rule in sdk/run.ts). */
export const DEBUG_UI_EVENTS = {
  /** Focus a frame in the editor: {workspaceId, id, conn, frameId, path, line}. Published by the Debug panel. */
  focusFrame: "debug-panel.focusFrame",
} as const;

/** Inline value text for a paused line: variables whose names occur in `lineText`, at most `max`. */
export function inlineValues(lineText: string, variables: DebugVariable[], max = 5): string {
  const words = new Set(lineText.match(/[A-Za-z_$][\w$]*/g) || []);
  return variables.filter(v => words.has(v.name)).slice(0, max)
    .map(v => `${v.name} = ${v.value.length > 40 ? v.value.slice(0, 39) + "…" : v.value}`).join(", ");
}
