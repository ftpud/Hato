// module-dev: source browse/patch/build/activate/rollback policy for application modules.
// It uses only generic kernel primitives: a source-scope FS grant (writes require per-operation
// native approval showing a kernel-computed diff), a build grant that can run only esbuild with
// output to stdout, and the kernel's module stage/activate/rollback lifecycle (also approved
// natively). The kernel itself knows nothing about TypeScript or esbuild.
import type { AppModule, ModuleContext } from "../../../../sdk/types";
import { errMsg } from "../../../../sdk/runtime";

const BUILD_ARGS = ["--bundle", "--format=esm", "--platform=neutral", "--target=es2020", "--log-level=warning", "--charset=utf8", "--legal-comments=none", "--loader:.sql=text", "--loader:.md=text"];
let srcRead: Promise<string> | null = null;
let srcWrite: Promise<string> | null = null;
let shared: Promise<string> | null = null;
const lastBuild = new Map<string, any>();

const grantRead = (ctx: ModuleContext) => (srcRead ??= ctx.host.capabilities.request({ kind: "source" }).then((g) => g.grant).catch((e) => { srcRead = null; throw e; }));
const grantWrite = (ctx: ModuleContext) => (srcWrite ??= ctx.host.capabilities.request({ kind: "source", write: true }).then((g) => g.grant).catch((e) => { srcWrite = null; throw e; }));
const grantShared = (ctx: ModuleContext) => (shared ??= ctx.host.capabilities.request({ kind: "fs", root: ctx.host.env.info().sharedDir, write: true }).then((g) => g.grant).catch((e) => { shared = null; throw e; }));

async function moduleDir(ctx: ModuleContext, id: string): Promise<string> {
  const d: any = await ctx.host.modules.describe(id);
  // sourceDir is repo-relative, e.g. "modules/ui/projects-panel"
  return String(d.sourceDir).replace(/^modules\//, "");
}

/** Normalize an agent-supplied path to a modules/-relative path inside the module directory. */
async function resolveSourcePath(ctx: ModuleContext, id: string, p: string): Promise<string> {
  const dir = await moduleDir(ctx, id);
  let rel = String(p || "").trim().replace(/^\.\//, "");
  if (rel.startsWith("a/") || rel.startsWith("b/")) rel = rel.slice(2);
  if (rel.startsWith("modules/")) rel = rel.slice("modules/".length);
  if (!rel.startsWith(dir + "/")) rel = `${dir}/${rel}`;
  const parts: string[] = [];
  for (const seg of rel.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") { parts.pop(); continue; }
    parts.push(seg);
  }
  const norm = parts.join("/");
  if (!norm.startsWith(dir + "/")) {
    const e: any = new Error(`path ${p} is outside module '${id}' (allowed: modules/${dir}/)`);
    e.code = "EPERM";
    throw e;
  }
  return norm;
}

async function listTree(ctx: ModuleContext, grant: string, dir: string, out: string[], depth = 0) {
  if (depth > 6 || out.length > 500) return;
  const r = await ctx.host.fs.list(grant, dir);
  for (const e of r.entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const p = `${dir}/${e.name}`;
    if (e.kind === "dir") await listTree(ctx, grant, p, out, depth + 1);
    else out.push(p);
  }
}

// ---- unified diff -----------------------------------------------------------------------------
interface Hunk { oldStart: number; lines: string[] }
interface FilePatch { path: string; hunks: Hunk[]; isNew: boolean }

export function parseUnifiedDiff(patch: string): FilePatch[] {
  const files: FilePatch[] = [];
  const lines = patch.replace(/\r\n/g, "\n").split("\n");
  let cur: FilePatch | null = null;
  let hunk: Hunk | null = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith("--- ")) {
      const next = lines[i + 1] || "";
      if (next.startsWith("+++ ")) {
        const oldP = l.slice(4).split("\t")[0].trim();
        const newP = next.slice(4).split("\t")[0].trim();
        const strip = (x: string) => x.replace(/^[ab]\//, "");
        cur = { path: strip(newP === "/dev/null" ? oldP : newP), hunks: [], isNew: oldP === "/dev/null" };
        files.push(cur); hunk = null; i++;
        continue;
      }
    }
    const h = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(l);
    if (h) {
      if (!cur) throw new Error("hunk before file header");
      hunk = { oldStart: Number(h[1]), lines: [] };
      cur.hunks.push(hunk);
      continue;
    }
    if (hunk && (l.startsWith(" ") || l.startsWith("+") || l.startsWith("-"))) hunk.lines.push(l);
    else if (hunk && l === "") hunk.lines.push(" ");
    else if (l.startsWith("\\ No newline")) continue;
  }
  if (!files.length) throw new Error("no file headers (--- / +++) found in patch");
  return files;
}

export function applyHunks(text: string, hunks: Hunk[]): string {
  const src = text.split("\n");
  let out: string[] = [];
  let pos = 0;
  for (const h of hunks) {
    // Trailing blank context lines produced by editors are not meaningful.
    while (h.lines.length && h.lines[h.lines.length - 1] === " " ) h.lines.pop();
    const oldLines = h.lines.filter((l) => !l.startsWith("+")).map((l) => l.slice(1));
    const newLines = h.lines.filter((l) => !l.startsWith("-")).map((l) => l.slice(1));
    const want = Math.max(0, h.oldStart - 1);
    const matches = (at: number) => oldLines.every((ol, k) => src[at + k] !== undefined && src[at + k].trimEnd() === ol.trimEnd());
    let at = -1;
    for (let d = 0; d <= Math.max(src.length, 1); d++) {
      if (want - d >= pos && matches(want - d)) { at = want - d; break; }
      if (want + d <= src.length && matches(want + d)) { at = want + d; break; }
      if (want - d < pos && want + d > src.length) break;
    }
    if (at < 0) throw new Error(`hunk @@ -${h.oldStart} does not apply (context not found)`);
    out = out.concat(src.slice(pos, at), newLines);
    pos = at + oldLines.length;
  }
  return out.concat(src.slice(pos)).join("\n");
}

async function backup(ctx: ModuleContext, rel: string, content: string) {
  try {
    const g = await grantShared(ctx);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const path = `backups/${rel.replace(/\//g, "__")}.${stamp}.bak`;
    await ctx.host.fs.mkdir(g, "backups");
    await ctx.host.fs.writeAtomic(g, path, content);
    return path;
  } catch (e) {
    ctx.log.warn("backup failed", errMsg(e));
    return null;
  }
}

async function readSrc(ctx: ModuleContext, rel: string): Promise<string | null> {
  try {
    const r = await ctx.host.fs.read(await grantRead(ctx), rel, 2 * 1024 * 1024);
    if (r.binary) throw new Error(`${rel} is binary`);
    return r.text!;
  } catch (e: any) {
    if (e && e.code === "ENOENT") return null;
    throw e;
  }
}

async function build(ctx: ModuleContext, id: string) {
  const info = await ctx.host.modules.sourceInfo();
  if (!info.buildTool) return { ok: false, error: "esbuild is not installed in the repository (run `npm ci`)" };
  const d: any = await ctx.host.modules.describe(id);
  const entry = `${d.sourceDir}/${d.manifest.entry}`;
  const g = await ctx.host.capabilities.request({ kind: "build" });
  const t0 = Date.now();
  const r = await ctx.host.process.run(g.grant, { executable: info.buildTool, args: [entry, ...BUILD_ARGS], cwd: info.repoRoot }, { timeoutMs: 120000, limitBytes: 8 * 1024 * 1024 });
  await ctx.host.capabilities.release(g.grant).catch(() => {});
  const diagnostics = r.stderr.trim();
  if (r.code !== 0 || !r.stdout.trim()) {
    const res = { ok: false, id, error: `build failed (exit ${r.code})`, diagnostics, buildMs: Date.now() - t0 };
    lastBuild.set(id, res);
    return res;
  }
  try {
    const staged = await ctx.host.modules.stageArtifact(id, r.stdout);
    const res = { ok: true, id, stageId: staged.stageId, version: staged.version, label: staged.label, sha256: staged.sha256, diagnostics, buildMs: Date.now() - t0 };
    lastBuild.set(id, res);
    return res;
  } catch (e: any) {
    const res = { ok: false, id, error: errMsg(e), code: e.code, diagnostics, buildMs: Date.now() - t0 };
    lastBuild.set(id, res);
    return res;
  }
}

const mod: AppModule = {
  id: "module-dev",
  moduleApiVersion: 1,
  methods: {
    list: (ctx) => ctx.host.modules.list(),
    describe: async (ctx, a) => {
      const d: any = await ctx.host.modules.describe(String(a.id));
      return { ...d, lastBuild: lastBuild.get(String(a.id)) || null };
    },
    logs: (ctx, a) => ctx.host.modules.logs(String(a.id), Number(a.limit) || 100),

    /** Without `path`: list the module's source files. With `path`: return its text. */
    async readSource(ctx, a) {
      const id = String(a.id);
      const dir = await moduleDir(ctx, id);
      if (!a.path) {
        const files: string[] = [];
        await listTree(ctx, await grantRead(ctx), dir, files);
        return { id, root: `modules/${dir}`, files: files.map((f) => `modules/${f}`) };
      }
      const rel = await resolveSourcePath(ctx, id, a.path);
      const text = await readSrc(ctx, rel);
      if (text === null) throw new Error(`modules/${rel} not found`);
      return { id, path: `modules/${rel}`, text };
    },

    /**
     * Apply a change to allowlisted module sources. Accepts a unified diff (`patch`), exact
     * replacements (`edits: [{path, oldText, newText}]`) or a whole file (`path` + `content`).
     * Each file write is approved natively with a kernel-computed diff; a backup is kept.
     */
    async applyPatch(ctx, a) {
      const id = String(a.id);
      const changes: { rel: string; before: string | null; after: string }[] = [];
      if (typeof a.patch === "string" && a.patch.trim()) {
        for (const fp of parseUnifiedDiff(a.patch)) {
          const rel = await resolveSourcePath(ctx, id, fp.path);
          const before = await readSrc(ctx, rel);
          if (before === null && !fp.isNew) throw new Error(`modules/${rel} does not exist`);
          changes.push({ rel, before, after: applyHunks(before ?? "", fp.hunks) });
        }
      } else if (Array.isArray(a.edits)) {
        const byFile = new Map<string, string | null>();
        for (const e of a.edits) {
          const rel = await resolveSourcePath(ctx, id, e.path);
          if (!byFile.has(rel)) byFile.set(rel, await readSrc(ctx, rel));
          const cur = byFile.get(rel);
          if (cur === null || cur === undefined) throw new Error(`modules/${rel} does not exist`);
          const n = cur.split(String(e.oldText)).length - 1;
          if (n !== 1) throw new Error(`oldText must occur exactly once in modules/${rel} (found ${n})`);
          byFile.set(rel, cur.replace(String(e.oldText), () => String(e.newText)));
        }
        for (const [rel, after] of byFile) changes.push({ rel, before: await readSrc(ctx, rel), after: after! });
      } else if (typeof a.path === "string" && typeof a.content === "string") {
        const rel = await resolveSourcePath(ctx, id, a.path);
        changes.push({ rel, before: await readSrc(ctx, rel), after: a.content });
      } else {
        throw new Error("provide `patch` (unified diff), `edits`, or `path` + `content`");
      }
      const results: any[] = [];
      for (const c of changes) {
        if (c.before === c.after) { results.push({ path: `modules/${c.rel}`, changed: false }); continue; }
        const bak = c.before !== null ? await backup(ctx, c.rel, c.before) : null;
        await ctx.host.fs.writeAtomic(await grantWrite(ctx), c.rel, c.after, { reason: a.reason ? String(a.reason).slice(0, 300) : undefined });
        results.push({ path: `modules/${c.rel}`, changed: true, backup: bak });
      }
      ctx.events.emit("module-dev.sourceChanged", { id, files: results.map((r) => r.path) });
      return { ok: true, id, files: results };
    },

    build: (ctx, a) => build(ctx, String(a.id)),

    async activate(ctx, a) {
      const id = String(a.id);
      const stageId = String(a.stageId || lastBuild.get(id)?.stageId || "");
      if (!stageId) throw new Error(`no staged build for '${id}'; run build first`);
      const r = await ctx.host.modules.activate(id, stageId);
      return { ...r, ok: true };
    },

    async rollback(ctx, a) {
      const r = await ctx.host.modules.rollback(String(a.id), a.toVersion ? { toVersion: Number(a.toVersion) } : undefined);
      return { ...r, ok: true };
    },

    async buildAndActivate(ctx, a) {
      const b: any = await build(ctx, String(a.id));
      if (!b.ok) return b;
      try {
        const r = await ctx.host.modules.activate(String(a.id), b.stageId);
        return { ...r, ok: true, build: b };
      } catch (e: any) {
        return { ok: false, id: a.id, error: errMsg(e), code: e.code, build: b };
      }
    },
  },
};
export default mod;
