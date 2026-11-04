// Script blocks and named Run App processes on the daemon machine.
import type { ModuleContext, Handle } from "../../../../sdk/types";
import { errMsg } from "../../../../sdk/runtime";

const shell = (ctx: ModuleContext) => ctx.host.env.info().platform === "macos" ? "/bin/zsh" : "/bin/sh";

export interface ScriptResult { code: number | null; stdout: string; stderr: string }

/** Run `command` through a login shell in `root`. The input arrives on stdin and in $HATO_WORKFLOW_INPUT. */
export async function runScript(ctx: ModuleContext, root: string, command: string, input: string, opts: { timeoutMs: number; track: (h: Handle | null) => void }): Promise<ScriptResult> {
  const grant = await ctx.host.capabilities.request({ kind: "process", root, target: { kind: "local" } });
  let handle: Handle;
  try {
    const env = { HATO_WORKFLOW_INPUT: input, HATOPAD_WORKFLOW_INPUT: input, TERM: "dumb" };
    handle = (await ctx.host.process.spawn(grant.grant, { target: { kind: "local" }, executable: shell(ctx), args: ["-lc", command], cwd: root, env })).handle;
  } finally { await ctx.host.capabilities.release(grant.grant); }
  opts.track(handle);
  let stdout = "", stderr = "";
  const subs = [
    await ctx.host.streams.listen(handle, { channel: "stdout" }, c => { stdout = (stdout + c).slice(-400_000); }),
    await ctx.host.streams.listen(handle, { channel: "stderr" }, c => { stderr = (stderr + c).slice(-40_000); }),
  ];
  const timer = setTimeout(() => { stderr += `\nScript timed out after ${Math.round(opts.timeoutMs / 1000)} s`; void ctx.host.process.terminate(handle, "SIGKILL").catch(() => {}); }, opts.timeoutMs);
  try {
    await ctx.host.process.write(handle, input).catch(() => {});
    await ctx.host.process.closeStdin(handle).catch(() => {});
    const exit = await ctx.host.process.wait(handle);
    // Let the final stream chunks arrive before reading the buffers.
    await new Promise(r => setTimeout(r, 50));
    return { code: exit?.code ?? null, stdout, stderr };
  } finally {
    clearTimeout(timer); opts.track(null);
    for (const s of subs) await s.close().catch(() => {});
    await ctx.host.resources.release(handle).catch(() => {});
  }
}

interface App { name: string; root: string; command: string; handle: Handle | null; pid?: number; status: "starting" | "running" | "exited"; exitCode?: number | null; output: string; startedAt: string }
const apps = new Map<string, App>();
const key = (root: string, name: string) => `${root}\u0000${name}`;
const APP_BUFFER = 512 * 1024;

export const runningApps = () => [...apps.values()].filter(a => a.status !== "exited").length;
export const listApps = (root: string) => [...apps.values()].filter(a => a.root === root).map(a => appState(a));
function appState(a: App | undefined, name = "", lines = 0) {
  if (!a) return { name, status: "not_found", output: "" };
  const out = lines > 0 ? a.output.split("\n").slice(-Math.min(lines, 10_000) - 1).join("\n") : undefined;
  return { name: a.name, status: a.status, pid: a.pid, exitCode: a.exitCode, startedAt: a.startedAt, command: a.command, ...(out !== undefined ? { output: out } : {}) };
}

export async function appAction(ctx: ModuleContext, root: string, name: string, command: string, action: string, lines = 100) {
  const k = key(root, name), current = apps.get(k);
  if (action === "status") return appState(current, name);
  if (action === "tail") return appState(current, name, lines);
  if (action === "kill") {
    if (!current || current.status === "exited" || !current.handle) return appState(current, name);
    const h = current.handle;
    await ctx.host.process.terminate(h, "SIGTERM").catch(() => {});
    setTimeout(() => { if (current.status !== "exited") void ctx.host.process.terminate(h, "SIGKILL").catch(() => {}); }, 3000);
    for (let i = 0; i < 40 && (current.status as string) !== "exited"; i++) await new Promise(r => setTimeout(r, 100));
    return appState(current, name);
  }
  if (action !== "start") throw new Error(`Unknown Run App action '${action}'`);
  if (current && current.status !== "exited") return { ...appState(current, name), note: "Already running" };
  const app: App = { name, root, command, handle: null, status: "starting", output: "", startedAt: new Date().toISOString() };
  apps.set(k, app);
  const grant = await ctx.host.capabilities.request({ kind: "process", root, target: { kind: "local" } });
  try {
    const spawned = await ctx.host.process.spawn(grant.grant, { target: { kind: "local" }, executable: shell(ctx), args: ["-lc", command], cwd: root, env: { TERM: "dumb" } });
    app.handle = spawned.handle; app.pid = spawned.pid; app.status = "running";
  } catch (e) { app.status = "exited"; app.output = errMsg(e); throw e; }
  finally { await ctx.host.capabilities.release(grant.grant); }
  const append = (c: string) => { app.output = (app.output + c).slice(-APP_BUFFER); };
  const h = app.handle!;
  await ctx.host.streams.listen(h, { channel: "stdout" }, append);
  await ctx.host.streams.listen(h, { channel: "stderr" }, append);
  void ctx.host.process.wait(h).then(exit => { app.status = "exited"; app.exitCode = exit?.code ?? null; void ctx.host.resources.release(h).catch(() => {}); })
    .catch(() => { app.status = "exited"; });
  await ctx.host.process.closeStdin(h).catch(() => {});
  return appState(app, name);
}

export async function killAllApps(ctx: ModuleContext) {
  for (const a of apps.values()) if (a.handle && a.status !== "exited") await ctx.host.process.terminate(a.handle, "SIGKILL").catch(() => {});
}
