// terminal-panel: mounts the native terminal control for the active workspace's PTY.
import type { AppModule, ModuleContext, UiNode } from "../../../../sdk/types";
import { errMsg } from "../../../../sdk/runtime";

let ws: any = null;
let term: any = null;
let error: string | null = null;
let seq = 0;

async function attach(ctx: ModuleContext, restart = false) {
  if (!ws) { term = null; ctx.ui.invalidate(); return; }
  const mine = ++seq;
  try {
    const r = await ctx.modules.call("terminals", restart ? "restart" : "attach", { workspaceId: ws.id, key: "main" }, { timeoutMs: 60000 });
    if (mine === seq) { term = { ...r, workspaceId: ws.id }; error = null; }
  } catch (e) { if (mine === seq) { error = errMsg(e); term = null; } }
  ctx.ui.invalidate();
}

const mod: AppModule = {
  id: "terminal-panel",
  moduleApiVersion: 1,
  async activate(ctx) {
    ws = ctx.state.get("workspace.selected") || null;
    ctx.state.watch("workspace.selected", (v: any) => { const changed = (ws && ws.id) !== (v && v.id); ws = v; if (changed) attach(ctx); });
    ctx.events.on("terminals.changed", () => ctx.ui.invalidate());
    await attach(ctx);
  },
  render(): UiNode {
    const label = ws ? `TERMINAL  [${ws.name}]` : "TERMINAL";
    return { type: "column", key: "terminal-root", gap: 4, padding: 6, grow: true, children: [
      { type: "row", key: "hdr", gap: 6, align: "center", children: [
        { type: "label", key: "t", text: label, size: "sm", weight: "bold", color: "muted" },
        { type: "label", key: "where", text: term ? `${term.machineId} · ${term.cwd}` : "", size: "xs", color: "muted", mono: true, grow: true },
        { type: "button", key: "restart", text: "Restart shell", action: "restart", small: true, disabled: !ws },
      ] },
      ...(error ? [{ type: "status", key: "err", text: error, level: "error" } as UiNode] : []),
      { type: "terminal", key: "term", pty: term ? term.pty : null, placeholder: ws ? "Starting shell…" : "Select a workspace.", grow: true },
    ] };
  },
  async onEvent(ctx, ev) {
    if (ev.action === "restart") await attach(ctx, true);
  },
};
export default mod;
