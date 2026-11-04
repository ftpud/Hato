// Per-session MCP endpoint hosted by the workflow runtime on the daemon. Each workflow agent
// session gets a token bound to its run and block (or, for the configurator, to its project);
// the token is the only authority: tool arguments never widen the scope.
import type { ModuleContext, Handle } from "../../../../sdk/types";
import { JsonRpcPeer, errMsg, rpcError } from "../../../../sdk/runtime";

export type Scope =
  | { kind: "run"; token: string; runId: string; blockId: string }
  | { kind: "config"; token: string; projectId: string; sessionId: string; profiles: { id: string; provider?: string }[]; mcps: { id: string }[] };

let db: Handle;
let listener: { handle: string; port: number } | null = null;
const scopes = new Map<string, Scope>();
const connections = new Map<string, { token: string | null; buffer: string; peer: JsonRpcPeer | null }>();
// The port is read from a file at connect time, so sessions reconnected after a daemon restart
// reach the new listener; HATO_MCP_PORT is the fallback.
const proxy = `const net=require('node:net'),fs=require('node:fs');let p=process.env.HATO_MCP_PORT;try{p=fs.readFileSync(process.env.HATO_MCP_PORT_FILE,'utf8').trim()||p}catch{}const s=net.connect({host:'127.0.0.1',port:Number(p)},()=>{s.write(JSON.stringify({token:process.env.HATO_MCP_TOKEN})+'\\n');process.stdin.pipe(s)});s.pipe(process.stdout);s.on('error',e=>{console.error(e.message);process.exit(1)});s.on('close',()=>process.exit(0));process.stdin.on('end',()=>s.end());`;

export interface ToolHandler { list(scope: Scope): any[]; call(scope: Scope, name: string, args: any): Promise<any> }
let handler: ToolHandler;
let portDir: string | null = null;
const PORT_FILE = "workflow-runner.port";

export async function initMcp(ctx: ModuleContext, database: Handle, h: ToolHandler) {
  db = database; handler = h;
  await ctx.host.db.exec(db, "CREATE TABLE IF NOT EXISTS scopes(token TEXT PRIMARY KEY, data TEXT NOT NULL)");
  for (const r of await ctx.host.db.query<any>(db, "SELECT data FROM scopes")) { const s: Scope = JSON.parse(r.data); scopes.set(s.token, s); }
  // The kernel's shared directory (not protected state) holds the port file.
  portDir = ctx.host.env.info().sharedDir || null;
  // Agent sessions restarted after a daemon restart reconnect through the port file.
  if (scopes.size && portDir) await listen(ctx).catch(e => ctx.log.warn("workflow MCP listener", errMsg(e)));
}

async function writePort(ctx: ModuleContext) {
  if (!portDir || !listener) return;
  portWritten = false;
  const g = await ctx.host.capabilities.request({ kind: "fs", root: portDir, target: { kind: "local" }, write: true });
  try { await ctx.host.fs.writeAtomic(g.grant, PORT_FILE, String(listener.port), { reason: "workflow MCP port" }); }
  finally { await ctx.host.capabilities.release(g.grant); }
  portWritten = true;
}
let portWritten = false;

async function listen(ctx: ModuleContext) {
  if (listener) return listener;
  listener = await ctx.host.net.listenLoopback(); let pending = "";
  await ctx.host.streams.listen(listener.handle, {}, chunk => {
    pending += chunk; let i;
    while ((i = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, i); pending = pending.slice(i + 1);
      try { const e = JSON.parse(line); if (e.connection) void connection(ctx, e.connection); } catch {}
    }
  });
  await writePort(ctx).catch(e => ctx.log.warn("workflow MCP port file", errMsg(e)));
  return listener;
}

async function connection(ctx: ModuleContext, handle: string) {
  const c = { token: null as string | null, buffer: "", peer: null as JsonRpcPeer | null }; connections.set(handle, c);
  await ctx.host.streams.listen(handle, {}, chunk => {
    if (c.peer) { c.peer.feed(chunk); return; }
    c.buffer += chunk; const i = c.buffer.indexOf("\n");
    if (i < 0) { if (c.buffer.length > 4096) void ctx.host.net.close(handle); return; }
    let token; try { token = JSON.parse(c.buffer.slice(0, i)).token; } catch {}
    if (typeof token !== "string" || !scopes.has(token)) { void ctx.host.net.close(handle); return; }
    c.token = token;
    c.peer = new JsonRpcPeer(line => ctx.host.net.write(handle, line + "\n"));
    c.peer.onRequest = async (method, params) => {
      const s = scopes.get(c.token!); if (!s) throw rpcError(-32001, "Workflow MCP access revoked");
      if (method === "initialize") return { protocolVersion: ["2024-11-05", "2025-03-26", "2025-06-18"].includes(params?.protocolVersion) ? params.protocolVersion : "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "hato-workflow", version: "0.1.0" } };
      if (method === "ping") return {};
      if (method === "tools/list") return { tools: handler.list(s) };
      if (method === "tools/call") {
        try { const value = await handler.call(s, String(params?.name || ""), params?.arguments || {}); return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }] }; }
        catch (e) { return { content: [{ type: "text", text: errMsg(e) }], isError: true }; }
      }
      throw rpcError(-32601, "Unknown MCP method");
    };
    const rest = c.buffer.slice(i + 1); c.buffer = ""; if (rest) c.peer.feed(rest);
  }, () => { connections.delete(handle); void ctx.host.net.close(handle).catch(() => {}); });
}

type NewScope = { kind: "run"; runId: string; blockId: string } | { kind: "config"; projectId: string; sessionId: string; profiles: { id: string; provider?: string }[]; mcps: { id: string }[] };
/** Issue an endpoint; returns an MCP server configuration for agent-runner session specs. */
export async function issueEndpoint(ctx: ModuleContext, scope: NewScope) {
  const token = crypto.randomUUID() + crypto.randomUUID();
  const s = { ...scope, token } as Scope;
  scopes.set(token, s); await ctx.host.db.exec(db, "INSERT INTO scopes(token,data) VALUES(?,?)", [token, JSON.stringify(s)]);
  const l = await listen(ctx);
  return { id: "hato-workflow", name: "hato-workflow", command: "node", args: ["-e", proxy], env: [{ name: "HATO_MCP_PORT", value: String(l.port) }, ...(portDir && portWritten ? [{ name: "HATO_MCP_PORT_FILE", value: `${portDir.replace(/\/$/, "")}/${PORT_FILE}` }] : []), { name: "HATO_MCP_TOKEN", value: token }] };
}

export async function revokeWhere(ctx: ModuleContext, match: (s: Scope) => boolean) {
  for (const [t, s] of [...scopes]) if (match(s)) {
    scopes.delete(t); await ctx.host.db.exec(db, "DELETE FROM scopes WHERE token=?", [t]);
    for (const [h, c] of connections) if (c.token === t) await ctx.host.net.close(h).catch(() => {});
  }
}
export const openConnections = () => connections.size;
