// Desktop gateway for visual workflows. Definitions, runs and execution live in the
// workflow-runner plugin on the workspace machine's daemon (hatod, also for local workspaces);
// this module installs/upgrades that runtime, resolves provider profiles and MCP servers into a
// run environment, routes designer requests, and contributes the self-configuration MCP commands.
import type { AppModule, ModuleContext, DaemonTarget } from "../../../../sdk/types";
import { errMsg, sshConnect, type WorkspaceDescriptor } from "../../../../sdk/runtime";
import { exportMcpTools } from "../../../../sdk/mcp";
import { WORKFLOW_REFERENCE, WORKFLOW_RUNNER_VERSION, edgeType, isAgentBlock, normalizeDefinition, validateWorkflow, type WorkflowRunEnv, type WorkflowRun } from "../../../../sdk/workflows";
import { advertisedChoices, providerChoiceKey } from "../../../../sdk/workflow-provider-options";
import { agentActivity } from "../../../../sdk/persistent-agents";
import { WORKFLOW_TEMPLATES } from "../../../../sdk/workflow-templates";

const prepared = new Map<string, Promise<{ target: DaemonTarget; bin: string; dir: string }>>();
async function resolve(ctx: ModuleContext, workspaceId: string): Promise<WorkspaceDescriptor> {
  if (typeof workspaceId !== "string" || !workspaceId) throw new Error("Select a workspace first");
  return ctx.modules.call("workspace", "resolve", { workspaceId });
}
/** Ensure the daemon and its agent + workflow runtimes. A runtime with active work is never replaced. */
async function daemon(ctx: ModuleContext, d: WorkspaceDescriptor) {
  let pending = prepared.get(d.machineId);
  if (!pending) {
    pending = (async () => {
      const target: DaemonTarget = d.location === "ssh" ? { kind: "ssh", connection: (await sshConnect(ctx, d)).connection } : { kind: "local" };
      const info = await ctx.host.daemon.ensure(target);
      const plugins = (await ctx.host.daemon.request(target, "plugins.list")).plugins as any[];
      for (const id of ["internal-remote-mcp", "agent-runner"]) {
        if (plugins.find(p => p.id === id)?.active) {
          if (id !== "agent-runner") continue;
          const health = await ctx.host.daemon.request(target, "modules.call", { target: id, method: "health", args: {}, timeoutMs: 15000 }).catch(() => null);
          if (health?.reasoning && health?.mcpActivity && health?.toolTitles) continue;
          const agents = await ctx.host.daemon.request(target, "modules.call", { target: id, method: "list", args: {}, timeoutMs: 15000 }).catch(() => null);
          if (!Array.isArray(agents) || agents.some((s: any) => ["ready", "starting", "busy", "waiting"].includes(s.status))) continue;
        }
        const pushed = await ctx.host.daemon.request(target, "plugins.push", { id });
        if (!pushed.active) throw new Error(pushed.error || `${id} did not activate on the daemon`);
      }
      let push = !plugins.find(p => p.id === "workflow-runner")?.active;
      if (!push) {
        const health = await ctx.host.daemon.request(target, "modules.call", { target: "workflow-runner", method: "health", args: {}, timeoutMs: 15000 }).catch(() => null);
        push = !health || (health.version !== WORKFLOW_RUNNER_VERSION && !health.active && !health.apps);
      }
      if (push) {
        const pushed = await ctx.host.daemon.request(target, "plugins.push", { id: "workflow-runner" });
        if (!pushed.active) throw new Error(pushed.error || "The workflow runtime did not activate on the daemon");
      }
      return { target, bin: info.bin, dir: info.dir };
    })();
    prepared.set(d.machineId, pending);
    void pending.catch(() => prepared.delete(d.machineId));
  }
  return pending;
}
async function daemonCall(ctx: ModuleContext, d: WorkspaceDescriptor, target: string, method: string, args: any = {}, timeoutMs = 120_000) {
  const t = await daemon(ctx, d);
  try { return await ctx.host.daemon.request(t.target, "modules.call", { target, method, args, timeoutMs }); }
  catch (e) { prepared.delete(d.machineId); throw e; }
}
const runner = (ctx: ModuleContext, d: WorkspaceDescriptor, method: string, args: any = {}, timeoutMs?: number) =>
  daemonCall(ctx, d, "workflow-runner", method, { projectId: d.projectId, ...args }, timeoutMs);

async function catalog(ctx: ModuleContext, d: WorkspaceDescriptor) {
  const c = await ctx.modules.call("persistent-agents", "catalog", { workspaceId: d.id }, { timeoutMs: 120_000 });
  const mcps = ((await ctx.modules.call("persistence", "settings.get", { key: "persistent-agents.mcps" })) || []).filter((m: any) => m.enabled !== false);
  const preferred = await ctx.modules.call("persistence", "settings.get", { key: "workflows.defaultProfile" }).catch(() => null);
  const defaultProfileId = c.profiles.some((p: any) => p.id === preferred) ? preferred : c.profiles[0]?.id || "";
  return { defaultProfileId, workspace: { id: d.id, name: d.name, machineId: d.machineId, location: d.location }, profiles: c.profiles.map((p: any) => ({ id: p.id, name: p.name, provider: p.provider })), skills: c.skills, agentFiles: c.agentFiles, mcps: mcps.map((m: any) => ({ id: m.id, name: m.name })), templates: WORKFLOW_TEMPLATES.map(t => ({ id: t.id, name: t.name, description: t.description })) };
}
async function runEnv(ctx: ModuleContext, d: WorkspaceDescriptor, workflowId?: string): Promise<WorkflowRunEnv> {
  const t = await daemon(ctx, d);
  const c = await ctx.modules.call("persistent-agents", "catalog", { workspaceId: d.id }, { timeoutMs: 120_000 });
  const mcps = ((await ctx.modules.call("persistence", "settings.get", { key: "persistent-agents.mcps" })) || []).filter((m: any) => m.enabled !== false);
  const mcpConfigs: Record<string, any> = {};
  if (workflowId) {
    const { definition } = await runner(ctx, d, "get", { id: workflowId });
    const connected = new Set<string>();
    for (const edge of definition.edges) {
      const agent = definition.blocks.find((b: any) => b.id === edge.from);
      if (agent && isAgentBlock(agent) && (agent.type === "chatbox" || edgeType(edge) === "use")) connected.add(edge.to);
    }
    const ids = [...new Set<string>(definition.blocks
      .filter((b: any) => b.type === "mcp" && connected.has(b.id))
      .map((b: any) => b.mcp?.serverId).filter(Boolean))];
    if (ids.length) {
      const configs = await ctx.modules.call("persistent-agents", "mcpConfigs", { workspaceId: d.id, ids }, { timeoutMs: 120_000 });
      for (const { id, ...config } of configs) mcpConfigs[id] = config;
    }
  }
  const subscription = await ctx.modules.call("persistence", "settings.get", { key: "acp.claude.useSubscription" });
  const preferred = await ctx.modules.call("persistence", "settings.get", { key: "workflows.defaultProfile" }).catch(() => null);
  return {
    projectId: d.projectId, workspaceId: d.id, workspaceName: d.name, root: d.rootAbsolutePath, machineId: d.machineId, daemon: { bin: t.bin, dir: t.dir },
    profiles: c.profiles, defaultProfileId: c.profiles.some((p: any) => p.id === preferred) ? preferred : c.profiles[0]?.id || "", claudeSubscription: subscription !== false, mcpServers: mcps, mcpConfigs,
  };
}
const available = async (ctx: ModuleContext, d: WorkspaceDescriptor) => { const c = await catalog(ctx, d); return { profiles: c.profiles, mcps: c.mcps }; };

/** A background agent that edits this project's workflows through the configurator endpoint. */
async function configurator(ctx: ModuleContext, d: WorkspaceDescriptor, a: any) {
  const env = await runEnv(ctx, d);
  const profile = env.profiles.find(p => p.id === a.profileId) || env.profiles.find(p => p.id === env.defaultProfileId);
  if (!profile) throw new Error("Enable an AI provider for this machine first");
  const id = crypto.randomUUID();
  const endpoint = await runner(ctx, d, "configEndpoint", { sessionId: id, profiles: env.profiles.map(p => ({ id: p.id, provider: p.provider })), mcps: env.mcpServers.map(m => ({ id: m.id })) });
  const spec = { id, name: "Workflow configurator", workspaceId: d.id, workspaceName: d.name, root: d.rootAbsolutePath, machineId: d.machineId, profile, model: String(a.model || ""),
    agentFile: null, skills: [], mcps: [endpoint], claudeSubscription: env.claudeSubscription, workspaceMcp: false, daemon: env.daemon, workflow: { configurator: true } };
  await daemonCall(ctx, d, "agent-runner", "create", { spec }, 240_000);
  const focus = a.workflowId ? `The user is editing workflow "${a.workflowId}" in the designer; read it first.` : "";
  const text = [
    "You configure Hato workflows for this project with the hato-workflow MCP tools (workflows_reference, workflows_list, workflows_read, workflows_write, workflows_validate).",
    "Read workflows_reference before designing. Read a workflow before editing and pass its revision as expected_revision (null to create; read id \"new\" for a starter).",
    "Preserve block and connection IDs and unrelated settings, fix returned validation issues, and never start runs: the user runs workflows from the Workflows panel.",
    "Report what you changed.", focus, "", `User request: ${String(a.request || "Help me design a workflow.").slice(0, 20_000)}`,
  ].filter(s => s !== undefined).join("\n");
  await daemonCall(ctx, d, "agent-runner", "send", { id, text }, 60_000);
  return { id, workspaceId: d.id };
}

const choicesCache = new Map<string, ReturnType<typeof advertisedChoices>>();
async function providerOptions(ctx: ModuleContext, d: WorkspaceDescriptor, a: any) {
  const c = await ctx.modules.call("persistent-agents", "catalog", { workspaceId: d.id });
  const preferred = await ctx.modules.call("persistence", "settings.get", { key: "workflows.defaultProfile" }).catch(() => null);
  const profile = c.profiles.find((p: any) => p.id === (a.profileId || preferred)) || (!a.profileId ? c.profiles[0] : null);
  if (!profile) throw new Error("Select an enabled provider first");
  const model = String(a.model || ""), key = providerChoiceKey(d.id, profile.id, model);
  const reasoningReady = !!(await daemonCall(ctx, d, "agent-runner", "health").catch(() => null))?.reasoning;
  if (!a.refresh && choicesCache.has(key)) return { ...choicesCache.get(key)!, reasoningReady };
  const sessions = await daemonCall(ctx, d, "agent-runner", "list");
  const existing = !a.refresh && sessions.find((s: any) => ["ready", "busy", "waiting"].includes(s.status) && s.workspaceId === d.id && s.profile?.id === profile.id && (s.model || "") === model && (s.configOptions?.length || s.models?.availableModels?.length));
  let choices: ReturnType<typeof advertisedChoices>;
  if (existing) choices = advertisedChoices(existing);
  else {
    // Negotiate metadata without sending a prompt. Only this disposable probe is removed;
    // running user sessions are never reconfigured or stopped for discovery.
    const id = crypto.randomUUID();
    try {
      const session = await daemonCall(ctx, d, "agent-runner", "create", { spec: { id, name: "Workflow provider options", workspaceId: d.id, workspaceName: d.name, root: d.rootAbsolutePath, machineId: d.machineId,
        profile, model, agentFile: null, skills: [], mcps: [], workspaceMcp: false, autopilot: false, claudeSubscription: (await ctx.modules.call("persistence", "settings.get", { key: "acp.claude.useSubscription" })) !== false } }, 240_000);
      choices = advertisedChoices(session);
    } finally { await daemonCall(ctx, d, "agent-runner", "remove", { id }).catch(() => {}); }
  }
  choicesCache.set(key, choices); return { ...choices, reasoningReady };
}

let mcp: ReturnType<typeof exportMcpTools> | null = null;
const mod: AppModule = {
  id: "workflows", moduleApiVersion: 1,
  activate(ctx) {
    const object = (properties: any, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });
    const scoped = async (scope: { workspaceId: string }) => resolve(ctx, scope.workspaceId);
    const parse = (c: any) => typeof c === "string" ? JSON.parse(c) : c;
    mcp = exportMcpTools(ctx, "Workflows", [
      { name: "reference", title: "Workflow format reference", description: "Read the workflow definition format: blocks, connections, templates and agent tools.", inputSchema: object({}), annotations: { readOnlyHint: true },
        handler: () => WORKFLOW_REFERENCE },
      { name: "catalog", title: "Workflow providers and templates", description: "List AI provider profiles, MCP servers, skills and templates usable by workflows in this workspace.", inputSchema: object({}), annotations: { readOnlyHint: true },
        handler: async (_a, s) => catalog(ctx, await scoped(s)) },
      { name: "list", title: "List workflows", description: "List this project's workflows with their revisions.", inputSchema: object({}), annotations: { readOnlyHint: true },
        handler: async (_a, s) => runner(ctx, await scoped(s), "list") },
      { name: "read", title: "Read a workflow", description: "Read a workflow definition and revision. Use id \"new\" (optionally template_id) for a starter definition.", inputSchema: object({ id: { type: "string" }, template_id: { type: "string" } }, ["id"]), annotations: { readOnlyHint: true },
        handler: async (a, s) => {
          const d = await scoped(s);
          if (a.id === "new") return { revision: null, definition: await runner(ctx, d, "starter", { templateId: a.template_id }) };
          const r = await runner(ctx, d, "get", { id: String(a.id) });
          return { ...r, issues: validateWorkflow(r.definition, await available(ctx, d)) };
        } },
      { name: "write", title: "Create or update a workflow", description: "Save a complete workflow definition (JSON string or object). expected_revision is the revision you read, or null to create. Returns validation issues. Never starts a run.",
        inputSchema: object({ content: {}, expected_revision: { type: ["number", "null"] } }, ["content", "expected_revision"]),
        handler: async (a, s) => {
          const d = await scoped(s);
          const r = await runner(ctx, d, "save", { definition: parse(a.content), expectedRevision: a.expected_revision === null ? null : Number(a.expected_revision), available: await available(ctx, d) });
          ctx.events.emit("workflows.changed", { workspaceId: d.id, workflowId: r.id });
          return { id: r.id, revision: r.revision, issues: r.issues };
        } },
      { name: "validate", title: "Validate a workflow", description: "Validate a workflow definition without saving it.", inputSchema: object({ content: {} }, ["content"]), annotations: { readOnlyHint: true },
        handler: async (a, s) => ({ issues: validateWorkflow(normalizeDefinition(parse(a.content)), await available(ctx, await scoped(s))) }) },
      { name: "run", title: "Run a workflow", description: "Start a workflow run on the workspace daemon. Only use when the user explicitly asks to run it.", inputSchema: object({ id: { type: "string" }, input: { type: "string" }, start_block_id: { type: "string" } }, ["id"]),
        handler: async (a, s) => { const d = await scoped(s); const r = await runner(ctx, d, "start", { workflowId: String(a.id), input: String(a.input || ""), startBlockId: a.start_block_id, env: await runEnv(ctx, d, String(a.id)) }); ctx.events.emit("workflows.changed", { workspaceId: d.id, runId: r.id }); return r; } },
      { name: "run_status", title: "Workflow run status", description: "Read a workflow run's status and block results (or list recent runs when run_id is omitted).", inputSchema: object({ run_id: { type: "string" }, workflow_id: { type: "string" } }), annotations: { readOnlyHint: true },
        handler: async (a, s) => {
          const d = await scoped(s);
          if (!a.run_id) return runner(ctx, d, "runs", { workflowId: a.workflow_id });
          const r = await runner(ctx, d, "run", { id: String(a.run_id) });
          if (r.projectId !== d.projectId) throw new Error("Run belongs to another project");
          return { ...r, definition: undefined, blocks: r.blocks.map((b: any) => ({ blockId: b.blockId, status: b.status, error: b.error, question: b.question, output: b.output?.slice(0, 4000) })) };
        } },
    ]);
  },
  canSwap: () => ({ ok: !mcp || mcp.pending() === 0, reason: "Workflow MCP commands are running" }),
  methods: {
    async providerOptions(ctx, a) { return providerOptions(ctx, await resolve(ctx, a.workspaceId), a); },
    async catalog(ctx, a) { return catalog(ctx, await resolve(ctx, a.workspaceId)); },
    async list(ctx, a) { return runner(ctx, await resolve(ctx, a.workspaceId), "list"); },
    async get(ctx, a) { const d = await resolve(ctx, a.workspaceId); const r = await runner(ctx, d, "get", { id: a.id }); return { ...r, issues: validateWorkflow(r.definition, await available(ctx, d)) }; },
    async save(ctx, a) {
      const d = await resolve(ctx, a.workspaceId);
      const r = await runner(ctx, d, "save", { definition: a.definition, expectedRevision: a.expectedRevision, available: await available(ctx, d) });
      ctx.events.emit("workflows.changed", { workspaceId: d.id, workflowId: r.id });
      return r;
    },
    async create(ctx, a) {
      const d = await resolve(ctx, a.workspaceId);
      const def = await runner(ctx, d, "starter", { templateId: a.templateId || "blank" });
      if (a.name) def.name = String(a.name).slice(0, 200);
      if (a.definition) Object.assign(def, normalizeDefinition(a.definition), { id: def.id });
      const r = await runner(ctx, d, "save", { definition: def, expectedRevision: null, available: await available(ctx, d) });
      ctx.events.emit("workflows.changed", { workspaceId: d.id, workflowId: r.id });
      return r;
    },
    async remove(ctx, a) { const d = await resolve(ctx, a.workspaceId); await runner(ctx, d, "remove", { id: a.id }); ctx.events.emit("workflows.changed", { workspaceId: d.id }); return null; },
    async run(ctx, a) {
      const d = await resolve(ctx, a.workspaceId);
      // Recheck an idle daemon before each new run. A prior check may have deferred
      // an upgrade because another run or app was still active.
      prepared.delete(d.machineId);
      const r = await runner(ctx, d, "start", { workflowId: a.id, input: String(a.input || ""), startBlockId: a.startBlockId || undefined, env: await runEnv(ctx, d, a.id) });
      ctx.events.emit("workflows.changed", { workspaceId: d.id, runId: r.id });
      return r;
    },
    async chatHistory(ctx, a) {
      const d = await resolve(ctx, a.workspaceId), r: WorkflowRun = await runner(ctx, d, "run", { id: a.runId });
      if (r.projectId !== d.projectId) throw new Error("Run belongs to another project");
      const st = r.blocks.find(b => b.blockId === a.blockId);
      if (!st?.sessionId || r.definition.blocks.find(b => b.id === a.blockId)?.type !== "chatbox") throw new Error("Unknown chatbox session");
      if (!Number.isSafeInteger(a.before) || a.before <= 0) throw new Error("Invalid history cursor");
      const view = await daemonCall(ctx, d, "agent-runner", "view", { id: st.sessionId, before: a.before, limit: 40 }, 15_000);
      if (view.session.workspaceId !== d.id || (view.session.workflow && (view.session.workflow.runId !== r.id || view.session.workflow.blockId !== st.blockId))) throw new Error("Session belongs to another workflow");
      const messages = view.messages.map((message: any) => {
        const user = message.role === "user" && [...(st.chat || [])].reverse().find(m => m.role === "user" && String(message.text || "").endsWith(m.text));
        return user ? { ...message, text: user.text } : message;
      });
      return { sessionId: st.sessionId, messages, before: view.before ?? null };
    },
    async runs(ctx, a) { return runner(ctx, await resolve(ctx, a.workspaceId), "runs", { workflowId: a.workflowId }); },
    async runDetail(ctx, a) {
      const d = await resolve(ctx, a.workspaceId), r: WorkflowRun = await runner(ctx, d, "run", { id: a.runId });
      if (r.projectId !== d.projectId) throw new Error("Run belongs to another project");
      // Chatboxes remain usable after the workflow finishes. Read the actual session,
      // rather than treating the last workflow invocation's status as current activity.
      const blocks = await Promise.all(r.blocks.map(async st => {
        if (!st.sessionId || r.definition.blocks.find(b => b.id === st.blockId)?.type !== "chatbox") return st;
        try {
          const view = await daemonCall(ctx, d, "agent-runner", "view", { id: st.sessionId, limit: 40 }, 15_000);
          if (view.session.workspaceId !== d.id || (view.session.workflow && (view.session.workflow.runId !== r.id || view.session.workflow.blockId !== st.blockId))) throw new Error("Session belongs to another workflow");
          return { ...st, agentMessages: view.messages.map((message: any) => {
            // The first provider prompt contains workflow instructions; display the user's chat text.
            const user = message.role === "user" && [...(st.chat || [])].reverse().find(m => m.role === "user" && String(message.text || "").endsWith(m.text));
            return user ? { ...message, text: user.text } : message;
          }), agentHistoryBefore: view.before ?? null, agentActivity: { status: view.session.status, text: view.session.status === "ready" ? "Ready for a message" : agentActivity(view), permissionId: view.permissions?.[0]?.id } };
        } catch { return { ...st, agentActivity: { status: "unavailable", text: "Agent status is temporarily unavailable" } }; }
      }));
      return { ...r, blocks };
    },
    async blockOutput(ctx, a) { return runner(ctx, await resolve(ctx, a.workspaceId), "blockOutput", { runId: a.runId, blockId: a.blockId, offset: a.offset, limit: a.limit }); },
    async cancel(ctx, a) { return runner(ctx, await resolve(ctx, a.workspaceId), "cancel", { id: a.runId }); },
    async answer(ctx, a) { return runner(ctx, await resolve(ctx, a.workspaceId), "answer", { runId: a.runId, blockId: a.blockId, pauseId: a.pauseId, answer: a.answer }); },
    async chat(ctx, a) { return runner(ctx, await resolve(ctx, a.workspaceId), "chat", { runId: a.runId, blockId: a.blockId, text: a.text }); },
    async removeRun(ctx, a) {
      const d = await resolve(ctx, a.workspaceId);
      const r = await runner(ctx, d, "removeRun", { id: a.runId });
      for (const id of r.sessions || []) await daemonCall(ctx, d, "agent-runner", "remove", { id }).catch(e => ctx.log.warn("workflow session cleanup", errMsg(e)));
      return null;
    },
    async apps(ctx, a) { const d = await resolve(ctx, a.workspaceId); return runner(ctx, d, "apps", { root: d.rootAbsolutePath }); },
    async appAction(ctx, a) { const d = await resolve(ctx, a.workspaceId); return runner(ctx, d, "appAction", { root: d.rootAbsolutePath, name: a.name, action: a.action, lines: a.lines }); },
    /** Provider permission of a block's session, reviewed through the trusted approval UI. */
    async reviewPermission(ctx, a) { return ctx.modules.call("persistent-agents", "reviewPermission", { workspaceId: a.workspaceId, id: a.sessionId, permissionId: a.permissionId }, { timeoutMs: 600_000 }); },
    async configure(ctx, a) { return configurator(ctx, await resolve(ctx, a.workspaceId), a); },
    async setDefaultProfile(ctx, a) { await ctx.modules.call("persistence", "settings.set", { key: "workflows.defaultProfile", value: String(a.profileId || "") }); return null; },
  },
};
export default mod;
