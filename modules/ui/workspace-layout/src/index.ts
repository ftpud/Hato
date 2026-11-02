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
let upd: Record<string, any> = {};
let updSummary: { available: string[]; errors: string[] } = { available: [], errors: [] };
let scanningUpd = false;
let sizes = { columns: [0.17, 0.17, 0.38, 0.28], rows: [0.68, 0.32] };

async function loadUpdates(ctx: ModuleContext, scan: boolean, full = false) {
  try {
    if (scan) { scanningUpd = true; ctx.ui.invalidate(); }
    const r = await ctx.modules.call("module-dev", scan ? "scanUpdates" : "updates", { full }, { timeoutMs: 300000 });
    upd = {};
    for (const m of r.modules) upd[m.id] = m;
    updSummary = { available: r.available, errors: r.errors };
  } catch (e) { diag = errMsg(e); }
  finally { scanningUpd = false; ctx.ui.invalidate(); }
}

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
    ctx.events.on("module-dev.updatesChanged", () => loadUpdates(ctx, false));
    await loadModules(ctx);
    loadUpdates(ctx, false);
  },
  snapshot: () => ({ showModules, sizes }),
  render(): UiNode {
    const where = ws ? `${ws.name}  ·  ${ws.location === "ssh" ? `SSH ${ws.ssh?.user}@${ws.ssh?.host}` : "Local"}  ·  ${ws.rootAbsolutePath}` : "No workspace selected";
    const header: UiNode = { type: "row", key: "header", gap: 10, padding: 6, bg: "panel", border: true, align: "center", children: [
      { type: "label", key: "app", text: "Hato", weight: "bold" },
      { type: "label", key: "ws", text: where, size: "sm", color: "muted", grow: true },
      { type: "button", key: "mods", text: showModules ? "Hide modules" : updSummary.available.length ? `Modules (${updSummary.available.length} update${updSummary.available.length > 1 ? "s" : ""})` : "Modules", action: "toggleModules", small: true, variant: updSummary.available.length && !showModules ? "primary" : "default" },
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
      const rank = (m: any) => (upd[m.id]?.status === "update-available" ? 0 : upd[m.id]?.status === "build-error" ? 1 : 2);
      const sorted = [...modules].sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id));
      const rows: UiNode[] = sorted.map((m) => {
        const u = upd[m.id];
        const st = !u ? { t: "checking…", c: "muted" } : u.status === "update-available" ? { t: "● update available (source changed)", c: "warning" } : u.status === "build-error" ? { t: `✖ source does not build: ${(u.diagnostics || "").split("\n")[0]}`, c: "danger" } : { t: "up to date", c: "success" };
        return { type: "row", key: "m-" + m.id, gap: 6, align: "center", children: [
        { type: "label", key: "n", text: m.active ? m.active.label : `${m.id} (inactive)`, mono: true, size: "sm", width: 210 },
        { type: "label", key: "k", text: m.kind, size: "xs", color: "muted", width: 50 },
        { type: "label", key: "u", text: st.t, size: "xs", color: st.c as any, width: 230 },
        { type: "label", key: "e", text: m.lastError ? `⚠ ${m.lastError}` : `${m.versions.length} version(s); previous: ${m.previous.slice(-3).join(",") || "-"}`, size: "xs", color: m.lastError ? "danger" : "muted", grow: true },
        { type: "button", key: "b", text: u && u.status === "update-available" ? "Update" : "Rebuild & activate", action: "rebuild", value: m.id, small: true, variant: u && u.status === "update-available" ? "primary" : "default", disabled: !!busy },
        { type: "button", key: "r", text: "Rollback", action: "rollback", value: m.id, small: true, disabled: !!busy || !(m.previous && m.previous.length) },
      ] } as UiNode; });
      kids.push({ type: "modal", key: "modules-modal", title: "Modules (hot-swappable TypeScript)", closeAction: "toggleModules", children: [
        { type: "label", key: "hint", text: "Edit sources under modules/, then Rebuild & activate. Builds, activation and rollback each require native approval; the Rust kernel is never rebuilt.", size: "xs", color: "muted", wrap: true },
        { type: "row", key: "upd-bar", gap: 6, align: "center", children: [
          { type: "label", key: "upd-sum", text: scanningUpd ? "Checking module sources for updates…" : updSummary.available.length ? `${updSummary.available.length} module(s) with updates: ${updSummary.available.join(", ")}` : "All modules match their sources.", size: "sm", color: updSummary.available.length ? "warning" : "muted", grow: true },
          { type: "button", key: "upd-all", text: `Activate all updates (${updSummary.available.length})`, action: "activateAll", small: true, variant: "primary", disabled: !!busy || !updSummary.available.length },
          { type: "button", key: "upd-scan", text: "Rescan", action: "rescan", small: true, disabled: scanningUpd || !!busy, tooltip: "Rebuild every module in memory and compare with the active version" },
        ] },
        ...(busy ? [{ type: "progress", key: "busy", indeterminate: true, label: busy } as UiNode] : []),
        ...(diag ? [{ type: "status", key: "diag", text: diag, level: diag.startsWith("✓") ? "success" : "error" } as UiNode] : []),
        { type: "column", key: "list", gap: 2, scroll: true, children: rows },
      ] });
    }
    return { type: "column", key: "layout-root", grow: true, children: kids };
  },
  async onEvent(ctx, ev) {
    if (ev.action === "toggleModules") { showModules = !showModules; diag = null; if (showModules) { await loadModules(ctx); loadUpdates(ctx, true); } }
    else if (ev.action === "rescan") { await loadUpdates(ctx, true, true); }
    else if (ev.action === "activateAll") {
      busy = `Updating ${updSummary.available.join(", ")}…`; diag = null; ctx.ui.invalidate();
      try {
        const r = await ctx.modules.call("module-dev", "activateUpdates", {}, { timeoutMs: 1800000 });
        diag = r.ok ? `✓ updated ${r.results.map((x: any) => x.label).join(", ")}` : r.results.filter((x: any) => !x.ok).map((x: any) => `${x.id}: ${x.error}`).join("\n");
      } catch (e) { diag = errMsg(e); }
      busy = null;
      await loadModules(ctx);
      await loadUpdates(ctx, true);
    }
    else if (ev.action === "rebuild" || ev.action === "rollback") {
      const id = String(ev.value);
      busy = `${ev.action === "rebuild" ? "Building" : "Rolling back"} ${id}…`; diag = null; ctx.ui.invalidate();
      try {
        const r = await ctx.modules.call("module-dev", ev.action === "rebuild" ? "buildAndActivate" : "rollback", { id }, { timeoutMs: 900000 });
        diag = r.ok === false ? `${id}: ${r.error || "failed"}\n${(r.diagnostics || "").slice(0, 2000)}` : `✓ ${r.label || id} active${r.swapMs !== undefined ? ` (swap ${r.swapMs} ms)` : ""}`;
      } catch (e) { diag = `${id}: ${errMsg(e)}`; }
      busy = null;
      await loadModules(ctx);
      await loadUpdates(ctx, true);
    }
    ctx.ui.invalidate();
  },
};
export default mod;
