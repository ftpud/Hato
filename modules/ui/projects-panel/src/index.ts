// projects-panel: left tree of projects and their Git task worktrees.
// Clicking a row selects a workspace; clicking the chevron expands/collapses (separate events).
import type { AppModule, ModuleContext, TreeRow, UiNode } from "../../../../sdk/types";
import { errMsg } from "../../../../sdk/runtime";
import { uiIcons } from "../../../../sdk/ui-icons";
import { projectsBranding } from "./branding";

let tree: any[] = [];
let selected: string | null = null;
let error: string | null = null;
let notice: string | null = null;
let busy: string | null = null;
let sshForm = false;
let addForm = false;
let filter = "";
let backgroundOpacity = 0.12;
let taskFormFor: string | null = null;
// workspaceId -> number of working AI chats (ai-sessions) and background agents (persistent-agents).
let chatBusy: Record<string, number> = {};
let agentBusy: Record<string, number> = {};
let aiBusy: Record<string, number> = {};
const busyText = (n: number) => `AI working${n > 1 ? ` (${n})` : ""}`;
// Busy rows swap their icon for a rotating spinner; frames only tick while something is working.
let frame = 0;
let animation: ReturnType<typeof setInterval> | null = null;
const spinnerSvg = () => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="8" opacity="0.2"/><path d="M12 4a8 8 0 0 1 8 8" stroke-linecap="round" transform="rotate(${frame * 30} 12 12)"/></svg>`;
function updateBusy(ctx: ModuleContext) {
  aiBusy = { ...chatBusy };
  for (const [k, n] of Object.entries(agentBusy)) aiBusy[k] = (aiBusy[k] || 0) + n;
  const working = Object.values(aiBusy).some((n) => n > 0);
  if (working && !animation) animation = setInterval(() => { frame = (frame + 1) % 12; ctx.ui.invalidate(); }, 80);
  else if (!working && animation) { clearInterval(animation); animation = null; }
  ctx.ui.invalidate();
}
const asCounts = (v: any): Record<string, number> => (v && typeof v === "object" ? v : {});

async function reload(ctx: ModuleContext) {
  try { tree = await ctx.modules.call("projects", "tree"); error = null; }
  catch (e) { error = errMsg(e); }
  ctx.ui.invalidate();
}

function rows(): TreeRow[] {
  const out: TreeRow[] = [];
  const query = filter.trim().toLowerCase();
  for (const p of tree) {
    const key = `project:${p.id}:root`;
    const projectMatches = !query || [p.name, p.rootPath, p.host].some(value => String(value || "").toLowerCase().includes(query));
    const tasks = projectMatches ? p.tasks : p.tasks.filter((task: any) => [task.name, task.branch].some(value => String(value || "").toLowerCase().includes(query)));
    if (!projectMatches && !tasks.length) continue;
    const location = p.kind === "ssh" ? `SSH · ${p.host || p.rootPath}` : p.rootPath;
    const open = !!query || p.expanded;
    // A collapsed project also reports activity in its hidden tasks.
    const busyCount = (aiBusy[key] || 0) + (open ? 0 : p.tasks.reduce((n: number, t: any) => n + (aiBusy[`task:${t.id}`] || 0), 0));
    out.push({
      key, label: p.name, depth: 0, expandable: tasks.length > 0, expanded: !!query || p.expanded, selected: selected === key,
      badge: p.offline ? "Offline" : tasks.length ? `${tasks.length} ${tasks.length === 1 ? "task" : "tasks"}` : undefined,
      detail: p.offline ? `Offline · ${p.offline}` : busyCount ? `${busyText(busyCount)} · ${location}` : location,
      icon: p.offline ? "warning" : p.kind === "ssh" ? "remote" : "folder",
      iconSvg: busyCount ? spinnerSvg() : p.offline ? uiIcons.warning : p.kind === "ssh" ? uiIcons.terminal : uiIcons.folder, iconColor: busyCount ? "primary" : "muted", weight: "semibold",
    });
    if (query || p.expanded) for (const [index, t] of tasks.entries()) {
      const tk = `task:${t.id}`;
      const taskBusy = aiBusy[tk] || 0;
      out.push({ key: tk, label: t.name, connector: index === tasks.length - 1 ? "last" : "branch", depth: 1, expandable: false, expanded: false, selected: selected === tk,
        badge: t.status !== "ready" ? t.status : undefined, detail: taskBusy ? `${busyText(taskBusy)} · ${t.branch}` : t.branch, icon: t.status === "ready" ? "task" : "warning",
        iconSvg: taskBusy ? spinnerSvg() : t.status === "ready" ? uiIcons["git-branch"] : uiIcons.warning, iconColor: taskBusy ? "primary" : "muted" });
    }
  }
  return out;
}

function selectedProject() {
  if (!selected) return null;
  const pm = /^project:(.+):root$/.exec(selected);
  if (pm) return tree.find((p) => p.id === pm[1]) || null;
  const tm = /^task:(.+)$/.exec(selected);
  if (tm) return tree.find((p) => p.tasks.some((t: any) => t.id === tm[1])) || null;
  return null;
}

const mod: AppModule = {
  id: "projects-panel",
  moduleApiVersion: 1,
  async activate(ctx, prev) {
    if (prev) { sshForm = !!prev.sshForm; taskFormFor = prev.taskFormFor || null; addForm = !!prev.addForm; filter = prev.filter || ""; }
    const sel: any = ctx.state.get("workspace.selected");
    selected = sel ? sel.id : null;
    ctx.state.watch("workspace.selected", (v: any) => { selected = v ? v.id : null; ctx.ui.invalidate(); });
    const updateBackground = (value: any) => {
      backgroundOpacity = typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0.12;
      ctx.ui.invalidate();
    };
    updateBackground(ctx.state.get("workspace-layout.projectsBackgroundOpacity"));
    ctx.state.watch("workspace-layout.projectsBackgroundOpacity", updateBackground);
    chatBusy = asCounts(ctx.state.get("ai-sessions.busy"));
    agentBusy = asCounts(ctx.state.get("persistent-agents.busy"));
    ctx.state.watch("ai-sessions.busy", (v: any) => { chatBusy = asCounts(v); updateBusy(ctx); });
    ctx.state.watch("persistent-agents.busy", (v: any) => { agentBusy = asCounts(v); updateBusy(ctx); });
    updateBusy(ctx);
    ctx.events.on("projects.changed", () => reload(ctx));
    ctx.events.on("git-tasks.changed", () => reload(ctx));
    await reload(ctx);
  },
  deactivate() { if (animation) clearInterval(animation); animation = null; },
  snapshot: () => ({ sshForm, taskFormFor, addForm, filter }),
  render(): UiNode {
    const proj = selectedProject();
    const visibleRows = rows();
    const children: UiNode[] = [
      { type: "row", key: "hdr", gap: 3, children: [
        { type: "textInput", key: "project-filter", prefixSvg: uiIcons.search, placeholder: "Filter projects", value: filter, changeAction: "filter", grow: true },
        { type: "button", key: "add-project", text: "", iconSvg: uiIcons["plus"], action: "showAdd", small: true, variant: "ghost", tooltip: "Add project", disabled: !!busy },
        { type: "button", key: "refresh", text: "", iconSvg: uiIcons["refresh"], action: "refresh", small: true, variant: "ghost", tooltip: "Refresh projects", disabled: !!busy },
      ] },
      { type: "row", key: "summary", gap: 4, children: [
        { type: "label", key: "count", text: `${tree.length} ${tree.length === 1 ? "project" : "projects"}`, size: "xs", color: "muted", grow: true },
        ...(proj?.isGit && proj.hasCommits !== false ? [{ type: "button", key: "new-task", text: "New task", iconSvg: uiIcons["git-branch"], action: "newTask", small: true, variant: "ghost", tooltip: `Create a worktree in ${proj.name}`, disabled: !!busy } as UiNode] : []),
      ] },
    ];
    if (error) children.push({ type: "status", key: "err", text: error, level: "error" });
    if (notice) children.push({ type: "status", key: "notice", text: notice, level: "warn" });
    if (busy) children.push({ type: "progress", key: "busy", indeterminate: true, label: busy });
    if (!visibleRows.length) children.push({ type: "label", key: "empty", text: filter.trim() ? "No matching projects or tasks." : "Add a project to get started.", size: "sm", color: "muted", padding: 8 });
    children.push({ type: "tree", key: "tree", rowHeight: 42, rowGap: 0, iconSize: 18, rows: visibleRows, selectAction: "selectWorkspace", expandAction: "toggleExpanded", grow: true });
    if (proj && proj.isGit && proj.hasCommits !== false) {
      if (taskFormFor === proj.id) {
        children.push({ type: "modal", key: "task-form", title: "New Git task", closeAction: "cancelTask", children: [
          { type: "label", key: "tf-l", text: `New Git task in ${proj.name}`, size: "sm", weight: "bold" },
          ...(error ? [{ type: "status", key: "task-error", text: error, level: "error" } as UiNode] : []),
          { type: "textInput", key: "task-name", placeholder: "Task name (e.g. Fix login bug)", submitAction: "createTask" },
          { type: "textInput", key: "task-branch", placeholder: "Branch (optional, e.g. feature/login-fix)", submitAction: "createTask" },
          { type: "row", key: "tf-b", gap: 4, children: [
            { type: "button", key: "tf-create", text: "Create worktree", action: "createTask", variant: "primary", small: true, disabled: !!busy },
            { type: "button", key: "tf-cancel", text: "Cancel", action: "cancelTask", small: true },
          ] },
          { type: "label", key: "tf-hint", text: "Creates a worktree on its own branch. Leave Branch empty to generate task/<name>; an existing local or remote branch is checked out, otherwise a new one starts from HEAD. Uncommitted changes stay in the original project.", size: "xs", color: "muted", wrap: true },
        ] });
      }
    }
    if (addForm) children.push({ type: "modal", key: "add-modal", title: "Add project", closeAction: "hideAdd", children: [
      { type: "button", key: "add-local", text: "Choose local folder…", iconSvg: uiIcons["folder"], action: "addLocal", disabled: !!busy },
      { type: "label", key: "path-label", text: "Or enter a local folder path", size: "sm", color: "muted" },
      { type: "row", key: "manual", gap: 4, children: [
        { type: "textInput", key: "local-path", placeholder: "/path/to/project", submitAction: "addLocalPath", grow: true },
        { type: "button", key: "add-path", text: "Add", action: "addLocalPath", disabled: !!busy },
      ] },
      { type: "divider", key: "separator" },
      { type: "button", key: "add-ssh", text: "Connect over SSH…", iconSvg: uiIcons["terminal"], action: "showSsh", disabled: !!busy },
      ...(error ? [{ type: "status", key: "add-error", text: error, level: "error" } as UiNode] : []),
    ] });
    if (sshForm) {
      children.push({ type: "modal", key: "ssh-modal", title: "Add SSH project", closeAction: "hideSsh", children: [
        { type: "label", key: "ssh-l1", text: "The remote project is browsed, executed and served by agents ON that host. Authentication uses your SSH agent or a key file path (never stored key contents). Host keys are verified against known_hosts.", size: "xs", color: "muted", wrap: true },
        ...(error ? [{ type: "status", key: "ssh-error", text: error, level: "error" } as UiNode] : []),
        { type: "textInput", key: "ssh-host", placeholder: "hostname" },
        { type: "textInput", key: "ssh-user", placeholder: "user" },
        { type: "textInput", key: "ssh-port", placeholder: "port (22)" },
        { type: "textInput", key: "ssh-path", placeholder: "/absolute/remote/path" },
        { type: "textInput", key: "ssh-key", placeholder: "identity file path (optional, default: ssh-agent)" },
        { type: "textInput", key: "ssh-name", placeholder: "display name (optional)" },
        { type: "row", key: "ssh-b", gap: 4, children: [
          { type: "button", key: "ssh-add", text: busy ? "Connecting…" : "Connect & add", action: "addSsh", variant: "primary", disabled: !!busy },
          { type: "button", key: "ssh-cancel", text: "Cancel", action: "hideSsh" },
        ] },
      ] });
    }
    return { type: "column", key: "projects-root", gap: 4, padding: 6, grow: true,
      ...(backgroundOpacity > 0 ? { backgroundImage: projectsBranding, backgroundImageStyle: { opacity: backgroundOpacity, scale: 1.2, offsetX: -0.1 } } : {}), children };
  },
  async onEvent(ctx, ev) {
    const run = async (label: string, fn: () => Promise<any>) => {
      busy = label; error = null; ctx.ui.invalidate();
      try { return await fn(); } catch (e) { error = errMsg(e); return null; } finally { busy = null; await reload(ctx); }
    };
    if (busy) return;
    switch (ev.action) {
      case "filter": filter = String(ev.value || ""); break;
      case "refresh": await reload(ctx); break;
      case "showAdd": addForm = true; error = null; break;
      case "hideAdd": addForm = false; break;
      case "selectWorkspace":
        error = null;
        selected = ev.rowKey || null; ctx.ui.invalidate();
        try { await ctx.modules.call("workspace", "select", { workspaceId: ev.rowKey }); } catch (e) { error = errMsg(e); }
        break;
      case "toggleExpanded": {
        const m = /^project:(.+):root$/.exec(ev.rowKey || "");
        const p = m && tree.find((x) => x.id === m[1]);
        if (p) await ctx.modules.call("projects", "setExpanded", { projectId: p.id, expanded: !p.expanded });
        break;
      }
      case "addLocal": { const result = await run("Adding project…", () => ctx.modules.call("projects", "pickAndAddLocal", {})); if (result) addForm = false; break; }
      case "addLocalPath": {
        const path = (ev.inputs["local-path"] || "").trim();
        if (path) { const result = await run("Adding project…", () => ctx.modules.call("projects", "addLocal", { path })); if (result) addForm = false; }
        break;
      }
      case "showSsh": addForm = false; sshForm = true; error = null; break;
      case "hideSsh": sshForm = false; break;
      case "addSsh": {
        const i = ev.inputs;
        const r = await run("Connecting over SSH…", () => ctx.modules.call("projects", "addSsh", {
          host: i["ssh-host"], user: i["ssh-user"], port: Number(i["ssh-port"]) || 22, remotePath: i["ssh-path"], identityFile: i["ssh-key"] || null, name: i["ssh-name"] || null,
        }, { timeoutMs: 120000 }));
        if (r) sshForm = false;
        break;
      }
      case "newTask": taskFormFor = selectedProject()?.id || null; notice = null; break;
      case "cancelTask": taskFormFor = null; break;
      case "createTask": {
        const name = (ev.inputs["task-name"] || "").trim();
        const branch = (ev.inputs["task-branch"] || "").trim();
        const projectId = taskFormFor;
        if ((!name && !branch) || !projectId) { error = "Enter a task name or a branch"; break; }
        const r = await run("Creating worktree…", () => ctx.modules.call("git-tasks", "create", { projectId, name, branch }, { timeoutMs: 300000 }));
        if (r) { taskFormFor = null; notice = r.warning || null; }
        break;
      }
    }
    ctx.ui.invalidate();
  },
};
export default mod;
