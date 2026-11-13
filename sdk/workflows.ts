// Visual workflows: shared definition contract, validation, prompt rendering and the
// self-configuration reference. Bundled into the daemon runtime (workflow-runner), the desktop
// gateway (workflows) and the designer (workflows-panel). Definitions use the same JSON shape
// as VibeEditor/HatoPad workflows, so existing definitions import unchanged where the block
// types are supported here.
import type { ChatMessage } from "./types";
import type { AgentMcp, AgentProfile } from "./persistent-agents";

/** Bumped whenever the daemon runtime changes behavior; the gateway pushes a newer runtime when idle. */
export const WORKFLOW_RUNNER_VERSION = "8";

export type WorkflowBlockType =
  | "start_button" | "start_input" | "ai" | "chatbox" | "skill" | "mcp" | "task_controls" | "terminal_control"
  | "meeting" | "text" | "timer" | "user_prompt" | "yes_no_prompt" | "markdown" | "script" | "run_app";

export type WorkflowAppAction = "start" | "status" | "kill" | "tail";

export interface WorkflowDataSchema {
  type: "string" | "number" | "boolean" | "object" | "array";
  properties?: Record<string, WorkflowDataSchema>; required?: string[]; items?: WorkflowDataSchema;
}

export interface WorkflowBlock {
  id: string;
  type: WorkflowBlockType;
  label: string;
  description?: string;
  /** Prompt template, text content, question or instructions depending on the type. */
  prompt: string;
  position: { x: number; y: number };
  /** script, run_app */ command?: string;
  /** script */ timeoutSeconds?: number;
  /** timer */ seconds?: number;
  /** run_app */ app?: { name: string; actions?: WorkflowAppAction[]; action?: WorkflowAppAction; lines?: number };
  /** ai, chatbox: an ACP provider profile id (Settings → AI providers). Empty uses the run default. */ profileId?: string;
  /** ai, chatbox: HatoPad provider name (claude, codex, …); used when no profileId is set. */ provider?: string;
  /** ai, chatbox */ model?: string;
  /** ACP thought_level value, checked against the selected model at session startup. */ reasoning?: string;
  /** ai, chatbox: approve provider tool permissions automatically. */ autopilot?: boolean;
  /** ai, chatbox: workspace-relative instruction file (AGENTS.md, .agents/agents/x.md). */ agentFile?: string;
  /** skill: workspace-relative SKILL.md path of an existing skill (otherwise `prompt` holds instructions). */ skillId?: string;
  /** mcp: a configured MCP server id (MCP servers panel). */ mcp?: { serverId: string };
  /** Fan-in policy for converging follow/path connections. */ join?: "all" | "any";
  inputSchema?: WorkflowDataSchema; outputSchema?: WorkflowDataSchema;
}

export type WorkflowEdgeType = "follow" | "use" | "path";
export interface WorkflowEdge {
  id: string; from: string; to: string;
  /** follow (default): run `to` with this block's output. use: `to` is a tool of `from`. path: an AI-chosen route. */
  type?: WorkflowEdgeType;
  /** path: the route name the source chooses. */ label?: string;
  /** Mark a connection that intentionally closes a cycle. */ loop?: boolean;
  /** use: how long a tool call waits before returning timed_out (default 300 s). */ timeoutMs?: number;
}

export interface WorkflowSettings { maxLoopCount?: number; maxSteps?: number; outputLimitChars?: number; promptLimitChars?: number; maxRunDurationMs?: number }

export interface WorkflowDefinition {
  id: string; name: string; description?: string; version: number; createdAt: string; updatedAt: string;
  settings?: WorkflowSettings; blocks: WorkflowBlock[]; edges: WorkflowEdge[];
}

export interface WorkflowIssue { code: string; message: string; blockId?: string; edgeId?: string; severity?: "error" | "warning" }

export type WorkflowBlockStatus = "idle" | "queued" | "running" | "succeeded" | "failed" | "cancelled" | "skipped"
  | "waiting_timer" | "awaiting_user_input" | "awaiting_permission";
export type WorkflowRunStatus = "running" | "waiting" | "succeeded" | "failed" | "cancelled";

export interface WorkflowLog { at: string; kind: "lifecycle" | "prompt" | "response" | "error" | "tool"; text: string }
export interface WorkflowChatMessage { id: string; role: "user" | "assistant"; text: string; at: string }
export interface WorkflowMeetingMessage { seq: number; blockId: string; author: string; text: string; at: string; kind?: "status"; participantStatus?: WorkflowBlockStatus }

export interface WorkflowBlockState {
  blockId: string; status: WorkflowBlockStatus;
  startedAt?: string; completedAt?: string; runs: number;
  input?: string; prompt?: string; output?: string; error?: string;
  /** Background agent session (agent-runner id) for ai/chatbox blocks. */ sessionId?: string;
  selectedRoute?: string; question?: string; pauseId?: string; waitingUntil?: string;
  permissionId?: string; chat?: WorkflowChatMessage[];
  /** Last referenced excerpts delivered to this chatbox session. */
  referenceContext?: { sessionId: string; values: Record<string, string> };
  /** Live session projection supplied by the desktop gateway; does not change run status. */
  agentMessages?: ChatMessage[];
  agentHistoryBefore?: number | null;
  agentActivity?: { status: string; text: string; permissionId?: string };
  meeting?: { seq: number; messages: WorkflowMeetingMessage[]; cursors: Record<string, number> };
  log: WorkflowLog[];
}

export interface WorkflowRunEnv {
  projectId: string; workspaceId: string; workspaceName: string; root: string; machineId: string;
  daemon?: { bin: string; dir: string };
  profiles: AgentProfile[]; defaultProfileId: string; claudeSubscription: boolean;
  mcpServers: AgentMcp[];
  /** Provider-ready configurations, including fresh remote authorization. */
  mcpConfigs?: Record<string, any>;
}

/** Actual payload boundaries, retained in order so polling cannot lose fast calls. */
export interface WorkflowTransfer {
  seq: number; callId: string; edgeId: string; phase: "send" | "return" | "flow";
  at: string; action?: string; chars: number; error?: boolean;
}
export interface WorkflowRun {
  id: string; workflowId: string; workflowName: string; projectId: string; workspaceId: string;
  status: WorkflowRunStatus; input: string; startBlockId?: string;
  createdAt: string; completedAt?: string; error?: string;
  definition: WorkflowDefinition; blocks: WorkflowBlockState[]; transfers?: WorkflowTransfer[];
}

/** Presentation-neutral catalog: labels, behavior summary and which fields a block uses. */
export const WORKFLOW_BLOCKS: { type: WorkflowBlockType; label: string; summary: string; fields: string[]; tool: boolean }[] = [
  { type: "start_button", label: "Start button", summary: "Starts the run with its prompt as the input.", fields: ["prompt"], tool: false },
  { type: "start_input", label: "Start with text", summary: "Starts the run with text typed when it is run.", fields: [], tool: false },
  { type: "ai", label: "AI Agent", summary: "A background agent session that runs its prompt template and returns its final answer.", fields: ["prompt", "profileId", "model", "reasoning", "autopilot", "agentFile"], tool: true },
  { type: "chatbox", label: "Chatbox", summary: "A persistent conversation; every outgoing connection is a tool it can call.", fields: ["prompt", "profileId", "model", "reasoning", "autopilot", "agentFile"], tool: true },
  { type: "skill", label: "SKILL", summary: "Reusable instructions, custom or loaded from a workspace SKILL.md.", fields: ["description", "prompt", "skillId"], tool: true },
  { type: "text", label: "Text input", summary: "Fixed text (supports templates) passed on or returned to the caller.", fields: ["prompt"], tool: true },
  { type: "markdown", label: "Markdown document", summary: "Renders its template, or its input, as a Markdown document.", fields: ["prompt"], tool: true },
  { type: "script", label: "Script execution", summary: "Runs a shell command in the workspace; stdin and $HATO_WORKFLOW_INPUT receive the input.", fields: ["command", "timeoutSeconds"], tool: true },
  { type: "run_app", label: "Run App", summary: "Starts, checks, kills or tails a named long-lived app.", fields: ["command", "app"], tool: true },
  { type: "timer", label: "Timer", summary: "Waits, then passes its input to follow connections. Used as a tool it arms and returns at once.", fields: ["seconds"], tool: true },
  { type: "user_prompt", label: "User Prompt", summary: "Asks the user a question and returns the typed answer.", fields: ["prompt"], tool: true },
  { type: "yes_no_prompt", label: "Yes/No Prompt", summary: "Asks the user and returns \"yes\" or \"no\" (also selects a yes/no path).", fields: ["prompt"], tool: true },
  { type: "meeting", label: "Meeting", summary: "A shared, attributed discussion between connected agents.", fields: ["description"], tool: true },
  { type: "terminal_control", label: "Terminal Control", summary: "Gives connected agents the workspace terminal tools (list, read, write).", fields: [], tool: true },
  { type: "task_controls", label: "Task controls", summary: "Gives connected agents the Git task tools (list, create, start agent).", fields: [], tool: true },
  { type: "mcp", label: "MCP server", summary: "Attaches a configured MCP server to connected agents.", fields: ["mcp"], tool: true },
];
export const blockInfo = (type: string) => WORKFLOW_BLOCKS.find(b => b.type === type);
const AGENT_TYPES = new Set(["ai", "chatbox"]);
export const isAgentBlock = (b: { type: string }) => AGENT_TYPES.has(b.type);
/** Blocks that only add capabilities to connected agents and never execute themselves. */
export const isCapabilityBlock = (b: { type: string }) => b.type === "terminal_control" || b.type === "task_controls" || b.type === "mcp";
export const isStartBlock = (b: { type: string }) => b.type === "start_button" || b.type === "start_input";
export const edgeType = (e: WorkflowEdge): WorkflowEdgeType => e.type || "follow";

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const now = () => new Date().toISOString();
const clip = (v: unknown, n: number) => typeof v === "string" ? v.slice(0, n) : "";
const num = (v: unknown) => typeof v === "number" && Number.isFinite(v) ? v : undefined;

/** Coerce untrusted JSON (designer, import, agent writes) into a definition. Unknown fields are dropped. */
export function normalizeDefinition(raw: any, fallback?: Partial<WorkflowDefinition>): WorkflowDefinition {
  if (!raw || typeof raw !== "object") throw new Error("A workflow definition must be a JSON object");
  if (raw.blocks !== undefined && !Array.isArray(raw.blocks)) throw new Error("blocks must be an array");
  if (raw.edges !== undefined && !Array.isArray(raw.edges)) throw new Error("edges must be an array");
  if ((raw.blocks?.length || 0) > 300 || (raw.edges?.length || 0) > 1000) throw new Error("A workflow is limited to 300 blocks and 1000 connections");
  const blocks: WorkflowBlock[] = (raw.blocks || []).map((b: any, i: number) => {
    const block: WorkflowBlock = {
      id: clip(b?.id, 80) || `block-${i + 1}`, type: String(b?.type || "") as WorkflowBlockType,
      label: clip(b?.label, 200), prompt: clip(b?.prompt, 200_000),
      position: { x: Math.round(num(b?.position?.x) ?? 40 + (i % 5) * 260), y: Math.round(num(b?.position?.y) ?? 40 + Math.floor(i / 5) * 170) },
    };
    if (typeof b?.description === "string") block.description = clip(b.description, 4000);
    if (typeof b?.command === "string") block.command = clip(b.command, 64_000);
    if (num(b?.timeoutSeconds) !== undefined) block.timeoutSeconds = num(b.timeoutSeconds);
    if (num(b?.seconds) !== undefined) block.seconds = num(b.seconds);
    if (b?.app && typeof b.app === "object") block.app = {
      name: clip(b.app.name, 80), ...(Array.isArray(b.app.actions) ? { actions: b.app.actions.filter((a: any) => ["start", "status", "kill", "tail"].includes(a)) } : {}),
      ...(["start", "status", "kill", "tail"].includes(b.app.action) ? { action: b.app.action } : {}), ...(num(b.app.lines) ? { lines: num(b.app.lines) } : {}),
    };
    for (const k of ["profileId", "provider", "model", "reasoning", "agentFile", "skillId"] as const) if (typeof b?.[k] === "string" && b[k]) (block as any)[k] = clip(b[k], 400);
    // HatoPad agent references ({scope,name}) have no Hato equivalent; workspace files are kept.
    if (!block.agentFile && b?.agent && b.agent.scope === "workspace" && typeof b.agent.name === "string") block.agentFile = `.agents/agents/${clip(b.agent.name, 180)}`;
    if (typeof b?.autopilot === "boolean") block.autopilot = b.autopilot;
    if (b?.mcp && typeof b.mcp.serverId === "string") block.mcp = { serverId: clip(b.mcp.serverId, 120) };
    if (b?.join === "any" || b?.join === "all") block.join = b.join;
    if (b?.inputSchema && typeof b.inputSchema === "object") block.inputSchema = b.inputSchema;
    if (b?.outputSchema && typeof b.outputSchema === "object") block.outputSchema = b.outputSchema;
    return block;
  });
  const edges: WorkflowEdge[] = (raw.edges || []).map((e: any, i: number) => {
    const edge: WorkflowEdge = { id: clip(e?.id, 120) || `edge-${i + 1}`, from: clip(e?.from, 80), to: clip(e?.to, 80) };
    if (["follow", "use", "path"].includes(e?.type)) edge.type = e.type;
    if (typeof e?.label === "string" && e.label) edge.label = clip(e.label, 80);
    if (e?.loop === true) edge.loop = true;
    if (num(e?.timeoutMs)) edge.timeoutMs = num(e.timeoutMs);
    return edge;
  });
  const settings: WorkflowSettings = {};
  for (const k of ["maxLoopCount", "maxSteps", "outputLimitChars", "promptLimitChars", "maxRunDurationMs"] as const) if (num(raw.settings?.[k]) !== undefined) settings[k] = num(raw.settings[k]);
  return {
    id: clip(raw.id, 80) || fallback?.id || crypto.randomUUID(), name: clip(raw.name, 200).trim() || fallback?.name || "Untitled workflow",
    ...(typeof raw.description === "string" ? { description: clip(raw.description, 4000) } : {}),
    version: num(raw.version) ?? fallback?.version ?? 1, createdAt: clip(raw.createdAt, 40) || fallback?.createdAt || now(), updatedAt: now(),
    ...(Object.keys(settings).length ? { settings } : {}), blocks, edges,
  };
}

const reaches = (edges: WorkflowEdge[], from: string, to: string) => {
  const seen = new Set<string>(), stack = [from];
  while (stack.length) {
    const c = stack.pop()!;
    if (c === to) return true;
    if (seen.has(c)) continue;
    seen.add(c);
    for (const e of edges) if (e.from === c && edgeType(e) !== "use") stack.push(e.to);
  }
  return false;
};

/** Graph validation. Errors block a run; warnings are advice. Saving keeps invalid drafts. */
export function validateWorkflow(def: WorkflowDefinition, available?: { profiles?: { id: string; provider?: string }[]; mcps?: { id: string }[] }): WorkflowIssue[] {
  const issues: WorkflowIssue[] = [];
  const err = (code: string, message: string, extra: Partial<WorkflowIssue> = {}) => issues.push({ code, message, severity: "error", ...extra });
  const warn = (code: string, message: string, extra: Partial<WorkflowIssue> = {}) => issues.push({ code, message, severity: "warning", ...extra });
  if (!def.blocks.length) err("empty", "Add at least one block before running this workflow");
  const ids = new Set<string>();
  for (const b of def.blocks) {
    const name = b.label || b.id;
    if (!ID.test(b.id)) err("invalid-id", `Block ID '${b.id}' must start with a letter or digit and use letters, digits, _ or -`, { blockId: b.id });
    if (ids.has(b.id)) err("duplicate-id", `Block ID '${b.id}' is duplicated`, { blockId: b.id });
    ids.add(b.id);
    const info = blockInfo(b.type);
    if (!info) { err("unsupported-type", `Block '${name}' has unsupported type '${b.type}'`, { blockId: b.id }); continue; }
    if (!b.label.trim()) err("empty-label", "Every block needs a name", { blockId: b.id });
    if (["ai", "start_button", "user_prompt", "yes_no_prompt"].includes(b.type) && !b.prompt.trim()) err("empty-prompt", `Block '${name}' needs a prompt`, { blockId: b.id });
    if (b.type === "skill" && !b.skillId && !b.prompt.trim()) err("empty-prompt", `Skill '${name}' needs instructions or an existing skill`, { blockId: b.id });
    if (b.type === "skill" && !b.description?.trim()) warn("skill-description", `Skill '${name}' should describe when to use it`, { blockId: b.id });
    if (b.type === "skill" && b.skillId && (b.skillId.startsWith("/") || b.skillId.split("/").includes("..") || !b.skillId.endsWith(".md")))
      err("invalid-skill", `Skill '${name}' must reference a workspace-relative SKILL.md file`, { blockId: b.id });
    if ((b.type === "script" || b.type === "run_app") && !b.command?.trim()) err("empty-command", `Block '${name}' needs a shell command`, { blockId: b.id });
    if (b.type === "script" && b.timeoutSeconds !== undefined && !(b.timeoutSeconds >= 1 && b.timeoutSeconds <= 86_400)) err("invalid-timeout", `Script '${name}' timeout must be 1–86400 seconds`, { blockId: b.id });
    if (b.type === "run_app" && !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(b.app?.name || "")) err("invalid-app", `Run App '${name}' needs an app name (letters, digits, . _ -)`, { blockId: b.id });
    if (b.type === "timer" && !(Number.isInteger(b.seconds) && b.seconds! >= 0 && b.seconds! <= 7 * 86_400)) err("invalid-timer", `Timer '${name}' needs whole seconds from 0 to 604800`, { blockId: b.id });
    if (b.type === "mcp" && !b.mcp?.serverId) err("invalid-mcp", `MCP block '${name}' needs a configured server`, { blockId: b.id });
    if (b.type === "mcp" && b.mcp?.serverId && available?.mcps && !available.mcps.some(m => m.id === b.mcp!.serverId)) warn("unavailable-mcp", `MCP server for '${name}' is not configured or enabled`, { blockId: b.id });
    if (isAgentBlock(b) && available?.profiles) {
      const ok = b.profileId ? available.profiles.some(p => p.id === b.profileId) : b.provider ? available.profiles.some(p => p.provider === b.provider) : available.profiles.length > 0;
      if (!ok) err("unavailable-provider", `No enabled AI provider matches '${name}' on this machine`, { blockId: b.id });
    }
    if (isAgentBlock(b) && b.agentFile && (b.agentFile.startsWith("/") || b.agentFile.split("/").includes(".."))) err("invalid-agent", `Agent file of '${name}' must be workspace-relative`, { blockId: b.id });
  }
  const edgeIds = new Set<string>(), pairs = new Set<string>();
  for (const e of def.edges) {
    if (edgeIds.has(e.id)) err("duplicate-edge-id", `Connection ID '${e.id}' is duplicated`, { edgeId: e.id });
    edgeIds.add(e.id);
    const from = def.blocks.find(b => b.id === e.from), to = def.blocks.find(b => b.id === e.to);
    if (!from || !to) { err("missing-endpoint", `Connection '${e.id}' references a missing block`, { edgeId: e.id }); continue; }
    if (e.from === e.to) err("self-edge", `Block '${from.label}' cannot connect to itself`, { edgeId: e.id });
    const pair = `${e.from}>${e.to}>${edgeType(e)}>${e.label || ""}`;
    if (pairs.has(pair)) err("duplicate-edge", `Duplicate connection from '${from.label}' to '${to.label}'`, { edgeId: e.id });
    pairs.add(pair);
    const t = edgeType(e);
    if (t === "use" && !isAgentBlock(from)) err("invalid-use", `Only AI Agent and Chatbox blocks can use '${to.label}' as a tool`, { edgeId: e.id });
    if (t === "use" && isStartBlock(to)) err("invalid-use", "Start blocks cannot be used as tools", { edgeId: e.id });
    if (t === "path" && from.type !== "ai" && from.type !== "yes_no_prompt") err("route-label", `Paths start at an AI Agent or Yes/No Prompt ('${from.label}')`, { edgeId: e.id });
    if (t === "path" && !e.label?.trim()) err("route-label", `Path from '${from.label}' needs a route name`, { edgeId: e.id });
    if (t === "path" && from.type === "yes_no_prompt" && e.label && !["yes", "no"].includes(e.label)) err("route-label", "Yes/No paths are named yes or no", { edgeId: e.id });
    if (t !== "use" && from.type !== "chatbox" && isCapabilityBlock(to)) err("invalid-capability", `'${to.label}' adds tools to agents; connect it with a Use connection`, { edgeId: e.id });
    if (t !== "use" && isStartBlock(to)) err("invalid-follow", "Start blocks cannot have incoming connections", { edgeId: e.id });
    if (t !== "use" && from.type === "chatbox") warn("chatbox-follow", `Chatbox '${from.label}' exposes every outgoing connection as a tool; follow connections do not run automatically`, { edgeId: e.id });
    if (t !== "use" && !e.loop && reaches(def.edges.filter(x => x.id !== e.id), e.to, e.from) && !["timer", "user_prompt", "yes_no_prompt"].includes(from.type) && !isAgentBlock(to))
      warn("cycle", `Connection '${from.label}' → '${to.label}' closes a cycle; mark it as a loop if intended`, { edgeId: e.id });
  }
  return issues;
}
export const blockingIssues = (issues: WorkflowIssue[]) => issues.filter(i => i.severity !== "warning");

/** Bounded preview used when a template references another block's output. */
export function preview(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const head = Math.floor(limit * 0.6), tail = limit - head;
  return `${text.slice(0, head)}\n…[${text.length - limit} characters omitted; use workflow_block_output to page]…\n${text.slice(-tail)}`;
}

/** `{{input}}` and `{{blocks.ID.output}}` placeholders. Missing outputs render as empty text. */
export function renderPrompt(template: string, input: string, outputs: Map<string, string> | Record<string, string>, limits = { reference: 8000, total: 20000 }): string {
  const get = (id: string) => outputs instanceof Map ? outputs.get(id) : outputs[id];
  let budget = limits.total;
  return template.replace(/\{\{\s*(input|blocks\.([A-Za-z0-9_-]+)\.output)\s*\}\}/g, (_m, all, id) => {
    if (all === "input") return input;
    const value = get(id) ?? "";
    const text = preview(value, Math.max(200, Math.min(limits.reference, budget)));
    budget = Math.max(0, budget - text.length);
    return text;
  });
}

export const newBlockId = (def: WorkflowDefinition, type: string) => {
  const base = type.replace(/_/g, "-");
  for (let i = 1; ; i++) if (!def.blocks.some(b => b.id === `${base}-${i}`)) return `${base}-${i}`;
};
export const newEdgeId = (def: WorkflowDefinition, from: string, to: string) => {
  const base = `${from}-${to}`.slice(0, 100);
  if (!def.edges.some(e => e.id === base)) return base;
  for (let i = 2; ; i++) if (!def.edges.some(e => e.id === `${base}-${i}`)) return `${base}-${i}`;
};

export const WORKFLOW_REFERENCE = String.raw`# Hato workflows: blocks and connections

Workflows are JSON graphs of blocks joined by connections. They run on the workspace
machine's daemon (hatod), so a run continues when the desktop disconnects. Saving a
workflow never starts it; the user runs it from the Workflows panel.

## Definition

~~~json
{"id":"review","name":"Review changes","blocks":[
  {"id":"start","type":"start_button","label":"Start","prompt":"Review the current changes","position":{"x":40,"y":80}},
  {"id":"status","type":"script","label":"Git status","prompt":"","command":"git status --short","position":{"x":300,"y":260}},
  {"id":"reviewer","type":"ai","label":"Reviewer","prompt":"{{input}}\nUse the status block, then report findings.","position":{"x":300,"y":80}}],
 "edges":[{"id":"e1","from":"start","to":"reviewer","type":"follow"},
  {"id":"e2","from":"reviewer","to":"status","type":"use"}]}
~~~

Keep block and connection IDs stable when editing (letters, digits, _ and -). Positions are
designer coordinates in pixels; place new blocks about 260 px apart horizontally.

## Connections

- follow (default): when the source finishes, the target runs with the source's output as input.
  Several follows from one block run in parallel. Converging follows join: the target waits for
  all active branches (join "all", default) or runs on the first one (join "any").
- use: the target becomes a tool of the source AI Agent or Chatbox, called with workflow_use_block.
- path: a named route (label). An AI Agent with paths must call workflow_choose_path before it
  finishes; only matching path connections run. Yes/No Prompts select the "yes" or "no" path.
- loop: true marks a follow/path that intentionally returns to an earlier block (bounded by
  settings.maxLoopCount, default 100).

## Templates

Prompts may contain {{input}} (the block's input) and {{blocks.ID.output}} (another block's latest
output, previewed to 8,000 characters). AI prompts without {{input}} get the input appended.

## Blocks

| type | fields | behavior |
| --- | --- | --- |
| start_button | prompt | Starts a run; its prompt becomes the input. |
| start_input | — | Starts a run with text typed by the user. |
| ai | prompt, profileId or provider, model, reasoning, autopilot, agentFile | Background agent session. Returns its final answer. Keeps its context for later invocations in the run. |
| chatbox | prompt (session guidance), profileId, model, reasoning, autopilot | Persistent conversation the user chats with. All outgoing connections are its tools. |
| skill | description, prompt or skillId (workspace SKILL.md path) | Instructions loaded on demand by connected agents. |
| text | prompt | Returns its rendered text. |
| markdown | prompt (optional) | Renders its template or its input as a Markdown document. |
| script | command, timeoutSeconds (default 1800) | sh -lc in the workspace root. stdin and $HATO_WORKFLOW_INPUT receive the input. Non-zero exit fails. |
| run_app | command, app {name, actions} | Named long-lived app: start, status, kill, tail. Survives between runs until killed. |
| timer | seconds | Waits, then follows run with its input. As a tool it arms and returns at once; reusing it re-arms. |
| user_prompt | prompt | Asks the user; returns the typed answer. |
| yes_no_prompt | prompt | Asks the user; returns "yes" or "no". |
| meeting | description | Shared transcript: publish, tail, diff, wait, status, shake. Participant work/idle/permission/error status changes are posted automatically and wake room waiters. |
| terminal_control | — | Connected agents call workflow_use_block with action list/read/write; read/write take key, read accepts cursor, write takes text. Requests/results are logged on the block. |
| task_controls | — | Use it to give an agent Git task tools (tasks_list/create/start_agent; desktop open). |
| mcp | mcp {serverId} | Use it to attach a configured MCP server to an agent. |

AI providers: profileId is an ACP profile id from the catalog (workflows__catalog). A block may
instead name a provider (claude, codex, gemini, …); the first enabled matching profile is used.

## Agent tools inside a run

- workflow_connections: list connected tools.
- workflow_use_block {block_id, input?, action?, lines?, timeout_seconds?}: run or control a connected block.
  AI/Chatbox actions: (omitted) run and wait, start, status, tail, steer. Run App: start, status,
  kill, tail. Meeting: publish {message}, tail, diff (default), wait, status, shake {peer_block_id, message} (a specific nonempty message is required).
  Any data block: fetch returns output not yet fetched by this caller.
- workflow_block_output {block_id, offset?, limit?}: page through retained output.
- workflow_block_messages {block_id, count?}: recent messages of a connected agent.
- workflow_choose_path {path}: choose a route before finishing.

## Self-configuration

Use workflows__list, workflows__read, workflows__write and workflows__validate (desktop MCP) or the
configurator's workflows_* tools. Read before writing and pass the returned revision as
expected_revision (null to create). Check returned validation issues. Never start runs unasked.
`;
