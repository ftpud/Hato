// terminals: maps (workspaceId, stableKey) to a kernel-owned PTY handle. Local workspaces get a
// local login shell in the root/worktree; SSH workspaces get an SSH PTY in the remote directory.
// PTY bytes and the emulator buffer live in the kernel; this module only decides which PTY
// belongs to which workspace, so a hot swap of this module never kills a shell.
import type { AppModule, ModuleContext } from "../../../../sdk/types";
import { workspaceGrant, withWorkspace, type WorkspaceDescriptor } from "../../../../sdk/runtime";

const keyFor = (workspaceId: string, key: string) => `pty:${workspaceId}:${key || "main"}`;

async function attach(ctx: ModuleContext, a: any, forceNew = false) {
  const d: WorkspaceDescriptor = await ctx.modules.call("workspace", "resolve", { workspaceId: a.workspaceId });
  const stable = keyFor(d.id, a.key);
  const existing = await ctx.host.resources.lookup(stable);
  if (existing && !forceNew) {
    const info: any = await ctx.host.pty.info(existing);
    // An exited shell stays visible (with its exit status) until the user restarts it explicitly.
    return { pty: existing, machineId: info.machineId, cwd: info.cwd, exited: info.exit, reattached: true };
  }
  if (existing && forceNew) await ctx.host.pty.close(existing).catch(() => {});
  return withWorkspace(ctx, d, async () => {
    const g = await workspaceGrant(ctx, d, "pty");
    const r = await ctx.host.pty.open(g.grant, { cwd: d.rootAbsolutePath, columns: a.columns || 120, rows: a.rows || 30 });
    await ctx.host.resources.retainForWorkspace(r.handle, stable);
    ctx.events.emit("terminals.changed", { workspaceId: d.id });
    return { pty: r.handle, machineId: r.machineId, cwd: r.cwd, exited: null, reattached: false };
  });
}

const mod: AppModule = {
  id: "terminals",
  moduleApiVersion: 1,
  methods: {
    attach: (ctx, a) => attach(ctx, a, false),
    restart: (ctx, a) => attach(ctx, a, true),
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
