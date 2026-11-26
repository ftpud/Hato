import type { McpLaunchOptions } from "./provider-mcp";
import type { ReportedUsage } from "./context-usage";
import type { ChatMessage } from "./types";
export interface AgentProfile { id: string; provider: string; name: string; executable: string; args: string[]; mcpLaunch?: McpLaunchOptions; envRefs?: Record<string,string>; enabled?: boolean }
export type McpTransport = "stdio" | "http" | "sse";
/** Remote server authentication. OAuth tokens live in the mcp-auth service, never in this config. */
export interface McpAuth { type: "none" | "oauth" | "bearer"; token?: string; clientId?: string; clientSecret?: string; scopes?: string; redirectPort?: number }
/** A user MCP server: a local command (stdio) or a remote endpoint (Streamable HTTP or legacy SSE). */
export interface AgentMcp { enabled?: boolean; id: string; name: string; transport?: McpTransport;
  command: string; args: string[]; env: {name:string; value:string}[];
  url?: string; headers?: {name:string; value:string}[]; auth?: McpAuth }
export interface AgentSpec {
  id: string; name: string; workspaceId: string; workspaceName: string; root: string; machineId: string;
  profile: AgentProfile; model: string; reasoning?: string; agentFile: string | null; skills: string[]; mcps: AgentMcp[];
  /** Text of selected Library entries (`library:<id>` refs in agentFile/skills); they are not workspace files.
   *  Views expose only `inlineDigest` (ref → digest). */
  inline?: Record<string, string>; inlineDigest?: Record<string, string>;
  claudeSubscription: boolean; workspaceMcp?: boolean; daemon?: {bin:string;dir:string};
  /** Approve the agent's tool permissions (allow-once) without asking, also while the desktop is closed. */
  autopilot?: boolean;
  /** Approval policy below autopilot: "auto-low" approves read/search/think/fetch tools only. */
  approvalPolicy?: "ask" | "auto-low";
  /** Provider session options (mode, reasoning and other advertised settings) reapplied on every connect. */
  settings?: Record<string, string | boolean>;
  /** True once the user named the agent; automatic "Provider/Model" naming then stops. */
  customName?: boolean;
  /** Workflow session ownership used for scoped tool activity tracing. */
  workflow?: { runId: string; blockId: string; workflowId?: string };
  /** Request provider-initiated turn lifecycle events for a Claude workflow session. */
  trackAutonomousClaudeTurns?: boolean;
}
export interface AgentSession extends AgentSpec {
  childSessions?: import("./acp-subagents").AcpSubagents;
  status: "starting" | "ready" | "busy" | "waiting" | "stopped" | "interrupted" | "error";
  /** The agent's own estimate for the current turn (report_progress tool); cleared when a turn starts. */
  progress?: AgentProgress | null;
  handoffPending?: boolean; contextSent?: boolean;
  /** Internal runner state: trusted context delivered through ACP systemPrompt append. Never public. */
  systemPrompt?: string | null;
  systemPromptSent?: boolean;
  /** Last progress instruction delivered through a user prompt on providers without systemPrompt. */
  progressInstruction?: string;
  /** Fingerprints of the instruction/skill texts already sent in this provider conversation (path → digest). */
  sentDigests?: Record<string, string>; sessionId: string | null; createdAt: string; updatedAt: string; error: string | null;
  configOptions: any[]; models: any; revision: number;
  /** Legacy ACP session modes, last reported context usage and prompt capabilities of the connected provider. */
  modes?: any; usage?: ReportedUsage | null; promptImages?: boolean;
  /** Slash commands last advertised by the provider (ACP available_commands_update). */
  commands?: { name: string; description?: string; input?: { hint?: string } | null }[];
  /** Desktop list projection of the latest activity; never drives the agent. */
  activity?: string;
}
/** A working daemon session published by the persistent-agents service. */
/** Self-reported progress of an agent's current request, 0–100. Shown in Hato's sidebar, not in the chat. */
export interface AgentProgress { percent: number; note?: string; at: number }
/** Validate a report_progress call: percent is clamped and rounded; the note is optional and short. */
export function agentProgress(args: any): AgentProgress {
  const n = Number(args?.percent);
  if (!Number.isFinite(n)) throw new Error("percent must be a number from 0 to 100");
  const note = typeof args?.note === "string" ? args.note.trim().slice(0, 80) : "";
  return { percent: Math.round(Math.max(0, Math.min(100, n))), ...(note ? { note } : {}), at: Date.now() };
}
export const REPORT_PROGRESS_TOOL = {
  name: "report_progress",
  description: "Update this session's sidebar progress with JSON such as {\"percent\":5,\"note\":\"Inspecting code\"}. Use 0–100: about 5 at the start, updates at major milestones, and 100 when finished. The optional note is at most 80 characters. Check the result: {\"percent\":5} acknowledges the update; isError or 'Transport closed' means it failed even if the call returned normally. Try another available report_progress endpoint for this session if a connection is closed. Sidebar only: do not put progress reports in chat replies.",
  inputSchema: { type: "object", properties: { percent: { type: "number", minimum: 0, maximum: 100 }, note: { type: "string", maxLength: 80, description: "Current step, a few words" } }, required: ["percent"], additionalProperties: false },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
};
/** Starting instruction for agents without Hato's MCP tools: an HTML comment in the reply, which
 *  Hato reads for the sidebar and strips from every transcript (Markdown hides it anyway). */
export const PROGRESS_MARKER_INSTRUCTION = "Progress: without Hato MCP tools, emit an HTML comment on its own line, exactly in this format: <!-- hato-progress 40 | Reading tests -->. Use a number from 0 to 100 and an optional short note after |. Emit about 5 when work starts, update at major milestones while working, and emit 100 only when finished; do not save all updates for the final reply. Hato reads these comments for its sidebar and hides them. Do not add visible progress percentages or explain the comments in chat.";
const MARKER = /<!--\s*hato-progress\s+(\d{1,3}(?:\.\d+)?)\s*%?\s*(?:\|\s*([^>]*?))?\s*-->/gi;
/** The latest complete progress marker in reply text, or null. */
export function lastProgressMarker(text: string): AgentProgress | null {
  let last: RegExpExecArray | null = null;
  for (const m of String(text || "").matchAll(MARKER)) last = m as RegExpExecArray;
  return last ? agentProgress({ percent: Number(last[1]), note: last[2] || "" }) : null;
}
/** Remove progress markers, including a still-streaming one at the end of the text. */
export function stripProgressMarkers(text: string): string {
  if (!text || !text.includes("<!--")) return text;
  // A marker on its own line takes the line with it; inline ones leave the text around them.
  let out = text.replace(new RegExp(`^[ \\t]*(?:${MARKER.source})[ \\t]*(?:\\r?\\n|$)`, "gim"), "").replace(MARKER, "");
  const open = out.lastIndexOf("<!--");
  if (open >= 0 && !out.includes("-->", open)) {
    // Unfinished comment at the end: drop it if it is (or could still become) a progress marker.
    const head = out.slice(open + 4).replace(/^\s+/, "").toLowerCase();
    const word = head.split(/[\s|]/)[0]!;
    if ("hato-progress".startsWith(word) || /^hato-progress\b/.test(head)) out = out.slice(0, open);
  }
  return out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
/** Rolling scan of streamed reply chunks: keeps a short tail so a marker split across chunks is found. */
export function scanProgressChunk(tail: string, chunk: string): { progress: AgentProgress | null; tail: string } {
  const text = tail + chunk;
  return { progress: lastProgressMarker(text), tail: text.slice(-240) };
}

/** Starting instruction for agents that have Hato's MCP tools. */
export const PROGRESS_INSTRUCTION = "Progress: call this session's report_progress tool with JSON like {\"percent\":5,\"note\":\"Inspecting code\"}. Use 0–100: about 5 at the start, update at major milestones while working, and 100 only when finished. The optional note is at most 80 characters. Inspect the tool result: {\"percent\":5} acknowledges the update; isError or 'Transport closed' means it failed even if the call returned normally. If a connection is closed, try another available report_progress endpoint for this session instead of repeatedly using the stale connection. Do not assume failed updates reached the sidebar. Progress feeds Hato's sidebar only — do not mention it in chat replies.";
export interface WorkingAgent {
  children?: import("./acp-subagents").AcpSubagent[];
  id: string;
  progress?: { percent: number; note?: string; at?: number } | null;
  name: string;
  workspaceId: string;
  status: Extract<AgentSession["status"], "starting" | "busy" | "waiting">;
  workflow: { workflowId?: string; runId?: string; blockId?: string } | null;
}
export interface AgentPermission { id: string; request: any; createdAt: string }
export interface AgentView { session: AgentSession; messages: ChatMessage[]; before: number | null; permissions: AgentPermission[]; queued: string[] }
export function modelChoices(state: {configOptions?:any[];models?:any}): {id:string;label:string;configId:string}[] {
  const option = state.configOptions?.find(o=>o.category === "model");
  if (option) {
    const flatten=(options:any[]):any[]=>options.flatMap(o=>Array.isArray(o.options)?flatten(o.options):[o]);
    return flatten(option.options || []).map(o=>({id:String(o.value),label:o.name || String(o.value),configId:option.id}));
  }
  return (state.models?.availableModels || []).map((m:any)=>({id:m.modelId,label:m.name||m.modelId,configId:"__model"}));
}
export function relativeAgentPath(value: unknown): string {
  if (typeof value !== "string" || !value || value.startsWith("/") || value.includes("\\") || value.split("/").some(p=>p===".." || !p)) throw new Error("Expected a workspace-relative instruction path");
  return value;
}

/** A bounded single-line preview. Keep the newest end of streaming text rather than the old
 * opening sentence, and do not replace useful output with bookkeeping like "Turn ended". */
export function agentActivity(view: AgentView): string {
  const compact=(value:string)=>value.replace(/\s+/g," ").trim();
  const tail=(value:string)=>{const text=compact(value);return text.length>180?"…"+text.slice(-179):text;};
  if(view.session.error)return "Error: "+tail(view.session.error);
  if(view.session.status==="waiting")return "Awaiting approval: "+tail(view.permissions[0]?.request?.toolCall?.title||"Agent tool request");
  if(view.session.status==="starting")return "Connecting to provider…";
  const latest=[...view.messages].reverse().find(m=>m.role!=="system"&&(compact(m.text||"")||m.title));
  if(latest?.role==="tool")return tail([latest.title||"Tool",latest.status,latest.text].filter(Boolean).join(" · "));
  if(latest?.role==="thought")return "Thinking: "+tail(latest.text);
  if(latest?.role==="user"&&view.session.status==="busy")return "Working on: "+tail(latest.text);
  if(latest)return tail(latest.text);
  return view.session.status==="busy"?"Working…":view.session.status==="ready"?"Ready for a prompt":view.session.status;
}

export type AgentPolicy = "ask" | "auto-low" | "autopilot";
export const agentPolicy = (s: { autopilot?: boolean; approvalPolicy?: string }): AgentPolicy =>
  s.autopilot ? "autopilot" : s.approvalPolicy === "auto-low" ? "auto-low" : "ask";
/** Tool kinds approved automatically under the "auto-low" policy (matches local chats). */
export const LOW_RISK_TOOL_KINDS = new Set(["read", "search", "think", "fetch"]);
/** Sanitized provider option map: bounded string ids with string or boolean values. */
export function agentSettings(value: unknown): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [k, v] of Object.entries(value).slice(0, 32))
    if (k && k.length <= 200 && (typeof v === "boolean" || (typeof v === "string" && v.length <= 500))) out[k] = v;
  return out;
}

/** Provider name without its adapter, e.g. "Claude (claude-agent-acp)" → "Claude". */
export function providerLabel(profile: { name?: string; provider?: string } | null | undefined): string {
  const name = String(profile?.name || profile?.provider || "Agent").replace(/\s*\([^)]*\)\s*$/, "").trim();
  return name || "Agent";
}
/** Model id currently selected on a session (config option, legacy models, or the saved spec). */
export function currentModel(s: { configOptions?: any[]; models?: any; model?: string }): string {
  const option = s.configOptions?.find(o => o.category === "model");
  return String(option?.currentValue ?? s.models?.currentModelId ?? s.model ?? "");
}
/** Automatic agent name "Provider/Model" ("Provider" until a model is known). */
export function autoAgentName(s: { profile?: { name?: string; provider?: string }; configOptions?: any[]; models?: any; model?: string }): string {
  const provider = providerLabel(s.profile), id = currentModel(s);
  const model = id ? modelChoices(s).find(m => m.id === id)?.label || id : "";
  return (model ? `${provider}/${model}` : provider).slice(0, 120);
}
/** Whether a name is still automatic (never typed by the user) and may follow provider/model changes. */
export function isAutoAgentName(s: { name: string; customName?: boolean; profile?: { name?: string; provider?: string }; configOptions?: any[]; models?: any; model?: string }): boolean {
  if (typeof s.customName === "boolean") return !s.customName;
  // Agents from before the flag existed: infer from the name's shape.
  const provider = providerLabel(s.profile), full = String(s.profile?.name || "");
  if (["Chat", "Agent", provider, full].includes(s.name)) return true;
  const [head, ...rest] = s.name.split("/"), model = rest.join("/");
  if (!model || (head !== provider && head !== full)) return false;
  return model === currentModel(s) || modelChoices(s).some(m => m.label === model || m.id === model) || model === s.model;
}
