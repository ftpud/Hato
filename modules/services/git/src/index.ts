// git: read-only working-tree status and per-file patches for a workspace, run on the
// workspace's own machine with argv (never shell strings). Patches are handed to the UI as
// native document handles rendered by the `diff` node.
import type { AppModule, ModuleContext, RunResult } from "../../../../sdk/types";
import { targetFor, withWorkspace, workspaceGrant, type WorkspaceDescriptor } from "../../../../sdk/runtime";
import { parseNumstat, parseStatus } from "./status";

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const MAX_PATCH_BYTES = 4 * 1024 * 1024;
const docCache = new Map<string, { text: string; document: string }>();

async function desc(ctx: ModuleContext, workspaceId: string): Promise<WorkspaceDescriptor> {
  return ctx.modules.call("workspace", "resolve", { workspaceId });
}

async function git(ctx: ModuleContext, d: WorkspaceDescriptor, args: string[], limitBytes = MAX_PATCH_BYTES): Promise<RunResult> {
  return withWorkspace(ctx, d, async () => {
    const g = await workspaceGrant(ctx, d, "process");
    return ctx.host.process.run(g.grant, {
      target: await targetFor(ctx, d), executable: "git",
      args: ["--no-optional-locks", "-c", "core.quotepath=false", "-c", "color.ui=false", ...args],
      cwd: d.rootAbsolutePath, loginShell: d.location === "ssh",
    }, { timeoutMs: 30000, limitBytes });
  });
}

function fail(r: RunResult, what: string): never {
  throw new Error(`${what} failed (exit ${r.code}): ${(r.stderr || r.stdout).trim().slice(0, 600)}`);
}

async function base(ctx: ModuleContext, d: WorkspaceDescriptor) {
  const head = await git(ctx, d, ["rev-parse", "--verify", "-q", "HEAD"]);
  return head.code === 0 ? "HEAD" : EMPTY_TREE;
}

function cleanRel(p: any): string {
  const s = String(p || "");
  if (!s || s.startsWith("/") || s.split("/").includes("..")) throw new Error("path must be workspace-relative");
  return s;
}

const mod: AppModule = {
  id: "git",
  moduleApiVersion: 1,
  methods: {
    /** Changed files in the working tree (staged, unstaged and untracked) with line counts. */
    async status(ctx, a) {
      const d = await desc(ctx, a.workspaceId);
      const prefixR = await git(ctx, d, ["rev-parse", "--show-prefix"]);
      if (prefixR.code !== 0) return { workspaceId: d.id, repo: false, branch: null, files: [] };
      // Porcelain and numstat paths are repo-root relative; the workspace may be a subdirectory.
      const prefix = prefixR.stdout.trim();
      const rel = (p: string | null) => p == null ? null : p.startsWith(prefix) ? p.slice(prefix.length) : null;
      const branchR = await git(ctx, d, ["symbolic-ref", "--short", "-q", "HEAD"]);
      const st = await git(ctx, d, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "."]);
      if (st.code !== 0) fail(st, "git status");
      const files = parseStatus(st.stdout).flatMap((f) => {
        const path = rel(f.path);
        return path ? [{ ...f, path, origPath: rel(f.origPath) }] : [];
      });
      const ns = await git(ctx, d, ["diff", "--numstat", "-z", "-M", await base(ctx, d), "--", "."]);
      if (ns.code === 0) {
        const counts = parseNumstat(ns.stdout);
        for (const f of files) Object.assign(f, counts.get(prefix + f.path) || {});
      }
      return { workspaceId: d.id, repo: true, branch: branchR.code === 0 ? branchR.stdout.trim() : "(detached)", truncated: st.truncated, files };
    },

    /** Patch for one file against HEAD (working tree incl. staged changes) as a document handle. */
    async diff(ctx, a) {
      const d = await desc(ctx, a.workspaceId);
      const path = cleanRel(a.path);
      const st = await git(ctx, d, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", path]);
      if (st.code !== 0) fail(st, "git status");
      const change = parseStatus(st.stdout)[0];
      const prefix = (await git(ctx, d, ["rev-parse", "--show-prefix"])).stdout.trim();
      const orig = change?.origPath?.startsWith(prefix) ? change.origPath.slice(prefix.length) : null;
      let r: RunResult;
      if (change?.kind === "untracked") {
        r = await git(ctx, d, ["diff", "--no-index", "--no-ext-diff", "--", "/dev/null", path]);
        if (r.code !== 0 && r.code !== 1) fail(r, "git diff --no-index");
      } else {
        r = await git(ctx, d, ["diff", "--no-ext-diff", "-M", await base(ctx, d), "--", ...(orig ? [orig] : []), path]);
        if (r.code !== 0) fail(r, "git diff");
      }
      const text = r.stdout;
      const key = `${d.id}|${path}`;
      const cached = docCache.get(key);
      const document = cached && cached.text === text ? cached.document : await ctx.host.ui.documentOpen(d.id, text, "diff", { path });
      docCache.set(key, { text, document });
      return { workspaceId: d.id, path, kind: change?.kind || null, document, empty: !text.trim(), truncated: r.truncated };
    },
  },
};
export default mod;
