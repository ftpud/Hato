// Each tab attaches to a distinct kernel-owned PTY, retained across panel swaps.
import type { AppModule, ModuleContext, UiNode } from "../../../../sdk/types";
import { errMsg } from "../../../../sdk/runtime";
let ws: any = null;
let term: any = null;
let error: string | null = null;
let seq = 0;
let keys = ["main"];
let active = "main";
async function attach(ctx: ModuleContext, restart = false) {
  const mine = ++seq;
  term = null;
  if (!ws) { ctx.ui.invalidate(); return; }
  const workspaceId = ws.id, key = active;
  ctx.ui.invalidate();
  try {
    const r = await ctx.modules.call("terminals", restart ? "restart" : "attach", { workspaceId, key }, { timeoutMs: 60000 });
    if (mine === seq) { term = r; error = null; }
  } catch (e) { if (mine === seq) error = errMsg(e); }
  ctx.ui.invalidate();
}
function restore() {
  const saved = ws?.view?.ui?.terminalTabs;
  keys = Array.isArray(saved?.keys) && saved.keys.length ? saved.keys : ["main"];
  active = keys.includes(saved?.active) ? saved.active : keys[0];
}
async function save(ctx: ModuleContext) {
  await ctx.modules.call("workspace", "view.patch", { workspaceId: ws.id, patch: { ui: { terminalTabs: { keys: [...keys], active } } } });
}
const mod: AppModule = {
  id: "terminal-panel", moduleApiVersion: 1,
  async activate(ctx) {
    ws = ctx.state.get("workspace.selected") || null; restore();
    ctx.state.watch("workspace.selected", (v: any) => { const changed = ws?.id !== v?.id; ws = v; if (changed) { restore(); void attach(ctx); } });
    ctx.events.on("terminals.changed", () => ctx.ui.invalidate());
    await attach(ctx);
  },
  render(): UiNode {
    return { type: "column", key: "terminal-root", gap: 3, padding: 4, grow: true, children: [
      { type: "row", key: "tabs", gap: 3, wrap: true, children: [
        ...keys.map((key, i): UiNode => ({ type: "row", key, gap: 0, children: [
          { type: "button", key: "select", text: `Terminal ${i + 1}`, action: `select:${key}`, small: true, variant: active === key ? "primary" : "ghost", disabled: !ws },
          { type: "button", key: "close", text: "", icon: "x", action: `close:${key}`, small: true, variant: "ghost", tooltip: "Close terminal", disabled: !ws },
        ] })),
        { type: "button", key: "new", text: "", icon: "plus", action: "new", small: true, variant: "ghost", tooltip: "New terminal", disabled: !ws },
        { type: "button", key: "restart", text: "", icon: "refresh", action: "restart", small: true, variant: "ghost", tooltip: "Restart active shell", disabled: !ws },
      ] },
      ...(error ? [{ type: "status", key: "err", text: error, level: "error" } as UiNode] : []),
      { type: "terminal", key: `term:${active}`, pty: term?.pty || null, placeholder: ws ? "Starting shell…" : "Select a workspace.", grow: true },
    ] };
  },
  async onEvent(ctx, ev) {
    if (!ws) return;
    try {
      if (ev.action === "restart") { await attach(ctx, true); return; }
      if (ev.action === "new") { active = `shell-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`; keys.push(active); }
      else if (ev.action.startsWith("select:")) { const key = ev.action.slice(7); if (!keys.includes(key)) return; active = key; }
      else if (ev.action.startsWith("close:")) {
        const key = ev.action.slice(6), index = keys.indexOf(key);
        if (index < 0) return;
        await ctx.modules.call("terminals", "close", { workspaceId: ws.id, key });
        keys.splice(index, 1);
        if (!keys.length) keys = ["main"];
        if (active === key) active = keys[Math.min(index, keys.length - 1)];
      } else return;
      await save(ctx); await attach(ctx);
    } catch (e) { error = errMsg(e); ctx.ui.invalidate(); }
  },
};
export default mod;
