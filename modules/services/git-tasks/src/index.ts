// git-tasks: Git task = its own branch + real linked `git worktree`, created ON the project's
// machine (local or remote via SSH), outside the original checkout. Commands use argv locally and
// the kernel's audited POSIX quoting adapter remotely — never interpolated shell strings.
import type { AppModule, ModuleContext, RunResult } from "../../../../sdk/types";
import { errMsg, shortId, sshProfileSpec, targetFor, workspaceGrant, type WorkspaceDescriptor } from "../../../../sdk/runtime";
import { exportMcpTools } from "../../../../sdk/mcp";
import { taskTools } from "./tools";

function slugify(name: string) {
  const s = name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return s || "task";
}

async function git(ctx: ModuleContext, desc: WorkspaceDescriptor, args: string[], timeoutMs = 60000): Promise<RunResult> {
  const g = await workspaceGrant(ctx, desc, "process");
  return ctx.host.process.run(g.grant, {
    target: await targetFor(ctx, desc),
    executable: "git", args, cwd: desc.rootAbsolutePath, loginShell: desc.location === "ssh",
  }, { timeoutMs });
}

function must(r: RunResult, what: string) {
  if (r.code !== 0) throw new Error(`${what} failed (exit ${r.code}): ${(r.stderr || r.stdout).trim().slice(0, 800)}`);
  return r.stdout;
}

function parsePorcelain(out: string) {
  const items: { worktree: string; branch: string | null; head: string | null; detached: boolean; prunable: boolean }[] = [];
  let cur: any = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) { if (cur) items.push(cur); cur = { worktree: line.slice(9), branch: null, head: null, detached: false, prunable: false }; }
    else if (cur && line.startsWith("branch ")) cur.branch = line.slice(7).replace(/^refs\/heads\//, "");
    else if (cur && line.startsWith("HEAD ")) cur.head = line.slice(5);
    else if (cur && line === "detached") cur.detached = true;
    else if (cur && line.startsWith("prunable")) cur.prunable = true;
  }
  if (cur) items.push(cur);
  return items;
}

async function remoteStateDir(ctx: ModuleContext, desc: WorkspaceDescriptor) {
  const c = await ctx.host.ssh.connect(sshProfileSpec(desc.ssh!));
  if (!c.home) throw new Error("cannot determine remote home directory");
  return `${c.home.replace(/\/+$/, "")}/.local/state/hato`;
}

async function reconcile(ctx: ModuleContext, projectId: string) {
  const proj = await ctx.modules.call("projects", "get", { projectId });
  const tasks = await ctx.modules.call("persistence", "tasks.list", { projectId });
  if (tasks.length === 0) return { tasks: [], worktrees: [] };
  const out = await git(ctx, proj.desc, ["-C", proj.desc.rootAbsolutePath, "worktree", "list", "--porcelain"]);
  if (out.code !== 0) return { error: out.stderr.trim(), tasks };
  const wts = parsePorcelain(out.stdout);
  const changed: any[] = [];
  for (const t of tasks) {
    const wt = wts.find((w) => w.worktree === t.worktreePath);
    const status = !wt ? "missing" : wt.prunable ? "prunable" : wt.branch !== t.branch ? "branch-mismatch" : "ready";
    if (status !== t.status) {
      await ctx.modules.call("persistence", "tasks.setStatus", { id: t.id, status });
      changed.push({ id: t.id, status });
    }
  }
  if (changed.length) ctx.events.emit("git-tasks.changed", { projectId, changed });
  return { worktrees: wts, changed };
}

let contribution: ReturnType<typeof exportMcpTools> | null = null;

const mod: AppModule = {
  id: "git-tasks",
  moduleApiVersion: 1,
  async activate(ctx) {
    contribution = exportMcpTools(ctx, "Git tasks", taskTools(ctx, {
      create: (args) => mod.methods!.create(ctx, args, { caller: "git-tasks" }),
      reconcile: (projectId) => reconcile(ctx, projectId),
    }));
    // Reconcile on start (never prunes or deletes anything).
    setTimeout(async () => {
      try {
        const projects = await ctx.modules.call("persistence", "projects.list");
        for (const p of projects) reconcile(ctx, p.id).catch((e) => ctx.log.warn("reconcile", p.name, errMsg(e)));
      } catch (e) { ctx.log.warn("reconcile failed", errMsg(e)); }
    }, 500);
  },
  canSwap: () => ({ ok: (contribution?.pending() ?? 0) === 0, reason: "A Git task MCP command is running" }),
  methods: {
    list: (ctx, a) => ctx.modules.call("persistence", "tasks.list", { projectId: a.projectId }),
    reconcile: (ctx, a) => reconcile(ctx, a.projectId),

    /** Report whether the parent checkout has uncommitted/untracked changes (not copied into tasks). */
    async dirtyCheck(ctx, a) {
      const proj = await ctx.modules.call("projects", "get", { projectId: a.projectId });
      const r = await git(ctx, proj.desc, ["-C", proj.desc.rootAbsolutePath, "status", "--porcelain"]);
      must(r, "git status");
      const lines = r.stdout.split("\n").filter(Boolean);
      return { dirty: lines.length > 0, count: lines.length, sample: lines.slice(0, 10) };
    },

    async create(ctx, a) {
      const name = String(a.name || a.branch || "").trim();
      if (!name || name.length > 100) throw new Error("task name is required (max 100 chars)");
      // 1. Resolve authorized machine/root and verify Git project.
      const proj = await ctx.modules.call("projects", "get", { projectId: a.projectId });
      const desc: WorkspaceDescriptor = proj.desc;
      const root = desc.rootAbsolutePath;
      const top = await git(ctx, desc, ["-C", root, "rev-parse", "--show-toplevel"]);
      if (top.code !== 0) throw new Error("project root is not a Git working tree");
      if (top.stdout.trim() !== root) throw new Error(`project root must be the repository top level (${top.stdout.trim()})`);
      const head = await git(ctx, desc, ["-C", root, "rev-parse", "--verify", "-q", "HEAD"]);
      if (head.code !== 0) throw new Error("repository has no commits yet; commit once before creating tasks");
      // 2. Stable id + branch: a custom name (new, existing local, or one remote-tracking branch) or a generated task/<slug>-<id>.
      const taskId = crypto.randomUUID();
      const custom = String(a.branch || "").trim().replace(/^refs\/heads\//, "");
      if (custom.startsWith("-") || custom.length > 200) throw new Error("invalid branch name");
      const branch = custom || `task/${slugify(name)}-${shortId(taskId)}`;
      must(await git(ctx, desc, ["check-ref-format", "--branch", branch]), "git check-ref-format");
      const local = (await git(ctx, desc, ["-C", root, "show-ref", "--verify", "-q", `refs/heads/${branch}`])).code === 0;
      const remotes = local ? [] : must(await git(ctx, desc, ["-C", root, "for-each-ref", "--format=%(refname)", `refs/remotes/*/${branch}`]), "git for-each-ref").split("\n").filter(Boolean);
      if (remotes.length > 1) throw new Error(`branch ${branch} exists on several remotes (${remotes.map((r) => r.replace(/^refs\/remotes\//, "")).join(", ")}); create a local branch first`);
      // 3. Worktree outside the original checkout, on the same machine.
      const base = desc.location === "local" ? `${ctx.host.env.info().sharedDir}/worktrees` : `${await remoteStateDir(ctx, desc)}/worktrees`;
      const wtPath = `${base}/${proj.id}/${taskId}`;
      if (wtPath.startsWith(root + "/")) throw new Error("refusing to place worktree inside the checkout");
      const dirty = await mod.methods!.dirtyCheck(ctx, { projectId: proj.id }, { caller: "git-tasks" });
      // 4. Existing local branch: worktree add <path> <branch> (git refuses one checked out elsewhere).
      //    Remote-only branch: --track -b <branch> <path> <remote ref>. Otherwise a new branch from HEAD.
      const addArgs = local ? [wtPath, branch] : remotes.length ? ["--track", "-b", branch, wtPath, remotes[0]] : ["-b", branch, wtPath, "HEAD"];
      must(await git(ctx, desc, ["-C", root, "worktree", "add", ...addArgs], 180000), "git worktree add");
      // 5. Verify with porcelain list, then persist.
      const list = must(await git(ctx, desc, ["-C", root, "worktree", "list", "--porcelain"]), "git worktree list");
      const wt = parsePorcelain(list).find((w) => w.branch === branch);
      if (!wt) throw new Error(`worktree for ${branch} not found in 'git worktree list' after creation`);
      try {
        await ctx.modules.call("persistence", "tasks.insert", { task: { id: taskId, projectId: proj.id, name, branch, worktreePath: wt.worktree, status: "ready" } });
      } catch (e) {
        // Do NOT delete the created worktree (user work); surface a reconcile action.
        throw new Error(`worktree created at ${wt.worktree} on ${desc.machineId} but saving the task failed: ${errMsg(e)}. Use Reconcile; nothing was deleted.`);
      }
      ctx.events.emit("git-tasks.changed", { projectId: proj.id, taskId });
      // 6. Select the new task workspace unless the caller (e.g. an agent) asked not to move the user's view.
      if (a.select !== false) await ctx.modules.call("workspace", "select", { workspaceId: `task:${taskId}` });
      const startedFrom = local ? `existing branch ${branch}` : remotes.length ? remotes[0].replace(/^refs\/remotes\//, "") : "HEAD";
      return { id: taskId, branch, worktreePath: wt.worktree, machineId: desc.machineId, startedFrom,
        warning: dirty.dirty && !local && !remotes.length ? `Parent checkout has ${dirty.count} uncommitted/untracked change(s); worktrees start from HEAD and do not include them.` : null };
    },
  },
};
export default mod;
