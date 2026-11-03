// git-changes: a single window (no tabs) with a live diff. By default it shows only the most
// recent update — what the last edit changed compared with the previous version — and can
// switch to every uncommitted change against HEAD. Refreshes on Git/file notifications.
import type { AppModule, ModuleContext, UiNode } from "../../../../sdk/types";
import { errMsg } from "../../../../sdk/runtime";
import { exportSettings } from "../../../../sdk/settings";
import { uiIcons } from "../../../../sdk/ui-icons";

type Scope = "latest" | "all";
interface Result { workspaceId: string; repo: boolean; document: string | null; empty: boolean; truncated?: boolean;
  /** latest: changed paths in the last update; all: number of changed files. */ files: string[] | number;
  at?: string | null; baseline?: boolean }

let ws: any = null;
let result: (Result & { scope: Scope }) | null = null;
let error: string | null = null;
let loading = false, dirty = false, visible = false;
let autoRefresh = true;
let mode: "split" | "unified" = "unified";
let scope: Scope = "latest";
let epoch = 0;
let publishSettings: () => void = () => {};

async function refresh(ctx: ModuleContext) {
  if (!ws || !visible || loading) { dirty = true; return; }
  dirty = false;
  const mine = ++epoch, workspaceId = ws.id, want = scope;
  loading = true; ctx.ui.invalidate();
  try {
    const r: Result = await ctx.modules.call("git", want === "latest" ? "latestChange" : "diffAll", { workspaceId }, { timeoutMs: 60000 });
    if (mine !== epoch || ws?.id !== workspaceId) return;
    result = { ...r, scope: want }; error = null;
  } catch (e) { if (mine === epoch) error = errMsg(e); }
  finally {
    if (mine === epoch) { loading = false; if (dirty && visible) void refresh(ctx); }
    ctx.ui.invalidate();
  }
}

async function save(ctx: ModuleContext, key: string, value: any) {
  await ctx.modules.call("persistence", "settings.set", { key: `git-changes.${key}`, value });
}

function summary(r: (Result & { scope: Scope }) | null): string {
  if (!r) return "Loading…";
  if (!r.repo) return "Not a Git repository";
  if (r.scope === "all") { const n = r.files as number; return r.empty ? "No uncommitted changes" : `All changes · ${n} ${n === 1 ? "file" : "files"}${r.truncated ? " (truncated)" : ""}`; }
  const files = r.files as string[];
  if (r.empty) return "No changes yet — waiting for the next update";
  const names = files.length === 1 ? files[0] : `${files.length} files`;
  const time = r.at ? new Date(r.at).toLocaleTimeString() : "";
  return `${r.baseline ? "Last modified" : "Last update"} · ${names}${time ? " · " + time : ""}`;
}

const mod: AppModule = {
  id: "git-changes",
  moduleApiVersion: 1,
  async activate(ctx, prev) {
    const get = (key: string) => ctx.modules.call("persistence", "settings.get", { key: `git-changes.${key}` });
    const [savedAuto, savedMode, savedScope] = await Promise.all([get("autoRefresh"), get("diffMode"), get("scope")]);
    autoRefresh = typeof savedAuto === "boolean" ? savedAuto : true;
    mode = savedMode === "split" ? "split" : "unified";
    scope = savedScope === "all" ? "all" : "latest";
    publishSettings = exportSettings(ctx, () => [{ key: "git-changes", title: "Latest changes", fields: [
      { key: "scope", label: "Show", type: "select", value: scope,
        options: [{ value: "latest", label: "Only the latest update" }, { value: "all", label: "All uncommitted changes" }],
        description: "Latest update compares each file with its previous version; all changes compare with HEAD." },
      { key: "autoRefresh", label: "Automatic refresh", type: "toggle", value: autoRefresh,
        description: "Update the diff when files or repository metadata change." },
      { key: "diffMode", label: "Diff layout", type: "select", value: mode,
        options: [{ value: "unified", label: "Unified" }, { value: "split", label: "Side by side" }] },
    ] }], async (_section, key, value) => {
      if (key === "autoRefresh" && typeof value === "boolean") { await save(ctx, key, value); autoRefresh = value; if (value) void refresh(ctx); return; }
      if (key === "diffMode" && (value === "split" || value === "unified")) { await save(ctx, key, value); mode = value; ctx.ui.invalidate(); return; }
      if (key === "scope" && (value === "latest" || value === "all")) { await save(ctx, key, value); scope = value; result = null; void refresh(ctx); return; }
      throw new Error("Invalid Latest changes setting");
    });
    ws = ctx.state.get("workspace.selected") || null;
    if (prev?.result && prev.result.workspaceId === ws?.id && prev.result.scope === scope) result = prev.result;
    visible = !!(ctx.state.get("workspace-layout.panels") as any)?.["git-changes"];
    ctx.events.on("git.changed", (event: any) => {
      if (event.workspaceId !== ws?.id || !autoRefresh) return;
      dirty = true; if (visible) void refresh(ctx);
    });
    ctx.state.watch("workspace-layout.panels", (v: any) => {
      const next = !!v?.["git-changes"];
      if (next === visible) return;
      visible = next;
      if (visible && (dirty || !result)) void refresh(ctx);
    });
    ctx.state.watch("workspace.selected", (v: any) => {
      const changed = ws?.id !== v?.id; ws = v;
      if (!changed) return;
      epoch++; loading = false; result = null; error = null; dirty = true;
      void refresh(ctx);
    });
    await refresh(ctx);
  },
  deactivate() { epoch++; loading = false; },
  snapshot: () => ({ result }),
  render(): UiNode {
    if (!ws) return { type: "column", key: "gc-root", padding: 8, grow: true, children: [{ type: "label", key: "none", text: "Select a project or task.", color: "muted" }] };
    const current = result?.workspaceId === ws.id ? result : null;
    const text = summary(current);
    const children: UiNode[] = [{ type: "row", key: "tools", gap: 4, align: "center", children: [
      { type: "label", key: "summary", text, size: "xs", color: "muted", grow: true, tooltip: current?.baseline ? "Nothing has changed since this panel opened; showing the most recently modified file against HEAD." : text },
      { type: "button", key: "scope", text: scope === "latest" ? "Show all" : "Latest only", action: "toggleScope", small: true, variant: "ghost",
        tooltip: scope === "latest" ? "Show every uncommitted change against HEAD" : "Show only the most recent update" },
      { type: "button", key: "mode", text: mode === "split" ? "Unified" : "Side by side", action: "toggleMode", small: true, variant: "ghost", tooltip: "Switch diff layout" },
      { type: "button", key: "refresh", text: "", iconSvg: uiIcons["refresh"], action: "refresh", small: true, variant: "ghost", disabled: loading, tooltip: "Refresh now" },
    ] }];
    if (error) children.push({ type: "status", key: "err", text: error, level: "error" });
    if (loading && !current) children.push({ type: "progress", key: "loading", indeterminate: true });
    if (current?.repo) children.push({ type: "diff", key: "diff", document: current.document, mode, header: true,
      emptyText: scope === "latest" ? "Waiting for the next change." : "No changes against HEAD.",
      placeholder: scope === "latest" ? "Waiting for the next change." : "No changes against HEAD.", grow: true });
    return { type: "column", key: "gc-root", gap: 4, padding: 6, grow: true, children };
  },
  async onEvent(ctx, ev) {
    try {
      if (ev.action === "refresh") { dirty = true; await refresh(ctx); return; }
      if (ev.action === "toggleMode") {
        const next = mode === "split" ? "unified" : "split";
        await save(ctx, "diffMode", next); mode = next; publishSettings();
      } else if (ev.action === "toggleScope") {
        const next: Scope = scope === "latest" ? "all" : "latest";
        await save(ctx, "scope", next); scope = next; result = null; publishSettings();
        epoch++; loading = false; await refresh(ctx); return;
      }
    } catch (e) { error = errMsg(e); }
    ctx.ui.invalidate();
  },
};
export default mod;
