import type { ChatMessage } from "./types";
export interface AgentProfile { id: string; provider: string; name: string; executable: string; args: string[]; envRefs?: Record<string,string>; enabled?: boolean }
export interface AgentMcp { enabled?: boolean; id: string; name: string; command: string; args: string[]; env: {name:string; value:string}[] }
export interface AgentSpec {
  id: string; name: string; workspaceId: string; workspaceName: string; root: string; machineId: string;
  profile: AgentProfile; model: string; agentFile: string | null; skills: string[]; mcps: AgentMcp[];
  claudeSubscription: boolean; workspaceMcp?: boolean; daemon?: {bin:string;dir:string};
  /** Approve the agent's tool permissions (allow-once) without asking, also while the desktop is closed. */
  autopilot?: boolean;
}
export interface AgentSession extends AgentSpec {
  status: "starting" | "ready" | "busy" | "waiting" | "stopped" | "interrupted" | "error";
  contextSent?: boolean; sessionId: string | null; createdAt: string; updatedAt: string; error: string | null;
  configOptions: any[]; models: any; revision: number;
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
