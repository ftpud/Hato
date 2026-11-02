// projects-panel: left tree of projects and their Git task worktrees.
// Clicking a row selects a workspace; clicking the chevron expands/collapses (separate events).
import type { AppModule, ModuleContext, TreeRow, UiNode } from "../../../../sdk/types";
import { errMsg } from "../../../../sdk/runtime";

let tree: any[] = [];
let selected: string | null = null;
let error: string | null = null;
let notice: string | null = null;
let busy: string | null = null;
let sshForm = false;
let taskFormFor: string | null = null;

async function reload(ctx: ModuleContext) {
  try { tree = await ctx.modules.call("projects", "tree"); error = null; }
  catch (e) { error = errMsg(e); }
  ctx.ui.invalidate();
}

function rows(): TreeRow[] {
  const out: TreeRow[] = [];
  for (const p of tree) {
    const key = `project:${p.id}:root`;
    const kind = p.kind === "ssh" ? "SSH" : "Local";
    const git = p.isGit === null ? "…" : p.isGit ? "Git" : "non-Git";
    out.push({
      key, label: p.name, depth: 0, expandable: p.tasks.length > 0, expanded: p.expanded, selected: selected === key,
      badge: `${kind} / ${git}`, detail: p.offline ? `offline: ${p.offline}` : (p.host || p.rootPath), icon: p.offline ? "warning" : p.kind === "ssh" ? "remote" : p.isGit ? "git" : "folder",
    });
    if (p.expanded) for (const t of p.tasks) {
      const tk = `task:${t.id}`;
      out.push({ key: tk, label: t.name, depth: 1, expandable: false, expanded: false, selected: selected === tk,
        badge: t.status !== "ready" ? t.status : p.kind === "ssh" ? "remote worktree" : "worktree", detail: t.branch, icon: t.status === "ready" ? "task" : "warning" });
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
    if (prev) { sshForm = !!prev.sshForm; taskFormFor = prev.taskFormFor || null; }
    const sel: any = ctx.state.get("workspace.selected");
    selected = sel ? sel.id : null;
    ctx.state.watch("workspace.selected", (v: any) => { selected = v ? v.id : null; ctx.ui.invalidate(); });
    ctx.events.on("projects.changed", () => reload(ctx));
    ctx.events.on("git-tasks.changed", () => reload(ctx));
    await reload(ctx);
  },
  snapshot: () => ({ sshForm, taskFormFor }),
  render(): UiNode {
    const proj = selectedProject();
    const children: UiNode[] = [
      { type: "row", key: "hdr", gap: 4, align: "center", children: [
        { type: "label", key: "title", text: "PROJECTS", size: "sm", weight: "bold", color: "muted" },
        { type: "spacer", key: "sp" },
        { type: "button", key: "add-local", text: "+ Local", action: "addLocal", small: true },
        { type: "button", key: "add-ssh", text: "+ SSH", action: "showSsh", small: true },
      ] },
    ];
    if (error) children.push({ type: "status", key: "err", text: error, level: "error" });
    if (notice) children.push({ type: "status", key: "notice", text: notice, level: "warn" });
    if (busy) children.push({ type: "progress", key: "busy", indeterminate: true, label: busy });
    children.push({ type: "tree", key: "tree", rows: rows(), selectAction: "selectWorkspace", expandAction: "toggleExpanded", grow: true });
    if (proj && proj.isGit && proj.hasCommits !== false) {
      if (taskFormFor === proj.id) {
        children.push({ type: "column", key: "task-form", gap: 4, border: true, padding: 6, children: [
          { type: "label", key: "tf-l", text: `New Git task in ${proj.name}`, size: "sm", weight: "bold" },
          { type: "textInput", key: "task-name", placeholder: "Task name (e.g. Fix login bug)", submitAction: "createTask" },
          { type: "row", key: "tf-b", gap: 4, children: [
            { type: "button", key: "tf-create", text: "Create worktree", action: "createTask", variant: "primary", small: true, disabled: !!busy },
            { type: "button", key: "tf-cancel", text: "Cancel", action: "cancelTask", small: true },
          ] },
          { type: "label", key: "tf-hint", text: "Creates branch task/<slug>-<id> and a linked worktree from HEAD on the project's machine. Uncommitted changes are not copied.", size: "xs", color: "muted", wrap: true },
        ] });
      } else {
        children.push({ type: "button", key: "new-task", text: "+ New Git Task", action: "newTask", small: true });
      }
    }
    children.push({ type: "row", key: "manual", gap: 4, children: [
      { type: "textInput", key: "local-path", placeholder: "/absolute/path", submitAction: "addLocalPath", grow: true },
      { type: "button", key: "add-path", text: "Add", action: "addLocalPath", small: true },
    ] });
    if (sshForm) {
      children.push({ type: "modal", key: "ssh-modal", title: "Add SSH project", closeAction: "hideSsh", children: [
        { type: "label", key: "ssh-l1", text: "The remote project is browsed, executed and served by agents ON that host. Authentication uses your SSH agent or a key file path (never stored key contents). Host keys are verified against known_hosts.", size: "xs", color: "muted", wrap: true },
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
    return { type: "column", key: "projects-root", gap: 6, padding: 8, grow: true, children };
  },
  async onEvent(ctx, ev) {
    const run = async (label: string, fn: () => Promise<any>) => {
      busy = label; error = null; ctx.ui.invalidate();
      try { return await fn(); } catch (e) { error = errMsg(e); return null; } finally { busy = null; await reload(ctx); }
    };
    switch (ev.action) {
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
      case "addLocal": await run("Adding project…", () => ctx.modules.call("projects", "pickAndAddLocal", {})); break;
      case "addLocalPath": {
        const path = (ev.inputs["local-path"] || "").trim();
        if (path) await run("Adding project…", () => ctx.modules.call("projects", "addLocal", { path }));
        break;
      }
      case "showSsh": sshForm = true; error = null; break;
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
        const projectId = taskFormFor;
        if (!name || !projectId) { error = "Enter a task name"; break; }
        const r = await run("Creating worktree…", () => ctx.modules.call("git-tasks", "create", { projectId, name }, { timeoutMs: 300000 }));
        if (r) { taskFormFor = null; notice = r.warning || null; }
        break;
      }
    }
    ctx.ui.invalidate();
  },
};
export default mod;
