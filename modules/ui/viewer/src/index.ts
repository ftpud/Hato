// viewer: a native syntax-highlighted source editor bound to a kernel document handle, with
// autosave through the files service. Highlighting, editing and selection are native; the module
// owns save policy (debounce, conflicts, retries). Tabs prefixed by DIFF_TAB_PREFIX show a native
// Git diff of that file instead (opened by git-panel).
import type { AppModule, ModuleContext, UiNode } from "../../../../sdk/types";
import { fileIcons } from "../../../../sdk/file-icons";
import { fileTabStyle, tabButtonStyle } from "../../../../sdk/tab-style";
import { exportSettings } from "../../../../sdk/settings";
import { errMsg } from "../../../../sdk/runtime";
import { resolveWorkspaceLink } from "../../../../sdk/links";
import { diffTabPath } from "../../../../sdk/git";
import { uiIcons } from "../../../../sdk/ui-icons";

let showMetadata = true;
let renderMarkdown = true;
let diffMode: "split" | "unified" = "split";
let publishSettings: () => void = () => {};
let ws: any = null;
let current: any = null;
let error: string | null = null;
let loadingPath: string | null = null;

let editable = true;
let autosave = true;
let autosaveDelay = 800;
const AUTOSAVE_DELAYS = [300, 800, 2000, 5000];

// Edits keyed by document handle so a debounced change that lands after a tab switch still
// saves the right file. `mtime` is the on-disk version this buffer is based on.
interface Buffer { workspaceId: string; path: string; mtime: number | null; text: string | null;
  state: "clean" | "dirty" | "saving" | "error" | "conflict"; error?: string; inflight?: boolean; again?: boolean }
const buffers = new Map<string, Buffer>();
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function bufferFor(path: string | null | undefined): Buffer | undefined {
  if (!path || !ws) return undefined;
  for (const b of buffers.values()) if (b.workspaceId === ws.id && b.path === path) return b;
  return undefined;
}
const unsaved = (b?: Buffer) => !!b && b.state !== "clean";

async function save(ctx: ModuleContext, b: Buffer, force = false) {
  if (b.text === null) return;
  if (b.inflight) { b.again = true; return; }
  b.inflight = true; b.again = false; b.state = "saving"; ctx.ui.invalidate();
  const text = b.text;
  try {
    const r = await ctx.modules.call("files", "save", { workspaceId: b.workspaceId, relativePath: b.path, text, expectedMtime: b.mtime, force }, { timeoutMs: 600000 });
    b.mtime = r?.mtime ?? b.mtime;
    if (b.text === text) { b.state = "clean"; b.text = null; } else b.state = "dirty";
    b.error = undefined;
  } catch (e: any) {
    const msg = errMsg(e);
    b.state = e?.code === "ECONFLICT" || /changed on disk/.test(msg) ? "conflict" : "error";
    b.error = msg; b.again = false;
  } finally {
    b.inflight = false;
    if (b.again && b.state === "dirty") void save(ctx, b);
    ctx.ui.invalidate();
  }
}
function scheduleSaves(ctx: ModuleContext, now = false) {
  if (saveTimer) clearTimeout(saveTimer);
  const run = () => { saveTimer = null; for (const b of buffers.values()) if (b.state === "dirty") void save(ctx, b); };
  if (now) run(); else saveTimer = setTimeout(run, autosaveDelay);
}

let tabs: string[] = [];
let generation = 0;
function restoreTabs() {
  const saved = ws?.view?.ui?.viewerTabs;
  tabs = Array.isArray(saved) ? saved.filter((p: unknown) => typeof p === "string") : [];
}
async function saveTabs(ctx: ModuleContext) {
  await ctx.modules.call("workspace", "view.patch", { workspaceId: ws.id, patch: { ui: { viewerTabs: [...tabs] } } });
}
async function load(ctx: ModuleContext, force = false) {
  const path = ws?.view?.previewPath || null;
  const workspaceId = ws?.id;
  if (!workspaceId || !path) { generation++; loadingPath = null; current = null; error = null; ctx.ui.invalidate(); return; }
  if (!tabs.includes(path)) { tabs.push(path); await saveTabs(ctx); }
  if (ws?.id !== workspaceId || ws?.view?.previewPath !== path) return;
  if (!force && current?.workspaceId === workspaceId && current.tab === path || loadingPath === path) return;
  const mine = ++generation;
  // A forced reload (diff refresh) keeps the current view until the new one arrives.
  if (!force) current = null;
  error = null; loadingPath = path; ctx.ui.invalidate();
  try {
    const diffPath = diffTabPath(path);
    const r = diffPath
      ? { ...(await ctx.modules.call("git", "diff", { workspaceId, path: diffPath }, { timeoutMs: 45000 })), diff: true, relativePath: diffPath }
      : await ctx.modules.call("files", "open", { workspaceId, relativePath: path });
    if (mine === generation) {
      current = { ...r, workspaceId, tab: path }; error = null;
      if (!r.diff && r.document && !buffers.has(r.document)) {
        // A fresh handle replaces any older clean buffer for the same file.
        for (const [doc, b] of buffers) if (b.workspaceId === workspaceId && b.path === r.relativePath && b.state === "clean") buffers.delete(doc);
        buffers.set(r.document, { workspaceId, path: r.relativePath, mtime: r.mtime ?? null, text: null, state: "clean" });
      }
    }
  } catch (e) { if (mine === generation) { error = errMsg(e); current = null; } }
  finally { if (mine === generation) loadingPath = null; ctx.ui.invalidate(); }
}

function tabLabel(tab: string) {
  const file = diffTabPath(tab) ?? tab;
  const name = file.split("/").pop() || file;
  return diffTabPath(tab) ? `Δ ${name}` : unsaved(bufferFor(tab)) ? `● ${name}` : name;
}

/** Reload the open file when it changed on disk and has no unsaved edits. */
async function refreshFromDisk(ctx: ModuleContext) {
  if (!current || current.diff || current.binary || !ws) return;
  const b = buffers.get(current.document);
  if (!b || b.state !== "clean" || b.inflight) return;
  const st = await ctx.modules.call("files", "stat", { workspaceId: ws.id, relativePath: current.relativePath }).catch(() => null);
  if (!st || st.error || st.mtime == null || st.mtime === b.mtime) return;
  if (buffers.get(current?.document) === b && b.state === "clean") void load(ctx, true);
}

function saveStatus(b: Buffer | undefined): { text: string; color: string; tooltip?: string } {
  if (!b) return { text: "", color: "muted" };
  switch (b.state) {
    case "saving": return { text: "Saving…", color: "muted" };
    case "dirty": return { text: autosave ? "Edited" : "Unsaved", color: autosave ? "muted" : "warning" };
    case "error": return { text: "Save failed", color: "danger", tooltip: b.error };
    case "conflict": return { text: "Changed on disk", color: "warning", tooltip: b.error };
    default: return { text: b.mtime != null ? "Saved" : "", color: "muted" };
  }
}

const mod: AppModule = {
  id: "viewer",
  moduleApiVersion: 1,
  async activate(ctx, prev) {
    const saved = await ctx.modules.call("persistence", "settings.get", { key: "viewer.showMetadata" });
    showMetadata = typeof saved === "boolean" ? saved : true;
    const savedMarkdown = await ctx.modules.call("persistence", "settings.get", { key: "viewer.renderMarkdown" });
    renderMarkdown = typeof savedMarkdown === "boolean" ? savedMarkdown : true;
    const savedDiffMode = await ctx.modules.call("persistence", "settings.get", { key: "viewer.diffMode" });
    diffMode = savedDiffMode === "unified" ? "unified" : "split";
    const savedEditable = await ctx.modules.call("persistence", "settings.get", { key: "viewer.editable" });
    editable = typeof savedEditable === "boolean" ? savedEditable : true;
    const savedAutosave = await ctx.modules.call("persistence", "settings.get", { key: "viewer.autosave" });
    autosave = typeof savedAutosave === "boolean" ? savedAutosave : true;
    const savedDelay = await ctx.modules.call("persistence", "settings.get", { key: "viewer.autosaveDelay" });
    autosaveDelay = AUTOSAVE_DELAYS.includes(Number(savedDelay)) ? Number(savedDelay) : 800;
    for (const [doc, b] of Object.entries(prev?.buffers || {}) as [string, Buffer][]) buffers.set(doc, { ...b, inflight: false, again: false });
    publishSettings = exportSettings(ctx, () => [{ key: "viewer", title: "Source editor", fields: [
      { key: "editable", label: "Edit files", type: "toggle", value: editable,
        description: "Allow editing in the source panel. The first save in a workspace asks for write access." },
      { key: "autosave", label: "Autosave", type: "toggle", value: autosave,
        description: "Save edits automatically after you stop typing. When off, use Save in the status bar." },
      { key: "autosaveDelay", label: "Autosave delay", type: "select", value: String(autosaveDelay),
        options: AUTOSAVE_DELAYS.map(ms => ({ value: String(ms), label: ms < 1000 ? `${ms} ms` : `${ms / 1000} s` })),
        description: "Quiet time after the last keystroke before saving." },
      { key: "showMetadata", label: "Show file metadata", type: "toggle", value: showMetadata,
        description: "Display the language and file size in the bottom status bar." },
      { key: "renderMarkdown", label: "Preview Markdown files", type: "toggle", value: renderMarkdown,
        description: "Render Markdown documents. Switch between Preview and Source in the viewer status bar." },
      { key: "diffMode", label: "Diff layout", type: "select", value: diffMode,
        options: [{ value: "split", label: "Side by side" }, { value: "unified", label: "Unified" }],
        description: "How Git diffs are compared. Switch in the viewer status bar." },
    ] }], async (_section, key, value) => {
      if (key === "diffMode") {
        if (value !== "split" && value !== "unified") throw new Error("Invalid diff layout");
        await ctx.modules.call("persistence", "settings.set", { key: "viewer.diffMode", value });
        diffMode = value; return;
      }
      if (key === "autosaveDelay") {
        const ms = Number(value);
        if (!AUTOSAVE_DELAYS.includes(ms)) throw new Error("Invalid autosave delay");
        await ctx.modules.call("persistence", "settings.set", { key: "viewer.autosaveDelay", value: ms });
        autosaveDelay = ms; return;
      }
      if (!["showMetadata", "renderMarkdown", "editable", "autosave"].includes(key) || typeof value !== "boolean") throw new Error("Invalid viewer setting");
      await ctx.modules.call("persistence", "settings.set", { key: `viewer.${key}`, value });
      if (key === "showMetadata") showMetadata = value;
      else if (key === "renderMarkdown") renderMarkdown = value;
      else if (key === "editable") editable = value;
      else { autosave = value; if (value) scheduleSaves(ctx); }
      ctx.ui.invalidate();
    });
    ws = ctx.state.get("workspace.selected") || null;
    restoreTabs();
    // Keep an open diff current as the working tree changes.
    ctx.events.on("git-panel.statusChanged", (e: any) => {
      if (current?.diff && e?.workspaceId === ws?.id && ws?.view?.previewPath === current.tab) void load(ctx, true);
    });
    ctx.events.on("files.changed", (e: any) => { if (e?.workspaceId === ws?.id) void refreshFromDisk(ctx); });
    ctx.state.watch("workspace.selected", (v: any) => {
      const changed = ws?.id !== v?.id; ws = v;
      if (changed) { generation++; current = null; loadingPath = null; restoreTabs(); }
      void load(ctx);
    });
    await load(ctx);
  },
  async deactivate(ctx) {
    // Flush pending edits before a hot swap; unsaved buffers also survive in the snapshot.
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    if (autosave) await Promise.all([...buffers.values()].filter(b => b.state === "dirty").map(b => save(ctx, b)));
  },
  snapshot: () => ({ current, buffers: Object.fromEntries([...buffers].filter(([, b]) => b.state !== "clean" || b.mtime != null).map(([d, b]) => [d, { ...b, inflight: false }])) }),
  render(): UiNode {
    const diff = !!current?.diff;
    const markdown = current && !diff && !current.binary && (current.language === "markdown" || /\.(md|markdown)$/i.test(current.relativePath));
    const title = current ? (diff ? `Changes in ${current.relativePath}` : current.relativePath) : ws?.view?.previewPath || "No file selected";
    const kids: UiNode[] = [
      { type: "row", key: "tabs", gap: 3, wrap: true, children: tabs.map((path): UiNode => ({ type: "row", key: path, gap: 0, style: fileTabStyle(ws?.view?.previewPath === path), children: [
        { type: "button", key: "select", iconSvg: fileIcons.file, text: tabLabel(path), tooltip: diffTabPath(path) ? `Changes in ${diffTabPath(path)}` : path, action: `select:${path}`, small: true, variant: "ghost", style: tabButtonStyle(ws?.view?.previewPath === path) },
        { type: "button", key: "close", text: "", iconSvg: uiIcons["x"], tooltip: `Close ${path}`, action: `close:${path}`, small: true, variant: "ghost", style: tabButtonStyle(ws?.view?.previewPath === path) },
      ] })) },

    ];
    if (error) kids.push({ type: "status", key: "err", text: error, level: "error" });
    if (loadingPath) kids.push({ type: "progress", key: "ld", indeterminate: true, label: `Opening ${loadingPath}…` });
    if (current && current.binary) kids.push({ type: "status", key: "bin", text: current.message, level: "info" });
    if (diff) kids.push({ type: "diff", key: "diff", document: current.document, mode: diffMode, header: false, emptyText: "No changes against HEAD.", grow: true });
    else if (markdown && renderMarkdown) kids.push({ type: "markdown", key: "preview", document: current.document, linkAction: "openLink", grow: true });
    else {
      const canEdit = editable && !!current && !current.binary && !current.truncated && !!current.document;
      kids.push({ type: "codeViewer", key: "code", document: current && !current.binary ? current.document : null, placeholder: ws ? "Open a file from the explorer." : "Select a workspace.", grow: true,
        editable: canEdit, changeAction: canEdit ? "edit" : undefined, changeDebounceMs: 250 });
    }
    const buf = !diff && current?.document ? buffers.get(current.document) : undefined;
    const status = saveStatus(buf);
    kids.push(
      { type: "row", key: "status-bar", gap: 6, padding: 3, align: "center", children: [
        { type: "label", key: "path", text: title, size: "xs", color: "muted", tooltip: title, grow: true },
        ...(diff ? [
          { type: "button", key: "diff-mode", text: diffMode === "split" ? "Unified" : "Side by side", action: "toggleDiffMode", small: true, variant: "ghost", tooltip: "Switch diff layout" } as UiNode,
          ...(current.kind !== "deleted" ? [{ type: "button", key: "open-file", text: "Open file", action: "openFile", small: true, variant: "ghost", tooltip: `Open ${current.relativePath}` } as UiNode] : []),
        ] : []),
        ...(status.text ? [{ type: "label", key: "save-state", text: status.text, size: "xs", color: status.color, tooltip: status.tooltip } as UiNode] : []),
        ...(buf && (buf.state === "error" || (buf.state === "dirty" && !autosave)) ? [{ type: "button", key: "save", text: buf.state === "error" ? "Retry" : "Save", action: "save", small: true, variant: "ghost", tooltip: `Save ${current.relativePath}` } as UiNode] : []),
        ...(buf?.state === "conflict" ? [
          { type: "button", key: "overwrite", text: "Overwrite", action: "overwrite", small: true, variant: "ghost", tooltip: "Replace the file on disk with your edits" } as UiNode,
          { type: "button", key: "reload", text: "Reload", action: "reload", small: true, variant: "ghost", tooltip: "Discard your edits and load the file from disk" } as UiNode,
        ] : []),
        ...(markdown ? [{ type: "button", key: "markdown-mode", text: renderMarkdown ? "Source" : "Preview", action: "toggleMarkdown", small: true, variant: "ghost", tooltip: renderMarkdown ? "Show Markdown source" : "Render Markdown preview" } as UiNode] : []),
        { type: "label", key: "lang", text: diff ? (current.truncated ? "diff (truncated)" : "") : current && showMetadata ? `${current.language} · ${current.size} B${current.truncated ? " (truncated)" : ""}` : "", size: "xs", color: "muted" },
      ] }
    );
    return { type: "column", key: "viewer-root", gap: 3, padding: 4, grow: true, children: kids };
  },
  async onEvent(ctx, ev) {
    if (!ws) return;
    try {
      if (ev.action === "edit") {
        const v: any = ev.value || {};
        const b = typeof v.document === "string" ? buffers.get(v.document) : undefined;
        if (!b || typeof v.text !== "string") return;
        b.text = v.text;
        if (b.state === "clean" || b.state === "error") b.state = "dirty";
        if (autosave && b.state === "dirty") scheduleSaves(ctx);
      } else if (ev.action === "save") {
        const b = current?.document ? buffers.get(current.document) : undefined;
        if (b && b.text !== null) { b.state = "dirty"; await save(ctx, b); }
      } else if (ev.action === "overwrite") {
        const b = current?.document ? buffers.get(current.document) : undefined;
        if (b) await save(ctx, b, true);
      } else if (ev.action === "reload") {
        if (current?.document) buffers.delete(current.document);
        await load(ctx, true);
      } else if (ev.action === "toggleDiffMode") {
        const next = diffMode === "split" ? "unified" : "split";
        await ctx.modules.call("persistence", "settings.set", { key: "viewer.diffMode", value: next });
        diffMode = next; publishSettings();
      } else if (ev.action === "openFile" && current?.diff) {
        await ctx.modules.call("workspace", "view.patch", { workspaceId: ws.id, patch: { previewPath: current.relativePath } });
      } else if (ev.action === "toggleMarkdown") {
        const next = !renderMarkdown;
        await ctx.modules.call("persistence", "settings.set", { key: "viewer.renderMarkdown", value: next });
        renderMarkdown = next; publishSettings();
      } else if (ev.action === "openLink") {
        const base = current?.relativePath ? current.relativePath.split("/").slice(0, -1).join("/") : "";
        const path = resolveWorkspaceLink(String(ev.value || ""), ws.rootAbsolutePath, base);
        if (!path) throw new Error(`Cannot open link outside the workspace: ${ev.value}`);
        await ctx.modules.call("workspace", "view.patch", { workspaceId: ws.id, patch: { previewPath: path } });
      } else if (ev.action.startsWith("select:")) {
        const path = ev.action.slice(7);
        if (tabs.includes(path)) await ctx.modules.call("workspace", "view.patch", { workspaceId: ws.id, patch: { previewPath: path } });
      } else if (ev.action.startsWith("close:")) {
        const path = ev.action.slice(6), index = tabs.indexOf(path);
        if (index < 0) return;
        // Closing a tab commits its edits even when autosave is off.
        const pending = bufferFor(path);
        if (pending?.state === "dirty") void save(ctx, pending);
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
