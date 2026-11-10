// remote-runtime: policy for the workspace machine's daemon. The kernel only installs/starts the
// daemon and moves requests; this module decides when to start it, which plugins run there
// (manifest `runsOn: "workspace"`, pushed automatically when enabled), and exposes status and
// controls to UI plugins. Changes here hot reload like any module.
import type { AppModule, DaemonTarget, ModuleContext, PluginInfo } from "../../../../sdk/types";
import { errMsg, sshConnect, type WorkspaceDescriptor } from "../../../../sdk/runtime";
import { syncScope } from "../../../../sdk/scoped-settings";
import { exportSettings } from "../../../../sdk/settings";

let autoStart = true;
let autoPush = true;
const lastError = new Map<string, string>();
const connected = new Map<string, DaemonTarget>();
const syncing = new Map<string, Promise<any>>();
function sync(ctx: ModuleContext, machineId: string, target: DaemonTarget) {
  const previous = syncing.get(machineId) || Promise.resolve();
  const next = previous.catch(() => {}).then(async () => {
    const result = await syncScope(`machine:${machineId}`,
      (method, args) => ctx.modules.call("persistence", method, args),
      (method, args) => ctx.host.daemon.request(target, "modules.call", { target: "persistence", method, args }));
    if (result.conflicts.length) {
      const message = `Settings conflicts (desktop retained): ${result.conflicts.join(", ")}`;
      lastError.set(machineId, message);
      ctx.log.warn(message);
    }
    return result;
  });
  syncing.set(machineId, next);
  void next.finally(() => { if (syncing.get(machineId) === next) syncing.delete(machineId); }).catch(() => {});
  return next;
}

async function resolve(ctx: ModuleContext, workspaceId: string): Promise<{ d: WorkspaceDescriptor; target: DaemonTarget }> {
  const d: WorkspaceDescriptor = await ctx.modules.call("workspace", "resolve", { workspaceId });
  const target: DaemonTarget = d.location === "ssh" ? { kind: "ssh", connection: (await sshConnect(ctx, d)).connection } : { kind: "local" };
  return { d, target };
}

/** Locally enabled service plugins meant for the workspace machine. */
async function workspacePlugins(ctx: ModuleContext): Promise<PluginInfo[]> {
  const { plugins } = await ctx.host.plugins.list();
  return plugins.filter((p) => p.enabled && p.kind === "service" && p.runsOn === "workspace");
}

async function ensure(ctx: ModuleContext, workspaceId: string) {
  const { d, target } = await resolve(ctx, workspaceId);
  try {
    const status = await ctx.host.daemon.ensure(target);
    lastError.delete(d.machineId);
    if (d.location === "ssh") {
      await ctx.host.daemon.request(target, "plugins.push", { id: "persistence" });
      await sync(ctx, d.machineId, target);
      connected.set(d.machineId, target);
    }
    const pushed: string[] = [];
    if (autoPush) for (const p of await workspacePlugins(ctx)) {
      try { await ctx.host.daemon.request(target, "plugins.push", { id: p.id }); pushed.push(p.id); }
      catch (e) { lastError.set(d.machineId, `${p.id}: ${errMsg(e)}`); }
    }
    ctx.events.emit("remote-runtime.changed", { machineId: d.machineId });
    return { machineId: d.machineId, status, pushed };
  } catch (e) {
    lastError.set(d.machineId, errMsg(e));
    ctx.events.emit("remote-runtime.changed", { machineId: d.machineId });
    throw e;
  }
}

const mod: AppModule = {
  id: "remote-runtime",
  moduleApiVersion: 1,
  async activate(ctx) {
    const saved = await ctx.modules.call("persistence", "settings.get", { key: "remote-runtime.prefs" }).catch(() => null);
    if (saved && typeof saved === "object") { autoStart = saved.autoStart !== false; autoPush = saved.autoPush !== false; }
    exportSettings(ctx, () => [{ key: "remote", title: "Remote runtime", fields: [
      { key: "autoStart", label: "Start the Hato daemon when an SSH workspace is selected", type: "toggle", value: autoStart,
        description: "Installs a small copy of Hato on the server (in ~/.hato) so terminals and plugins keep running while you are offline." },
      { key: "autoPush", label: "Run workspace plugins on the server", type: "toggle", value: autoPush,
        description: "Enabled plugins whose manifest says runsOn: \"workspace\" are copied to the server's daemon with the permissions you approved." },
    ] }], async (_s, key, value) => {
      if ((key !== "autoStart" && key !== "autoPush") || typeof value !== "boolean") throw new Error("Invalid preference");
      const next = { autoStart: key === "autoStart" ? value : autoStart, autoPush: key === "autoPush" ? value : autoPush };
      await ctx.modules.call("persistence", "settings.set", { key: "remote-runtime.prefs", value: next });
      autoStart = next.autoStart; autoPush = next.autoPush;
    });
    // `workspace.selected` also changes with view state (open tabs, preview path). Ensuring costs
    // several SSH round trips, so it runs once per workspace selection; a failure retries next time.
    let ensuredFor: string | null = null;
    ctx.state.watch("workspace.selected", (ws: any) => {
      const id = autoStart && ws?.location === "ssh" && ws.id ? String(ws.id) : null;
      if (id === ensuredFor) return;
      ensuredFor = id;
      if (id) ensure(ctx, id).catch((e) => { if (ensuredFor === id) ensuredFor = null; ctx.log.warn("daemon", errMsg(e)); });
    });
    ctx.events.on("persistence.settingChanged", (event: any) => {
      if (!event?.scope?.startsWith("machine:")) return;
      const machineId = event.scope.slice(8), target = connected.get(machineId);
      if (target) sync(ctx, machineId, target).catch(e => {
        lastError.set(machineId, errMsg(e));
        ctx.events.emit("remote-runtime.changed", { machineId });
      });
    });
    // Terminals opened or closed change what the daemon holds.
    // The daemon creates the shell once the remote attach starts, shortly after the local viewer.
    ctx.events.on("terminals.changed", () => {
      ctx.events.emit("remote-runtime.changed", {});
      setTimeout(() => ctx.events.emit("remote-runtime.changed", {}), 1500);
    });
    // Newly enabled workspace plugins go to the current workspace machine right away.
    ctx.events.on("kernel.modules.changed", () => {
      const ws: any = ctx.state.get("workspace.selected");
      if (autoPush && ws?.location === "ssh" && ws.id) resolve(ctx, ws.id).then(async ({ target }) => {
        if (!(await ctx.host.daemon.status(target))) return;
        for (const p of await workspacePlugins(ctx)) await ctx.host.daemon.request(target, "plugins.push", { id: p.id }).catch(() => {});
      }).catch(() => {});
    });
  },
  methods: {
    async sync(ctx, a) {
      const { d, target } = await resolve(ctx, String(a.workspaceId));
      return sync(ctx, d.machineId, target);
    },
    ensure: (ctx, a) => ensure(ctx, String(a.workspaceId)),
    async status(ctx, a) {
      const { d, target } = await resolve(ctx, String(a.workspaceId));
      const daemon = await ctx.host.daemon.status(target);
      const base = { machineId: d.machineId, location: d.location, error: lastError.get(d.machineId) || null, candidates: (await workspacePlugins(ctx)).map((p) => p.id) };
      if (!daemon) return { ...base, running: false };
      try {
        const hello = await ctx.host.daemon.request(target, "hello");
        return { ...base, running: true, version: hello.version, pid: hello.pid, stale: !!daemon.status?.stale, resources: hello.resources, plugins: hello.plugins };
      } catch (e) {
        return { ...base, running: false, error: errMsg(e) };
      }
    },
    async kill(ctx, a) {
      const { target } = await resolve(ctx, String(a.workspaceId));
      await ctx.host.daemon.request(target, a.kind === "proc" ? "proc.kill" : "pty.kill", { key: String(a.key) });
      ctx.events.emit("remote-runtime.changed", {});
      return null;
    },
    async push(ctx, a) {
      const { target } = await resolve(ctx, String(a.workspaceId));
      const r = await ctx.host.daemon.request(target, "plugins.push", { id: String(a.id) });
      ctx.events.emit("remote-runtime.changed", {});
      return r;
    },
    async disable(ctx, a) {
      const { target } = await resolve(ctx, String(a.workspaceId));
      const r = await ctx.host.daemon.request(target, "plugins.disable", { id: String(a.id) });
      ctx.events.emit("remote-runtime.changed", {});
      return r;
    },
  },
};
export default mod;
