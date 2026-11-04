import type { AppModule, ModuleContext, UiNode } from "../../../../sdk/types";
import type { GitBranch, GitBranches } from "../../../../sdk/git-branches";
import { errMsg } from "../../../../sdk/runtime";
import { uiIcons } from "../../../../sdk/ui-icons";

let workspaceId: string | null = null;
let catalog: GitBranches | null = null;
let open = false, loading = false, dirty = false;
let busy: string | null = null, error: string | null = null;
let query = "", tab: "local" | "remote" = "local";
let actionsFor: string | null = null;
let creating = false, source: string | null = null, branchName = "";
let epoch = 0, mutations = 0;

async function refresh(ctx: ModuleContext) {
  if (!workspaceId) return;
  if (loading || busy) { dirty = true; return; }
  const id = workspaceId, mine = ++epoch;
  dirty = false; loading = true; ctx.ui.invalidate();
  try {
    const result: GitBranches = await ctx.modules.call("git", "branches", { workspaceId: id }, { timeoutMs: 180000 });
    if (mine === epoch && id === workspaceId) { catalog = result; error = null; }
  } catch (e) { if (mine === epoch && id === workspaceId) error = errMsg(e); }
  finally {
    if (mine === epoch && id === workspaceId) {
      loading = false;
      if (dirty) void refresh(ctx);
    }
    ctx.ui.invalidate();
  }
}

async function mutate(ctx: ModuleContext, method: "checkout" | "createBranch", args: object) {
  if (!workspaceId || busy) return;
  const id = workspaceId;
  ++epoch; loading = false; busy = method === "checkout" ? "Checking out branch…" : "Creating branch…";
  error = null; mutations++; ctx.ui.invalidate();
  try {
    const result: GitBranches = await ctx.modules.call("git", method, { workspaceId: id, ...args }, { timeoutMs: 180000 });
    if (workspaceId !== id) return;
    ++epoch; catalog = result; open = false; creating = false; branchName = ""; actionsFor = null; dirty = false;
  } catch (e) { if (workspaceId === id) { error = errMsg(e); open = true; } }
  finally { mutations--; if (workspaceId === id) { busy = null; if (dirty) void refresh(ctx); } ctx.ui.invalidate(); }
}

const button = (key: string, text: string, action: string, extra: object = {}): UiNode => ({ type: "button", key, text, action, small: true, disabled: !!busy, ...extra });
function branchRow(branch: GitBranch): UiNode {
  return { type: "column", key: branch.ref, gap: 3, padding: 5, style: { radius: 8, ...(branch.current ? { background: "selection" } : {}) }, children: [
    { type: "row", key: "row", gap: 6, children: [
      button("checkout", branch.name, "checkout", { value: branch.ref, iconSvg: uiIcons["git-branch"], variant: "ghost", grow: true,
        disabled: !!busy || branch.current, tooltip: branch.current ? "Current branch" : `Check out ${branch.name}` }),
      ...(branch.current ? [{ type: "label", key: "current", text: "✓", color: "primary", size: "sm" } as UiNode] : []),
      button("actions", "⋮", "branchActions", { value: branch.ref, variant: "ghost", tooltip: `Actions for ${branch.name}` }),
    ] },
    ...(branch.worktree && !branch.current ? [{ type: "label", key: "worktree", text: "In another worktree", color: "muted", size: "xs", tooltip: branch.worktree } as UiNode] : []),
    ...(actionsFor === branch.ref ? [{ type: "row", key: "actions", gap: 4, children: [
      button("create-from", "Create branch from here", "createFrom", { value: branch.ref, iconSvg: uiIcons.plus, variant: "ghost" }),
    ] } as UiNode] : []),
  ] };
}

const mod: AppModule = {
  id: "git-branch", moduleApiVersion: 1,
  async activate(ctx, previous) {
    workspaceId = (ctx.state.get("workspace.selected") as any)?.id || null;
    if (previous?.workspaceId === workspaceId) {
      catalog = previous.catalog || null; query = previous.query || ""; tab = previous.tab === "remote" ? "remote" : "local";
    }
    ctx.state.watch("workspace.selected", (value: any) => {
      const next = value?.id || null;
      if (next === workspaceId) return;
      ++epoch; workspaceId = next; catalog = null; open = false; loading = false; dirty = false; busy = null; error = null;
      query = ""; tab = "local"; creating = false; source = null; branchName = ""; actionsFor = null;
      ctx.ui.invalidate(); void refresh(ctx);
    });
    ctx.events.on("git.changed", (event: any) => { if (event.workspaceId === workspaceId) void refresh(ctx); });
    await refresh(ctx);
  },
  deactivate() { ++epoch; },
  canSwap: () => ({ ok: mutations === 0, ...(mutations ? { reason: "A branch operation is in progress." } : {}) }),
  snapshot: () => ({ workspaceId, catalog, query, tab }),
  render(): UiNode {
    const list = catalog?.[tab] || [];
    const filtered = list.filter(b => b.name.toLowerCase().includes(query.trim().toLowerCase()));
    const title = !workspaceId ? "No workspace" : !catalog ? error ? "Git unavailable" : "Git…" : !catalog.repo ? "No repository" : catalog.current || (catalog.head ? `Detached ${catalog.head}` : "No commits");
    const children: UiNode[] = [
      { type: "row", key: "header", gap: 6, children: [
        { type: "column", key: "heading", gap: 3, grow: true, children: [
          { type: "label", key: "title", text: "Switch branch", weight: "semibold" },
          { type: "label", key: "hint", text: `Current: ${title}`, color: "muted", size: "xs", wrap: true },
        ] },
        button("refresh", "", "refresh", { iconSvg: uiIcons.refresh, variant: "ghost", tooltip: "Refresh local and remote-tracking branches", disabled: loading || !!busy }),
      ] },
      { type: "textInput", key: "branch-search", value: query, placeholder: "Find a branch…", prefixSvg: uiIcons.search, changeAction: "filter", disabled: !!busy },
      { type: "row", key: "tabs", gap: 6, children: [
        button("local", `Local ${catalog?.local.length || 0}`, "tab", { value: "local", variant: tab === "local" ? "primary" : "ghost" }),
        button("remote", `Remote ${catalog?.remote.length || 0}`, "tab", { value: "remote", variant: tab === "remote" ? "primary" : "ghost" }),
      ] },
      { type: "divider", key: "divider" },
    ];
    if (error) children.push({ type: "status", key: "error", text: error, level: "error" });
    if (busy || loading) children.push({ type: "progress", key: "loading", indeterminate: true, label: busy || "Refreshing branches…" });
    children.push({ type: "scroll", key: "branches", height: Math.min(260, Math.max(48, filtered.length * 48)), children: filtered.map(branchRow) });
    if (!filtered.length) children.push({ type: "label", key: "empty", text: query ? "No matching branches." : tab === "remote" ? "No remote-tracking branches. Fetch using Git to update this list." : "No local branches.", color: "muted", size: "sm", wrap: true });
    if (creating) children.push({ type: "column", key: "create-form", gap: 5, children: [
      { type: "label", key: "from", text: source ? `From ${source.replace(/^refs\/(heads|remotes)\//, "")}` : "From the current HEAD", size: "xs", color: "muted" },
      { type: "textInput", key: "new-branch-name", value: branchName, placeholder: "feature/welcome", changeAction: "branchName", submitAction: "createBranch", disabled: !!busy },
      { type: "row", key: "create-actions", gap: 6, children: [button("create", "Create & checkout", "createBranch", { variant: "primary", disabled: !!busy || !branchName.trim() }), button("cancel", "Cancel", "cancelCreate", { variant: "ghost" })] },
    ] });
    children.push({ type: "divider", key: "footer-divider" }, { type: "row", key: "footer", gap: 5, children: [
      button("new", "Create a branch", "showCreate", { iconSvg: uiIcons.plus, variant: "ghost", grow: true }),
      { type: "label", key: "esc", text: "esc to close", color: "muted", size: "xs" },
    ] });
    return { type: "dropdown", key: "branch-menu", text: `${title}  ⌄`, iconSvg: uiIcons["git-branch"], variant: "ghost", action: "toggle", open,
      disabled: !workspaceId || catalog?.repo === false, menuWidth: 440, maxHeight: 620, tooltip: `Current branch: ${title}${error ? `\n${error}` : ""}`,
      style: { background: "transparent", borderWidth: 0 }, children };
  },
  async onEvent(ctx, event) {
    if (event.action === "toggle") { open = !!event.value; if (open) { error = null; void refresh(ctx); } ctx.ui.invalidate(); return; }
    if (busy) return;
    switch (event.action) {
      case "filter": query = String(event.value || ""); actionsFor = null; break;
      case "tab": tab = event.value === "remote" ? "remote" : "local"; actionsFor = null; break;
      case "refresh": await refresh(ctx); return;
      case "branchActions": actionsFor = actionsFor === event.value ? null : String(event.value); break;
      case "showCreate": creating = true; source = null; branchName = ""; break;
      case "createFrom": creating = true; source = String(event.value); branchName = ""; actionsFor = null; break;
      case "cancelCreate": creating = false; branchName = ""; break;
      case "branchName": branchName = String(event.value || ""); break;
      case "checkout": await mutate(ctx, "checkout", { ref: event.value }); return;
      case "createBranch": {
        branchName = event.inputs?.["new-branch-name"] ?? branchName;
        if (!branchName.trim()) { error = "Enter a branch name."; break; }
        await mutate(ctx, "createBranch", { name: branchName.trim(), from: source }); return;
      }
    }
    ctx.ui.invalidate();
  },
};
export default mod;
