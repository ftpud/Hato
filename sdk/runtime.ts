// Shared helpers bundled (statically, at build time) into modules. Not a live module: nothing
// here is imported at runtime from another module's generation.
import type { ExecutionTarget, Handle, ModuleContext, ScopeGrant } from "./types";

/** Workspace descriptor produced by the `workspace` service (the kernel never parses it). */
export interface WorkspaceDescriptor {
  id: string; // project:<uuid>:root | task:<uuid>
  projectId: string;
  taskId?: string | null;
  name: string;
  location: "local" | "ssh";
  machineId: string; // local | ssh:<profileId>
  rootAbsolutePath: string; // path ON that machine
  connectionRef?: string | null; // ssh profile id (no credentials)
  ssh?: { profileId: string; host: string; port: number; user: string; identityFile?: string | null } | null;
  isGit?: boolean;
  status?: string;
}

const grantCache = new Map<string, Promise<ScopeGrant>>();
const sshCache = new Map<string, Promise<{ connection: Handle; machineId: string; home: string | null }>>();

/** Connect (or reuse) the SSH master for a workspace's machine. Errors are surfaced, never masked. */
export function sshConnect(ctx: ModuleContext, desc: WorkspaceDescriptor) {
  if (desc.location !== "ssh" || !desc.ssh) throw new Error("not an SSH workspace");
  const key = desc.machineId;
  let p = sshCache.get(key);
  if (!p) {
    p = ctx.host.ssh.connect({ profileId: desc.ssh.profileId, host: desc.ssh.host, port: desc.ssh.port, user: desc.ssh.user, identityFile: desc.ssh.identityFile ?? null });
    sshCache.set(key, p);
    p.catch(() => sshCache.delete(key));
  }
  return p;
}

export function forgetSsh(machineId: string) {
  sshCache.delete(machineId);
  for (const k of Array.from(grantCache.keys())) if (k.includes("|" + machineId + "|")) grantCache.delete(k);
}

export async function targetFor(ctx: ModuleContext, desc: WorkspaceDescriptor): Promise<ExecutionTarget> {
  if (desc.location === "local") return { kind: "local" };
  const c = await sshConnect(ctx, desc);
  return { kind: "ssh", connection: c.connection, machineId: c.machineId };
}

/** Scoped grant for a workspace root on its own machine. Cached per module generation. */
export async function workspaceGrant(ctx: ModuleContext, desc: WorkspaceDescriptor, kind: "fs" | "process" | "pty", root?: string): Promise<ScopeGrant> {
  const r = root || desc.rootAbsolutePath;
  const key = kind + "|" + desc.machineId + "|" + r;
  let p = grantCache.get(key);
  if (!p) {
    p = (async () => {
      const target = await targetFor(ctx, desc);
      return ctx.host.capabilities.request({ kind, root: r, target });
    })();
    grantCache.set(key, p);
    p.catch(() => grantCache.delete(key));
  }
  try {
    return await p;
  } catch (e: any) {
    if (e && (e.code === "ENOTCONN" || e.code === "EBADF")) forgetSsh(desc.machineId);
    throw e;
  }
}

/** Retry once after reconnecting when an SSH operation fails because the master died. */
export async function withWorkspace<T>(ctx: ModuleContext, desc: WorkspaceDescriptor, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e: any) {
    if (desc.location === "ssh" && e && (e.code === "ENOTCONN" || e.code === "ESTALE" || e.code === "EBADF")) {
      forgetSsh(desc.machineId);
      return await fn();
    }
    throw e;
  }
}

export function debounce(fn: () => void, ms: number): () => void {
  let t: any = null;
  return () => {
    if (t !== null) return;
    t = setTimeout(() => { t = null; fn(); }, ms);
  };
}

/** Newline-delimited JSON-RPC 2.0 peer over an arbitrary byte transport. */
export class JsonRpcPeer {
  private buf = "";
  private nextId = 1;
  private pending = new Map<number | string, { resolve: (v: any) => void; reject: (e: any) => void; method: string }>();
  onRequest: (method: string, params: any, id: number | string) => Promise<any> = async (m) => { throw rpcError(-32601, "Method not found: " + m); };
  onNotification: (method: string, params: any) => void = () => {};
  onProtocolError: (err: string, line: string) => void = () => {};

  constructor(private send: (line: string) => Promise<void>, startId = 1) { this.nextId = startId; }

  get pendingCount() { return this.pending.size; }
  get nextRequestId() { return this.nextId; }
  get partial() { return this.buf; }
  restore(partial: string) { this.buf = partial; }

  feed(chunk: string) {
    this.buf += chunk;
    let i: number;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let msg: any;
      try { msg = JSON.parse(line); } catch (e) { this.onProtocolError("invalid JSON", line); continue; }
      this.handle(msg, line);
    }
  }

  private handle(msg: any, line: string) {
    if (msg && msg.method && msg.id !== undefined && msg.id !== null) {
      const id = msg.id;
      this.onRequest(msg.method, msg.params, id).then(
        (result) => this.send(JSON.stringify({ jsonrpc: "2.0", id, result: result === undefined ? null : result })),
        (err) => this.send(JSON.stringify({ jsonrpc: "2.0", id, error: { code: err && typeof err.rpcCode === "number" ? err.rpcCode : -32603, message: (err && err.message) || String(err), data: err && err.data } })),
      ).catch(() => {});
    } else if (msg && msg.method) {
      try { this.onNotification(msg.method, msg.params); } catch (e) { this.onProtocolError(String(e), line); }
    } else if (msg && (msg.result !== undefined || msg.error !== undefined) && msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) {
        const d = msg.error.data;
        const detail = d ? (typeof d === "string" ? d : typeof d.message === "string" ? d.message : JSON.stringify(d)) : "";
        const e: any = new Error((msg.error.message || "JSON-RPC error") + (detail && !String(msg.error.message).includes(detail) ? `: ${detail.slice(0, 600)}` : "")); e.rpcCode = msg.error.code; e.data = msg.error.data; p.reject(e); }
      else p.resolve(msg.result);
    } else {
      this.onProtocolError("unrecognized message", line);
    }
  }

  request<T = any>(method: string, params?: any): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.send(JSON.stringify({ jsonrpc: "2.0", id, method, params })).catch((e) => { this.pending.delete(id); reject(e); });
    });
  }

  notify(method: string, params?: any) { return this.send(JSON.stringify({ jsonrpc: "2.0", method, params })); }

  failAll(reason: string) {
    for (const [id, p] of this.pending) { const e: any = new Error(reason); e.code = "ECLOSED"; p.reject(e); this.pending.delete(id); }
  }
}

export function rpcError(code: number, message: string, data?: any) {
  const e: any = new Error(message);
  e.rpcCode = code;
  e.data = data;
  return e;
}

export function shortId(uuid: string) { return uuid.replace(/-/g, "").slice(0, 8); }

export function errMsg(e: any): string { return (e && (e.message || String(e))) || "unknown error"; }

export function langFromPath(p: string): string {
  const name = p.split("/").pop() || "";
  const lower = name.toLowerCase();
  if (lower === "makefile") return "make";
  if (lower === "dockerfile") return "bash";
  if (lower === "cmakelists.txt") return "cmake";
  const ext = lower.includes(".") ? lower.split(".").pop()! : "";
  const map: Record<string, string> = {
    ts: "typescript", mts: "typescript", cts: "typescript", tsx: "tsx", js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
    rs: "rust", py: "python", rb: "ruby", go: "go", java: "java", kt: "kotlin", swift: "swift", c: "c", h: "c", cc: "cpp", cpp: "cpp", hpp: "cpp",
    cs: "csharp", php: "php", json: "json", toml: "toml", yaml: "yaml", yml: "yaml", md: "markdown", html: "html", htm: "html", css: "css", scss: "css",
    sh: "bash", bash: "bash", zsh: "bash", sql: "sql", lua: "lua", zig: "zig", ex: "elixir", exs: "elixir", proto: "proto", graphql: "graphql", scala: "scala", svelte: "svelte",
  };
  return map[ext] || "text";
}
