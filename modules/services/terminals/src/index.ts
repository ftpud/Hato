// terminals: maps (workspaceId, stableKey) to a kernel-owned PTY handle. Local workspaces get a
// local login shell in the root/worktree; SSH workspaces get an SSH PTY in the remote directory.
// PTY bytes and the emulator buffer live in the kernel; this module only decides which PTY
// belongs to which workspace, so a hot swap of this module never kills a shell.
import { exportMcpTools } from "../../../../sdk/mcp";
import { terminalTools } from "./tools";
import type { AppModule, ModuleContext } from "../../../../sdk/types";
import { errMsg, sshConnect, workspaceGrant, withWorkspace, type WorkspaceDescriptor } from "../../../../sdk/runtime";
import { exportSettings } from "../../../../sdk/settings";
import type { DaemonTarget } from "../../../../sdk/types";

// Persistence preferences: terminals held by `hato daemon` survive disconnects (remote) and app
// restarts (local). Failures fall back to an ordinary shell with a warning.
let keepRemote = true;
let keepLocal = false;
const ensured = new Map<string, Promise<unknown>>();
const daemonKey = (stable: string) => stable.replace(/[^A-Za-z0-9\-_.:@/]/g, "_");

async function daemonTarget(ctx: ModuleContext, d: WorkspaceDescriptor): Promise<DaemonTarget | null> {
  if (d.location === "ssh" ? !keepRemote : !keepLocal) return null;
  const target: DaemonTarget = d.location === "ssh" ? { kind: "ssh", connection: (await sshConnect(ctx, d)).connection } : { kind: "local" };
  let p = ensured.get(d.machineId);
  if (!p) {
    p = ctx.host.daemon.ensure(target);
    ensured.set(d.machineId, p);
  }
  try { await p; return target; }
  catch (e) {
    ensured.delete(d.machineId);
    ctx.host.ui.toast("warn", `Terminals on ${d.machineId} will not survive disconnects: ${errMsg(e)}`);
    return null;
  }
}

let commands: ReturnType<typeof terminalTools>;
let contribution: ReturnType<typeof exportMcpTools>;
const keyFor = (workspaceId: string, key: string) => `pty:${workspaceId}:${key || "main"}`;

async function attach(ctx: ModuleContext, a: any, forceNew = false) {
  const d: WorkspaceDescriptor = await ctx.modules.call("workspace", "resolve", { workspaceId: a.workspaceId });
  const stable = keyFor(d.id, a.key);
  commands?.remember(d.id, a.key || "main");
  const existing = await ctx.host.resources.lookup(stable);
  if (existing && !forceNew) {
    const info: any = await ctx.host.pty.info(existing);
    // An exited shell stays visible (with its exit status) until the user restarts it explicitly.
    return { pty: existing, machineId: info.machineId, cwd: info.cwd, exited: info.exit, reattached: true };
  }
  if (existing && forceNew) await ctx.host.pty.close(existing).catch(() => {});
  return withWorkspace(ctx, d, async () => {
    const g = await workspaceGrant(ctx, d, "pty");
    const target = await daemonTarget(ctx, d);
    // Restart means a fresh shell: drop the daemon-held one first.
    if (target && forceNew) await ctx.host.daemon.request(target, "pty.kill", { key: daemonKey(stable) }).catch(() => {});
    const r = await ctx.host.pty.open(g.grant, { cwd: d.rootAbsolutePath, columns: a.columns || 120, rows: a.rows || 30,
      ...(target ? { persist: { key: daemonKey(stable) } } : {}) });
    await ctx.host.resources.retainForWorkspace(r.handle, stable);
    ctx.events.emit("terminals.changed", { workspaceId: d.id });
    return { pty: r.handle, machineId: r.machineId, cwd: r.cwd, exited: null, reattached: false };
  });
}

const mod: AppModule = {
  id: "terminals",
  moduleApiVersion: 1,
  async activate(ctx, prev) {
    commands = terminalTools(ctx, prev?.known);
    contribution = exportMcpTools(ctx, "Terminal", commands.tools);
    const saved = await ctx.modules.call("persistence", "settings.get", { key: "terminals.persistence" }).catch(() => null);
    if (saved && typeof saved === "object") { keepRemote = saved.remote !== false; keepLocal = saved.local === true; }
    exportSettings(ctx, () => [{ key: "terminals", title: "Terminals", fields: [
      { key: "remote", label: "Keep SSH terminals running on the server", type: "toggle", value: keepRemote,
        description: "Shells run inside the Hato daemon on the remote machine and survive disconnects; reopening reattaches." },
      { key: "local", label: "Keep local terminals running after quitting", type: "toggle", value: keepLocal,
        description: "Shells run inside a local Hato daemon and are reattached at the next start." },
    ] }], async (_section, key, value) => {
      if ((key !== "remote" && key !== "local") || typeof value !== "boolean") throw new Error("Invalid terminal preference");
      const next = { remote: key === "remote" ? value : keepRemote, local: key === "local" ? value : keepLocal };
      await ctx.modules.call("persistence", "settings.set", { key: "terminals.persistence", value: next });
      keepRemote = next.remote; keepLocal = next.local;
    });
  },
  snapshot: () => ({ known: commands.snapshot() }),
  canSwap: async () => ({ ok: !commands.running() && !contribution.pending(), reason: "A terminal MCP command is in progress" }),
  methods: {
    async workspaceControl(ctx,a,meta) {
      if(meta.caller!=="internal-remote-mcp")throw new Error("Workspace terminal control requires the workspace MCP server");
      const tool=commands.tools.find(t=>t.name===a.tool);
      if(!tool)throw new Error("Unknown terminal tool");
      return tool.handler(a.args||{},a.scope);
    },
    attach: (ctx, a) => attach(ctx, a, false),
    restart: (ctx, a) => attach(ctx, a, true),
    async close(ctx, a) {
      const h = await ctx.host.resources.lookup(keyFor(a.workspaceId, a.key));
      if (h) await ctx.host.pty.close(h);
      // Closing a tab ends the shell, including a daemon-held one.
      try {
        const d: WorkspaceDescriptor = await ctx.modules.call("workspace", "resolve", { workspaceId: a.workspaceId });
        const target = await daemonTarget(ctx, d);
        if (target) await ctx.host.daemon.request(target, "pty.kill", { key: daemonKey(keyFor(d.id, a.key)) }).catch(() => {});
      } catch { /* workspace gone: nothing to clean up remotely */ }
      commands?.forget(a.workspaceId, a.key || "main");
      ctx.events.emit("terminals.changed", { workspaceId: a.workspaceId });
      return null;
    },
    async lookup(ctx, a) { return ctx.host.resources.lookup(keyFor(a.workspaceId, a.key)); },
    async info(ctx, a) {
      const h = await ctx.host.resources.lookup(keyFor(a.workspaceId, a.key));
      return h ? { pty: h, ...(await ctx.host.pty.info(h) as any) } : null;
    },
    async send(ctx, a) {
      const h = await ctx.host.resources.lookup(keyFor(a.workspaceId, a.key));
      if (!h) throw new Error("no terminal for this workspace");
      await ctx.host.pty.write(h, String(a.text));
      return null;
    },
  },
};
export default mod;
