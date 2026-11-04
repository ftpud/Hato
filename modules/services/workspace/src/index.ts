// workspace: the sole resolver of WorkspaceDescriptors (project root or task worktree), active
// selection and per-workspace view state. The kernel never constructs or parses descriptors.
import type { AppModule, ModuleContext } from "../../../../sdk/types";
import type { WorkspaceDescriptor } from "../../../../sdk/runtime";

let selectedId: string | null = null;

async function resolve(ctx: ModuleContext, workspaceId: string): Promise<WorkspaceDescriptor> {
  if (typeof workspaceId !== "string") throw new Error("workspaceId required");
  let project: any;
  let task: any = null;
  const m = /^project:([0-9a-f-]+):root$/.exec(workspaceId);
  if (m) {
    project = await ctx.modules.call("persistence", "projects.get", { id: m[1] });
  } else {
    const t = /^task:([0-9a-f-]+)$/.exec(workspaceId);
    if (!t) throw new Error(`malformed workspace id ${workspaceId}`);
    task = await ctx.modules.call("persistence", "tasks.get", { id: t[1] });
    if (!task) throw new Error(`unknown task ${t[1]}`);
    project = await ctx.modules.call("persistence", "projects.get", { id: task.projectId });
  }
  if (!project) throw new Error(`unknown workspace ${workspaceId}`);
  let ssh: WorkspaceDescriptor["ssh"] = null;
  if (project.kind === "ssh") {
    const p = await ctx.modules.call("persistence", "ssh.get", { id: project.sshProfileId });
    if (!p) throw new Error(`SSH profile ${project.sshProfileId} missing`);
    ssh = { profileId: p.id, host: p.host, port: p.port, user: p.user, identityFile: p.authRef && p.authRef !== "agent" ? p.authRef : null };
  }
  return {
    id: task ? `task:${task.id}` : `project:${project.id}:root`,
    projectId: project.id,
    taskId: task ? task.id : null,
    name: task ? `${project.name} / ${task.name}` : project.name,
    location: project.kind,
    machineId: project.kind === "ssh" ? `ssh:${project.sshProfileId}` : "local",
    rootAbsolutePath: task ? task.worktreePath : project.rootPath,
    connectionRef: project.kind === "ssh" ? project.sshProfileId : null,
    ssh,
    status: task ? task.status : "ready",
  };
}

async function publish(ctx: ModuleContext) {
  if (!selectedId) { ctx.state.set("workspace.selected", null); return; }
  try {
    const d = await resolve(ctx, selectedId);
    const view = await ctx.modules.call("persistence", "views.get", { workspaceId: d.id });
    ctx.state.set("workspace.selected", { ...d, view } as any);
  } catch (e: any) {
    ctx.log.warn("selected workspace no longer resolves:", e.message);
    selectedId = null;
    ctx.state.set("workspace.selected", null);
  }
}

const mod: AppModule = {
  id: "workspace",
  moduleApiVersion: 1,
  async activate(ctx, prev) {
    selectedId = (prev && prev.selectedId) || (await ctx.modules.call("persistence", "settings.get", { key: "workspace.selected" }));
    await publish(ctx);
  },
  snapshot: () => ({ selectedId }),
  methods: {
    resolve: (ctx, a) => resolve(ctx, a.workspaceId),
    current: async (ctx) => (selectedId ? resolve(ctx, selectedId) : null),
    currentId: () => selectedId,
    async select(ctx, a) {
      const d = await resolve(ctx, a.workspaceId); // validates
      selectedId = d.id;
      await ctx.modules.call("persistence", "settings.set", { key: "workspace.selected", value: d.id });
      await publish(ctx);
      ctx.events.emit("workspace.selected", { workspaceId: d.id });
      return d;
    },
    "view.get": (ctx, a) => ctx.modules.call("persistence", "views.get", { workspaceId: a.workspaceId }),
    async "view.patch"(ctx, a) {
      const v = await ctx.modules.call("persistence", "views.patch", { workspaceId: a.workspaceId, patch: a.patch });
      if (a.workspaceId === selectedId) await publish(ctx);
      ctx.events.emit("workspace.viewChanged", { workspaceId: a.workspaceId, changed: Object.keys(a.patch || {}), previewPath: a.patch?.previewPath });
      return v;
    },
    async refresh(ctx) { await publish(ctx); return null; },
  },
};
export default mod;
