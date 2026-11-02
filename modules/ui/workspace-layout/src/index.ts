// workspace-layout: main window composition. Other UI modules are embedded through `slot` nodes,
// so each keeps rendering even if another fails. Also hosts the module diagnostics drawer
// (developer workflow: rebuild/activate/rollback via module-dev; each step needs native approval).
import type { AppModule, ModuleContext, UiNode } from "../../../../sdk/types";
import { errMsg } from "../../../../sdk/runtime";

let ws: any = null;
let modules: any[] = [];
let showModules = false;
let diag: string | null = null;
let busy: string | null = null;
let sizes = { columns: [0.17, 0.17, 0.38, 0.28], rows: [0.68, 0.32] };

async function loadModules(ctx: ModuleContext) {
  try { modules = await ctx.modules.call("module-dev", "list"); } catch (e) { diag = errMsg(e); }
  ctx.ui.invalidate();
}

function summary() {
  const ui = modules.filter((m) => m.active).map((m) => m.active.label).sort();
  return ui.length ? ui.join("  ") : "modules: loading…";
}

const mod: AppModule = {
  id: "workspace-layout",
  moduleApiVersion: 1,
  async activate(ctx, prev) {
    if (prev) { showModules = !!prev.showModules; if (prev.sizes) sizes = prev.sizes; }
    ws = ctx.state.get("workspace.selected") || null;
    ctx.state.watch("workspace.selected", (v: any) => { ws = v; ctx.ui.invalidate(); });
    ctx.events.on("kernel.modules.changed", () => loadModules(ctx));
    await loadModules(ctx);
  },
  snapshot: () => ({ showModules, sizes }),
  render(): UiNode {
    const where = ws ? `${ws.name}  ·  ${ws.location === "ssh" ? `SSH ${ws.ssh?.user}@${ws.ssh?.host}` : "Local"}  ·  ${ws.rootAbsolutePath}` : "No workspace selected";
    const header: UiNode = { type: "row", key: "header", gap: 10, padding: 6, bg: "panel", border: true, align: "center", children: [
      { type: "label", key: "app", text: "Hato", weight: "bold" },
      { type: "label", key: "ws", text: where, size: "sm", color: "muted", grow: true },
      { type: "button", key: "mods", text: showModules ? "Hide modules" : "Modules", action: "toggleModules", small: true },
    ] };
    const main: UiNode = { type: "split", key: "main", direction: "vertical", sizes: sizes.rows, grow: true, children: [
      { type: "split", key: "top", direction: "horizontal", sizes: sizes.columns, children: [
        { type: "slot", key: "s-projects", module: "projects-panel" },
        { type: "slot", key: "s-explorer", module: "explorer" },
        { type: "slot", key: "s-viewer", module: "viewer" },
        { type: "slot", key: "s-ai", module: "ai" },
      ] },
      { type: "slot", key: "s-terminal", module: "terminal-panel" },
    ] };
    const status: UiNode = { type: "row", key: "status", gap: 10, padding: 4, bg: "panel", border: true, align: "center", children: [
      { type: "label", key: "loc", text: ws ? `Active workspace · files/terminal/agent run on: ${ws.machineId}` : "Active workspace: none", size: "xs", color: "muted" },
      { type: "label", key: "mods", text: summary(), size: "xs", color: "muted", mono: true, grow: true },
      { type: "approvalPanel", key: "approvals" },
    ] };
    const kids: UiNode[] = [header, main, status];
    if (showModules) {
      const rows: UiNode[] = modules.map((m) => ({ type: "row", key: "m-" + m.id, gap: 6, align: "center", children: [
        { type: "label", key: "n", text: m.active ? m.active.label : `${m.id} (inactive)`, mono: true, size: "sm", width: 210 },
        { type: "label", key: "k", text: m.kind, size: "xs", color: "muted", width: 50 },
        { type: "label", key: "e", text: m.lastError ? `⚠ ${m.lastError}` : `${m.versions.length} version(s); previous: ${m.previous.slice(-3).join(",") || "-"}`, size: "xs", color: m.lastError ? "danger" : "muted", grow: true },
        { type: "button", key: "b", text: "Rebuild & activate", action: "rebuild", value: m.id, small: true, disabled: !!busy },
        { type: "button", key: "r", text: "Rollback", action: "rollback", value: m.id, small: true, disabled: !!busy || !(m.previous && m.previous.length) },
      ] }));
      kids.push({ type: "modal", key: "modules-modal", title: "Modules (hot-swappable TypeScript)", closeAction: "toggleModules", children: [
        { type: "label", key: "hint", text: "Edit sources under modules/, then Rebuild & activate. Builds, activation and rollback each require native approval; the Rust kernel is never rebuilt.", size: "xs", color: "muted", wrap: true },
        ...(busy ? [{ type: "progress", key: "busy", indeterminate: true, label: busy } as UiNode] : []),
        ...(diag ? [{ type: "status", key: "diag", text: diag, level: diag.startsWith("✓") ? "success" : "error" } as UiNode] : []),
        { type: "column", key: "list", gap: 2, scroll: true, children: rows },
      ] });
    }
    return { type: "column", key: "layout-root", grow: true, children: kids };
  },
  async onEvent(ctx, ev) {
    if (ev.action === "toggleModules") { showModules = !showModules; diag = null; if (showModules) await loadModules(ctx); }
    else if (ev.action === "rebuild" || ev.action === "rollback") {
      const id = String(ev.value);
      busy = `${ev.action === "rebuild" ? "Building" : "Rolling back"} ${id}…`; diag = null; ctx.ui.invalidate();
      try {
        const r = await ctx.modules.call("module-dev", ev.action === "rebuild" ? "buildAndActivate" : "rollback", { id }, { timeoutMs: 900000 });
        diag = r.ok === false ? `${id}: ${r.error || "failed"}\n${(r.diagnostics || "").slice(0, 2000)}` : `✓ ${r.label || id} active${r.swapMs !== undefined ? ` (swap ${r.swapMs} ms)` : ""}`;
      } catch (e) { diag = `${id}: ${errMsg(e)}`; }
      busy = null;
      await loadModules(ctx);
    }
    ctx.ui.invalidate();
  },
};
export default mod;
