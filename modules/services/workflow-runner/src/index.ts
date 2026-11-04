// Workflow runtime hosted by the workspace machine's daemon (hatod). It owns workflow
// definitions per project, durable run state, execution, Run App processes and the per-session
// workflow MCP endpoint. AI blocks are agent-runner sessions on the same daemon, so a run keeps
// going while the desktop is closed or disconnected. The desktop gateway (`workflows`) resolves
// providers and workspace details and is the only caller of the mutating methods.
import type { AppModule, ModuleContext, Handle } from "../../../../sdk/types";
import { errMsg } from "../../../../sdk/runtime";
import {
  WORKFLOW_REFERENCE, WORKFLOW_RUNNER_VERSION, type WorkflowDefinition, type WorkflowRun, type WorkflowRunEnv,
  blockingIssues, edgeType, isAgentBlock, isCapabilityBlock, normalizeDefinition, preview, validateWorkflow,
} from "../../../../sdk/workflows";
import { WORKFLOW_TEMPLATES } from "../../../../sdk/workflow-templates";
import { recordMcpActivity, cancel, chat, drive, execs, initEngine, invoke, messages, newExec, stateOf, steer, toolTargets, toolCatalogue, touch, track, transfer, useMeeting, answer, type Exec } from "./engine";
import { initMcp, issueEndpoint, revokeWhere, type Scope } from "./mcp";
import { terminalAction } from "./terminal";
import { appAction, killAllApps, listApps, runningApps } from "./procs";

let db: Handle;
const now = () => new Date().toISOString();
const GATEWAY = new Set(["daemon-client", "workflows"]);
const gateway = (meta: any) => { if (!GATEWAY.has(meta?.caller)) throw new Error("Only the Hato workflow gateway may call this method"); };

// ---------------------------------------------------------------- persistence

let ctxRef: ModuleContext;
const dirty = new Map<string, WorkflowRun>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
function save(run: WorkflowRun) {
  dirty.set(run.id, run);
  if (!flushTimer) flushTimer = setTimeout(() => { void flush(); }, 250);
}
async function flush() {
  flushTimer = null;
  const runs = [...dirty.values()]; dirty.clear();
  for (const run of runs) await ctxRef.host.db.exec(db, "UPDATE runs SET data=? WHERE id=?", [JSON.stringify(run), run.id]).catch(e => ctxRef.log.error("workflow run save", errMsg(e)));
}
async function loadRun(id: string): Promise<{ run: WorkflowRun; env: WorkflowRunEnv } | null> {
  const r = (await ctxRef.host.db.query<any>(db, "SELECT data, env FROM runs WHERE id=?", [id]))[0];
  return r ? { run: dirty.get(id) || JSON.parse(r.data), env: JSON.parse(r.env) } : null;
}
/** The live execution for a run, rebuilt from storage for Chatbox turns and tool calls after it finished. */
async function execFor(id: string): Promise<Exec> {
  const live = execs.get(id); if (live) return live;
  const stored = await loadRun(id); if (!stored) throw new Error("Workflow run not found");
  return execs.get(id) || newExec(stored.run, stored.env);
}
async function definition(projectId: string, id: string) {
  const r = (await ctxRef.host.db.query<any>(db, "SELECT data, revision FROM definitions WHERE id=? AND project=?", [id, projectId]))[0];
  if (!r) throw new Error(`Workflow '${id}' not found`);
  return { definition: JSON.parse(r.data) as WorkflowDefinition, revision: Number(r.revision) };
}
async function saveDefinition(projectId: string, raw: any, expected: number | null | undefined, available?: any) {
  const def = normalizeDefinition(raw);
  const current = (await ctxRef.host.db.query<any>(db, "SELECT revision, data, project FROM definitions WHERE id=?", [def.id]))[0];
  if (current && current.project !== projectId) throw new Error("This workflow id belongs to another project; choose a new id");
  if (expected === null && current) throw new Error(`Workflow '${def.id}' already exists (revision ${current.revision}); read it and pass its revision`);
  if (typeof expected === "number" && (!current || Number(current.revision) !== expected)) throw new Error(`Revision conflict: workflow '${def.id}' is at revision ${current ? current.revision : "none"}; reload and reconcile`);
  if (current) { const prev = JSON.parse(current.data); def.createdAt = prev.createdAt || def.createdAt; def.version = (prev.version || 1) + 1; }
  const revision = current ? Number(current.revision) + 1 : 1;
  await ctxRef.host.db.exec(db, "INSERT INTO definitions(id,project,revision,data) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision, data=excluded.data",
    [def.id, projectId, revision, JSON.stringify(def)]);
  return { id: def.id, revision, definition: def, issues: validateWorkflow(def, available) };
}
async function listDefinitions(projectId: string) {
  const rows = await ctxRef.host.db.query<any>(db, "SELECT data, revision FROM definitions WHERE project=? ORDER BY id", [projectId]);
  return rows.map(r => { const d: WorkflowDefinition = JSON.parse(r.data); return { id: d.id, name: d.name, description: d.description, revision: Number(r.revision), updatedAt: d.updatedAt, blocks: d.blocks.length }; })
    .sort((a, b) => a.name.localeCompare(b.name));
}
const summary = (run: WorkflowRun) => ({ id: run.id, workflowId: run.workflowId, workflowName: run.workflowName, status: run.status, createdAt: run.createdAt, completedAt: run.completedAt, error: run.error, input: preview(run.input, 300) });
/** Run detail with bounded block payloads; page full outputs with blockOutput. */
function detail(run: WorkflowRun) {
  return { ...run, blocks: run.blocks.map(s => ({ ...s, output: s.output === undefined ? undefined : preview(s.output, 16_000), outputChars: s.output?.length ?? 0, prompt: s.prompt === undefined ? undefined : preview(s.prompt, 8000), log: s.log.slice(-40), chat: s.chat?.slice(-60), meeting: s.meeting ? { ...s.meeting, messages: s.meeting.messages.slice(-60) } : undefined })) };
}

// ---------------------------------------------------------------- MCP tools

const object = (properties: any, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });
const RUN_TOOLS = [
  { name: "workflow_connections", description: "Discover connected workflow blocks and capabilities, including MCP server names, invocation methods, and allowed actions. Call before choosing tools or claiming a capability is unavailable.", inputSchema: object({}) },
  { name: "workflow_use_block", description: "Run or control a connected workflow block. Pass block_id and input; action selects start/status/tail/steer (AI Agent, Chatbox), start/status/kill/tail (Run App), publish/tail/diff/wait/status/shake (Meeting; shake requires peer_block_id and a specific message), list/read/write (Terminal Control, key/cursor/text), or fetch (unseen output of any data block).",
    inputSchema: object({ block_id: { type: "string" }, input: { type: "string" }, action: { type: "string" }, lines: { type: "number" }, timeout_seconds: { type: "number" }, message: { type: "string" }, peer_block_id: { type: "string" }, key: { type: "string" }, cursor: { type: "number" }, text: { type: "string" }, after: { type: "number" } }, ["block_id"]) },
  { name: "workflow_block_output", description: "Read retained output of a connected block in pages without running it.", inputSchema: object({ block_id: { type: "string" }, offset: { type: "number" }, limit: { type: "number" } }, ["block_id"]) },
  { name: "workflow_block_messages", description: "Read recent messages of a connected AI Agent or Chatbox without starting a turn.", inputSchema: object({ block_id: { type: "string" }, count: { type: "number" } }, ["block_id"]) },
  { name: "workflow_choose_path", description: "Choose the outgoing path your output is passed to. Call before finishing when paths are available.", inputSchema: object({ path: { type: "string" } }, ["path"]) },
];
const CONFIG_TOOLS = [
  { name: "workflows_reference", description: "Read the workflow format reference: block types, connections, templates and tools.", inputSchema: object({}) },
  { name: "workflows_list", description: "List this project's workflows with their revisions.", inputSchema: object({}) },
  { name: "workflows_read", description: "Read a workflow definition and its revision. Use id \"new\" for a starter definition, or template_id to start from a template.", inputSchema: object({ id: { type: "string" }, template_id: { type: "string" } }, ["id"]) },
  { name: "workflows_write", description: "Create or replace a workflow. content is the complete JSON definition (string or object). expected_revision is the revision you read, or null to create. Returns the revision and validation issues. Never starts a run.",
    inputSchema: object({ content: {}, expected_revision: { type: ["number", "null"] } }, ["content", "expected_revision"]) },
  { name: "workflows_validate", description: "Validate a workflow definition without saving it.", inputSchema: object({ content: {} }, ["content"]) },
];
const parseContent = (c: any) => { if (typeof c !== "string") return c; try { return JSON.parse(c); } catch (e) { throw new Error(`content is not valid JSON: ${errMsg(e)}`); } };
function starter(templateId?: string) {
  const t = WORKFLOW_TEMPLATES.find(t => t.id === (templateId || "blank"));
  if (!t) throw new Error(`Unknown template; use one of ${WORKFLOW_TEMPLATES.map(t => t.id).join(", ")}`);
  return normalizeDefinition({ id: `workflow-${crypto.randomUUID().slice(0, 8)}`, name: t.id === "blank" ? "New workflow" : t.name, ...t.graph() });
}

async function configTool(s: Extract<Scope, { kind: "config" }>, name: string, a: any) {
  const available = { profiles: s.profiles, mcps: s.mcps };
  if (name === "workflows_reference") return WORKFLOW_REFERENCE + `\n\nTemplates: ${WORKFLOW_TEMPLATES.map(t => `${t.id} (${t.description})`).join("; ")}.\nProviders on this machine: ${JSON.stringify(s.profiles)}.`;
  if (name === "workflows_list") return listDefinitions(s.projectId);
  if (name === "workflows_read") {
    if (a.id === "new") return { revision: null, definition: starter(a.template_id) };
    const d = await definition(s.projectId, String(a.id));
    return { ...d, issues: validateWorkflow(d.definition, available) };
  }
  if (name === "workflows_validate") return { issues: validateWorkflow(normalizeDefinition(parseContent(a.content)), available) };
  if (name === "workflows_write") {
    const r = await saveDefinition(s.projectId, parseContent(a.content), a.expected_revision === null ? null : Number(a.expected_revision), available);
    ctxRef.events.emit("workflow-runner.changed", { projectId: s.projectId, workflowId: r.id });
    return { id: r.id, revision: r.revision, issues: r.issues };
  }
  throw new Error("Unknown configuration tool");
}

// Trace only real, authorized calls to a connected block. Returned acknowledgements,
// paged output, errors and completed results all have their own matching return boundary.
async function runTool(s: Extract<Scope, { kind: "run" }>, name: string, a: any) {
  if (!["workflow_use_block", "workflow_block_output", "workflow_block_messages"].includes(name)) return runToolBody(s, name, a);
  const x = await execFor(s.runId);
  const target = toolTargets(x, s.blockId).find(t => t.id === String(a.block_id || ""));
  if (!target) return runToolBody(s, name, a);
  const edge = x.def.edges.find(e => e.from === s.blockId && e.to === target.id && edgeType(e) === "use")
    || x.def.edges.find(e => e.from === s.blockId && e.to === target.id);
  if (!edge) return runToolBody(s, name, a);
  const action = `${name}:${a.action || "call"}`;
  const callId = transfer(x, edge.id, "send", a, undefined, action);
  const logTarget = (kind: "tool" | "response" | "error", value: unknown) => {
    const st = stateOf(x, target.id);
    const text = typeof value === "string" ? value : JSON.stringify(value);
    st.log.push({ at: now(), kind, text: `${s.blockId} · ${action} · ${callId}
${preview(text || "", 4000)}` });
    if (st.log.length > 200) st.log.splice(0, st.log.length - 200);
    touch(x);
  };
  logTarget("tool", a);
  try {
    const result = await runToolBody(s, name, a);
    logTarget("response", result);
    transfer(x, edge.id, "return", result, callId, action);
    return result;
  } catch (error) {
    logTarget("error", errMsg(error));
    transfer(x, edge.id, "return", errMsg(error), callId, action, true);
    throw error;
  }
}

async function runToolBody(s: Extract<Scope, { kind: "run" }>, name: string, a: any) {
  const x = await execFor(s.runId), caller = s.blockId;
  const targets = toolTargets(x, caller);
  const target = () => {
    const t = targets.find(t => t.id === String(a.block_id || ""));
    if (!t) throw new Error(`Block '${a.block_id}' is not connected to you; call workflow_connections`);
    return t;
  };
  const record = (text: string) => { const st = stateOf(x, caller); st.log.push({ at: now(), kind: "tool", text: text.slice(0, 500) }); if (st.log.length > 200) st.log.shift(); };
  if (name === "workflow_connections") return toolCatalogue(x, x.def.blocks.find(b => b.id === caller)!).map(t => ({ ...t, status: stateOf(x, t.block_id).status }));
  if (name === "workflow_choose_path") {
    const paths = x.def.edges.filter(e => e.from === caller && edgeType(e) === "path").map(e => e.label);
    if (!paths.includes(String(a.path))) throw new Error(`Unknown path; choose one of ${JSON.stringify(paths)}`);
    stateOf(x, caller).selectedRoute = String(a.path); record(`chose path ${a.path}`); touch(x);
    return { selected: a.path };
  }
  if (name === "workflow_block_output") {
    const t = target(), out = x.outputs.get(t.id) ?? "";
    const offset = Math.max(0, Number(a.offset) || 0), limit = Math.min(Math.max(Number(a.limit) || 8000, 1), 8000);
    const text = out.slice(offset, offset + limit);
    return { block_id: t.id, offset, text, total: out.length, ...(offset + text.length < out.length ? { nextOffset: offset + text.length } : {}) };
  }
  if (name === "workflow_block_messages") { const t = target(); if (!isAgentBlock(t)) throw new Error("Only AI Agent and Chatbox blocks have messages"); return messages(x, t.id, Number(a.count) || 6); }
  if (name !== "workflow_use_block") throw new Error("Unknown workflow tool");
  const t = target(), action = typeof a.action === "string" && a.action ? a.action : undefined;
  const input = String(a.input ?? a.message ?? "");
  record(`${action || "use"} ${t.label}`);
  if (action === "fetch") {
    if (t.type === "mcp") return toolCatalogue(x, x.def.blocks.find(b => b.id === caller)!).find(entry => entry.block_id === t.id);
  if (t.type === "meeting") return useMeeting(x, t.id, caller, { action: "diff" });
    const k = `${caller}>${t.id}`, out = x.outputs.get(t.id) ?? "", seen = x.fetched.get(k) ?? 0;
    const from = seen > out.length ? 0 : seen, text = out.slice(from, from + 8000);
    x.fetched.set(k, from + text.length);
    return text ? { text, hasMore: from + text.length < out.length } : { unchanged: true };
  }
  if (t.type === "mcp") return toolCatalogue(x, x.def.blocks.find(b => b.id === caller)!).find(entry => entry.block_id === t.id);
  if (t.type === "meeting") return useMeeting(x, t.id, caller, { ...a, action: action || "diff" });
  if (t.type === "terminal_control") {
    const value = await terminalAction(ctxRef, x.env, action || "list", a);
    const st = stateOf(x, t.id);
    st.output = JSON.stringify(value); st.runs++; st.status = "succeeded";
    touch(x);
    return value;
  }
  if (isCapabilityBlock(t)) return { note: `${t.label} is not callable: it adds tools to your session.` };
  if (t.type === "run_app") {
    const allowed = t.app?.actions?.length ? t.app.actions : ["start", "status", "kill", "tail"];
    const act = action || t.app?.action || "start";
    if (!allowed.includes(act as any)) throw new Error(`Run App '${t.label}' allows ${allowed.join(", ")}`);
    const app = await appAction(ctxRef, x.env.root, t.app!.name, t.command || "", act, Math.min(Math.max(Number(a.lines) || t.app?.lines || 100, 1), 10_000));
    const st = stateOf(x, t.id); st.output = JSON.stringify(app); x.outputs.set(t.id, st.output); st.status = "succeeded"; st.runs++; touch(x);
    return { app };
  }
  const edge = x.def.edges.find(e => e.from === caller && e.to === t.id);
  const timeoutMs = Math.min(Math.max((Number(a.timeout_seconds) || (edge?.timeoutMs ?? 300_000) / 1000) * 1000, 1000), 86_400_000);
  if (isAgentBlock(t)) {
    const st = stateOf(x, t.id);
    if (action === "status") return { status: st.status, hasSession: !!st.sessionId, output: st.output === undefined ? undefined : preview(st.output, 4000), error: st.error };
    if (action === "tail") return messages(x, t.id, Math.min(Math.max(Number(a.lines) || 6, 1), 50));
    if (action === "steer" && x.busy.has(t.id)) return steer(x, t.id, input);
    if (action === "start" || action === "steer") { track(x, invoke(x, t.id, input, [caller], true)); return { status: "started" }; }
  }
  if (t.type === "user_prompt" || t.type === "yes_no_prompt") return { answer: await invoke(x, t.id, input, [caller], true) };
  const run = invoke(x, t.id, input, [caller], true);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([run.then(output => ({ output })), new Promise<{ timedOut: true }>(r => { timer = setTimeout(() => r({ timedOut: true }), timeoutMs); })]).finally(() => clearTimeout(timer));
  if ("timedOut" in outcome) { track(x, run); return { status: "timed_out", note: "The block keeps working; check it with action status or workflow_block_messages." }; }
  return { status: "succeeded", output: preview(outcome.output, 20_000) };
}

// ---------------------------------------------------------------- module

const mod: AppModule = {
  id: "workflow-runner", moduleApiVersion: 1,
  async activate(ctx) {
    ctxRef = ctx;
    db = await ctx.host.db.openNamespace("workflow-runner");
    await ctx.host.db.exec(db, "CREATE TABLE IF NOT EXISTS definitions(id TEXT PRIMARY KEY, project TEXT NOT NULL, revision INTEGER NOT NULL, data TEXT NOT NULL); CREATE INDEX IF NOT EXISTS definitions_project ON definitions(project); CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, project TEXT NOT NULL, workflow TEXT NOT NULL, created TEXT NOT NULL, data TEXT NOT NULL, env TEXT NOT NULL); CREATE INDEX IF NOT EXISTS runs_workflow ON runs(project, workflow, created)");
    initEngine(ctx, save);
    ctx.events.on("agent-runner.toolActivity", async (event: any) => {
      if (!event.workflow?.runId || !event.workflow?.blockId) return;
      try { recordMcpActivity(await execFor(event.workflow.runId), event.workflow.blockId, event.sessionId, event.update); }
      catch (e) { ctx.log.warn("MCP activity trace", errMsg(e)); }
    });
    await initMcp(ctx, db, {
      list: s => s.kind === "run" ? RUN_TOOLS : CONFIG_TOOLS,
      call: (s, name, args) => s.kind === "run" ? runTool(s, name, args) : configTool(s, name, args),
    });
    // A run cannot survive its runtime: mark interrupted runs instead of replaying them.
    for (const r of await ctx.host.db.query<any>(db, "SELECT id, data FROM runs")) {
      const run: WorkflowRun = JSON.parse(r.data);
      if (run.status !== "running" && run.status !== "waiting") continue;
      run.status = "failed"; run.error = "Interrupted: the workflow runtime restarted. Sessions and outputs remain for inspection."; run.completedAt = now();
      for (const s of run.blocks) if (["running", "waiting_timer", "awaiting_user_input", "awaiting_permission", "queued"].includes(s.status)) { s.status = "failed"; s.error = "Interrupted by a runtime restart"; }
      await ctx.host.db.exec(db, "UPDATE runs SET data=? WHERE id=?", [JSON.stringify(run), run.id]);
    }
  },
  canSwap: () => {
    const active = [...execs.values()].filter(x => x.driving || x.busy.size || x.timers.size || x.answers.size || x.background.size).length;
    return { ok: active === 0 && runningApps() === 0, reason: "Workflow runs or Run App processes are active" };
  },
  async deactivate(ctx) { if (flushTimer) clearTimeout(flushTimer); await flush(); void ctx; },
  methods: {
    health: () => ({ ok: true, version: WORKFLOW_RUNNER_VERSION, active: [...execs.values()].filter(x => x.driving || x.busy.size || x.timers.size || x.answers.size).length, apps: runningApps() }),
    async list(_ctx, a) { return listDefinitions(String(a.projectId)); },
    async get(_ctx, a) { return definition(String(a.projectId), String(a.id)); },
    async save(_ctx, a, meta) { gateway(meta); return saveDefinition(String(a.projectId), a.definition, a.expectedRevision === undefined ? undefined : a.expectedRevision, a.available); },
    async remove(ctx, a, meta) {
      gateway(meta);
      const active = [...execs.values()].some(x => x.run.workflowId === a.id && x.run.projectId === a.projectId && (x.driving || x.busy.size));
      if (active) throw new Error("Cancel this workflow's active runs before deleting it");
      await ctx.host.db.exec(db, "DELETE FROM definitions WHERE id=? AND project=?", [String(a.id), String(a.projectId)]);
      return null;
    },
    templates: () => WORKFLOW_TEMPLATES.map(t => ({ id: t.id, name: t.name, description: t.description })),
    starter: (_ctx, a) => starter(a.templateId),
    async start(ctx, a, meta) {
      gateway(meta);
      const env: WorkflowRunEnv = a.env;
      if (!env?.root?.startsWith("/") || !env.workspaceId || !Array.isArray(env.profiles)) throw new Error("Invalid workflow run environment");
      const { definition: def } = await definition(String(a.projectId), String(a.workflowId));
      const issues = blockingIssues(validateWorkflow(def, { profiles: env.profiles, mcps: env.mcpServers }));
      if (issues.length) throw new Error(`Fix the workflow first: ${issues.slice(0, 3).map(i => i.message).join("; ")}`);
      if (a.startBlockId && !def.blocks.some(b => b.id === a.startBlockId)) throw new Error("Unknown start block");
      const run: WorkflowRun = {
        id: crypto.randomUUID(), workflowId: def.id, workflowName: def.name, projectId: String(a.projectId), workspaceId: env.workspaceId,
        status: "running", input: String(a.input ?? "").slice(0, 200_000), ...(a.startBlockId ? { startBlockId: String(a.startBlockId) } : {}),
        createdAt: now(), definition: def, blocks: def.blocks.map(b => ({ blockId: b.id, status: "idle", runs: 0, log: [] })),
      };
      await ctx.host.db.exec(db, "INSERT INTO runs(id,project,workflow,created,data,env) VALUES(?,?,?,?,?,?)", [run.id, run.projectId, run.workflowId, run.createdAt, JSON.stringify(run), JSON.stringify(env)]);
      // Keep the newest 30 runs per workflow.
      const old = await ctx.host.db.query<any>(db, "SELECT id FROM runs WHERE project=? AND workflow=? ORDER BY created DESC LIMIT -1 OFFSET 30", [run.projectId, run.workflowId]);
      for (const r of old) if (!execs.get(r.id)?.driving) { execs.delete(r.id); await ctx.host.db.exec(db, "DELETE FROM runs WHERE id=?", [r.id]); await revokeWhere(ctx, s => s.kind === "run" && s.runId === r.id); }
      const x = newExec(run, env);
      void drive(x).catch(e => ctx.log.error("workflow drive", errMsg(e)));
      return summary(run);
    },
    async runs(ctx, a) {
      const rows = a.workflowId
        ? await ctx.host.db.query<any>(db, "SELECT data FROM runs WHERE project=? AND workflow=? ORDER BY created DESC LIMIT 30", [String(a.projectId), String(a.workflowId)])
        : await ctx.host.db.query<any>(db, "SELECT data FROM runs WHERE project=? ORDER BY created DESC LIMIT 50", [String(a.projectId)]);
      return rows.map(r => { const run: WorkflowRun = JSON.parse(r.data); return summary(execs.get(run.id)?.run || dirty.get(run.id) || run); });
    },
    async run(_ctx, a) {
      const live = execs.get(String(a.id))?.run; if (live) return detail(live);
      const stored = await loadRun(String(a.id)); if (!stored) throw new Error("Workflow run not found");
      return detail(stored.run);
    },
    async blockOutput(_ctx, a) {
      const x = await execFor(String(a.runId)), out = stateOf(x, String(a.blockId)).output ?? "";
      const offset = Math.max(0, Number(a.offset) || 0), limit = Math.min(Math.max(Number(a.limit) || 64_000, 1), 200_000);
      return { text: out.slice(offset, offset + limit), total: out.length };
    },
    async cancel(_ctx, a, meta) { gateway(meta); const x = await execFor(String(a.id)); await cancel(x); return summary(x.run); },
    async answer(_ctx, a, meta) { gateway(meta); const x = await execFor(String(a.runId)); answer(x, String(a.blockId), String(a.pauseId), String(a.answer ?? "")); return null; },
    async chat(_ctx, a, meta) {
      gateway(meta);
      const text = String(a.text || "").trim(); if (!text) throw new Error("Message is empty");
      return chat(await execFor(String(a.runId)), String(a.blockId), text);
    },
    /** Delete a finished run; returns its agent session ids for the gateway to remove. */
    async removeRun(ctx, a, meta) {
      gateway(meta);
      const x = execs.get(String(a.id));
      if (x && (x.driving || x.busy.size || x.timers.size || x.answers.size || x.background.size)) throw new Error("Cancel the run before deleting it");
      const stored = await loadRun(String(a.id)); if (!stored) return { sessions: [] };
      execs.delete(String(a.id)); dirty.delete(String(a.id));
      await ctx.host.db.exec(db, "DELETE FROM runs WHERE id=?", [String(a.id)]);
      await revokeWhere(ctx, s => s.kind === "run" && s.runId === a.id);
      return { sessions: stored.run.blocks.map(s => s.sessionId).filter(Boolean) };
    },
    apps: (_ctx, a) => listApps(String(a.root)),
    async appAction(ctx, a, meta) { gateway(meta); return appAction(ctx, String(a.root), String(a.name), "", String(a.action), Number(a.lines) || 200); },
    /** Workflow MCP endpoint for a configurator agent created by the gateway. */
    async configEndpoint(ctx, a, meta) {
      gateway(meta);
      return issueEndpoint(ctx, { kind: "config", projectId: String(a.projectId), sessionId: String(a.sessionId), profiles: (a.profiles || []).map((p: any) => ({ id: String(p.id), provider: p.provider })), mcps: (a.mcps || []).map((m: any) => ({ id: String(m.id) })) });
    },
    async revokeConfig(ctx, a, meta) { gateway(meta); await revokeWhere(ctx, s => s.kind === "config" && s.sessionId === a.sessionId); return null; },
    async shutdownApps(ctx, _a, meta) { gateway(meta); await killAllApps(ctx); return null; },
  },
};
export default mod;
