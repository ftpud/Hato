// Workspace file tree: lazy directory loading, scoped search, and viewer selection.
import type { AppModule, ModuleContext, UiNode } from "../../../../sdk/types";
import { debounce, errMsg } from "../../../../sdk/runtime";
import { directories, treeRows, type Entry } from "./model";
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

async function loadDir(ctx: ModuleContext, path: string, version = epoch) {
  if (!ws || pending.has(path) || dirs.has(path)) return;
  const workspaceId = ws.id;
  pending.add(path); ctx.ui.invalidate();
  try {
    const listing = await ctx.modules.call("files", "list", { workspaceId, relativeDir: path, showHidden: true });
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
    const next = await ctx.modules.call("files", "search", { workspaceId, query: text, refresh }, { timeoutMs: 120000 });
    if (version === searchVersion && ws?.id === workspaceId) { results = next; error = null; }
  } catch (e) { if (version === searchVersion && ws?.id === workspaceId) { error = errMsg(e); results = null; } }
  finally { if (version === searchVersion) searching = false; ctx.ui.invalidate(); }
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
  query = saved?.query || "";
  await loadDir(ctx, ".");
  if (version !== epoch) return;
  for (const path of [...expanded].sort()) { await loadDir(ctx, path, version); if (version !== epoch) return; }
  if (query) await search(ctx);
}
const mod: AppModule = {
  id: "explorer", moduleApiVersion: 1,
  async activate(ctx, prev) {
    searchSoon = debounce(() => { void search(ctx); }, 160);
    ws = ctx.state.get("workspace.selected") || null;
    ctx.state.watch("workspace.selected", (next: any) => { const changed = ws?.id !== next?.id; ws = next; if (changed) void reset(ctx); else ctx.ui.invalidate(); });
    await reset(ctx, prev?.workspaceId === ws?.id ? prev : null);
  },
  snapshot: () => ({ workspaceId: ws?.id || null, expanded: [...expanded], query }),
  render(): UiNode {
    const filtering = !!query.trim();
    const rows = treeRows(filtering ? directories(results?.entries || []) : dirs, expanded, ws?.view?.previewPath || null, filtering, filterCollapsed);
    const loaded = [...dirs.values()].reduce((count, entries) => count + entries.length, 0);
    const count = filtering ? searching ? "Searching workspace…" : `${results?.matchCount || 0} ${(results?.matchCount || 0) === 1 ? "match" : "matches"}${results?.partial ? " · partial results" : ""}` : `${loaded} items loaded`;
    const children: UiNode[] = [
      { type: "row", key: "filter-bar", gap: 4, children: [
        { type: "textInput", key: "file-filter", search: true, placeholder: "Filter files", value: query, changeAction: "filter", grow: true, disabled: !ws },
        ...(query ? [{ type: "button", key: "clear", text: "", icon: "x", action: "clearFilter", small: true, variant: "ghost", tooltip: "Clear filter" } as UiNode] : []),
      ] },
    ];
    if (!ws) children.push({ type: "label", key: "none", text: "Select a project or task.", color: "muted", padding: 8 });
    else {
      children.push({ type: "row", key: "tools", gap: 4, children: [
        { type: "label", key: "count", text: count, size: "xs", color: "muted", grow: true, tooltip: filtering ? "Search covers workspace paths, excluding .git object storage. Very large workspaces show partial results." : "Folders load as you expand them; filtering searches the workspace." },
        { type: "button", key: "reveal", text: "", icon: "locate", action: "reveal", small: true, variant: "ghost", disabled: !ws.view?.previewPath, tooltip: "Reveal selected file" },
        { type: "button", key: "collapse", text: "", icon: "collapse", action: "collapseAll", small: true, variant: "ghost", tooltip: "Collapse all folders" },
        { type: "button", key: "refresh", text: "", icon: "refresh", action: "refresh", small: true, variant: "ghost", tooltip: "Refresh files" },
      ] });
      if (error) children.push({ type: "status", key: "err", text: error, level: "error" });
      if (pending.size && !dirs.has(".")) children.push({ type: "progress", key: "loading", indeterminate: true });
      if (filtering && !searching && !rows.length && !error) children.push({ type: "label", key: "empty", text: "No matching files.", color: "muted", padding: 12 });
      if (!filtering && !pending.size && !loaded) children.push({ type: "label", key: "empty", text: "This folder is empty.", color: "muted", padding: 12 });
      children.push({ type: "tree", key: "files", appearance: "files", rows: rows.map((row) => pending.has(row.key) ? { ...row, badge: "…" } : row), selectAction: "open", expandAction: "expand", grow: true });
    }
    return { type: "column", key: "explorer-root", gap: 4, padding: 8, grow: true, children };
  },
  async onEvent(ctx, ev) {
    if (!ws) return;
    const workspaceId = ws.id;
    const version = epoch;
    try {
      if (ev.action === "filter") { query = String(ev.value || ""); filterCollapsed.clear(); results = null; searchVersion++; searching = !!query.trim(); if (query.trim()) searchSoon(); else searching = false; ctx.ui.invalidate(); return; }
      if (ev.action === "clearFilter") { query = ""; results = null; searching = false; searchVersion++; ctx.ui.invalidate(); return; }
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
      await ctx.modules.call("workspace", "view.patch", { workspaceId, patch: { ui: { explorerTree: { expanded: [...expanded] } } } });
      error = null;
    } catch (e) { if (version === epoch) error = errMsg(e); }
    ctx.ui.invalidate();
  },
};
export default mod;
