// git: read-only working-tree status and per-file patches for a workspace, run on the
// workspace's own machine with argv (never shell strings). Patches are handed to the UI as
// native document handles rendered by the `diff` node.
import { fileWatch } from "../../../../sdk/file-watch";
import type { AppModule, ModuleContext, RunResult } from "../../../../sdk/types";
import { targetFor, withWorkspace, workspaceGrant, type WorkspaceDescriptor } from "../../../../sdk/runtime";
import { parseNumstat, parseStatus } from "./status";
import { unifiedPatch } from "../../../../sdk/text-diff";

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

// Latest-update tracking: the last-seen content of each changed file per workspace, so a refresh
// can show only what the most recent edit changed instead of everything since HEAD.
const MAX_SNAPSHOT_BYTES = 1024 * 1024;
interface Seen { size: number; mtime: number | null; text: string | null; binary: boolean }
interface Latest { document: string | null; files: string[]; at: string | null; baseline: boolean; empty: boolean }
const snapshots = new Map<string, Map<string, Seen>>();
const latest = new Map<string, Latest>();
const latestQueue = new Map<string, Promise<any>>();

const GONE: Seen = { size: -1, mtime: null, text: null, binary: false };
async function statSeen(ctx: ModuleContext, grant: string, path: string): Promise<Seen> {
  try {
    const st = await ctx.host.fs.stat(grant, path);
    return st.kind === "file" ? { size: st.size, mtime: st.mtime, text: null, binary: st.size > MAX_SNAPSHOT_BYTES } : GONE;
  } catch { return GONE; }
}
async function readSeen(ctx: ModuleContext, grant: string, path: string, st: Seen): Promise<Seen> {
  if (st.size < 0 || st.binary) return st;
  try {
    const r = await ctx.host.fs.read(grant, path, MAX_SNAPSHOT_BYTES);
    return { ...st, text: r.binary || r.truncated ? null : r.text ?? "", binary: r.binary || r.truncated };
  } catch { return GONE; }
}
const missing = (s: Seen) => s.size < 0;

async function headText(ctx: ModuleContext, d: WorkspaceDescriptor, repoPath: string): Promise<string | null> {
  const r = await git(ctx, d, ["show", `HEAD:${repoPath}`], MAX_SNAPSHOT_BYTES);
  return r.code === 0 && !r.truncated ? r.stdout : null;
}

function filePatch(path: string, before: Seen | null, after: Seen): string {
  const b = before && !missing(before) ? before : null, a = missing(after) ? null : after;
  if (b?.binary || a?.binary) {
    if (b && a && b.size === a.size && b.mtime === a.mtime) return "";
    return `diff --git a/${path} b/${path}\nBinary files ${b ? "a/" + path : "/dev/null"} and ${a ? "b/" + path : "/dev/null"} differ\n`;
  }
  return unifiedPatch(path, b ? b.text : null, a ? a.text : null);
}

function setLatest(ctx: ModuleContext, workspaceId: string, next: Latest) {
  const prev = latest.get(workspaceId)?.document;
  latest.set(workspaceId, next);
  // Release the replaced document after the panel has had a moment to render the new one.
  if (prev && prev !== next.document) setTimeout(() => { void ctx.host.resources.release(prev).catch(() => {}); }, 5000);
}

async function computeLatest(ctx: ModuleContext, workspaceId: string): Promise<any> {
  const d = await desc(ctx, workspaceId);
  const prefixR = await git(ctx, d, ["rev-parse", "--show-prefix"]);
  if (prefixR.code !== 0) return { workspaceId: d.id, repo: false, document: null, files: [], at: null, baseline: false, empty: true };
  const prefix = prefixR.stdout.trim();
  const st = await git(ctx, d, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "."]);
  if (st.code !== 0) fail(st, "git status");
  const changes = parseStatus(st.stdout).filter(c => c.path.startsWith(prefix)).map(c => ({ ...c, path: c.path.slice(prefix.length) }));
  const kinds = new Map(changes.map(c => [c.path, c.kind]));
  const grant = (await workspaceGrant(ctx, d, "fs")).grant;
  let snap = snapshots.get(d.id);
  const candidates = new Set([...kinds.keys(), ...(snap?.keys() || [])]);
  // Stat everything; read only files that may have changed. mtime has one-second resolution, so
  // a same-size file whose mtime is near the newest one is re-read (compared on the file
  // system's own clock, which also holds for SSH workspaces).
  const stats = new Map<string, Seen>();
  for (const path of candidates) stats.set(path, await statSeen(ctx, grant, path));
  const newestMtime = Math.max(0, ...[...stats.values()].map(x => x.mtime ?? 0));
  const current = new Map<string, Seen>();
  for (const [path, st] of stats) {
    const before = snap?.get(path);
    const unchanged = before && before.size === st.size && before.mtime === st.mtime && st.mtime !== null && st.mtime < newestMtime - 2;
    current.set(path, unchanged ? before : await readSeen(ctx, grant, path, st));
  }

  // First look at this workspace: no previous version to compare with, so show the most
  // recently modified changed file against HEAD.
  if (!snap) {
    snapshots.set(d.id, new Map([...current].filter(([p]) => kinds.has(p))));
    const newest = [...current].filter(([p]) => kinds.has(p)).sort((x, y) => (y[1].mtime ?? 0) - (x[1].mtime ?? 0))[0];
    let text = "";
    if (newest) {
      const [path, after] = newest;
      const base = kinds.get(path) === "untracked" || kinds.get(path) === "added" ? null : await headText(ctx, d, prefix + path);
      text = filePatch(path, base === null ? null : { size: base.length, mtime: null, text: base, binary: false }, after);
    }
    const result: Latest = { document: text ? await ctx.host.ui.documentOpen(d.id, text, "diff", { path: "latest.diff" }) : null,
      files: newest ? [newest[0]] : [], at: newest?.[1].mtime ? new Date(newest[1].mtime * 1000).toISOString() : null, baseline: true, empty: !text };
    setLatest(ctx, d.id, result);
    return { workspaceId: d.id, repo: true, ...result };
  }

  const patches: string[] = [], files: string[] = [];
  for (const [path, after] of current) {
    const before = snap.get(path);
    if (before === after) continue;
    let prev: Seen | null = before ?? null;
    if (!before) {
      // Newly changed since the last look: its previous version is the committed one.
      const base = kinds.get(path) === "untracked" ? null : await headText(ctx, d, prefix + path);
      prev = base === null ? null : { size: base.length, mtime: null, text: base, binary: false };
    }
    const patch = filePatch(path, prev, after);
    if (patch) { patches.push(patch); files.push(path); }
  }
  snap = new Map([...current].filter(([p]) => kinds.has(p)));
  snapshots.set(d.id, snap);
  if (patches.length) {
    const text = patches.join("");
    setLatest(ctx, d.id, { document: await ctx.host.ui.documentOpen(d.id, text, "diff", { path: "latest.diff" }), files, at: new Date().toISOString(), baseline: false, empty: false });
  }
  const result = latest.get(d.id)!;
  return { workspaceId: d.id, repo: true, ...result };
}

let watchers: ReturnType<typeof fileWatch>[] = [];
let selection = 0, selectedId: string | null = null;
let changeTimer: ReturnType<typeof setTimeout> | null = null;
function changed(ctx: ModuleContext, workspaceId: string) {
  if (changeTimer) clearTimeout(changeTimer);
  changeTimer = setTimeout(() => ctx.events.emit("git.changed", { workspaceId }), 200);
}
async function watchSelected(ctx: ModuleContext) {
  const id = (ctx.state.get("workspace.selected") as any)?.id || null;
  if (id === selectedId) return;
  selectedId = id;
  const mine = ++selection;
  const previous = watchers; watchers = [];
  await Promise.all(previous.map(w => w.stop()));
  if (!id || mine !== selection) return;
  try {
    const d = await desc(ctx, id);
    // A linked checkout stores its index/HEAD outside the workspace. Watch both its private
    // metadata and shared refs, using independently scoped grants for those directories.
    const roots = await git(ctx, d, ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"]);
    if (mine !== selection || roots.code !== 0) return;
    for (const root of new Set(roots.stdout.trim().split("\n").filter(Boolean))) {
      const watcher = fileWatch(ctx, workspaceId => changed(ctx, workspaceId));
      watchers.push(watcher);
      await watcher.select(d, root);
      if (mine !== selection) { await watcher.stop(); return; }
    }
  } catch (e) { ctx.log.warn(`Git watcher: ${String(e)}`); }
}
const mod: AppModule = {
  id: "git",
  moduleApiVersion: 1,
  async activate(ctx) {
    ctx.events.on("files.changed", (event: any) => {
      if (event.workspaceId === selectedId) changed(ctx, event.workspaceId);
    });
    ctx.state.watch("workspace.selected", () => { void watchSelected(ctx); });
    await watchSelected(ctx);
  },
  async deactivate() {
    selection++;
    if (changeTimer) clearTimeout(changeTimer);
    await Promise.all(watchers.map(w => w.stop())); watchers = [];
  },
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

    /** Only what changed since the previous call (the most recent update), as one patch. */
    latestChange(ctx, a) {
      const id = String(a.workspaceId);
      const next = (latestQueue.get(id) || Promise.resolve()).catch(() => {}).then(() => computeLatest(ctx, id));
      latestQueue.set(id, next);
      void next.finally(() => { if (latestQueue.get(id) === next) latestQueue.delete(id); }).catch(() => {});
      return next;
    },

    /** One patch of every working-tree change against HEAD (tracked, staged and untracked). */
    async diffAll(ctx, a) {
      const d = await desc(ctx, a.workspaceId);
      const prefixR = await git(ctx, d, ["rev-parse", "--show-prefix"]);
      if (prefixR.code !== 0) return { workspaceId: d.id, repo: false, document: null, files: 0, empty: true, truncated: false };
      const prefix = prefixR.stdout.trim();
      const tracked = await git(ctx, d, ["diff", "--no-ext-diff", "-M", await base(ctx, d), "--", "."]);
      if (tracked.code !== 0) fail(tracked, "git diff");
      let text = tracked.stdout, truncated = tracked.truncated;
      const st = await git(ctx, d, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "."]);
      if (st.code !== 0) fail(st, "git status");
      const changes = parseStatus(st.stdout);
      const maxUntracked = Math.min(Math.max(Number(a.maxUntracked) || 100, 0), 500);
      const untracked = changes.filter(c => c.kind === "untracked" && c.path.startsWith(prefix)).map(c => c.path.slice(prefix.length));
      for (const path of untracked.slice(0, maxUntracked)) {
        if (text.length >= MAX_PATCH_BYTES) { truncated = true; break; }
        const r = await git(ctx, d, ["diff", "--no-index", "--no-ext-diff", "--", "/dev/null", path], MAX_PATCH_BYTES - text.length);
        if (r.code !== 0 && r.code !== 1) continue;
        if (r.stdout) text += (text && !text.endsWith("\n") ? "\n" : "") + r.stdout;
        truncated ||= r.truncated;
      }
      if (untracked.length > maxUntracked) truncated = true;
      const key = `${d.id}|*all*`;
      const cached = docCache.get(key);
      const document = cached && cached.text === text ? cached.document : await ctx.host.ui.documentOpen(d.id, text, "diff", { path: "changes.diff" });
      docCache.set(key, { text, document });
      return { workspaceId: d.id, repo: true, document, files: changes.length, empty: !text.trim(), truncated };
    },
  },
};
export default mod;
