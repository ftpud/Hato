// acp: Agent Client Protocol (agentclientprotocol.com) client implemented in TS over generic
// process stdio streams. The agent process runs ON the workspace's machine with cwd = the exact
// project root / worktree: local child process for local workspaces, SSH exec for remote ones.
// No local fallback, no implicit clone, no auto-install.
import { reportedUsage, type ReportedUsage } from "../../../../sdk/context-usage";
import { imageAttachments } from "../../../../sdk/images";
import { applyClaudeRateLimit, parseClaudeUsage, parseCodexStatus, type LimitProvider, type LimitsSnapshot } from "../../../../sdk/usage-limits";
import type { AppModule, Handle, ModuleContext } from "../../../../sdk/types";
import { errMsg, JsonRpcPeer, rpcError, targetFor, workspaceGrant, type WorkspaceDescriptor } from "../../../../sdk/runtime";

const PROTOCOL_VERSION = 1;
const DEFAULT_PROFILES = [
  { id: "codex", machineId: "*", provider: "codex", name: "Codex (codex-acp)", executable: "codex-acp", args: [], envRefs: {}, enabled: true },
  { id: "claude", machineId: "*", provider: "claude", name: "Claude (claude-agent-acp)", executable: "claude-agent-acp", args: [], envRefs: {}, enabled: true },
];

/** Known ACP adapters that can be installed/updated on request (npm global packages). */
export const ADAPTERS = [
  { id: "claude", name: "Claude (claude-agent-acp)", pkg: "@agentclientprotocol/claude-agent-acp", bin: "claude-agent-acp" },
  { id: "codex", name: "Codex (codex-acp)", pkg: "@agentclientprotocol/codex-acp", bin: "codex-acp" },
];

interface Conn {
  conversationId: string;
  workspaceId: string;
  machineId: string;
  cwd: string;
  profileId: string;
  proc: Handle;
  pid: number;
  peer: JsonRpcPeer;
  sessionId: string | null;
  agentInfo: any;
  agentCapabilities: any;
  /** Agent advertised the `_session/steering` extension (inject into the running turn). */
  steering: boolean;
  authMethods: any[];
  configOptions: any[] | null;
  modes: any | null;
  models: any | null;
  commands: any[];
  usage: ReportedUsage | null;
  status: "starting" | "ready" | "busy" | "exited" | "error";
  error: string | null;
  stderrTail: string;
  stopping?: boolean;
  mcp: { enabled: boolean; status: string; selection?: string[] };
  executablePath: string;
  startedAt: number;
}

const conns = new Map<string, Conn>();

// ---- plan usage limits ---------------------------------------------------------------------------
// Published at `acp.limits` as { claude, codex }. Refreshed by a short-lived hidden ACP session that
// runs the adapter's local usage command (no model call), and passively from live Claude turns.
const LIMIT_COMMAND: Record<LimitProvider, string> = { claude: "/usage", codex: "/status" };
let limits: Record<LimitProvider, LimitsSnapshot | null> = { claude: null, codex: null };
const probes = new Map<LimitProvider, Promise<LimitsSnapshot>>();
function publishLimits(ctx: ModuleContext) { ctx.state.set("acp.limits", limits as any); }
function setLimits(ctx: ModuleContext, provider: LimitProvider, snap: LimitsSnapshot) { limits = { ...limits, [provider]: snap }; publishLimits(ctx); }

async function probeLimits(ctx: ModuleContext, provider: LimitProvider, workspaceId: string): Promise<LimitsSnapshot> {
  const desc: WorkspaceDescriptor = await ctx.modules.call("workspace", "resolve", { workspaceId });
  const all = await profiles(ctx);
  const profile = all.find((p: any) => p.enabled && p.provider === provider && (p.machineId === desc.machineId || p.machineId === "*"));
  if (!profile) throw new Error(`no enabled ${provider} agent profile for ${desc.machineId}`);
  const det = await detect(ctx, desc, profile.executable);
  if (!det.found) throw new Error(`${profile.executable} was not found on ${desc.machineId}`);
  const g = await workspaceGrant(ctx, desc, "process");
  const env: Record<string, string> = { ...(profile.envRefs || {}) };
  if (det.pathEnv) env.PATH = det.pathEnv;
  const envRemove: string[] = [];
  if (provider === "claude" && (await authSettings(ctx)).claudeSubscription) for (const k of CLAUDE_API_VARS) { envRemove.push(k); delete env[k]; }
  const proc = await ctx.host.process.spawn(g.grant, {
    target: await targetFor(ctx, desc), executable: desc.location === "ssh" ? profile.executable : det.path,
    args: profile.args || [], cwd: desc.rootAbsolutePath, env, envRemove, loginShell: desc.location === "ssh",
  });
  const peer = new JsonRpcPeer((line) => ctx.host.process.write(proc.handle, line + "\n"), 1);
  let text = "", rateLimit: any = null;
  peer.onNotification = (method, params) => {
    const u = method === "session/update" ? params?.update : null;
    if (u?.sessionUpdate === "agent_message_chunk" && u.content?.type === "text") text += u.content.text;
    if (u?.sessionUpdate === "usage_update" && u._meta?.["_claude/rateLimit"]) rateLimit = u._meta["_claude/rateLimit"];
  };
  peer.onRequest = async (method) => { if (method === "session/request_permission") return { outcome: { outcome: "cancelled" } }; throw rpcError(-32601, `method not supported by client: ${method}`); };
  const subs = [
    await ctx.host.streams.listen(proc.handle, { channel: "stdout" }, (chunk) => peer.feed(chunk), () => peer.failAll("agent process exited")),
  ];
  try {
    await withTimeout(peer.request("initialize", { protocolVersion: PROTOCOL_VERSION, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "hato", title: "Hato usage meter", version: "0.1.0" } }), 60000, "initialize");
    const session: any = await withTimeout(peer.request("session/new", { cwd: desc.rootAbsolutePath, mcpServers: [] }), 120000, "session/new");
    await withTimeout(peer.request("session/prompt", { sessionId: session.sessionId, prompt: [{ type: "text", text: LIMIT_COMMAND[provider] }] }), 90000, LIMIT_COMMAND[provider]);
  } finally {
    for (const sub of subs) await sub.close().catch(() => {});
    await ctx.host.process.closeStdin(proc.handle).catch(() => {});
    await ctx.host.process.terminate(proc.handle).catch(() => {});
  }
  const parsed = provider === "claude" ? parseClaudeUsage(text) : parseCodexStatus(text);
  let snap: LimitsSnapshot = { provider, windows: parsed.windows, plan: parsed.plan, updatedAt: Date.now(), source: "probe", error: null };
  if (!snap.windows.length && rateLimit) snap = { ...applyClaudeRateLimit(null, rateLimit)!, source: "probe" };
  if (!snap.windows.length) snap.error = /not logged in|API key/i.test(text) ? `${provider} is not using a subscription login; plan limits are unavailable` : "the agent reported no plan limits";
  return snap;
}

function publicState(c: Conn | undefined) {
  if (!c) return null;
  return {
    conversationId: c.conversationId, workspaceId: c.workspaceId, machineId: c.machineId, cwd: c.cwd, profileId: c.profileId,
    pid: c.pid, sessionId: c.sessionId, agentInfo: c.agentInfo, agentCapabilities: c.agentCapabilities, authMethods: c.authMethods,
    configOptions: c.configOptions, modes: c.modes, models: c.models, commands: c.commands, usage: c.usage || null, status: c.status, error: c.error,
    stderrTail: c.stderrTail.slice(-2000), mcp: c.mcp, executablePath: c.executablePath, startedAt: c.startedAt,
  };
}

function emitStatus(ctx: ModuleContext, c: Conn) { ctx.events.emit("acp.status", publicState(c) as any); }

async function profiles(ctx: ModuleContext) {
  const rows = await ctx.modules.call("persistence", "acpProfiles.list");
  return rows;
}

async function resolveProfile(ctx: ModuleContext, id: string, machineId: string) {
  const all = await profiles(ctx);
  const p = all.find((x: any) => x.id === id && x.enabled && (x.machineId === machineId || x.machineId === "*"));
  if (!p) throw new Error(`agent profile '${id}' is not configured for ${machineId}`);
  return p;
}

/** Find the adapter executable on the workspace machine (login-shell PATH). Never installs anything. */
async function detect(ctx: ModuleContext, desc: WorkspaceDescriptor, executable: string) {
  const g = await workspaceGrant(ctx, desc, "process");
  const target = await targetFor(ctx, desc);
  if (executable.startsWith("/")) {
    const r = await ctx.host.process.run(g.grant, { target, executable: "test", args: ["-x", executable], cwd: desc.rootAbsolutePath }, { timeoutMs: 15000 });
    return { found: r.code === 0, path: executable, pathEnv: null as string | null };
  }
  if (desc.location === "ssh") {
    const r = await ctx.host.process.run(g.grant, { target, executable: "sh", args: ["-c", 'command -v -- "$1"', "hato-detect", executable], cwd: desc.rootAbsolutePath, loginShell: true }, { timeoutMs: 20000 });
    return { found: r.code === 0 && r.stdout.trim().length > 0, path: r.stdout.trim().split("\n").pop() || "", pathEnv: null };
  }
  // Local: the GUI process may not inherit the user's shell PATH; ask the login shell.
  const shell = "/bin/zsh";
  const r = await ctx.host.process.run(g.grant, { target, executable: shell, args: ["-lc", 'command -v -- "$1"; printf "\\n__PATH__=%s" "$PATH"', "hato-detect", executable], cwd: desc.rootAbsolutePath }, { timeoutMs: 20000 });
  const pathEnv = (/__PATH__=(.*)$/m.exec(r.stdout) || [])[1] || null;
  const found = r.stdout.split("\n").map((l) => l.trim()).find((l) => l.startsWith("/")) || "";
  return { found: !!found, path: found, pathEnv };
}

/** Runs npm on the workspace machine (local: absolute npm + login PATH; SSH: login shell). */
async function npmRunner(ctx: ModuleContext, desc: WorkspaceDescriptor) {
  const det = await detect(ctx, desc, "npm");
  if (!det.found) return { ok: false as const, error: `npm was not found on ${desc.machineId}; install Node.js there first`, run: null as any };
  const g = await workspaceGrant(ctx, desc, "process");
  const target = await targetFor(ctx, desc);
  const env: Record<string, string> = {};
  if (det.pathEnv) env.PATH = det.pathEnv;
  const run = (args: string[], timeoutMs: number) => ctx.host.process.run(g.grant, {
    target, executable: desc.location === "ssh" ? "npm" : det.path, args, cwd: desc.rootAbsolutePath, env, loginShell: desc.location === "ssh",
  }, { timeoutMs, limitBytes: 1 << 20 });
  return { ok: true as const, error: "", run };
}

const CLAUDE_API_VARS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"];

async function authSettings(ctx: ModuleContext): Promise<{ claudeSubscription: boolean }> {
  const v = await ctx.modules.call("persistence", "settings.get", { key: "acp.claude.useSubscription" });
  return { claudeSubscription: v === null || v === undefined ? true : !!v };
}

async function start(ctx: ModuleContext, a: any) {
  const existing = conns.get(a.conversationId);
  if (existing && (existing.status === "ready" || existing.status === "busy" || existing.status === "starting")) return publicState(existing);
  const desc: WorkspaceDescriptor = await ctx.modules.call("workspace", "resolve", { workspaceId: a.workspaceId });
  const profile = await resolveProfile(ctx, a.profileId, desc.machineId);
  const det = await detect(ctx, desc, profile.executable);
  if (!det.found) {
    throw new Error(`ACP adapter '${profile.executable}' was not found on ${desc.machineId}. Install and authenticate it on that machine (e.g. npm i -g @agentclientprotocol/codex-acp or @agentclientprotocol/claude-agent-acp), or point the profile to an absolute path. Hato never installs agents automatically.`);
  }
  const g = await workspaceGrant(ctx, desc, "process");
  const env: Record<string, string> = { ...(profile.envRefs || {}) };
  if (det.pathEnv) env.PATH = det.pathEnv;
  // Claude subscription mode (default): keep API-key variables from the shell/profile away from the
  // adapter so it authenticates with the user's Claude login instead of billing an API account.
  const auth = await authSettings(ctx);
  const envRemove: string[] = [];
  if (profile.provider === "claude" && auth.claudeSubscription) {
    for (const k of CLAUDE_API_VARS) { envRemove.push(k); delete env[k]; }
  }
  const spawned = await ctx.host.process.spawn(g.grant, {
    target: await targetFor(ctx, desc),
    executable: desc.location === "ssh" ? profile.executable : det.path,
    args: profile.args || [], cwd: desc.rootAbsolutePath, env, envRemove, loginShell: desc.location === "ssh",
  });
  const c: Conn = {
    conversationId: a.conversationId, workspaceId: desc.id, machineId: desc.machineId, cwd: desc.rootAbsolutePath, profileId: profile.id,
    proc: spawned.handle, pid: spawned.pid, peer: null as any, sessionId: null, agentInfo: null, agentCapabilities: null, steering: false, authMethods: [],
    configOptions: null, modes: null, models: null, commands: [], usage: null, status: "starting", error: null, stderrTail: "",
    mcp: { enabled: !!a.mcp, status: a.mcp ? "pending" : "disabled" }, executablePath: det.path, startedAt: Date.now(),
  };
  conns.set(c.conversationId, c);
  await wire(ctx, c, 1);
  emitStatus(ctx, c);
  try {
    const init: any = await withTimeout(c.peer.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "hato", title: "Hato", version: "0.1.0" },
    }), 60000, "initialize");
    c.agentInfo = init.agentInfo || null;
    c.agentCapabilities = init.agentCapabilities || {};
    c.steering = init._meta?.steering?.supported === true;
    c.authMethods = init.authMethods || [];
    if (init.protocolVersion !== PROTOCOL_VERSION) throw new Error(`agent negotiated unsupported ACP protocol version ${init.protocolVersion}`);
    let mcpServers: any[] = [...(a.mcpServers || [])];
    if (a.mcp) {
      try {
        const ep = await ctx.modules.call("internal-mcp", "endpoint", { conversationId: c.conversationId, workspaceId: desc.id }, { timeoutMs: 300000 });
        mcpServers.push(ep.server);
        c.mcp = { enabled: true, status: `internal MCP via ${ep.transport}` };
      } catch (e) {
        c.mcp = { enabled: true, status: `unavailable: ${errMsg(e)}` };
        ctx.log.warn("internal MCP unavailable for", c.conversationId, errMsg(e));
      }
    }
    const caps = c.agentCapabilities.mcpCapabilities || {};
    for (const server of mcpServers) {
      if (server.type === "http" && !caps.http) throw new Error(`Agent does not support HTTP MCP server “${server.name}”`);
      if (server.type === "sse" && !caps.sse) throw new Error(`Agent does not support SSE MCP server “${server.name}”`);
    }
    c.mcp.selection = (a.mcpSelection || (a.mcp ? ["internal"] : [])).filter((id: string) => id !== "internal" || mcpServers.some(s => s.name === "hato-internal"));
    let res: any;
    if (a.resumeSessionId && c.agentCapabilities.loadSession) {
      try {
        res = await withTimeout(c.peer.request("session/load", { sessionId: a.resumeSessionId, cwd: c.cwd, mcpServers }), 120000, "session/load");
        c.sessionId = a.resumeSessionId;
      } catch (e) {
        ctx.log.warn("session/load failed; starting a new session", errMsg(e));
        ctx.events.emit("acp.update", { conversationId: c.conversationId, update: { sessionUpdate: "_hato_notice", text: `Could not resume the previous agent session (${errMsg(e)}); started a new one. Cached history remains visible.` } });
      }
    }
    if (!c.sessionId) {
      res = await withTimeout(c.peer.request("session/new", { cwd: c.cwd, mcpServers }), 120000, "session/new");
      c.sessionId = res.sessionId;
    }
    c.configOptions = res && Array.isArray(res.configOptions) ? res.configOptions : null;
    c.modes = res && res.modes ? res.modes : null;
    c.models = res && res.models ? res.models : null;
    c.status = "ready";
  } catch (e: any) {
    c.status = "error";
    const auth = c.authMethods && c.authMethods.length && /auth/i.test(errMsg(e));
    c.error = auth ? `Agent requires authentication on ${c.machineId} (${c.authMethods.map((m: any) => m.name || m.id).join(", ")}). Authenticate the adapter there (e.g. 'codex login'), then reconnect. Details: ${errMsg(e)}` : errMsg(e);
    emitStatus(ctx, c);
    await ctx.host.process.terminate(c.proc).catch(() => {});
    throw new Error(c.error!);
  }
  emitStatus(ctx, c);
  return publicState(c);
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

/** Connect the JSON-RPC peer to the process streams (also used after a hot swap). */
async function wire(ctx: ModuleContext, c: Conn, nextId: number, partial = "") {
  c.peer = new JsonRpcPeer((line) => ctx.host.process.write(c.proc, line + "\n"), nextId);
  c.peer.restore(partial);
  c.peer.onNotification = (method, params) => {
    if (method === "session/update" && params && params.update) {
      const u = params.update;
      if (u.sessionUpdate === "config_option_update" && Array.isArray(u.configOptions)) { c.configOptions = u.configOptions; emitStatus(ctx, c); }
      else if (u.sessionUpdate === "current_mode_update" && c.modes) { c.modes = { ...c.modes, currentModeId: u.currentModeId }; emitStatus(ctx, c); }
      else if (u.sessionUpdate === "usage_update") {
        c.usage = reportedUsage(u); emitStatus(ctx, c);
        const rl = u._meta?.["_claude/rateLimit"];
        if (rl) { const next = applyClaudeRateLimit(limits.claude, rl); if (next) setLimits(ctx, "claude", { ...next, plan: limits.claude?.plan ?? null }); }
      }
      else if (u.sessionUpdate === "available_commands_update") { c.commands = u.availableCommands || []; }
      ctx.events.emit("acp.update", { conversationId: c.conversationId, update: u });
    }
  };
  c.peer.onRequest = async (method, params) => {
    if (method === "session/request_permission") {
      return ctx.modules.call("ai-sessions", "permissionRequest", { conversationId: c.conversationId, request: params }, { timeoutMs: 30 * 60 * 1000 });
    }
    // fs/* and terminal/* capabilities are not advertised by this client.
    throw rpcError(-32601, `method not supported by client: ${method}`);
  };
  c.peer.onProtocolError = (err, line) => ctx.log.warn(`ACP protocol error (${c.conversationId}): ${err}: ${line.slice(0, 200)}`);
  await ctx.host.streams.listen(c.proc, { channel: "stdout" }, (chunk) => c.peer.feed(chunk), (err) => {
    const wasBusy = c.status === "busy";
    c.status = "exited";
    if (c.stopping) { c.peer.failAll("agent stopped"); return; }
    c.error = c.error || (err ? errMsg(err) : "agent process exited");
    c.peer.failAll("agent process exited");
    ctx.host.process.wait(c.proc).then((x) => { if (x) c.error = `agent process exited (code ${x.code}${x.signal ? ", signal " + x.signal : ""})${c.stderrTail ? ": " + c.stderrTail.trim().split("\n").slice(-3).join(" | ") : ""}`; emitStatus(ctx, c); }).catch(() => emitStatus(ctx, c));
    if (wasBusy) ctx.events.emit("acp.turnEnded", { conversationId: c.conversationId, error: "agent process exited" });
  });
  await ctx.host.streams.listen(c.proc, { channel: "stderr" }, (chunk) => { c.stderrTail = (c.stderrTail + chunk).slice(-8000); });
}

const mod: AppModule = {
  id: "acp",
  moduleApiVersion: 1,
  async activate(ctx, prev) {
    const existing = await profiles(ctx);
    for (const p of DEFAULT_PROFILES) if (!existing.some((x: any) => x.id === p.id)) await ctx.modules.call("persistence", "acpProfiles.upsert", { profile: p });
    if (prev?.limits) limits = { claude: prev.limits.claude || null, codex: prev.limits.codex || null };
    for (const k of Object.keys(limits) as LimitProvider[]) if (limits[k]?.loading) limits[k] = { ...limits[k]!, loading: false };
    publishLimits(ctx);
    // Hot-swap hand-over: re-attach live agent processes; the kernel replays buffered stdout.
    if (prev && Array.isArray(prev.conns)) {
      for (const s of prev.conns) {
        const c: Conn = { ...s, peer: null as any };
        conns.set(c.conversationId, c);
        if (c.status === "ready" || c.status === "busy") await wire(ctx, c, s.nextId, s.partial);
      }
      ctx.log.info(`re-attached ${prev.conns.length} ACP connection(s) after hot swap`);
    }
  },
  /** Defer swaps while a prompt turn or an agent request is in flight (parser state would be lost). */
  canSwap() {
    if (probes.size) return { ok: false, reason: "a usage-limit probe is running" };
    for (const c of conns.values()) {
      if (c.status === "busy" || c.status === "starting" || (c.peer && c.peer.pendingCount > 0)) return { ok: false, reason: `ACP session ${c.conversationId} is busy` };
    }
    return { ok: true };
  },
  snapshot() {
    return { limits, conns: Array.from(conns.values()).map((c) => ({ ...publicState(c), proc: c.proc, stderrTail: c.stderrTail, nextId: c.peer ? c.peer.nextRequestId : 1, partial: c.peer ? c.peer.partial : "" })) };
  },
  methods: {
    profiles: async (ctx, a) => {
      const all = await profiles(ctx);
      return a && a.machineId ? all.filter((p: any) => p.machineId === "*" || p.machineId === a.machineId) : all;
    },
    saveProfile: async (ctx, a) => { await ctx.modules.call("persistence", "acpProfiles.upsert", { profile: a.profile }); return null; },
    authSettings: (ctx) => authSettings(ctx),
    async setAuthSettings(ctx, a) {
      if (typeof a.claudeSubscription === "boolean") await ctx.modules.call("persistence", "settings.set", { key: "acp.claude.useSubscription", value: a.claudeSubscription });
      ctx.events.emit("acp.authChanged", await authSettings(ctx));
      return authSettings(ctx);
    },
    detect: async (ctx, a) => {
      const desc = await ctx.modules.call("workspace", "resolve", { workspaceId: a.workspaceId });
      const p = await resolveProfile(ctx, a.profileId, desc.machineId);
      const d = await detect(ctx, desc, p.executable);
      return { ...d, machineId: desc.machineId, executable: p.executable, pathEnv: undefined };
    },
    start: (ctx, a) => start(ctx, a),
    state: (_ctx, a) => publicState(conns.get(a.conversationId)),
    async prompt(ctx, a) {
      const c = conns.get(a.conversationId);
      if (!c || c.status !== "ready") throw new Error(`agent session is ${c ? c.status : "not started"}`);
      const images = imageAttachments(a.images);
      if (images.length && !c.agentCapabilities?.promptCapabilities?.image) throw new Error("This agent does not support image prompts. Choose an agent with image support.");
      const blocks: any[] = a.text ? [{ type: "text", text: String(a.text) }] : [];
      blocks.push(...images.map((image) => ({ type: "image", mimeType: image.mimeType, data: image.data })));
      if (!blocks.length) throw new Error("empty prompt");
      c.status = "busy";
      emitStatus(ctx, c);
      c.peer.request("session/prompt", { sessionId: c.sessionId, prompt: blocks }).then(
        (r: any) => { if (c.stopping || c.status === "exited") return; if (c.status === "busy") c.status = "ready"; emitStatus(ctx, c); ctx.events.emit("acp.turnEnded", { conversationId: c.conversationId, stopReason: r && r.stopReason }); },
        (e) => { if (c.stopping || c.status === "exited") return; if (c.status === "busy") c.status = "ready"; c.error = errMsg(e); emitStatus(ctx, c); ctx.events.emit("acp.turnEnded", { conversationId: c.conversationId, error: errMsg(e) }); },
      );
      return { accepted: true };
    },
    /** Inject a message into the running turn without interrupting it.
     *  Returns `steered`, `promptRequired` (the turn already ended) or `unsupported`. */
    async steer(ctx, a) {
      const c = conns.get(a.conversationId);
      if (!c || !c.sessionId || !c.steering) return { outcome: "unsupported" };
      const images = imageAttachments(a.images);
      if (images.length && !c.agentCapabilities?.promptCapabilities?.image) throw new Error("This agent does not support image prompts. Choose an agent with image support.");
      const blocks: any[] = a.text ? [{ type: "text", text: String(a.text) }] : [];
      blocks.push(...images.map((image) => ({ type: "image", mimeType: image.mimeType, data: image.data })));
      if (!blocks.length) throw new Error("empty prompt");
      const r: any = await withTimeout(c.peer.request("_session/steering", { sessionId: c.sessionId, prompt: blocks, _meta: { steering: { idleBehavior: "promptRequired" } } }), 30000, "steering");
      return { outcome: r?.outcome === "promptRequired" ? "promptRequired" : "steered" };
    },
    async cancel(ctx, a) {
      const c = conns.get(a.conversationId);
      if (!c || !c.sessionId) return null;
      await c.peer.notify("session/cancel", { sessionId: c.sessionId });
      return null;
    },
    /** Change a negotiated session setting. Uses configOptions when advertised; legacy modes/models otherwise. */
    async setConfig(ctx, a) {
      const c = conns.get(a.conversationId);
      if (!c || !c.sessionId) throw new Error("agent session not started");
      const changesModel = a.configId === "__model" || c.configOptions?.some((o: any) => o.id === a.configId && o.category === "model");
      if (c.configOptions && c.configOptions.some((o: any) => o.id === a.configId)) {
        const r: any = await c.peer.request("session/set_config_option", { sessionId: c.sessionId, configId: a.configId, value: a.value });
        if (r && Array.isArray(r.configOptions)) c.configOptions = r.configOptions;
      } else if (a.configId === "__mode" && c.modes) {
        await c.peer.request("session/set_mode", { sessionId: c.sessionId, modeId: a.value });
        c.modes = { ...c.modes, currentModeId: a.value };
      } else if (a.configId === "__model" && c.models) {
        await c.peer.request("session/set_model", { sessionId: c.sessionId, modelId: a.value });
        c.models = { ...c.models, currentModelId: a.value };
      } else {
        throw new Error(`agent does not advertise setting '${a.configId}'`);
      }
      if (changesModel) c.usage = null;
      emitStatus(ctx, c);
      return publicState(c);
    },
    async stop(ctx, a) {
      const c = conns.get(a.conversationId);
      if (!c) return null;
      c.stopping = true;
      await ctx.host.process.closeStdin(c.proc).catch(() => {});
      await ctx.host.process.terminate(c.proc).catch(() => {});
      c.status = "exited";
      emitStatus(ctx, c);
      conns.delete(a.conversationId);
      await ctx.modules.call("internal-mcp", "revoke", { conversationId: a.conversationId }).catch(() => {});
      return null;
    },
    list: () => Array.from(conns.values()).map(publicState),

    /** Latest plan usage limits, refreshed through a hidden ACP session when older than `maxAgeMs`
     *  (default 60 s) or when `force`. Concurrent refreshes share one probe. */
    async limits(ctx, a) {
      const provider: LimitProvider = a?.provider === "codex" ? "codex" : "claude";
      const cur = limits[provider];
      const maxAge = Number.isFinite(a?.maxAgeMs) ? Number(a.maxAgeMs) : 60000;
      if (!a?.workspaceId || (!a.force && cur && !cur.error && Date.now() - cur.updatedAt < maxAge)) return cur;
      let p = probes.get(provider);
      if (!p) {
        setLimits(ctx, provider, { ...(cur || { provider, windows: [], plan: null, updatedAt: 0, source: "probe", error: null }), loading: true });
        p = probeLimits(ctx, provider, String(a.workspaceId)).catch((e) => ({ ...(limits[provider] || { provider, windows: [], plan: null, source: "probe" as const }), updatedAt: Date.now(), error: errMsg(e) }));
        probes.set(provider, p);
        p.then((snap) => { probes.delete(provider); setLimits(ctx, provider, { ...snap, loading: false }); });
      }
      return p;
    },

    /** Installed/latest versions of the known adapters on the workspace's machine. */
    async adapters(ctx, a) {
      const desc: WorkspaceDescriptor = await ctx.modules.call("workspace", "resolve", { workspaceId: a.workspaceId });
      const npm = await npmRunner(ctx, desc);
      const out: any[] = [];
      for (const ad of ADAPTERS) {
        const row: any = { id: ad.id, name: ad.name, pkg: ad.pkg, bin: ad.bin, machineId: desc.machineId, installed: null, latest: null, path: null, error: null };
        try {
          if (!npm.ok) throw new Error(npm.error);
          const ls = await npm.run(["ls", "-g", "--depth=0", "--json", ad.pkg], 60000);
          try { row.installed = JSON.parse(ls.stdout || "{}").dependencies?.[ad.pkg]?.version || null; } catch { row.installed = null; }
          const view = await npm.run(["view", ad.pkg, "version"], 60000);
          row.latest = view.code === 0 ? view.stdout.trim().split("\n").pop() || null : null;
          if (view.code !== 0) row.error = `cannot reach npm registry: ${view.stderr.trim().split("\n").pop()}`;
          const d = await detect(ctx, desc, ad.bin);
          row.path = d.found ? d.path : null;
        } catch (e) { row.error = errMsg(e); }
        out.push(row);
      }
      return out;
    },

    /** Install/update one known adapter with `npm install -g <pkg>@latest` on the workspace machine.
     *  Only accepted from ai-sessions, which obtains the user's approval first. */
    async installAdapter(ctx, a, meta) {
      if (meta.caller !== "ai-sessions") throw new Error("adapter installation must be requested through ai-sessions (approval required)");
      const ad = ADAPTERS.find((x) => x.id === a.adapterId);
      if (!ad) throw new Error(`unknown adapter ${a.adapterId}`);
      const desc: WorkspaceDescriptor = await ctx.modules.call("workspace", "resolve", { workspaceId: a.workspaceId });
      const npm = await npmRunner(ctx, desc);
      if (!npm.ok) throw new Error(npm.error);
      const r = await npm.run(["install", "-g", `${ad.pkg}@latest`], 15 * 60 * 1000);
      const tail = (r.stderr + "\n" + r.stdout).trim().split("\n").slice(-12).join("\n");
      ctx.events.emit("acp.adaptersChanged", { machineId: desc.machineId, adapterId: ad.id });
      if (r.code !== 0) throw new Error(`npm install -g ${ad.pkg}@latest failed on ${desc.machineId} (exit ${r.code}):\n${tail}`);
      return { ok: true, adapterId: ad.id, machineId: desc.machineId, output: tail };
    },
  },
};
export default mod;
