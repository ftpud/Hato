// internal-mcp: a real MCP server (newline-delimited JSON-RPC, the MCP stdio framing) implemented in
// TS. The kernel only provides a loopback listener, byte streams, SSH reverse forwarding and native
// approvals. Agents reach it through a tiny versioned stdio<->loopback proxy (deployed to remote
// hosts via SFTP with user consent). Every connection must authenticate with a session-scoped
// token bound to one conversation/workspace/machine. Tool logic delegates to `module-dev`, whose
// mutating operations are approved natively by the kernel (Autopilot cannot bypass that).
import type { AppModule, Handle, ModuleContext } from "../../../../sdk/types";
import { errMsg, JsonRpcPeer, rpcError, sshConnect, type WorkspaceDescriptor } from "../../../../sdk/runtime";
import skInspect from "../skills/inspect-module.md";
import skPatch from "../skills/patch-module.md";
import skBuild from "../skills/build-and-test-module.md";
import skActivate from "../skills/activate-and-verify.md";
import skRollback from "../skills/rollback-module.md";

const SERVER_VERSION = "1.0.0";
const PROXY_VERSION = "v1";
const SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const SKILLS: Record<string, string> = { "inspect-module": skInspect, "patch-module": skPatch, "build-and-test-module": skBuild, "activate-and-verify": skActivate, "rollback-module": skRollback };

export const PROXY_SOURCE = `#!/usr/bin/env node
// hato-mcp-proxy ${PROXY_VERSION}: forwards newline-delimited MCP JSON-RPC between stdio and a loopback
// socket. Contains no application logic. Env: HATO_MCP_PORT, HATO_MCP_TOKEN.
import net from "node:net";
const port = Number(process.env.HATO_MCP_PORT);
const token = process.env.HATO_MCP_TOKEN || "";
if (!port || !token) { process.stderr.write("hato-mcp-proxy: HATO_MCP_PORT/HATO_MCP_TOKEN missing\\n"); process.exit(2); }
const s = net.connect({ host: "127.0.0.1", port }, () => {
  s.write(JSON.stringify({ hatoAuth: token }) + "\\n");
  process.stdin.pipe(s);
});
s.pipe(process.stdout);
s.on("error", (e) => { process.stderr.write("hato-mcp-proxy: " + e.message + "\\n"); process.exit(1); });
s.on("close", () => process.exit(0));
process.stdin.on("end", () => s.end());
`;

interface TokenInfo { conversationId: string; workspaceId: string; machineId: string; created: number }
interface McpConn { handle: Handle; token: string | null; buf: string; peer: JsonRpcPeer | null; inflight: number; client: any }

let listener: { handle: Handle; port: number } | null = null;
const tokens = new Map<string, TokenInfo>();
const connsByHandle = new Map<Handle, McpConn>();
const forwards = new Map<string, { handle: Handle; remotePort: number; proxyPath: string }>();
let localProxyPath: string | null = null;
let stats = { connections: 0, toolCalls: 0, authFailures: 0 };

const TOOLS = [
  { name: "modules_list", title: "modules.list", description: "List Hato application modules with active/staged generations, versions and health.", inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: "modules_describe", title: "modules.describe", description: "Describe one module: static manifest, capabilities, dependencies, source dir, diagnostics, last build.", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] }, annotations: { readOnlyHint: true } },
  { name: "modules_read_source", title: "modules.read_source", description: "Read allowlisted module source. Without `path` lists files; with `path` (module-relative, e.g. src/index.ts) returns its text.", inputSchema: { type: "object", properties: { id: { type: "string" }, path: { type: "string" } }, required: ["id"] }, annotations: { readOnlyHint: true } },
  { name: "modules_apply_patch", title: "modules.apply_patch", description: "Apply a change to a module's source (unified diff in `patch`, or `edits` [{path, oldText, newText}], or `path`+`content`). Requires explicit native user approval of the exact diff; a backup is kept.", inputSchema: { type: "object", properties: { id: { type: "string" }, patch: { type: "string" }, edits: { type: "array", items: { type: "object", properties: { path: { type: "string" }, oldText: { type: "string" }, newText: { type: "string" } }, required: ["path", "oldText", "newText"] } }, path: { type: "string" }, content: { type: "string" }, reason: { type: "string" } }, required: ["id"] }, annotations: { destructiveHint: true } },
  { name: "modules_build", title: "modules.build", description: "Build a module with esbuild into a new versioned artifact and stage it (isolated evaluation, not active). Returns compiler diagnostics on failure. Requires native approval.", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  { name: "modules_activate", title: "modules.activate", description: "Hot-swap the staged build of a module (fence, snapshot, activate, health check, cutover). Previous version kept for rollback. Requires native approval.", inputSchema: { type: "object", properties: { id: { type: "string" }, stageId: { type: "string" } }, required: ["id"] } },
  { name: "modules_rollback", title: "modules.rollback", description: "Switch a module back to its previous healthy version (or `toVersion`). Requires native approval.", inputSchema: { type: "object", properties: { id: { type: "string" }, toVersion: { type: "integer" } }, required: ["id"] } },
  { name: "modules_logs", title: "modules.logs", description: "Bounded, redacted logs for one module.", inputSchema: { type: "object", properties: { id: { type: "string" }, limit: { type: "integer" } }, required: ["id"] }, annotations: { readOnlyHint: true } },
  { name: "skills_get", title: "skills.get", description: `Return a Hato skill guide (Markdown). Available: ${Object.keys(SKILLS).join(", ")}.`, inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] }, annotations: { readOnlyHint: true } },
];

async function callTool(ctx: ModuleContext, conn: McpConn, name: string, args: any) {
  const info = tokens.get(conn.token!);
  ctx.log.info(`tool ${name} from conversation ${info?.conversationId} (${info?.machineId})`);
  stats.toolCalls++;
  const md = (m: string, a: any) => ctx.modules.call("module-dev", m, a, { timeoutMs: 30 * 60 * 1000 });
  const id = args && args.id !== undefined ? String(args.id) : undefined;
  switch (name) {
    case "modules_list": {
      const all: any[] = await md("list", {});
      return all.map((m) => ({ id: m.id, kind: m.kind, active: m.active ? m.active.label : null, previous: m.previous, lastError: m.lastError, versions: m.versions.map((v: any) => `${v.version}:${v.status}`) }));
    }
    case "modules_describe": return md("describe", { id });
    case "modules_read_source": return md("readSource", { id, path: args.path });
    case "modules_apply_patch": return md("applyPatch", { id, patch: args.patch, edits: args.edits, path: args.path, content: args.content, reason: args.reason || `requested by agent in conversation ${info?.conversationId}` });
    case "modules_build": return md("build", { id });
    case "modules_activate": return md("activate", { id, stageId: args.stageId });
    case "modules_rollback": return md("rollback", { id, toVersion: args.toVersion });
    case "modules_logs": return md("logs", { id, limit: args.limit || 100 });
    case "skills_get": {
      const s = SKILLS[String(args.name)];
      if (!s) throw new Error(`unknown skill ${args.name}`);
      return s;
    }
    default: throw rpcError(-32602, `unknown tool ${name}`);
  }
}

function makePeer(ctx: ModuleContext, conn: McpConn) {
  const peer = new JsonRpcPeer((line) => ctx.host.net.write(conn.handle, line + "\n"));
  peer.onRequest = async (method, params) => {
    switch (method) {
      case "initialize": {
        conn.client = params && params.clientInfo;
        const v = params && SUPPORTED_PROTOCOLS.includes(params.protocolVersion) ? params.protocolVersion : SUPPORTED_PROTOCOLS[0];
        return {
          protocolVersion: v,
          capabilities: { tools: { listChanged: false }, prompts: { listChanged: false }, resources: { listChanged: false } },
          serverInfo: { name: "hato-internal", title: "Hato internal modules", version: SERVER_VERSION },
          instructions: "Tools to inspect and evolve Hato's hot-swappable TypeScript modules. Read the skills (skills_get or prompts) first. Mutating tools require explicit native approval by the user.",
        };
      }
      case "ping": return {};
      case "tools/list": return { tools: TOOLS };
      case "tools/call": {
        conn.inflight++;
        try {
          const r = await callTool(ctx, conn, params.name, params.arguments || {});
          return { content: [{ type: "text", text: typeof r === "string" ? r : JSON.stringify(r, null, 2) }], structuredContent: typeof r === "object" && r !== null && !Array.isArray(r) ? r : undefined, isError: !!(r && typeof r === "object" && (r as any).ok === false) };
        } catch (e: any) {
          if (e && e.rpcCode) throw e;
          return { content: [{ type: "text", text: `Error${e && e.code ? " " + e.code : ""}: ${errMsg(e)}` }], isError: true };
        } finally { conn.inflight--; }
      }
      case "prompts/list": return { prompts: Object.keys(SKILLS).map((n) => ({ name: n, description: (/description: (.*)/.exec(SKILLS[n]) || [])[1] || n })) };
      case "prompts/get": {
        const s = SKILLS[params && params.name];
        if (!s) throw rpcError(-32602, "unknown prompt");
        return { description: params.name, messages: [{ role: "user", content: { type: "text", text: s } }] };
      }
      case "resources/list": return { resources: Object.keys(SKILLS).map((n) => ({ uri: `hato://skills/${n}`, name: n, mimeType: "text/markdown" })) };
      case "resources/read": {
        const n = String(params && params.uri || "").replace("hato://skills/", "");
        if (!SKILLS[n]) throw rpcError(-32602, "unknown resource");
        return { contents: [{ uri: params.uri, mimeType: "text/markdown", text: SKILLS[n] }] };
      }
      default: throw rpcError(-32601, `method not found: ${method}`);
    }
  };
  peer.onNotification = () => {};
  return peer;
}

async function onConnection(ctx: ModuleContext, handle: Handle, restored?: Partial<McpConn>) {
  const conn: McpConn = { handle, token: null, buf: "", peer: null, inflight: 0, client: null, ...(restored || {}) } as McpConn;
  connsByHandle.set(handle, conn);
  if (conn.token) conn.peer = makePeer(ctx, conn);
  stats.connections++;
  await ctx.host.streams.listen(handle, { encoding: "utf8" }, (chunk) => {
    if (conn.peer) { conn.peer.feed(chunk); return; }
    conn.buf += chunk;
    const i = conn.buf.indexOf("\n");
    if (i < 0) { if (conn.buf.length > 4096) ctx.host.net.close(handle).catch(() => {}); return; }
    const first = conn.buf.slice(0, i);
    const rest = conn.buf.slice(i + 1);
    conn.buf = "";
    let tok: string | null = null;
    try { tok = JSON.parse(first).hatoAuth; } catch { tok = null; }
    if (!tok || !tokens.has(tok)) {
      stats.authFailures++;
      ctx.log.warn("rejected unauthenticated MCP connection");
      ctx.host.net.write(handle, JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "unauthorized" } }) + "\n").finally(() => ctx.host.net.close(handle).catch(() => {}));
      return;
    }
    conn.token = tok;
    conn.peer = makePeer(ctx, conn);
    if (rest) conn.peer.feed(rest);
  }, () => { connsByHandle.delete(handle); ctx.host.net.close(handle).catch(() => {}); });
}

async function ensureListener(ctx: ModuleContext) {
  if (listener) return listener;
  listener = await ctx.host.net.listenLoopback();
  await listenAccepts(ctx);
  return listener;
}

async function listenAccepts(ctx: ModuleContext) {
  let pending = "";
  await ctx.host.streams.listen(listener!.handle, { encoding: "utf8" }, (chunk) => {
    pending += chunk;
    let i: number;
    while ((i = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, i); pending = pending.slice(i + 1);
      try { const ev = JSON.parse(line); if (ev.connection) onConnection(ctx, ev.connection); } catch (e) { ctx.log.warn("bad accept event", errMsg(e)); }
    }
  });
}

async function deployLocalProxy(ctx: ModuleContext) {
  if (localProxyPath) return localProxyPath;
  const shared = ctx.host.env.info().sharedDir;
  const g = await ctx.host.capabilities.request({ kind: "fs", root: shared, write: true });
  await ctx.host.fs.mkdir(g.grant, "mcp-proxy");
  const rel = `mcp-proxy/hato-mcp-proxy-${PROXY_VERSION}.mjs`;
  const w = await ctx.host.fs.writeAtomic(g.grant, rel, PROXY_SOURCE, { mode: 0o755 });
  localProxyPath = w.path;
  return localProxyPath;
}

/** Remote: deploy the proxy via SFTP (native consent for the write grant) and open a loopback-only reverse forward. */
async function remoteBridge(ctx: ModuleContext, desc: WorkspaceDescriptor) {
  const existing = forwards.get(desc.machineId);
  if (existing) return existing;
  const c = await sshConnect(ctx, desc);
  if (!c.home) throw new Error("cannot determine remote home directory for proxy deployment");
  const dir = `${c.home.replace(/\/+$/, "")}/.local/state/hato/bin`;
  // Create the directory path under the remote home with a home-scoped grant (approved natively).
  const g = await ctx.host.capabilities.request({ kind: "fs", root: c.home, write: true, target: { kind: "ssh", connection: c.connection, machineId: c.machineId }, purpose: `Deploy the Hato MCP stdio proxy (${PROXY_VERSION}, forwards bytes only) to ${dir}` });
  await ctx.host.fs.mkdir(g.grant, ".local/state/hato/bin");
  const rel = `.local/state/hato/bin/hato-mcp-proxy-${PROXY_VERSION}.mjs`;
  let needWrite = true;
  try { const cur = await ctx.host.fs.read(g.grant, rel, 64 * 1024); needWrite = cur.text !== PROXY_SOURCE; } catch { needWrite = true; }
  if (needWrite) await ctx.host.fs.writeAtomic(g.grant, rel, PROXY_SOURCE, { mode: 0o755 });
  await ctx.host.capabilities.release(g.grant).catch(() => {});
  const l = await ensureListener(ctx);
  const f = await ctx.host.ssh.forwardLoopback(c.connection, { listener: l.handle });
  const entry = { handle: f.handle, remotePort: f.remotePort, proxyPath: `${dir}/hato-mcp-proxy-${PROXY_VERSION}.mjs` };
  forwards.set(desc.machineId, entry);
  return entry;
}

const mod: AppModule = {
  id: "internal-mcp",
  moduleApiVersion: 1,
  async activate(ctx, prev) {
    if (prev && prev.listener) {
      listener = prev.listener;
      for (const [k, v] of prev.tokens || []) tokens.set(k, v);
      for (const [k, v] of prev.forwards || []) forwards.set(k, v);
      localProxyPath = prev.localProxyPath || null;
      stats = prev.stats || stats;
      await listenAccepts(ctx);
      for (const c of prev.conns || []) await onConnection(ctx, c.handle, { token: c.token, client: c.client });
      ctx.log.info(`internal MCP re-attached: port ${listener!.port}, ${tokens.size} token(s), ${(prev.conns || []).length} connection(s)`);
    } else {
      await ensureListener(ctx);
      ctx.log.info(`internal MCP listening on 127.0.0.1:${listener!.port} (token-authenticated)`);
    }
  },
  canSwap() {
    for (const c of connsByHandle.values()) if (c.inflight > 0) return { ok: false, reason: "an MCP tool call is in flight" };
    return { ok: true };
  },
  snapshot: () => ({ listener, tokens: Array.from(tokens.entries()), forwards: Array.from(forwards.entries()), localProxyPath, stats, conns: Array.from(connsByHandle.values()).filter((c) => c.token).map((c) => ({ handle: c.handle, token: c.token, client: c.client })) }),
  methods: {
    /** MCP server config (ACP `mcpServers` stdio entry) for one conversation on its workspace machine. */
    async endpoint(ctx, a) {
      const desc: WorkspaceDescriptor = await ctx.modules.call("workspace", "resolve", { workspaceId: a.workspaceId });
      for (const [t, info] of tokens) if (info.conversationId === a.conversationId) tokens.delete(t);
      const token = crypto.randomHex(32);
      tokens.set(token, { conversationId: a.conversationId, workspaceId: desc.id, machineId: desc.machineId, created: Date.now() });
      const l = await ensureListener(ctx);
      if (desc.location === "local") {
        const proxy = await deployLocalProxy(ctx);
        return { transport: "local loopback", server: { name: "hato-internal", command: "node", args: [proxy], env: [{ name: "HATO_MCP_PORT", value: String(l.port) }, { name: "HATO_MCP_TOKEN", value: token }] } };
      }
      const f = await remoteBridge(ctx, desc);
      return { transport: `SSH reverse forward ${desc.machineId} 127.0.0.1:${f.remotePort} -> local 127.0.0.1:${l.port}`, server: { name: "hato-internal", command: "node", args: [f.proxyPath], env: [{ name: "HATO_MCP_PORT", value: String(f.remotePort) }, { name: "HATO_MCP_TOKEN", value: token }] } };
    },
    /** Revoke a conversation's token, close its connections, and drop unused forwards. */
    async revoke(ctx, a) {
      let machine: string | null = null;
      for (const [t, info] of tokens) if (info.conversationId === a.conversationId) { machine = info.machineId; tokens.delete(t); for (const c of connsByHandle.values()) if (c.token === t) ctx.host.net.close(c.handle).catch(() => {}); }
      if (machine && machine !== "local" && ![...tokens.values()].some((i) => i.machineId === machine)) {
        const f = forwards.get(machine);
        if (f) { await ctx.host.ssh.cancelForward(f.handle).catch(() => {}); forwards.delete(machine); }
      }
      return null;
    },
    status: () => ({ port: listener ? listener.port : null, tokens: tokens.size, connections: connsByHandle.size, forwards: Array.from(forwards.entries()).map(([m, f]) => ({ machineId: m, remotePort: f.remotePort })), stats, tools: TOOLS.map((t) => t.name), skills: Object.keys(SKILLS) }),
  },
};
export default mod;
