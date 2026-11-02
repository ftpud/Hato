// explorer: navigate the active workspace's directories and open files in the viewer.
import type { AppModule, ModuleContext, UiNode } from "../../../../sdk/types";
import { errMsg } from "../../../../sdk/runtime";

let ws: any = null;
let listing: any = null;
let error: string | null = null;
let loading = false;
let seq = 0;

async function load(ctx: ModuleContext) {
  if (!ws) { listing = null; ctx.ui.invalidate(); return; }
  const mine = ++seq;
  loading = true; ctx.ui.invalidate();
  try {
    const r = await ctx.modules.call("files", "list", { workspaceId: ws.id, relativeDir: ws.view?.explorerDir || "." });
    if (mine === seq) { listing = r; error = null; }
  } catch (e) {
    if (mine === seq) { error = errMsg(e); listing = null; }
    // A vanished directory falls back to the root.
    if (ws.view?.explorerDir && ws.view.explorerDir !== ".") await ctx.modules.call("workspace", "view.patch", { workspaceId: ws.id, patch: { explorerDir: "." } }).catch(() => {});
  } finally { if (mine === seq) loading = false; ctx.ui.invalidate(); }
}

const mod: AppModule = {
  id: "explorer",
  moduleApiVersion: 1,
  async activate(ctx) {
    ws = ctx.state.get("workspace.selected") || null;
    ctx.state.watch("workspace.selected", (v: any) => {
      const changed = !ws || !v || ws.id !== v.id || ws.view?.explorerDir !== v.view?.explorerDir;
      ws = v;
      if (changed) load(ctx); else ctx.ui.invalidate();
    });
    await load(ctx);
  },
  render(): UiNode {
    const dir = listing ? listing.relativeDir : ".";
    const kids: UiNode[] = [
      { type: "row", key: "hdr", gap: 4, align: "center", children: [
        { type: "label", key: "t", text: "FILES", size: "sm", weight: "bold", color: "muted" },
        { type: "label", key: "dir", text: dir === "." ? "/" : "/" + dir, size: "sm", mono: true, grow: true },
        { type: "button", key: "up", text: "↑", action: "up", small: true, disabled: dir === ".", tooltip: "Parent directory" },
        { type: "button", key: "refresh", text: "⟳", action: "refresh", small: true, tooltip: "Refresh" },
      ] },
    ];
    if (!ws) kids.push({ type: "label", key: "none", text: "Select a project or task.", color: "muted" });
    if (ws && ws.location === "ssh") kids.push({ type: "label", key: "loc", text: `remote: ${ws.ssh?.host}:${ws.rootAbsolutePath}`, size: "xs", color: "muted" });
    if (error) kids.push({ type: "status", key: "err", text: error, level: "error" });
    if (loading && !listing) kids.push({ type: "progress", key: "ld", indeterminate: true });
    if (listing) kids.push({ type: "fileList", key: "files", action: "open", grow: true,
      entries: listing.entries.map((e: any) => ({ key: e.relativePath, name: e.name + (e.kind === "dir" ? "/" : ""), kind: e.kind, size: e.size, selected: ws?.view?.previewPath === e.relativePath })) });
    return { type: "column", key: "explorer-root", gap: 6, padding: 8, grow: true, children: kids };
  },
  async onEvent(ctx, ev) {
    if (!ws) return;
    const patch = (p: any) => ctx.modules.call("workspace", "view.patch", { workspaceId: ws.id, patch: p });
    if (ev.action === "open" && ev.rowKey) {
      const e = listing?.entries.find((x: any) => x.relativePath === ev.rowKey);
      if (e && e.kind === "dir") await patch({ explorerDir: e.relativePath });
      else await patch({ previewPath: ev.rowKey });
    } else if (ev.action === "up") {
      const cur = listing ? listing.relativeDir : ".";
      const parent = cur.includes("/") ? cur.slice(0, cur.lastIndexOf("/")) : ".";
      await patch({ explorerDir: parent });
    } else if (ev.action === "refresh") {
      await load(ctx);
    }
  },
};
export default mod;
