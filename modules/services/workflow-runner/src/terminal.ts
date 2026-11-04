// Use the daemon's existing scoped PTY control operations. No terminal is created.
import type { ModuleContext } from "../../../../sdk/types";
import type { WorkflowRunEnv } from "../../../../sdk/workflows";
async function ctl(ctx: ModuleContext, env: WorkflowRunEnv, op: string, args: any = {}) {
  if (!env.daemon) throw new Error("Terminal Control requires the workspace daemon");
  const grant = await ctx.host.capabilities.request({ kind: "process", root: env.root });
  try {
    const r = await ctx.host.process.run(grant.grant, {
      executable: env.daemon.bin, args: ["daemon", "ctl", "--dir", env.daemon.dir], cwd: env.root,
    }, { stdin: JSON.stringify({ op, args }) + "\n", timeoutMs: 30000 });
    if (r.code !== 0) throw new Error(r.stderr || "Daemon control failed");
    const result = JSON.parse(r.stdout);
    if (!result.ok) throw new Error(result.error?.message || "Daemon request failed");
    return result.value;
  } finally { await ctx.host.capabilities.release(grant.grant); }
}
export async function terminalAction(ctx: ModuleContext, env: WorkflowRunEnv, action: string, a: any) {
  if (!["list", "read", "write"].includes(action)) throw new Error("Terminal Control actions: list, read, write");
  const list = await ctl(ctx, env, "resources.list");
  const root = env.root.replace(/\/$/, "");
  const allowed = (list.ptys || []).filter((p: any) => p.cwd === env.root || p.cwd.startsWith(root + "/"));
  if (action === "list") return allowed;
  if (!allowed.some((p: any) => p.key === a.key)) throw new Error("Terminal is outside this workspace");
  return ctl(ctx, env, action === "read" ? "pty.read" : "pty.write", {
    key: a.key, cursor: a.cursor, limitBytes: 65536, text: String(a.text ?? a.input ?? ""),
  });
}
