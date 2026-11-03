// viewer: renders a native, read-only, syntax-highlighted code viewer bound to a kernel document
// handle. Highlighting, scrolling and selection are native.
import type { AppModule, ModuleContext, UiNode } from "../../../../sdk/types";
import { exportSettings } from "../../../../sdk/settings";
import { errMsg } from "../../../../sdk/runtime";

let showMetadata = true;
let renderMarkdown = true;
let publishSettings: () => void = () => {};
let ws: any = null;
let current: any = null;
let error: string | null = null;
let loadingPath: string | null = null;

let tabs: string[] = [];
let generation = 0;
function restoreTabs() {
  const saved = ws?.view?.ui?.viewerTabs;
  tabs = Array.isArray(saved) ? saved.filter((p: unknown) => typeof p === "string") : [];
}
async function saveTabs(ctx: ModuleContext) {
  await ctx.modules.call("workspace", "view.patch", { workspaceId: ws.id, patch: { ui: { viewerTabs: [...tabs] } } });
}
async function load(ctx: ModuleContext) {
  const path = ws?.view?.previewPath || null;
  const workspaceId = ws?.id;
  if (!workspaceId || !path) { generation++; loadingPath = null; current = null; error = null; ctx.ui.invalidate(); return; }
  if (!tabs.includes(path)) { tabs.push(path); await saveTabs(ctx); }
  if (ws?.id !== workspaceId || ws?.view?.previewPath !== path) return;
  if (current?.workspaceId === workspaceId && current.relativePath === path || loadingPath === path) return;
  const mine = ++generation;
  current = null; error = null; loadingPath = path; ctx.ui.invalidate();
  try {
    const r = await ctx.modules.call("files", "open", { workspaceId, relativePath: path });
    if (mine === generation) { current = { ...r, workspaceId }; error = null; }
  } catch (e) { if (mine === generation) { error = errMsg(e); current = null; } }
  finally { if (mine === generation) loadingPath = null; ctx.ui.invalidate(); }
}

const mod: AppModule = {
  id: "viewer",
  moduleApiVersion: 1,
  async activate(ctx, prev) {
    const saved = await ctx.modules.call("persistence", "settings.get", { key: "viewer.showMetadata" });
    showMetadata = typeof saved === "boolean" ? saved : true;
    const savedMarkdown = await ctx.modules.call("persistence", "settings.get", { key: "viewer.renderMarkdown" });
    renderMarkdown = typeof savedMarkdown === "boolean" ? savedMarkdown : true;
    publishSettings = exportSettings(ctx, () => [{ key: "viewer", title: "Source viewer", fields: [
      { key: "showMetadata", label: "Show file metadata", type: "toggle", value: showMetadata,
        description: "Display the language and file size in the bottom status bar." },
      { key: "renderMarkdown", label: "Preview Markdown files", type: "toggle", value: renderMarkdown,
        description: "Render Markdown documents. Switch between Preview and Source in the viewer status bar." },
    ] }], async (_section, key, value) => {
      if (!["showMetadata", "renderMarkdown"].includes(key) || typeof value !== "boolean") throw new Error("Invalid viewer setting");
      await ctx.modules.call("persistence", "settings.set", { key: `viewer.${key}`, value });
      if (key === "showMetadata") showMetadata = value; else renderMarkdown = value;
    });
    ws = ctx.state.get("workspace.selected") || null;
    restoreTabs();
    ctx.state.watch("workspace.selected", (v: any) => {
      const changed = ws?.id !== v?.id; ws = v;
      if (changed) { generation++; current = null; loadingPath = null; restoreTabs(); }
      void load(ctx);
    });
    await load(ctx);
  },
  snapshot: () => ({ current }),
  render(): UiNode {
    const markdown = current && !current.binary && (current.language === "markdown" || /\.(md|markdown)$/i.test(current.relativePath));
    const title = current ? current.relativePath : ws?.view?.previewPath || "No file selected";
    const kids: UiNode[] = [
      { type: "row", key: "tabs", gap: 3, wrap: true, children: tabs.map((path): UiNode => ({ type: "row", key: path, gap: 0, children: [
        { type: "button", key: "select", text: path.split("/").pop() || path, tooltip: path, action: `select:${path}`, small: true, variant: ws?.view?.previewPath === path ? "primary" : "ghost" },
        { type: "button", key: "close", text: "", icon: "x", tooltip: `Close ${path}`, action: `close:${path}`, small: true, variant: "ghost" },
      ] })) },

    ];
    if (error) kids.push({ type: "status", key: "err", text: error, level: "error" });
    if (loadingPath) kids.push({ type: "progress", key: "ld", indeterminate: true, label: `Opening ${loadingPath}…` });
    if (current && current.binary) kids.push({ type: "status", key: "bin", text: current.message, level: "info" });
    if (markdown && renderMarkdown) kids.push({ type: "markdown", key: "preview", document: current.document, grow: true });
    else kids.push({ type: "codeViewer", key: "code", document: current && !current.binary ? current.document : null, placeholder: ws ? "Open a file from the explorer." : "Select a workspace.", grow: true });
    kids.push(
      { type: "row", key: "status-bar", gap: 6, padding: 3, align: "center", children: [
        { type: "label", key: "path", text: title, size: "xs", color: "muted", tooltip: title, grow: true },
        ...(markdown ? [{ type: "button", key: "markdown-mode", text: renderMarkdown ? "Source" : "Preview", action: "toggleMarkdown", small: true, variant: "ghost", tooltip: renderMarkdown ? "Show Markdown source" : "Render Markdown preview" } as UiNode] : []),
        { type: "label", key: "lang", text: current && showMetadata ? `${current.language} · ${current.size} B${current.truncated ? " (truncated)" : ""}` : "", size: "xs", color: "muted" },
      ] }
    );
    return { type: "column", key: "viewer-root", gap: 3, padding: 4, grow: true, children: kids };
  },
  async onEvent(ctx, ev) {
    if (!ws) return;
    try {
      if (ev.action === "toggleMarkdown") {
        const next = !renderMarkdown;
        await ctx.modules.call("persistence", "settings.set", { key: "viewer.renderMarkdown", value: next });
        renderMarkdown = next; publishSettings();
      } else if (ev.action.startsWith("select:")) {
        const path = ev.action.slice(7);
        if (tabs.includes(path)) await ctx.modules.call("workspace", "view.patch", { workspaceId: ws.id, patch: { previewPath: path } });
      } else if (ev.action.startsWith("close:")) {
        const path = ev.action.slice(6), index = tabs.indexOf(path);
        if (index < 0) return;
        tabs.splice(index, 1);
        // Move selection before persisting tabs so the watcher cannot reopen the closed file.
        const previewPath = ws.view?.previewPath === path ? tabs[Math.min(index, tabs.length - 1)] || null : ws.view?.previewPath;
        await ctx.modules.call("workspace", "view.patch", { workspaceId: ws.id, patch: { previewPath, ui: { viewerTabs: [...tabs] } } });
      }
    } catch (e) { error = errMsg(e); }
    ctx.ui.invalidate();
  },
};
export default mod;
