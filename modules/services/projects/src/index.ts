// projects: registration of local and SSH projects, Git detection on the project's own machine,
// and the project/task tree model. Persistence goes through the `persistence` service.
import type { AppModule, ModuleContext } from "../../../../sdk/types";
import { errMsg, targetFor, workspaceGrant, type WorkspaceDescriptor } from "../../../../sdk/runtime";

interface GitInfo { isGit: boolean; topLevel: string | null; hasCommits: boolean; error?: string; checkedAt: number }
const gitCache = new Map<string, GitInfo>();
const offline = new Map<string, string>(); // projectId -> last connectivity error

function projectDesc(p: any, ssh: any): WorkspaceDescriptor {
  return {
    id: `project:${p.id}:root`, projectId: p.id, name: p.name, location: p.kind,
    machineId: p.kind === "ssh" ? `ssh:${p.sshProfileId}` : "local",
    rootAbsolutePath: p.rootPath, connectionRef: p.sshProfileId,
    ssh: ssh ? { profileId: ssh.id, host: ssh.host, port: ssh.port, user: ssh.user, identityFile: ssh.authRef && ssh.authRef !== "agent" ? ssh.authRef : null } : null,
  };
}

async function describeProject(ctx: ModuleContext, projectId: string) {
  const p = await ctx.modules.call("persistence", "projects.get", { id: projectId });
  if (!p) throw new Error(`unknown project ${projectId}`);
  const ssh = p.kind === "ssh" ? await ctx.modules.call("persistence", "ssh.get", { id: p.sshProfileId }) : null;
  return { project: p, desc: projectDesc(p, ssh) };
}

/** `git -C <root> rev-parse --show-toplevel` on the project's machine via the process broker. */
async function detectGit(ctx: ModuleContext, desc: WorkspaceDescriptor): Promise<GitInfo> {
  const g = await workspaceGrant(ctx, desc, "process");
  const run = async (args: string[]) => ctx.host.process.run(g.grant, { target: await targetFor(ctx, desc), executable: "git", args: ["-C", desc.rootAbsolutePath, ...args], cwd: desc.rootAbsolutePath, loginShell: desc.location === "ssh" }, { timeoutMs: 20000 });
  const top = await run(["rev-parse", "--show-toplevel"]);
  if (top.code !== 0) return { isGit: false, topLevel: null, hasCommits: false, checkedAt: Date.now() };
  const head = await run(["rev-parse", "--verify", "-q", "HEAD"]);
  return { isGit: true, topLevel: top.stdout.trim(), hasCommits: head.code === 0, checkedAt: Date.now() };
}

async function refreshGit(ctx: ModuleContext, projectId: string) {
  try {
    const { desc } = await describeProject(ctx, projectId);
    const info = await detectGit(ctx, desc);
    gitCache.set(projectId, info);
    offline.delete(projectId);
  } catch (e) {
    offline.set(projectId, errMsg(e));
    gitCache.set(projectId, { isGit: gitCache.get(projectId)?.isGit ?? false, topLevel: null, hasCommits: false, error: errMsg(e), checkedAt: Date.now() });
  }
  ctx.events.emit("projects.changed", { projectId });
}

function basename(p: string) { const parts = p.replace(/\/+$/, "").split("/"); return parts[parts.length - 1] || p; }

const mod: AppModule = {
  id: "projects",
  moduleApiVersion: 1,
  async activate(ctx, prev) {
    if (prev && prev.git) for (const [k, v] of prev.git) gitCache.set(k, v);
    // First launch: register --root (or the process cwd) when no project exists.
    const list = await ctx.modules.call("persistence", "projects.list");
    if (list.length === 0) {
      const root = ctx.host.env.info().initialRoot;
      if (root) {
        try {
          await mod.methods!.addLocal(ctx, { path: root }, { caller: "projects" });
          ctx.log.info("registered initial project", root);
        } catch (e) { ctx.log.warn("could not register initial root", root, errMsg(e)); }
      }
    }
    // Background git detection (never blocks activation; SSH projects may be offline).
    const all = await ctx.modules.call("persistence", "projects.list");
    for (const p of all) if (!gitCache.has(p.id)) refreshGit(ctx, p.id);
  },
  snapshot: () => ({ git: Array.from(gitCache.entries()) }),
  methods: {
    health: async (ctx) => { await ctx.modules.call("persistence", "projects.list"); return { ok: true }; },

    /** Tree model consumed by projects-panel. Sorted by name (case-insensitive). */
    async tree(ctx) {
      const projects = await ctx.modules.call("persistence", "projects.list");
      const tasks = await ctx.modules.call("persistence", "tasks.list", {});
      const profiles = await ctx.modules.call("persistence", "ssh.list");
      const byProfile = new Map(profiles.map((p: any) => [p.id, p]));
      const out = projects.map((p: any) => {
        const git = gitCache.get(p.id);
        const ssh: any = p.kind === "ssh" ? byProfile.get(p.sshProfileId) : null;
        return {
          id: p.id, name: p.name, kind: p.kind, rootPath: p.rootPath, expanded: p.expanded,
          host: ssh ? `${ssh.user}@${ssh.host}${ssh.port !== 22 ? ":" + ssh.port : ""}` : null,
          isGit: git ? git.isGit : null, hasCommits: git ? git.hasCommits : null,
          offline: offline.get(p.id) || null,
          tasks: tasks.filter((t: any) => t.projectId === p.id).map((t: any) => ({ id: t.id, name: t.name, branch: t.branch, worktreePath: t.worktreePath, status: t.status })),
        };
      });
      out.sort((a: any, b: any) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
      return out;
    },

    async get(ctx, a) {
      const { project, desc } = await describeProject(ctx, a.projectId);
      return { ...project, desc, git: gitCache.get(project.id) || null };
    },

    async addLocal(ctx, a) {
      const path = String(a.path || "").trim();
      if (!path.startsWith("/")) throw new Error("project path must be absolute");
      // The kernel canonicalizes and validates the root when granting.
      const g = await ctx.host.capabilities.request({ kind: "fs", root: path, target: { kind: "local" } });
      const root = g.root;
      await ctx.host.capabilities.release(g.grant);
      const existing = await ctx.modules.call("persistence", "projects.findByRoot", { rootPath: root, sshProfileId: null });
      if (existing) return existing;
      const id = crypto.randomUUID();
      await ctx.modules.call("persistence", "projects.insert", { project: { id, name: String(a.name || basename(root)), kind: "local", rootPath: root, sshProfileId: null } });
      await refreshGit(ctx, id);
      ctx.events.emit("projects.changed", { projectId: id });
      return ctx.modules.call("persistence", "projects.get", { id });
    },

    async pickAndAddLocal(ctx) {
      const path = await ctx.host.ui.pickFolder();
      if (!path) return null;
      return mod.methods!.addLocal(ctx, { path }, { caller: "projects" });
    },

    /** Register an SSH project. Validates connectivity + remote root on that machine. */
    async addSsh(ctx, a) {
      const host = String(a.host || "").trim();
      const user = String(a.user || "").trim();
      const port = Number(a.port) || 22;
      const remotePath = String(a.remotePath || "").trim();
      const identityFile = a.identityFile ? String(a.identityFile).trim() : "";
      if (!host || !user || !remotePath.startsWith("/")) throw new Error("host, user and an absolute remote path are required");
      if (/PRIVATE KEY/.test(identityFile)) throw new Error("enter a key file path, never key contents");
      const profiles = await ctx.modules.call("persistence", "ssh.list");
      let profile = profiles.find((p: any) => p.host === host && p.user === user && p.port === port && (p.authRef || "agent") === (identityFile || "agent"));
      if (!profile) {
        profile = { id: crypto.randomUUID(), host, port, user, authRef: identityFile || "agent" };
        await ctx.modules.call("persistence", "ssh.upsert", { profile });
      }
      const desc: WorkspaceDescriptor = projectDesc({ id: "pending", name: "pending", kind: "ssh", rootPath: remotePath, sshProfileId: profile.id }, profile);
      const g = await workspaceGrant(ctx, desc, "fs"); // connects + realpaths on the remote machine
      const existing = await ctx.modules.call("persistence", "projects.findByRoot", { rootPath: g.root, sshProfileId: profile.id });
      if (existing) return existing;
      const id = crypto.randomUUID();
      await ctx.modules.call("persistence", "projects.insert", { project: { id, name: String(a.name || `${basename(g.root)} (${host})`), kind: "ssh", rootPath: g.root, sshProfileId: profile.id } });
      await refreshGit(ctx, id);
      ctx.events.emit("projects.changed", { projectId: id });
      return ctx.modules.call("persistence", "projects.get", { id });
    },

    async setExpanded(ctx, a) {
      await ctx.modules.call("persistence", "projects.setExpanded", { id: a.projectId, expanded: !!a.expanded });
      ctx.events.emit("projects.changed", { projectId: a.projectId });
      return null;
    },

    async gitInfo(ctx, a) {
      if (a.refresh || !gitCache.has(a.projectId)) await refreshGit(ctx, a.projectId);
      return gitCache.get(a.projectId) || null;
    },

    async refresh(ctx, a) {
      const all = await ctx.modules.call("persistence", "projects.list");
      await Promise.all(all.filter((p: any) => !a || !a.projectId || p.id === a.projectId).map((p: any) => refreshGit(ctx, p.id)));
      return null;
    },
  },
};
export default mod;
