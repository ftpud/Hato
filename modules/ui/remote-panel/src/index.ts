// remote-panel: what the workspace machine's daemon is holding, with controls. All decisions are
// in the remote-runtime service; this module only renders its status.
import type { AppModule, ModuleContext, UiNode } from "../../../../sdk/types";
import { errMsg } from "../../../../sdk/runtime";
import { uiIcons } from "../../../../sdk/ui-icons";

let ws: any = null;
let status: any = null;
let error: string | null = null;
let busy: string | null = null;
let timer: any = null;

async function refresh(ctx: ModuleContext) {
  if (!ws) { status = null; ctx.ui.invalidate(); return; }
  try { status = await ctx.modules.call("remote-runtime", "status", { workspaceId: ws.id }, { timeoutMs: 60000 }); error = null; }
  catch (e) { error = errMsg(e); }
  ctx.ui.invalidate();
}

async function run(ctx: ModuleContext, label: string, fn: () => Promise<unknown>) {
  busy = label; error = null; ctx.ui.invalidate();
  try { await fn(); } catch (e) { error = errMsg(e); }
  busy = null; await refresh(ctx);
}

const row = (key: string, label: string, detail: string, actions: UiNode[]): UiNode => ({ type: "row", key, gap: 6, align: "center", padding: 2, children: [
  { type: "column", key: "t", grow: true, gap: 0, children: [
    { type: "label", key: "l", text: label, size: "sm", mono: true },
    { type: "label", key: "d", text: detail, size: "xs", color: "muted" },
  ] },
  ...actions,
] });

const mod: AppModule = {
  id: "remote-panel",
  moduleApiVersion: 1,
  async activate(ctx) {
    ws = ctx.state.get("workspace.selected") || null;
    ctx.state.watch("workspace.selected", (v: any) => { ws = v; void refresh(ctx); });
    ctx.events.on("remote-runtime.changed", () => { void refresh(ctx); });
    timer = setInterval(() => { if ((ctx.state.get("workspace-layout.panels") as any)?.remote) void refresh(ctx); }, 5000);
    await refresh(ctx);
  },
  deactivate() { if (timer) clearInterval(timer); },
  render(): UiNode {
    const kids: UiNode[] = [];
    if (!ws) return { type: "column", key: "root", padding: 8, children: [{ type: "label", key: "none", text: "Select a project or task.", color: "muted" }] };
    kids.push({ type: "row", key: "head", gap: 6, align: "center", children: [
      { type: "label", key: "machine", text: status ? `${status.machineId}` : ws.machineId, weight: "semibold", size: "sm", grow: true },
      { type: "button", key: "refresh", text: "", iconSvg: uiIcons.refresh, action: "refresh", small: true, variant: "ghost", tooltip: "Refresh" },
    ] });
    if (busy) kids.push({ type: "progress", key: "busy", indeterminate: true, label: busy });
    if (error || status?.error) kids.push({ type: "status", key: "err", text: error || status.error, level: "error" });
    if (!status) return { type: "column", key: "root", padding: 8, gap: 6, children: kids };
    if (!status.running) {
      kids.push({ type: "label", key: "off", text: "The Hato daemon is not running on this machine. Terminals and plugins stop when the connection drops.", size: "sm", color: "muted", wrap: true });
      kids.push({ type: "button", key: "start", text: "Start daemon", action: "ensure", variant: "primary", small: true, disabled: !!busy });
      return { type: "column", key: "root", padding: 8, gap: 6, children: kids };
    }
    kids.push({ type: "label", key: "ver", text: `daemon ${status.version} · pid ${status.pid}${status.stale ? " · older build (restarts when idle)" : ""}`, size: "xs", color: status.stale ? "warning" : "muted" });
    const ptys: any[] = status.resources?.ptys || [], procs: any[] = status.resources?.procs || [];
    kids.push({ type: "label", key: "h-res", text: `Held on the server (${ptys.length + procs.length})`, weight: "semibold", size: "sm" });
    for (const p of ptys) kids.push(row(`pty:${p.key}`, p.key, `terminal · ${p.exit ? `exited (${p.exit})` : p.attached ? "attached" : "detached"} · ${p.cwd}`, [
      { type: "button", key: "kill", text: "Stop", action: "kill", value: { kind: "pty", key: p.key }, small: true, variant: "danger", disabled: !!busy },
    ]));
    for (const p of procs) kids.push(row(`proc:${p.key}`, p.key, `process ${p.pid} · ${p.exit ? "exited" : p.attached ? "attached" : `detached, ${p.bufferedBytes} bytes buffered`}`, [
      { type: "button", key: "kill", text: "Stop", action: "kill", value: { kind: "proc", key: p.key }, small: true, variant: "danger", disabled: !!busy },
    ]));
    const remote: any[] = status.plugins || [];
    const candidates: string[] = status.candidates || [];
    kids.push({ type: "label", key: "h-plg", text: "Plugins on the server", weight: "semibold", size: "sm" });
    if (!remote.length && !candidates.length) kids.push({ type: "label", key: "no-plg", text: "None. Plugins with runsOn: \"workspace\" are sent here when enabled.", size: "xs", color: "muted", wrap: true });
    for (const p of remote) kids.push(row(`rp:${p.id}`, p.id, `${p.enabled ? p.active || "loading" : "disabled"}${p.lastError && !p.active ? ` · ${p.lastError}` : ""}`, [
      ...(p.enabled ? [{ type: "button", key: "dis", text: "Stop", action: "disable", value: p.id, small: true, disabled: !!busy } as UiNode] : []),
      { type: "button", key: "push", text: "Update", action: "push", value: p.id, small: true, disabled: !!busy },
    ]));
    for (const id of candidates.filter((id) => !remote.some((p) => p.id === id))) kids.push(row(`cp:${id}`, id, "enabled here, not on the server yet", [
      { type: "button", key: "push", text: "Send", action: "push", value: id, small: true, variant: "primary", disabled: !!busy },
    ]));
    return { type: "column", key: "root", padding: 8, gap: 6, scroll: true, grow: true, children: kids };
  },
  async onEvent(ctx, ev) {
    const workspaceId = ws?.id;
    if (!workspaceId) return;
    switch (ev.action) {
      case "refresh": return refresh(ctx);
      case "ensure": return run(ctx, "Starting daemon…", () => ctx.modules.call("remote-runtime", "ensure", { workspaceId }, { timeoutMs: 600000 }));
      case "kill": return run(ctx, "Stopping…", () => ctx.modules.call("remote-runtime", "kill", { workspaceId, ...(ev.value as any) }));
      case "push": return run(ctx, `Sending ${ev.value}…`, () => ctx.modules.call("remote-runtime", "push", { workspaceId, id: ev.value }, { timeoutMs: 120000 }));
      case "disable": return run(ctx, `Stopping ${ev.value}…`, () => ctx.modules.call("remote-runtime", "disable", { workspaceId, id: ev.value }));
    }
  },
};
export default mod;
