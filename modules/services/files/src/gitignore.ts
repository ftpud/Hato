// Git-aware helpers for the files service: which paths .gitignore hides, and content search.
// Outside a Git repository nothing is treated as ignored and content search falls back to grep.
import type { ModuleContext, RunResult } from "../../../../sdk/types";
import { targetFor, withWorkspace, workspaceGrant, type WorkspaceDescriptor } from "../../../../sdk/runtime";

async function run(ctx: ModuleContext, d: WorkspaceDescriptor, executable: string, args: string[], stdin?: string, limitBytes = 4 << 20, timeoutMs = 30000): Promise<RunResult> {
  return withWorkspace(ctx, d, async () => {
    const g = await workspaceGrant(ctx, d, "process");
    return ctx.host.process.run(g.grant, { target: await targetFor(ctx, d), executable, args, cwd: d.rootAbsolutePath, loginShell: d.location === "ssh" },
      { timeoutMs, limitBytes, ...(stdin !== undefined ? { stdin } : {}) });
  });
}
const git = (ctx: ModuleContext, d: WorkspaceDescriptor, args: string[], stdin?: string, limit?: number, timeout?: number) =>
  run(ctx, d, "git", ["--no-optional-locks", "-c", "core.quotepath=false", ...args], stdin, limit, timeout);

/** Paths among `entries` that Git ignores (tracked files never count). `.git` itself is included. */
export async function ignoredAmong(ctx: ModuleContext, d: WorkspaceDescriptor, entries: { relativePath: string; kind: string }[]): Promise<Set<string>> {
  const out = new Set(entries.filter(e => e.relativePath === ".git" || e.relativePath.endsWith("/.git")).map(e => e.relativePath));
  const ask = entries.filter(e => !out.has(e.relativePath));
  if (!ask.length) return out;
  // Directory patterns ("build/") only match when the path is passed with a trailing slash.
  const byQuery = new Map(ask.map(e => [e.kind === "dir" ? e.relativePath + "/" : e.relativePath, e.relativePath]));
  const r = await git(ctx, d, ["check-ignore", "-z", "--stdin"], [...byQuery.keys()].join("\0") + "\0").catch(() => null);
  if (!r || (r.code !== 0 && r.code !== 1)) return out; // 128: not a repository
  for (const p of r.stdout.split("\0")) { const rel = byQuery.get(p); if (rel) out.add(rel); }
  return out;
}

export interface IgnoredSet { dirs: string[]; files: Set<string> }
const ignoredCache = new Map<string, { time: number; pending: Promise<IgnoredSet | null> }>();
export const invalidateIgnored = (d: WorkspaceDescriptor) => ignoredCache.delete(`${d.id}|${d.rootAbsolutePath}`);
/** Every ignored path in the workspace (ignored directories collapsed to one entry). */
export function ignoredSet(ctx: ModuleContext, d: WorkspaceDescriptor): Promise<IgnoredSet | null> {
  const key = `${d.id}|${d.rootAbsolutePath}`;
  const hit = ignoredCache.get(key);
  if (hit && Date.now() - hit.time < 30000) return hit.pending;
  const pending = (async () => {
    const r = await git(ctx, d, ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"], undefined, 8 << 20).catch(() => null);
    if (!r || r.code !== 0) return null;
    const dirs: string[] = [], files = new Set<string>();
    for (const p of r.stdout.split("\0")) if (p) (p.endsWith("/") ? dirs.push(p) : files.add(p));
    return { dirs, files };
  })();
  ignoredCache.set(key, { time: Date.now(), pending });
  pending.catch(() => ignoredCache.delete(key));
  return pending;
}
export function isIgnored(set: IgnoredSet | null, path: string): boolean {
  if (path === ".git" || path.startsWith(".git/") || path.includes("/.git/") || path.endsWith("/.git")) return true;
  if (!set) return false;
  return set.files.has(path) || set.dirs.some(dir => path === dir.slice(0, -1) || path.startsWith(dir));
}

export interface GrepMatch { line: number; text: string }
export interface GrepFile { relativePath: string; matches: GrepMatch[] }
/** Case-insensitive literal search of file contents. Binary files are skipped. */
export async function grepFiles(ctx: ModuleContext, d: WorkspaceDescriptor, query: string, includeIgnored: boolean, maxMatches = 500) {
  const limit = 3 << 20;
  let r = await git(ctx, d, ["grep", "-z", "-n", "-I", "-i", "-F", "--no-color", "--untracked", ...(includeIgnored ? ["--no-exclude-standard"] : []), "-e", query], undefined, limit, 60000).catch(() => null);
  let viaGit = true;
  if (!r || r.code === 128 || (r.code !== 0 && r.code !== 1)) {
    viaGit = false;
    r = await run(ctx, d, "grep", ["-r", "-n", "-I", "-i", "-F", "--null", "--exclude-dir=.git", "-e", query, "--", "."], undefined, limit, 60000);
    if (r.code !== 0 && r.code !== 1) throw new Error(`Search failed: ${(r.stderr || r.stdout).trim().slice(0, 300) || `exit ${r.code}`}`);
  }
  const files = new Map<string, GrepFile>();
  let count = 0, truncated = !!r.truncated;
  for (const raw of r.stdout.split("\n")) {
    if (!raw) continue;
    // git grep -z: path\0line\0text · grep --null: path\0line:text
    const a = raw.indexOf("\0");
    if (a < 0) continue;
    let path = raw.slice(0, a), rest = raw.slice(a + 1), line: number, text: string;
    const b = viaGit ? rest.indexOf("\0") : rest.indexOf(":");
    if (b < 0) continue;
    line = Number(rest.slice(0, b)); text = rest.slice(b + 1);
    if (!Number.isFinite(line)) continue;
    if (path.startsWith("./")) path = path.slice(2);
    if (count >= maxMatches) { truncated = true; break; }
    let f = files.get(path);
    if (!f) { f = { relativePath: path, matches: [] }; files.set(path, f); }
    f.matches.push({ line, text: text.trim().slice(0, 240) });
    count++;
  }
  return { files: [...files.values()], matchCount: count, fileCount: files.size, truncated, engine: viaGit ? "git grep" : "grep" };
}
