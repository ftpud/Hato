// viewer: renders a native, read-only, syntax-highlighted code viewer bound to a kernel document
// handle. Highlighting, scrolling and selection are native.
import type { AppModule, ModuleContext, UiNode } from "../../../../sdk/types";
import { errMsg } from "../../../../sdk/runtime";

let ws: any = null;
let current: any = null;
let error: string | null = null;
let loadingPath: string | null = null;

async function load(ctx: ModuleContext) {
  const path = ws?.view?.previewPath || null;
  if (!ws || !path) { current = null; error = null; ctx.ui.invalidate(); return; }
  if (current && current.workspaceId === ws.id && current.relativePath === path) return;
  loadingPath = path; ctx.ui.invalidate();
  try {
    const r = await ctx.modules.call("files", "open", { workspaceId: ws.id, relativePath: path });
    if (loadingPath === path) { current = r; error = null; }
  } catch (e) { if (loadingPath === path) { error = errMsg(e); current = null; } }
  finally { if (loadingPath === path) loadingPath = null; ctx.ui.invalidate(); }
}

const mod: AppModule = {
  id: "viewer",
  moduleApiVersion: 1,
  async activate(ctx, prev) {
    if (prev && prev.current) current = prev.current;
    ws = ctx.state.get("workspace.selected") || null;
    ctx.state.watch("workspace.selected", (v: any) => { ws = v; load(ctx); });
    await load(ctx);
  },
  snapshot: () => ({ current }),
  render(): UiNode {
    const title = current ? current.relativePath : ws?.view?.previewPath || "No file selected";
    const kids: UiNode[] = [
      { type: "row", key: "hdr", gap: 6, align: "center", children: [
        { type: "label", key: "t", text: "SOURCE VIEWER", size: "sm", weight: "bold", color: "muted" },
        { type: "label", key: "path", text: title, size: "sm", mono: true, grow: true },
        { type: "label", key: "lang", text: current ? `${current.language} · ${current.size} B${current.truncated ? " (truncated)" : ""}` : "", size: "xs", color: "muted" },
      ] },
    ];
    if (error) kids.push({ type: "status", key: "err", text: error, level: "error" });
    if (loadingPath) kids.push({ type: "progress", key: "ld", indeterminate: true, label: `Opening ${loadingPath}…` });
    if (current && current.binary) kids.push({ type: "status", key: "bin", text: current.message, level: "info" });
    kids.push({ type: "codeViewer", key: "code", document: current && !current.binary ? current.document : null, placeholder: ws ? "Open a file from the explorer." : "Select a workspace.", grow: true });
    return { type: "column", key: "viewer-root", gap: 6, padding: 8, grow: true, children: kids };
  },
};
export default mod;
