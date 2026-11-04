// Workflow execution on the daemon. Semantics follow HatoPad's flow runner: follow connections
// pass output on, converging follows join (all/any), path connections are routes chosen by an AI
// Agent (or a Yes/No Prompt), and use connections make blocks tools of AI Agents and Chatboxes.
import type { ModuleContext, Handle } from "../../../../sdk/types";
import { errMsg } from "../../../../sdk/runtime";
import { acpServer, transportOf } from "../../../../sdk/mcp-servers";
import type { AgentProfile } from "../../../../sdk/persistent-agents";
import {
  type WorkflowBlock, type WorkflowBlockState, type WorkflowDefinition, type WorkflowEdge, type WorkflowRun, type WorkflowRunEnv,
  edgeType, isAgentBlock, isCapabilityBlock, isStartBlock, preview, renderPrompt,
} from "../../../../sdk/workflows";
import { appAction, runScript } from "./procs";
import { issueEndpoint, revokeWhere } from "./mcp";

export interface Exec {
  run: WorkflowRun; env: WorkflowRunEnv; def: WorkflowDefinition;
  mcpCalls: Map<string, { blockId: string; edgeId: string; callId: string; title: string; status: string }>;
  outputs: Map<string, string>; busy: Set<string>;
  timers: Map<string, ReturnType<typeof setTimeout>>;
  answers: Map<string, { pauseId: string; resolve: (v: string) => void; reject: (e: Error) => void }>;
  background: Set<Promise<unknown>>; loops: Map<string, number>; steps: number;
  joins: Map<string, { resolved: Set<string>; active: Set<string>; outputs: Map<string, string>; fired: boolean }>;
  fetched: Map<string, number>; meetingWaiters: Map<string, Set<() => void>>; participantStatuses: Map<string, string>;
  procs: Set<Handle>; cancelled: boolean; flowFailed?: string; driving: boolean; deadline?: ReturnType<typeof setTimeout>;
}

let ctx: ModuleContext;
let persist: (run: WorkflowRun) => void;
export const execs = new Map<string, Exec>();
export function initEngine(c: ModuleContext, save: (run: WorkflowRun) => void) { ctx = c; persist = save; }

const now = () => new Date().toISOString();
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const block = (x: Exec, id: string) => { const b = x.def.blocks.find(b => b.id === id); if (!b) throw new Error(`Unknown block '${id}'`); return b; };
export const stateOf = (x: Exec, id: string) => { let s = x.run.blocks.find(s => s.blockId === id); if (!s) { s = { blockId: id, status: "idle", runs: 0, log: [] }; x.run.blocks.push(s); } return s; };
const outputLimit = (x: Exec) => x.def.settings?.outputLimitChars ?? 200_000;
function log(s: WorkflowBlockState, kind: WorkflowBlockState["log"][number]["kind"], text: string) {
  s.log.push({ at: now(), kind, text: text.length > 4000 ? text.slice(0, 4000) + "…" : text });
  if (s.log.length > 200) s.log.splice(0, s.log.length - 200);
}
export function touch(x: Exec) {
  publishMeetingStatusChanges(x);
  if (x.run.status === "running" || x.run.status === "waiting") {
    const active = x.run.blocks.some(s => s.status === "running");
    const paused = x.run.blocks.some(s => ["awaiting_user_input", "awaiting_permission", "waiting_timer"].includes(s.status));
    x.run.status = active ? "running" : paused ? "waiting" : "running";
  }
  persist(x.run);
}
export function transfer(x: Exec, edgeId: string, phase: "send" | "return" | "flow", payload: unknown, callId = crypto.randomUUID(), action?: string, error = false) {
  const events = x.run.transfers ??= [];
  const text = typeof payload === "string" ? payload : JSON.stringify(payload) || "";
  events.push({ seq: (events[events.length - 1]?.seq ?? 0) + 1, callId, edgeId, phase, at: now(), action, chars: text.length, ...(error ? { error: true } : {}) });
  if (events.length > 1000) events.splice(0, events.length - 1000);
  touch(x);
  return callId;
}
/** Attribute provider MCP events only to a server explicitly connected to this agent. */
export function recordMcpActivity(x: Exec, callerId: string, sessionId: string, u: any) {
  if (stateOf(x, callerId).sessionId !== sessionId || !u.toolCallId) return;
  const key = `${sessionId}:${u.toolCallId}`;
  let call = x.mcpCalls.get(key);
  if (!call) {
    const raw = u.rawInput || {};
    const server = raw.server || raw.server_name || raw.mcpServer || u._meta?.mcpServer;
    const title = String(u.title || raw.tool || raw.name || "");
    const names = [u.title, raw.tool, raw.name].filter((name): name is string => typeof name === "string");
    const candidates = toolTargets(x, callerId).filter(b => b.type === "mcp").filter(b => {
      const config = x.env.mcpServers.find(m => m.id === b.mcp?.serverId);
      return config && [config.id, config.name].some(name => server === name || names.some(tool => tool.startsWith(`mcp__${name}__`) || tool.startsWith(`mcp.${name}.`)));
    });
    // Ambiguous or unqualified native tools must never light up an unrelated MCP block.
    if (candidates.length !== 1) return;
    const target = candidates[0];
    const edge = x.def.edges.find(e => e.from === callerId && e.to === target.id && edgeType(e) === "use")
      || x.def.edges.find(e => e.from === callerId && e.to === target.id && block(x, callerId).type === "chatbox");
    if (!edge) return;
    const callId = transfer(x, edge.id, "send", raw.arguments || raw, undefined, title);
    call = { blockId: target.id, edgeId: edge.id, callId, title: title || String(raw.tool || "MCP tool"), status: "" };
    x.mcpCalls.set(key, call);
    const st = stateOf(x, target.id);
    st.runs++; st.startedAt = now(); st.completedAt = undefined; st.error = undefined;
    log(st, "tool", `${callerId} · ${call.title} · ${callId}\n${preview(JSON.stringify(raw.arguments || raw), 3000)}`);
  }
  const status = String(u.status || "in_progress");
  if (call.status === status || ["completed", "failed"].includes(call.status)) return;
  call.status = status;
  const st = stateOf(x, call.blockId);
  if (["completed", "failed"].includes(status)) {
    const result = (u.content || []).map((item: any) => item.content?.text || item.text || "").join("\n");
    log(st, status === "failed" ? "error" : "response", `${call.title} · ${status} · ${call.callId}\n${result}`);
    transfer(x, call.edgeId, "return", result, call.callId, call.title, status === "failed");
    if (status === "failed") st.error = preview(result || `${call.title} failed`, 1000);
    st.completedAt = now();
  }
  const pending = [...x.mcpCalls.values()].some(c => c.blockId === call!.blockId && !["completed", "failed"].includes(c.status));
  st.status = pending ? "running" : st.error ? "failed" : "succeeded";
  // Retain bounded terminal identities so duplicate provider updates are harmless.
  if (x.mcpCalls.size > 200) for (const [id, old] of x.mcpCalls) {
    if (x.mcpCalls.size <= 200) break;
    if (["completed", "failed"].includes(old.status)) x.mcpCalls.delete(id);
  }
  touch(x);
}

function assertActive(x: Exec) { if (x.cancelled) throw new Error("Workflow run was cancelled"); }

export function newExec(run: WorkflowRun, env: WorkflowRunEnv): Exec {
  const x: Exec = {
    run, env, def: run.definition, mcpCalls: new Map(), outputs: new Map(), busy: new Set(), timers: new Map(), answers: new Map(), background: new Set(),
    loops: new Map(), steps: 0, joins: new Map(), fetched: new Map(), meetingWaiters: new Map(), participantStatuses: new Map(run.blocks.map(s => [s.blockId, s.status])), procs: new Set(), cancelled: false, driving: false,
  };
  for (const s of run.blocks) if (s.output !== undefined) x.outputs.set(s.blockId, s.output);
  execs.set(run.id, x);
  return x;
}

// ---------------------------------------------------------------- graph helpers

const flowEdge = (e: WorkflowEdge) => edgeType(e) !== "use";
function reaches(x: Exec, from: string, to: string) {
  const seen = new Set<string>(), stack = [from];
  while (stack.length) {
    const c = stack.pop()!;
    if (c === to) return true;
    if (seen.has(c)) continue;
    seen.add(c);
    for (const e of x.def.edges) if (e.from === c && flowEdge(e)) stack.push(e.to);
  }
  return false;
}
/** Connections that close a cycle are loop returns, not join inputs. */
const forwardEdge = (x: Exec, e: WorkflowEdge) => !e.loop && flowEdge(e) && !reaches(x, e.to, e.from);
/** Blocks a caller may use: use connections, and every outgoing connection of a Chatbox. */
export function toolTargets(x: Exec, callerId: string): WorkflowBlock[] {
  const caller = block(x, callerId);
  const ids = x.def.edges.filter(e => e.from === callerId && (edgeType(e) === "use" || caller.type === "chatbox")).map(e => e.to);
  return [...new Set(ids)].map(id => block(x, id));
}

function joinInput(x: Exec, target: string, active: WorkflowEdge[], outputs: Map<string, string>) {
  return active.map(e => `## ${block(x, e.from).label} (${e.from})\n${preview(outputs.get(e.from) ?? "", Math.floor(20_000 / active.length))}`).join("\n\n");
}

function resolveEdge(x: Exec, e: WorkflowEdge, active: boolean, output: string, path: string[], visited = new Set<string>()): Promise<unknown>[] {
  if (active) transfer(x, e.id, "flow", output);
  const target = e.to;
  const incoming = x.def.edges.filter(i => i.to === target && forwardEdge(x, i));
  const outgoing = () => x.def.edges.filter(o => o.from === target && forwardEdge(x, o));
  if (incoming.length < 2) {
    if (active) return [invoke(x, target, output, path)];
    if (visited.has(target)) return [];
    visited.add(target);
    return outgoing().flatMap(n => resolveEdge(x, n, false, "", [...path, target], visited));
  }
  let entry = x.joins.get(target);
  if (!entry) { entry = { resolved: new Set(), active: new Set(), outputs: new Map(), fired: false }; x.joins.set(target, entry); }
  entry.resolved.add(e.id);
  if (active) { entry.active.add(e.id); entry.outputs.set(e.from, output); }
  const complete = incoming.every(i => entry!.resolved.has(i.id));
  const results: Promise<unknown>[] = [];
  if (!entry.fired && entry.active.size > 0 && (complete || block(x, target).join === "any")) {
    entry.fired = true;
    const activeEdges = incoming.filter(i => entry!.active.has(i.id));
    const input = activeEdges.length === 1 ? entry.outputs.get(activeEdges[0].from)! : joinInput(x, target, activeEdges, entry.outputs);
    results.push(invoke(x, target, input, path));
  }
  if (complete) {
    x.joins.delete(target);
    if (!entry.fired && !visited.has(target)) {
      visited.add(target);
      for (const n of outgoing()) results.push(...resolveEdge(x, n, false, "", [...path, target], visited));
    }
  }
  return results;
}

// ---------------------------------------------------------------- invocation

/** Run one block and, unless it is a Chatbox or a tool call that returns to its caller, its followers.
 *  `viaTool` marks a block invoked by an agent; its failure is reported to that agent, not the run. */
export async function invoke(x: Exec, id: string, input: string, ancestors: string[] = [], viaTool = false): Promise<string> {
  assertActive(x);
  if (x.busy.has(id)) throw new Error("This block is already active; recursive or concurrent calls are not allowed");
  if (++x.steps > (x.def.settings?.maxSteps ?? 1000)) throw new Error("Workflow exceeded its block execution limit");
  const b = block(x, id), s = stateOf(x, id);
  x.busy.add(id);
  Object.assign(s, { status: "running", startedAt: now(), completedAt: undefined, error: undefined, selectedRoute: undefined, input: preview(input, 20_000), runs: s.runs + 1 });
  touch(x);
  let output = input;
  try {
    const rendered = () => renderPrompt(b.prompt, input, x.outputs);
    switch (b.type) {
      case "start_button": case "text": output = rendered(); break;
      case "start_input": output = input; break;
      case "markdown": output = b.prompt.trim() ? rendered() : input; break;
      case "skill": output = b.skillId ? await loadSkill(x, b) : rendered(); break;
      case "meeting": output = JSON.stringify(meetingTail(s, 20)); break;
      case "terminal_control": case "task_controls": case "mcp": output = `${b.label} adds tools to connected agents.`; break;
      case "script": output = await script(x, b, s, input); break;
      case "run_app": output = JSON.stringify(await appAction(ctx, x.env.root, b.app!.name, b.command || "", b.app?.action || "start", b.app?.lines || 100)); break;
      case "timer": {
        armTimer(x, b, s, input);
        x.busy.delete(id);
        return `Timer armed for ${s.waitingUntil}`;
      }
      case "user_prompt": case "yes_no_prompt": {
        const question = rendered().trim() || input;
        let answer = await ask(x, b, s, question);
        if (b.type === "yes_no_prompt") { answer = /^(y|yes|true)$/i.test(answer.trim()) ? "yes" : "no"; s.selectedRoute = answer; }
        output = answer;
        break;
      }
      case "ai": case "chatbox": output = await agent(x, b, s, input); break;
      default: throw new Error(`Unsupported block type '${b.type}'`);
    }
    assertActive(x);
    log(s, "response", output);
    s.output = output.length > outputLimit(x) ? output.slice(-outputLimit(x)) : output;
    x.outputs.set(id, output);
    Object.assign(s, { status: "succeeded", completedAt: now(), question: undefined, pauseId: undefined, permissionId: undefined });
    touch(x);
  } catch (e) {
    const message = errMsg(e);
    Object.assign(s, { status: x.cancelled ? "cancelled" : "failed", error: message, completedAt: now(), question: undefined, pauseId: undefined, permissionId: undefined });
    log(s, "error", message);
    if (!viaTool && !x.cancelled) x.flowFailed ??= `${b.label}: ${message}`;
    touch(x);
    throw e;
  } finally { x.busy.delete(id); }
  if (b.type !== "chatbox") await followers(x, b, s, output, ancestors);
  return output;
}

async function followers(x: Exec, b: WorkflowBlock, s: WorkflowBlockState, output: string, ancestors: string[]) {
  const id = b.id, out = x.def.edges.filter(e => e.from === id && flowEdge(e));
  const pending: Promise<unknown>[] = [];
  for (const e of out.filter(e => edgeType(e) === "path" && e.label !== s.selectedRoute && forwardEdge(x, e)))
    pending.push(...resolveEdge(x, e, false, "", [...ancestors, id]));
  for (const e of out.filter(e => edgeType(e) === "follow" || (edgeType(e) === "path" && e.label === s.selectedRoute))) {
    // A block used as a tool returns its result to the waiting caller; a drawn connection
    // back to that caller must not start a second turn in its active session.
    if (x.busy.has(e.to)) { log(s, "lifecycle", `Skipped connection to active block '${block(x, e.to).label}'`); continue; }
    const back = ancestors.includes(e.to) || e.to === id || !forwardEdge(x, e);
    if (back) {
      const count = (x.loops.get(e.id) ?? 0) + 1, limit = x.def.settings?.maxLoopCount ?? 100;
      if (count > limit) throw new Error(`Workflow loop '${e.label || e.id}' reached its limit of ${limit} iterations`);
      x.loops.set(e.id, count);
      transfer(x, e.id, "flow", output);
      pending.push(invoke(x, e.to, output, [...ancestors, id]));
    } else pending.push(...resolveEdge(x, e, true, output, [...ancestors, id]));
  }
  const settled = await Promise.allSettled(pending);
  const failed = settled.find((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failed) throw failed.reason;
}

// ---------------------------------------------------------------- block types

async function loadSkill(x: Exec, b: WorkflowBlock) {
  const g = await ctx.host.capabilities.request({ kind: "fs", root: x.env.root, target: { kind: "local" } });
  try {
    const file = await ctx.host.fs.read(g.grant, b.skillId!, 256 * 1024);
    if (file.binary || file.truncated) throw new Error(`Skill file is binary or too large: ${b.skillId}`);
    const dir = b.skillId!.includes("/") ? b.skillId!.slice(0, b.skillId!.lastIndexOf("/")) : ".";
    return JSON.stringify({ skill: { name: b.label, path: b.skillId, baseDirectory: `${x.env.root.replace(/\/$/, "")}/${dir}`, content: file.text || "" } });
  } finally { await ctx.host.capabilities.release(g.grant); }
}

async function script(x: Exec, b: WorkflowBlock, s: WorkflowBlockState, input: string) {
  log(s, "prompt", input);
  const timeoutMs = Math.min(Math.max((b.timeoutSeconds ?? 1800) * 1000, 1000), 86_400_000);
  let current: Handle | null = null;
  const r = await runScript(ctx, x.env.root, b.command || "", input, { timeoutMs, track: h => { if (current) x.procs.delete(current); current = h; if (h) x.procs.add(h); } });
  assertActive(x);
  if (r.code !== 0) throw new Error(`Script exited with ${r.code ?? "a signal"}${r.stderr.trim() ? `: ${preview(r.stderr.trim(), 4000)}` : r.stdout.trim() ? `: ${preview(r.stdout.trim(), 4000)}` : ""}`);
  return r.stdout + (r.stderr.trim() ? `\n[stderr]\n${r.stderr}` : "");
}

function armTimer(x: Exec, b: WorkflowBlock, s: WorkflowBlockState, input: string) {
  const old = x.timers.get(b.id); if (old) clearTimeout(old);
  const ms = Math.max(0, (b.seconds ?? 0) * 1000);
  Object.assign(s, { status: "waiting_timer", waitingUntil: new Date(Date.now() + ms).toISOString(), pauseId: crypto.randomUUID() });
  log(s, "lifecycle", `Timer armed for ${s.waitingUntil}`);
  touch(x);
  x.timers.set(b.id, setTimeout(() => {
    x.timers.delete(b.id);
    if (x.cancelled) return;
    x.steps = 0;
    s.output = input; x.outputs.set(b.id, input);
    Object.assign(s, { status: "succeeded", completedAt: now(), waitingUntil: undefined, pauseId: undefined });
    log(s, "lifecycle", "Timer fired; starting followers");
    touch(x);
    track(x, followers(x, b, s, input, []).catch(e => { x.flowFailed ??= `${b.label}: ${errMsg(e)}`; }));
  }, ms));
}

async function ask(x: Exec, b: WorkflowBlock, s: WorkflowBlockState, question: string): Promise<string> {
  const pauseId = crypto.randomUUID();
  Object.assign(s, { status: "awaiting_user_input", question, pauseId });
  log(s, "prompt", question);
  touch(x);
  return new Promise<string>((resolve, reject) => x.answers.set(b.id, { pauseId, resolve, reject }));
}

export function answer(x: Exec, blockId: string, pauseId: string, text: string) {
  const pending = x.answers.get(blockId);
  if (!pending || pending.pauseId !== pauseId) throw new Error("This question is no longer waiting for an answer");
  x.answers.delete(blockId);
  pending.resolve(String(text).slice(0, 100_000));
}

/** Background work (tool-started blocks, fired timers, chat turns). A run whose flow already
 *  finished is settled again when its last background task ends. */
export function track<T>(x: Exec, p: Promise<T>) {
  x.background.add(p);
  void p.catch(() => {}).finally(() => { x.background.delete(p); if (!x.driving) settle(x); });
  return p;
}

// ---------------------------------------------------------------- agents

function pickProfile(x: Exec, b: WorkflowBlock): AgentProfile {
  const ps = x.env.profiles;
  const p = (b.profileId && ps.find(p => p.id === b.profileId)) || (b.provider && ps.find(p => p.provider === b.provider)) || (!b.profileId && !b.provider && (ps.find(p => p.id === x.env.defaultProfileId) || ps[0]));
  if (!p) throw new Error(`No enabled AI provider for '${b.label}' on this machine${b.provider ? ` (${b.provider})` : ""}`);
  return p;
}

export function toolCatalogue(x: Exec, b: WorkflowBlock) {
  return toolTargets(x, b.id).map(t => ({
    block_id: t.id, name: t.label, type: t.type, ...(t.description ? { description: t.description } : {}),
    invocation: t.type === "mcp" ? "provider_mcp_tools" : t.type === "task_controls" ? "workspace_task_tools" : "workflow_use_block",
    ...(t.type === "mcp" ? { server_id: t.mcp?.serverId, server_name: x.env.mcpServers.find(m => m.id === t.mcp?.serverId)?.name,
      usage: "Discover and call this server's tools through the provider MCP tools. workflow_use_block only describes the connection; it does not call the MCP server." } : {}),
    ...(t.type === "task_controls" ? { usage: "Use workspace tasks_list, tasks_create, tasks_start_agent and tasks_reconcile tools." } : {}),
    ...(t.type === "run_app" ? { actions: t.app?.actions?.length ? t.app.actions : ["start", "status", "kill", "tail"] } : {}),
    ...(t.type === "terminal_control" ? { actions: ["list", "read", "write"] } : {}),
    ...(t.type === "timer" ? { seconds: t.seconds } : {}),
  }));
}

function instructions(x: Exec, b: WorkflowBlock) {
  const tools = toolCatalogue(x, b);
  const paths = b.type === "chatbox" ? [] : x.def.edges.filter(e => e.from === b.id && edgeType(e) === "path").map(e => e.label);
  const caps = toolTargets(x, b.id).filter(isCapabilityBlock).map(t => t.type);
  return [
    `You are the "${b.label}" block of the Hato workflow "${x.run.workflowName}". Each workflow block keeps its own session and context.`,
    tools.length ? `Connected workflow blocks and capabilities: ${JSON.stringify(tools)}.` : "No workflow blocks are connected to you as tools.",
    "Call workflow_connections to discover your connected blocks and their invocation methods before deciding which tools to use. Check the connected capabilities before claiming you lack access. Blocks with invocation workflow_use_block accept block_id and input; provider_mcp_tools means use that MCP server's advertised tools directly.",
    caps.includes("mcp") ? "Connected MCP servers are available capabilities. Identify them by server_name in workflow_connections, then inspect their advertised tool names and descriptions. If your provider loads tools lazily, use its tool discovery/search facility to find that server's tools. Use relevant tools for the user's request without requiring the user to name the server. If discovery or connection fails, report that specific error rather than claiming no MCP server is connected." : "",
    tools.length ? "For connected AI Agents and Chatboxes: omit action to run and wait, start launches in the background, status checks state, tail reads recent messages (lines 1–50) and steer sends input to a running session. A timed_out result means the block keeps working; check it with status or workflow_block_messages. Run App blocks take action start, status, kill or tail. Meetings automatically publish participant status changes (started activity, idle, permission wait, error or stop) as room messages. Use diff or wait to receive them without status polling. Publishing does not consume your unread cursor or invoke other agents. Meetings take publish (message), tail, diff, wait, status and shake (peer_block_id and an explicit message, required). Skill blocks return instructions to apply in your own session. Timers arm and return at once; when they fire, their follow connections receive the input you gave them. User Prompt and Yes/No Prompt blocks wait for the user's answer. action \"fetch\" returns output you have not seen yet. Use workflow_block_output to page through long outputs. Keep requests and reports concise." : "",
    caps.includes("terminal_control") ? "Terminal Control: always call workflow_use_block with the connected Terminal Control block_id and action list, read or write. read/write take key; read accepts cursor; write takes text. These calls are logged on the block. Do not use direct workspace terminals_* tools. Reuse existing terminals; do not start agents in terminals." : "",
    caps.includes("task_controls") ? "Task controls: use the workspace tasks_list, tasks_create, tasks_start_agent and tasks_reconcile tools (they need the Hato desktop open)." : "",
    paths.length ? `Available paths: ${JSON.stringify(paths)}. Call workflow_choose_path with one of them before you finish; your final answer is passed to the chosen path.` : "",
    b.type === "chatbox" ? "You are a chat with the user. Use your connected tools when they help answer." : "Your final message is this block's output.",
  ].filter(Boolean).join("\n");
}

async function agentCall(method: string, args: any, timeoutMs = 60_000) { return ctx.modules.call<any>("agent-runner", method, args, { timeoutMs }); }

async function createSession(x: Exec, b: WorkflowBlock) {
  const profile = pickProfile(x, b);
  if (b.reasoning && !(await agentCall("health", {}).catch(() => null))?.reasoning) throw new Error("Reasoning needs the updated agent runtime. Stop saved background agents before upgrading their runtime, then retry.");
  const targets = toolTargets(x, b.id);
  const extra = targets.filter(t => t.type === "mcp").map(t => x.env.mcpServers.find(m => m.id === t.mcp?.serverId)).filter(Boolean).map((m: any) => {
    const prepared = x.env.mcpConfigs?.[m.id];
    if (prepared) return { id: m.id, ...prepared };
    if (transportOf(m) !== "stdio" && m.auth?.type === "oauth") throw new Error(`MCP server “${m.name}” needs fresh authorization. Start a new workflow run to reconnect it.`);
    return { id: m.id, ...acpServer(m) };
  });
  const endpoint = await issueEndpoint(ctx, { kind: "run", runId: x.run.id, blockId: b.id });
  const id = crypto.randomUUID();
  const spec = {
    id, name: `${x.run.workflowName} · ${b.label}`.slice(0, 120), workspaceId: x.env.workspaceId, workspaceName: x.env.workspaceName, root: x.env.root, machineId: x.env.machineId,
    profile, model: b.model || "", reasoning: b.reasoning || "", agentFile: b.agentFile || null, skills: [], mcps: [endpoint, ...extra], claudeSubscription: x.env.claudeSubscription,
    workspaceMcp: targets.some(t => t.type === "task_controls") && !!x.env.daemon, daemon: x.env.daemon,
    autopilot: !!b.autopilot, workflow: { runId: x.run.id, blockId: b.id },
  };
  try { await agentCall("create", { spec }, 240_000); }
  catch (e) { await revokeWhere(ctx, s => s.kind === "run" && s.token === endpoint.env.find(v => v.name === "HATO_MCP_TOKEN")?.value); throw e; }
  return id;
}

const seqOf = (m: any) => Number(String(m?.key || "").replace("agent-msg-", "")) || 0;

/** One prompt in a block's session; resolves with the turn's final assistant message. */
async function turn(x: Exec, s: WorkflowBlockState, text: string): Promise<string> {
  const id = s.sessionId!;
  const before = await agentCall("view", { id, limit: 1 });
  const mark = Math.max(0, ...before.messages.map(seqOf));
  if (["busy", "waiting", "starting"].includes(before.session.status)) throw new Error("This block's agent is busy; use steer or wait for it to finish");
  await agentCall("send", { id, text }, 240_000);
  for (;;) {
    await sleep(800);
    if (x.cancelled) { await agentCall("cancel", { id }).catch(() => {}); throw new Error("Workflow run was cancelled"); }
    const v = await agentCall("view", { id, limit: 80 });
    const status = v.session.status;
    if (status === "waiting" && s.status !== "awaiting_permission") { s.status = "awaiting_permission"; s.permissionId = v.permissions[0]?.id; touch(x); }
    else if (status !== "waiting" && s.status === "awaiting_permission") { s.status = "running"; s.permissionId = undefined; touch(x); }
    const after = v.messages.filter((m: any) => seqOf(m) > mark);
    const failure = after.find((m: any) => m.role === "error");
    if (failure && status === "ready") throw new Error(failure.text || "The agent turn failed");
    if (["interrupted", "stopped", "error"].includes(status)) throw new Error(v.session.error || `Agent ${status}`);
    if (status === "ready" && after.some((m: any) => m.role === "system" && String(m.text).startsWith("Turn ended"))) {
      if (after.some((m: any) => m.role === "system" && /cancel/i.test(String(m.text)))) log(s, "lifecycle", "Turn was cancelled");
      const answer = [...after].reverse().find((m: any) => m.role === "assistant" && String(m.text || "").trim());
      return answer ? String(answer.text).trim() : "";
    }
  }
}

async function agent(x: Exec, b: WorkflowBlock, s: WorkflowBlockState, input: string) {
  const fresh = !s.sessionId;
  if (fresh) { s.sessionId = await createSession(x, b); touch(x); }
  const limit = x.def.settings?.promptLimitChars ?? 200_000;
  const clipped = preview(input, 20_000);
  let text: string;
  if (b.type === "chatbox") {
    const refs = [...new Set([...b.prompt.matchAll(/\{\{\s*blocks\.([A-Za-z0-9_-]+)\.output\s*\}\}/g)].map(m => m[1]))];
    const updates = refs.length ? `\n\nWorkflow context updates:\n${refs.map(r => `${r}: ${preview(x.outputs.get(r) ?? "", 4000)}`).join("\n")}` : "";
    text = fresh ? `${instructions(x, b)}\n\nSession guidance:\n${renderPrompt(b.prompt, "", x.outputs)}\n\nUser message:\n${clipped}` : clipped + updates;
    s.chat = [...(s.chat || []), { id: crypto.randomUUID(), role: "user" as const, text: clipped, at: now() }].slice(-200);
  } else {
    const template = /\{\{\s*input\s*\}\}/.test(b.prompt) ? b.prompt : `${b.prompt}\n\nInput:\n{{input}}`;
    const body = fresh || /\{\{/.test(b.prompt) ? renderPrompt(template, clipped, x.outputs) : clipped;
    text = fresh ? `${instructions(x, b)}\n\n${body}` : body;
  }
  if (text.length > limit) text = preview(text, limit);
  s.prompt = preview(text, 20_000);
  log(s, "prompt", text);
  touch(x);
  const out = await turn(x, s, text);
  if (b.type === "chatbox") s.chat = [...(s.chat || []), { id: crypto.randomUUID(), role: "assistant" as const, text: out, at: now() }].slice(-200);
  const paths = b.type === "chatbox" ? [] : x.def.edges.filter(e => e.from === b.id && edgeType(e) === "path");
  if (paths.length && !s.selectedRoute) throw new Error(`${b.label} finished without choosing a path (workflow_choose_path)`);
  return out;
}

export async function steer(x: Exec, id: string, text: string) {
  const s = stateOf(x, id);
  if (!s.sessionId) throw new Error("This block has no session yet; start it first");
  return agentCall("send", { id: s.sessionId, text: preview(text, 20_000), steer: true }, 60_000);
}
export async function messages(x: Exec, id: string, count: number) {
  const s = stateOf(x, id);
  if (!s.sessionId) return { status: s.status, messages: [] };
  const v = await agentCall("view", { id: s.sessionId, limit: Math.min(Math.max(count, 1), 50) });
  return { status: s.status, agentStatus: v.session.status, messages: v.messages.filter((m: any) => m.role !== "system").map((m: any) => ({ role: m.role, title: m.title, text: preview(String(m.text || ""), 2000) })) };
}

// ---------------------------------------------------------------- meetings

const STATUS_DESCRIPTIONS: Record<string, string> = {
  running: "started activity", succeeded: "is idle", failed: "stopped with an error",
  cancelled: "was stopped", awaiting_permission: "is waiting for permission",
  awaiting_user_input: "is waiting for input", waiting_timer: "is waiting for a timer", queued: "is queued",
};
function notifyMeeting(x: Exec, roomId: string) {
  for (const wake of [...(x.meetingWaiters.get(roomId) || [])]) wake();
}
/** Append without consuming any reader's cursor. Publishing is not reading. No recursive touch. */
function appendMeetingMessage(x: Exec, roomId: string, participantId: string, text: string, status?: WorkflowBlockState["status"]) {
  const s = stateOf(x, roomId), m = meeting(s), author = block(x, participantId).label;
  m.messages.push({ seq: ++m.seq, blockId: participantId, author, text, at: now(), ...(status ? { kind: "status" as const, participantStatus: status } : {}) });
  if (m.messages.length > 1000) m.messages.splice(0, m.messages.length - 1000);
  const output = m.messages.map(msg => `[${msg.seq}] ${msg.author}: ${msg.text}`).join("\n\n").slice(-outputLimit(x));
  s.output = output; x.outputs.set(roomId, output);
  if (status) log(s, "lifecycle", text);
  notifyMeeting(x, roomId);
  return m.seq;
}
function publishMeetingStatusChanges(x: Exec) {
  for (const participant of x.def.blocks.filter(isAgentBlock)) {
    const s = stateOf(x, participant.id), before = x.participantStatuses.get(participant.id);
    x.participantStatuses.set(participant.id, s.status);
    if (before === s.status || (before === undefined && s.status !== "running")) continue;
    const description = STATUS_DESCRIPTIONS[s.status]; if (!description) continue;
    // toolTargets includes all outgoing Chatbox edges and deduplicates repeated room links.
    for (const room of toolTargets(x, participant.id).filter(b => b.type === "meeting")) {
      appendMeetingMessage(x, room.id, participant.id, `[Status] ${participant.label.slice(0, 200)} ${description}.`, s.status);
    }
  }
}

function meeting(s: WorkflowBlockState) { return s.meeting ??= { seq: 0, messages: [], cursors: {} }; }
function meetingTail(s: WorkflowBlockState, lines: number) {
  const m = meeting(s);
  return { messages: m.messages.slice(-Math.min(Math.max(lines, 1), 50)), latestSequence: m.seq };
}
export async function useMeeting(x: Exec, meetingId: string, caller: string, a: any) {
  const s = stateOf(x, meetingId), m = meeting(s), action = a.action || "diff";
  const lines = Math.min(Math.max(Number(a.lines) || 20, 1), 50);
  const diff = (status?: string) => {
    const from = typeof a.after === "number" ? a.after : m.cursors[caller] ?? 0;
    const unread = m.messages.filter(msg => msg.seq > from), page = unread.slice(0, lines);
    const cursor = page.length ? page[page.length - 1].seq : from;
    if (typeof a.after !== "number") m.cursors[caller] = Math.max(m.cursors[caller] ?? 0, cursor);
    touch(x);
    return { meeting: { ...(status ? { status } : {}), messages: page, cursor, latestSequence: m.seq, hasMore: unread.length > page.length } };
  };
  if (action === "publish") {
    const text = String(a.message ?? a.input ?? "").slice(0, 10_000);
    if (!text.trim()) throw new Error("A meeting message is required");
    const published = appendMeetingMessage(x, meetingId, caller, text);
    touch(x);
    return { meeting: { published } };
  }
  if (action === "tail" || action === "fetch") return { meeting: meetingTail(s, lines) };
  if (action === "diff") return diff();
  if (action === "status") {
    const peers = x.def.edges.filter(e => e.to === meetingId && edgeType(e) === "use").map(e => block(x, e.from));
    return { meeting: { peers: peers.map(p => ({ block_id: p.id, name: p.label, type: p.type, online: x.busy.has(p.id), block_status: stateOf(x, p.id).status, hasSession: !!stateOf(x, p.id).sessionId, self: p.id === caller })) } };
  }
  if (action === "wait") {
    const from = typeof a.after === "number" ? a.after : m.cursors[caller] ?? 0;
    if (m.messages.some(msg => msg.seq > from)) return diff("updated");
    const timeout = Math.min(Math.max(Number(a.timeout_seconds) || 300, 1), 86_400) * 1000;
    const updated = await new Promise<boolean>(resolve => {
      const listeners = x.meetingWaiters.get(meetingId) || new Set<() => void>();
      x.meetingWaiters.set(meetingId, listeners);
      const done = (v: boolean) => {
        listeners.delete(wake);
        if (!listeners.size) x.meetingWaiters.delete(meetingId);
        clearTimeout(t); resolve(v);
      };
      const wake = () => done(true);
      const t = setTimeout(() => done(false), timeout);
      listeners.add(wake);
    });
    assertActive(x);
    return diff(updated ? "updated" : "timed_out");
  }
  if (action === "shake") {
    const peer = String(a.peer_block_id || "");
    if (!x.def.edges.some(e => e.from === peer && e.to === meetingId && edgeType(e) === "use") || peer === caller) throw new Error("Shake a different agent connected to this meeting");
    const message = a.message ?? a.input;
    if (typeof message !== "string" || !message.trim() || message.length > 10_000) throw new Error("Meeting shake needs a specific message of 1 to 10000 characters");
    if (x.busy.has(peer)) { await steer(x, peer, message); return { meeting: { shake: { blockId: peer, delivery: "steered" } } }; }
    track(x, invoke(x, peer, message, [], true).catch(() => {}));
    return { meeting: { shake: { blockId: peer, delivery: "started" } } };
  }
  throw new Error(`Unknown meeting action '${action}'`);
}

// ---------------------------------------------------------------- run lifecycle

export async function drive(x: Exec, entries?: string[]) {
  x.driving = true;
  const maxMs = x.def.settings?.maxRunDurationMs ?? 24 * 3600_000;
  x.deadline = setTimeout(() => { x.flowFailed ??= "The workflow reached its maximum run duration"; void cancel(x, "The workflow reached its maximum run duration"); }, maxMs);
  (x.deadline as any).unref?.();
  try {
    const roots = entries ?? defaultRoots(x);
    for (const id of roots) {
      try { await invoke(x, id, x.run.input); }
      catch (e) { if (x.cancelled) break; x.flowFailed ??= errMsg(e); break; }
    }
    // Timers and background tool work keep the run open.
    while (!x.cancelled && (x.timers.size || x.background.size)) {
      if (x.background.size) await Promise.race([Promise.allSettled([...x.background]), sleep(500)]);
      else await sleep(250);
    }
  } finally { x.driving = false; settle(x); }
}

export function defaultRoots(x: Exec) {
  if (x.run.startBlockId) return [x.run.startBlockId];
  const starts = x.def.blocks.filter(isStartBlock);
  if (starts.length) return starts.map(b => b.id);
  return x.def.blocks.filter(b => !x.def.edges.some(e => e.to === b.id) && !isCapabilityBlock(b) && !(b.type === "chatbox" && !x.run.input.trim()) && !["meeting", "skill"].includes(b.type)).map(b => b.id);
}

/** Close the run once nothing is active. A Chatbox remains available for later user turns. */
export function settle(x: Exec) {
  if (x.driving || x.busy.size || x.timers.size || x.background.size || x.answers.size) { touch(x); return; }
  if (x.deadline) clearTimeout(x.deadline);
  if (x.run.status === "running" || x.run.status === "waiting") {
    x.run.status = x.cancelled ? "cancelled" : x.flowFailed ? "failed" : "succeeded";
    x.run.error = x.cancelled ? x.run.error : x.flowFailed;
    x.run.completedAt = now();
  }
  for (const s of x.run.blocks) if (s.status === "queued") s.status = "skipped";
  persist(x.run);
}

export async function cancel(x: Exec, reason = "Cancelled by the user") {
  x.cancelled = true;
  for (const t of x.timers.values()) clearTimeout(t);
  x.timers.clear();
  for (const p of x.answers.values()) p.reject(new Error("Workflow run was cancelled"));
  x.answers.clear();
  for (const listeners of [...x.meetingWaiters.values()]) for (const wake of [...listeners]) wake();
  for (const h of x.procs) await ctx.host.process.terminate(h, "SIGKILL").catch(() => {});
  for (const s of x.run.blocks) {
    if (s.sessionId && (s.status === "running" || s.status === "awaiting_permission")) await agentCall("cancel", { id: s.sessionId }).catch(() => {});
    if (["running", "waiting_timer", "awaiting_user_input", "awaiting_permission", "queued"].includes(s.status)) { s.status = "cancelled"; s.completedAt = now(); }
  }
  x.run.status = "cancelled"; x.run.error = reason; x.run.completedAt = now();
  touch(x);
}

/** A Chatbox user turn, also on a finished run (its sessions and frozen graph are reused). */
export function chat(x: Exec, blockId: string, text: string) {
  const b = block(x, blockId);
  if (b.type !== "chatbox") throw new Error("Only Chatbox blocks accept chat messages");
  if (x.cancelled) throw new Error("This run was cancelled; start a new run to chat");
  if (x.busy.has(blockId)) return steer(x, blockId, text).then(() => ({ steered: true }));
  if (x.run.status !== "running" && x.run.status !== "waiting") { x.run.status = "running"; x.run.completedAt = undefined; }
  track(x, invoke(x, blockId, text, [], true));
  touch(x);
  return Promise.resolve({ accepted: true });
}

export { isAgentBlock };
