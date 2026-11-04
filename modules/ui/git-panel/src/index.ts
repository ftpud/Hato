// git-panel: modified files in the selected workspace. Click opens a diff tab in the viewer,
// double click opens the file itself. Refreshes from filesystem notifications.
import type { AppModule, ModuleContext, UiNode } from "../../../../sdk/types";
import { errMsg } from "../../../../sdk/runtime";
import { diffTab, diffTabPath } from "../../../../sdk/git";
import { exportSettings } from "../../../../sdk/settings";
import { changeRows, signature, type Change } from "./model";
import { uiIcons } from "../../../../sdk/ui-icons";

let ws: any = null;
let status: { workspaceId: string; repo: boolean; branch: string | null; files: Change[]; truncated?: boolean } | null = null;
let error: string | null = null;
let loading = false;
let visible = false;
let autoRefresh = true;
let dirty = false;
let epoch = 0;
let lastSig = "";

async function refresh(ctx: ModuleContext) {
  if (!ws) return;
  if (loading) { dirty = true; return; }
  dirty = false;
  const mine = ++epoch, workspaceId = ws.id;
  loading = true;
  if (!status) ctx.ui.invalidate();
  try {
    const r = await ctx.modules.call("git", "status", { workspaceId }, { timeoutMs: 45000 });
    if (mine !== epoch || ws?.id !== workspaceId) return;
    error = null;
    const sig = workspaceId + "\n" + signature(r);
    status = r;
    if (sig !== lastSig) { lastSig = sig; ctx.events.emit("git-panel.statusChanged", { workspaceId }); }
  } catch (e) { if (mine === epoch) error = errMsg(e); }
  finally { if (mine === epoch) { loading = false; if (dirty && visible && autoRefresh) void refresh(ctx); } ctx.ui.invalidate(); }
}

async function show(ctx: ModuleContext, previewPath: string) {
  await ctx.modules.call("workspace", "view.patch", { workspaceId: ws.id, patch: { previewPath } });
}

const mod: AppModule = {
  id: "git-panel",
  moduleApiVersion: 1,
  async activate(ctx, prev) {
    const saved = await ctx.modules.call("persistence", "settings.get", { key: "git-panel.autoRefresh" });
    const old = saved == null ? await ctx.modules.call("persistence", "settings.get", { key: "git-panel.pollSeconds" }) : null;
    autoRefresh = typeof saved === "boolean" ? saved : old !== 0;
    exportSettings(ctx, () => [{ key: "git-panel", title: "Git changes", fields: [
      { key: "autoRefresh", label: "Automatic refresh", type: "toggle", value: autoRefresh,
        description: "Refresh Git status when files or repository metadata change." },
    ] }], async (_section, key, value) => {
      if (key !== "autoRefresh" || typeof value !== "boolean") throw new Error("Invalid automatic refresh preference");
      await ctx.modules.call("persistence", "settings.set", { key: "git-panel.autoRefresh", value });
      autoRefresh = value;
      if (visible && value) void refresh(ctx);
    });
    ctx.events.on("git.changed", (event: any) => {
      if (event.workspaceId === ws?.id && autoRefresh) {
        dirty = true;
        if (visible) void refresh(ctx);
      }
    });
    ws = ctx.state.get("workspace.selected") || null;
    if (prev?.status && prev.status.workspaceId === ws?.id) status = prev.status;
    visible = !!(ctx.state.get("workspace-layout.panels") as any)?.git;
    ctx.state.watch("workspace-layout.panels", (v: any) => {
      const next = !!v?.git;
      if (next === visible) return;
      visible = next;
      if (visible) void refresh(ctx);
    });
    ctx.state.watch("workspace.selected", (v: any) => {
      const changed = ws?.id !== v?.id; ws = v;
      if (changed) { epoch++; loading = false; status = null; error = null; lastSig = ""; dirty = false; void refresh(ctx); }
      else ctx.ui.invalidate();
    });
    await refresh(ctx);
  },
  deactivate() { epoch++; loading = false; dirty = false; },
  snapshot: () => ({ status }),
  render(): UiNode {
    const children: UiNode[] = [];
    if (!ws) return { type: "column", key: "git-root", padding: 8, grow: true, children: [{ type: "label", key: "none", text: "Select a project or task.", color: "muted" }] };
    const files = status && status.workspaceId === ws.id ? status.files : [];
    const preview = ws.view?.previewPath || null;
    const selected = diffTabPath(preview) ?? preview;
    const summary = !status ? "Loading…" : !status.repo ? "Not a Git repository" : files.length ? `${files.length} changed ${files.length === 1 ? "file" : "files"}` : "No changes";
    children.push({ type: "row", key: "tools", gap: 4, align: "center", children: [
      { type: "label", key: "branch", text: status?.branch ? `⎇ ${status.branch}` : "", size: "xs", weight: "semibold", tooltip: "Current branch" },
      { type: "label", key: "count", text: summary + (status?.truncated ? " (truncated)" : ""), size: "xs", color: "muted", grow: true },
      { type: "button", key: "refresh", text: "", iconSvg: uiIcons["refresh"], action: "refresh", small: true, variant: "ghost", disabled: loading, tooltip: "Refresh Git status" },
    ] });
    if (error) children.push({ type: "status", key: "err", text: error, level: "error" });
    if (loading && !status) children.push({ type: "progress", key: "loading", indeterminate: true });
    if (status?.repo && files.length) {
      children.push({ type: "tree", key: "changes", rows: changeRows(files, selected), selectAction: "diff", activateAction: "open", grow: true,
        rowHeight: 52, rowGap: 3, iconSize: 18,
        tooltip: "Click to compare with HEAD · double click to open the file" } as UiNode);
    }
    return { type: "column", key: "git-root", gap: 4, padding: 8, grow: true, children };
  },
  async onEvent(ctx, ev) {
    if (!ws) return;
    try {
      if (ev.action === "refresh") { await refresh(ctx); return; }
      const change = status?.files.find((c) => c.path === ev.rowKey);
      if (!change) return;
      if (ev.action === "diff") await show(ctx, diffTab(change.path));
      else if (ev.action === "open") {
        if (change.kind === "deleted") throw new Error(`${change.path} was deleted; showing its diff instead.`);
        await show(ctx, change.path);
      }
    } catch (e) { error = errMsg(e); }
    ctx.ui.invalidate();
  },
};
export default mod;
