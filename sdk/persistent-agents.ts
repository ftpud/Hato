import type { ChatMessage } from "./types";
export interface AgentProfile { id: string; provider: string; name: string; executable: string; args: string[]; envRefs?: Record<string,string>; enabled?: boolean }
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
  claudeSubscription: boolean; workspaceMcp?: boolean; daemon?: {bin:string;dir:string};
  /** Approve the agent's tool permissions (allow-once) without asking, also while the desktop is closed. */
  autopilot?: boolean;
  /** Approval policy below autopilot: "auto-low" approves read/search/think/fetch tools only. */
  approvalPolicy?: "ask" | "auto-low";
  /** Provider session options (mode, reasoning and other advertised settings) reapplied on every connect. */
  settings?: Record<string, string | boolean>;
  /** Workflow session ownership used for scoped tool activity tracing. */
  workflow?: { runId: string; blockId: string };
}
export interface AgentSession extends AgentSpec {
  status: "starting" | "ready" | "busy" | "waiting" | "stopped" | "interrupted" | "error";
  contextSent?: boolean; sessionId: string | null; createdAt: string; updatedAt: string; error: string | null;
  configOptions: any[]; models: any; revision: number;
  /** Legacy ACP session modes, last reported context usage and prompt capabilities of the connected provider. */
  modes?: any; usage?: { used: number; size: number } | null; promptImages?: boolean;
  /** Desktop list projection of the latest activity; never drives the agent. */
  activity?: string;
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
