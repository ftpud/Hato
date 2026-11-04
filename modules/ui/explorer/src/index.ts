// Workspace file tree: lazy directory loading, scoped search, and viewer selection.
import type { AppModule, ModuleContext, UiNode } from "../../../../sdk/types";
import { debounce, errMsg } from "../../../../sdk/runtime";
import { directories, fileIcon, treeRows, type Entry } from "./model";
import { fileIcons } from "../../../../sdk/file-icons";
import type { TreeRow } from "../../../../sdk/types";
import { uiIcons } from "../../../../sdk/ui-icons";
let ws: any = null;
let dirs = new Map<string, Entry[]>();
let expanded = new Set<string>();
let filterCollapsed = new Set<string>();
let pending = new Set<string>();
let query = "";
let results: any = null;
let searching = false;
let error: string | null = null;
let epoch = 0;
let searchVersion = 0;
let searchSoon: () => void = () => {};
/** Filter text searches file contents instead of paths. */
let contentMode = false;
/** .gitignored files are hidden unless the user shows them. */
let showIgnored = false;
let grep: any = null;
let grepCollapsed = new Set<string>();
let grepSoon: () => void = () => {};

async function loadDir(ctx: ModuleContext, path: string, version = epoch) {
  if (!ws || pending.has(path) || dirs.has(path)) return;
  const workspaceId = ws.id;
  pending.add(path); ctx.ui.invalidate();
  try {
    const listing = await ctx.modules.call("files", "list", { workspaceId, relativeDir: path, showHidden: true, hideIgnored: !showIgnored });
    if (version === epoch) { dirs.set(path, listing.entries.filter((entry: Entry) => entry.name !== ".DS_Store")); error = null; }
  } catch (e) { if (version === epoch) error = errMsg(e); }
  finally { if (version === epoch) pending.delete(path); ctx.ui.invalidate(); }
}
async function search(ctx: ModuleContext, refresh = false) {
  const version = ++searchVersion;
  const workspaceId = ws?.id;
  const text = query.trim();
  if (!workspaceId || !text) { results = null; searching = false; ctx.ui.invalidate(); return; }
  searching = true; ctx.ui.invalidate();
  try {
    const next = contentMode
      ? await ctx.modules.call("files", "grep", { workspaceId, query: text, hideIgnored: !showIgnored }, { timeoutMs: 120000 })
      : await ctx.modules.call("files", "search", { workspaceId, query: text, refresh, hideIgnored: !showIgnored }, { timeoutMs: 120000 });
    if (contentMode && version === searchVersion && ws?.id === workspaceId) { grep = next; results = null; error = null; return; }
    if (version === searchVersion && ws?.id === workspaceId) { results = next; error = null; }
  } catch (e) { if (version === searchVersion && ws?.id === workspaceId) { error = errMsg(e); results = null; } }
  finally { if (version === searchVersion) searching = false; ctx.ui.invalidate(); }
}
/** Content matches: one expandable row per file, one child row per matching line. */
function grepRows(): TreeRow[] {
  const out: TreeRow[] = [];
  const selected = ws?.view?.previewPath || null;
  for (const f of grep?.files || []) {
    const name = f.relativePath.split("/").pop() || f.relativePath;
    const dir = f.relativePath.slice(0, Math.max(0, f.relativePath.length - name.length - 1));
    const open = !grepCollapsed.has(f.relativePath);
    out.push({ key: f.relativePath, label: name, detail: dir || undefined, badge: String(f.matches.length), depth: 0, expandable: true, expanded: open, selected: f.relativePath === selected,
      iconSvg: fileIcons[fileIcon({ name, kind: "file", relativePath: f.relativePath }) as keyof typeof fileIcons] || fileIcons.file, weight: "medium" });
    if (open) for (const m of f.matches) out.push({ key: `${f.relativePath}#${m.line}`, label: m.text || " ", badge: String(m.line), depth: 1, expandable: false, expanded: false, selected: false });
  }
  return out;
}
async function reveal(ctx: ModuleContext) {
  const path = ws?.view?.previewPath;
  if (!path) return;
  const version = epoch;
  query = ""; results = null; searchVersion++; searching = false;
  const parts = path.split("/"); parts.pop();
  let parent = "";
  for (const part of parts) { parent = parent ? parent + "/" + part : part; expanded.add(parent); await loadDir(ctx, parent, version); if (version !== epoch) return; }
  ctx.ui.invalidate();
}
async function reset(ctx: ModuleContext, saved?: any) {
  const version = ++epoch; searchVersion++; ctx.ui.invalidate(); dirs = new Map(); pending = new Set(); filterCollapsed = new Set(); results = null; searching = false; error = null;
  expanded = new Set(saved?.expanded || ws?.view?.ui?.explorerTree?.expanded || []);
  query = saved?.query || ""; grep = null; grepCollapsed = new Set();
  if (saved && typeof saved.showIgnored === "boolean") showIgnored = saved.showIgnored;
  if (saved && typeof saved.contentMode === "boolean") contentMode = saved.contentMode;
  await loadDir(ctx, ".");
  if (version !== epoch) return;
  for (const path of [...expanded].sort()) { await loadDir(ctx, path, version); if (version !== epoch) return; }
  if (query) await search(ctx);
}
const mod: AppModule = {
  id: "explorer", moduleApiVersion: 1,
  async activate(ctx, prev) {
    searchSoon = debounce(() => { void search(ctx); }, 160);
    grepSoon = debounce(() => { void search(ctx); }, 450);
    ws = ctx.state.get("workspace.selected") || null;
    ctx.state.watch("workspace.selected", (next: any) => { const changed = ws?.id !== next?.id; ws = next; if (changed) void reset(ctx); else ctx.ui.invalidate(); });
    ctx.events.on("files.changed", (event: any) => {
      if (event.workspaceId !== ws?.id) return;
      // Keep expansion, query and selection when replacing stale directory listings.
      void reset(ctx, { expanded: [...expanded], query, showIgnored, contentMode });
    });
    const savedView = ws?.view?.ui?.explorerTree;
    await reset(ctx, prev?.workspaceId === ws?.id ? prev : savedView ? { showIgnored: !!savedView.showIgnored, contentMode: false } : null);
  },
  snapshot: () => ({ workspaceId: ws?.id || null, expanded: [...expanded], query, showIgnored, contentMode }),
  render(): UiNode {
    const filtering = !!query.trim();
    const grepping = filtering && contentMode;
    const rows = grepping ? grepRows() : treeRows(filtering ? directories(results?.entries || []) : dirs, expanded, ws?.view?.previewPath || null, filtering, filterCollapsed);
    const loaded = [...dirs.values()].reduce((count, entries) => count + entries.length, 0);
    const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
    const count = grepping ? searching ? "Searching file contents…" : query.trim().length < 2 ? "Type at least 2 characters" : `${plural(grep?.matchCount || 0, "match", "matches")} in ${plural(grep?.fileCount || 0, "file", "files")}${grep?.truncated ? " · first results" : ""}`
      : filtering ? searching ? "Searching workspace…" : `${plural(results?.matchCount || 0, "match", "matches")}${results?.partial ? " · partial results" : ""}` : `${loaded} items loaded`;
    const toggle = (key: string, icon: string, on: boolean, action: string, tooltip: string): UiNode => ({ type: "button", key, text: "", iconSvg: icon, action, small: true, variant: on ? "primary" : "ghost", tooltip, disabled: !ws });
    const children: UiNode[] = [
      { type: "row", key: "filter-bar", gap: 4, align: "center", children: [
        { type: "textInput", key: "file-filter", prefixSvg: contentMode ? uiIcons["text-search"] : uiIcons.search, placeholder: contentMode ? "Search in files" : "Filter files", value: query, changeAction: "filter", submitAction: "submitFilter", grow: true, disabled: !ws },
        ...(query ? [{ type: "button", key: "clear", text: "", iconSvg: uiIcons["x"], action: "clearFilter", small: true, variant: "ghost", tooltip: "Clear filter" } as UiNode] : []),
        toggle("content-mode", uiIcons["text-search"], contentMode, "toggleContent", contentMode ? "Searching file contents — click to filter by file name" : "Search the filter text inside files"),
        toggle("show-ignored", showIgnored ? uiIcons.eye : uiIcons["eye-off"], showIgnored, "toggleIgnored", showIgnored ? "Showing .gitignored files — click to hide them" : "Show .gitignored files"),
      ] },
    ];
    if (!ws) children.push({ type: "label", key: "none", text: "Select a project or task.", color: "muted", padding: 8 });
    else {
      children.push({ type: "row", key: "tools", gap: 4, children: [
        { type: "label", key: "count", text: count, size: "xs", color: "muted", grow: true, tooltip: filtering ? "Search covers workspace paths, excluding .git object storage. Very large workspaces show partial results." : "Folders load as you expand them; filtering searches the workspace." },
        { type: "button", key: "reveal", text: "", iconSvg: uiIcons["locate"], action: "reveal", small: true, variant: "ghost", disabled: !ws.view?.previewPath, tooltip: "Reveal selected file" },
        { type: "button", key: "collapse", text: "", iconSvg: uiIcons["collapse"], action: "collapseAll", small: true, variant: "ghost", tooltip: "Collapse all folders" },
        { type: "button", key: "refresh", text: "", iconSvg: uiIcons["refresh"], action: "refresh", small: true, variant: "ghost", tooltip: "Refresh files" },
      ] });
      if (error) children.push({ type: "status", key: "err", text: error, level: "error" });
      if (pending.size && !dirs.has(".")) children.push({ type: "progress", key: "loading", indeterminate: true });
      if (filtering && !searching && !rows.length && !error && !(grepping && query.trim().length < 2)) children.push({ type: "label", key: "empty", text: grepping ? "No files contain this text." : "No matching files.", color: "muted", padding: 12 });
      if (!filtering && !pending.size && !loaded) children.push({ type: "label", key: "empty", text: "This folder is empty.", color: "muted", padding: 12 });
      if (grepping) children.push({ type: "tree", key: "grep", rowHeight: 21, rowGap: 0, rows, selectAction: "openMatch", expandAction: "expandMatch", grow: true });
      else children.push({ type: "tree", key: "files", rowHeight: 21, rowGap: 0, rows: rows.map((row) => pending.has(row.key) ? { ...row, badge: "…" } : row), selectAction: "open", expandAction: "expand", grow: true });
    }
    return { type: "column", key: "explorer-root", gap: 4, padding: 8, grow: true, children };
  },
  async onEvent(ctx, ev) {
    if (!ws) return;
    const workspaceId = ws.id;
    const version = epoch;
    try {
      if (ev.action === "filter") {
        query = String(ev.value || ""); filterCollapsed.clear(); grepCollapsed.clear(); results = null; grep = null; searchVersion++;
        const go = contentMode ? query.trim().length >= 2 : !!query.trim();
        searching = go; if (go) (contentMode ? grepSoon : searchSoon)();
        ctx.ui.invalidate(); return;
      }
      if (ev.action === "submitFilter") { if (query.trim()) await search(ctx); return; }
      if (ev.action === "clearFilter") { query = ""; results = null; grep = null; searching = false; searchVersion++; ctx.ui.invalidate(); return; }
      if (ev.action === "toggleContent") { contentMode = !contentMode; results = null; grep = null; grepCollapsed.clear(); searchVersion++; if (query.trim()) await search(ctx); else ctx.ui.invalidate(); return; }
      if (ev.action === "toggleIgnored") {
        showIgnored = !showIgnored;
        await ctx.modules.call("workspace", "view.patch", { workspaceId, patch: { ui: { explorerTree: { expanded: [...expanded], showIgnored } } } });
        await reset(ctx, { expanded: [...expanded], query, showIgnored, contentMode });
        return;
      }
      if (ev.action === "expandMatch" && ev.rowKey) { if (grepCollapsed.has(ev.rowKey)) grepCollapsed.delete(ev.rowKey); else grepCollapsed.add(ev.rowKey); ctx.ui.invalidate(); return; }
      if (ev.action === "openMatch" && ev.rowKey) {
        const path = ev.rowKey.includes("#") ? ev.rowKey.slice(0, ev.rowKey.lastIndexOf("#")) : ev.rowKey;
        if (!ev.rowKey.includes("#") && grep?.files?.some((f: any) => f.relativePath === path) && ws.view?.previewPath === path) { if (grepCollapsed.has(path)) grepCollapsed.delete(path); else grepCollapsed.add(path); ctx.ui.invalidate(); return; }
        await ctx.modules.call("workspace", "view.patch", { workspaceId, patch: { previewPath: path } });
        return;
      }
      if (ev.action === "collapseAll") { expanded.clear(); query = ""; results = null; searchVersion++; searching = false; }
      else if (ev.action === "reveal") { await reveal(ctx); }
      else if (ev.action === "refresh") { const saved = await mod.snapshot!(ctx); await ctx.modules.call("files", "search", { workspaceId, query: "", refresh: true }); if (version !== epoch) return; await reset(ctx, saved); }
      else if (["open", "expand"].includes(ev.action) && ev.rowKey) {
        const entry = (query.trim() ? results?.entries : [...dirs.values()].flat())?.find((item: Entry) => item.relativePath === ev.rowKey);
        if (!entry) return;
        if (entry.kind === "dir") {
          if (query.trim()) { if (filterCollapsed.has(entry.relativePath)) filterCollapsed.delete(entry.relativePath); else filterCollapsed.add(entry.relativePath); }
          else if (expanded.has(entry.relativePath)) expanded.delete(entry.relativePath);
          else { expanded.add(entry.relativePath); await loadDir(ctx, entry.relativePath); }
        } else if (ev.action === "open") await ctx.modules.call("workspace", "view.patch", { workspaceId: ws.id, patch: { previewPath: entry.relativePath } });
      }
      if (version !== epoch) return;
      await ctx.modules.call("workspace", "view.patch", { workspaceId, patch: { ui: { explorerTree: { expanded: [...expanded], showIgnored } } } });
      error = null;
    } catch (e) { if (version === epoch) error = errMsg(e); }
    ctx.ui.invalidate();
  },
};
export default mod;
