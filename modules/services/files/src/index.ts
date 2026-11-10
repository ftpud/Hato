// files: workspace-scoped listing and reading through scoped FS grants (local fs or SFTP on the
// workspace's machine). Returns native document handles for the viewer.
import { fileWatch } from "../../../../sdk/file-watch";
import { searchFiles, invalidateSearch } from "./search";
import { workspaceSkills } from "./skills";
import { grepFiles, ignoredAmong, ignoredSet, invalidateIgnored, isIgnored } from "./gitignore";
import type { AppModule, ModuleContext } from "../../../../sdk/types";
import { errMsg, langFromPath, targetFor, withWorkspace, workspaceGrant, type WorkspaceDescriptor } from "../../../../sdk/runtime";
import type { ScopeGrant } from "../../../../sdk/types";

const words = (q: string) => q.toLowerCase().trim().split(/\s+/).filter(Boolean);
const MAX_VIEW_BYTES = 2 * 1024 * 1024;
const docCache = new Map<string, { document: string; mtime: number | null; size: number }>();

async function desc(ctx: ModuleContext, workspaceId: string): Promise<WorkspaceDescriptor> {
  return ctx.modules.call("workspace", "resolve", { workspaceId });
}

function cleanRel(rel: any): string {
  const r = typeof rel === "string" && rel.length ? rel : ".";
  if (r.startsWith("/")) throw new Error("paths must be workspace-relative");
  const parts: string[] = [];
  for (const p of r.split("/")) {
    if (p === "" || p === ".") continue;
    if (p === "..") { if (!parts.length) throw new Error("path escapes the workspace root"); parts.pop(); continue; }
    parts.push(p);
  }
  return parts.length ? parts.join("/") : ".";
}

// Write grants are requested lazily (the kernel shows a native approval) and reused per root.
const writeGrants = new Map<string, Promise<ScopeGrant>>();
function writeGrant(ctx: ModuleContext, d: WorkspaceDescriptor): Promise<ScopeGrant> {
  const key = `${d.machineId}|${d.rootAbsolutePath}`;
  let p = writeGrants.get(key);
  if (!p) {
    p = (async () => ctx.host.capabilities.request({ kind: "fs", root: d.rootAbsolutePath, target: await targetFor(ctx, d), write: true, purpose: "Save files edited in the source editor." }))();
    writeGrants.set(key, p);
    p.catch(() => writeGrants.delete(key));
  }
  return p;
}

let watcher: ReturnType<typeof fileWatch> | null = null;
let changeTimer: ReturnType<typeof setTimeout> | null = null;
let selected: WorkspaceDescriptor | null = null;
let selection = 0;
async function watchSelected(ctx: ModuleContext) {
  const mine = ++selection;
  const ws: any = ctx.state.get("workspace.selected");
  try {
    const next = ws?.id ? await desc(ctx, ws.id) : null;
    if (mine !== selection) return;
    if (selected?.id === next?.id && selected?.rootAbsolutePath === next?.rootAbsolutePath) return;
    selected = next;
    await watcher?.select(next);
  } catch (e) { ctx.log.warn(`File watcher: ${errMsg(e)}`); }
}
let skillsVersion = 0;
async function publishSkills(ctx: ModuleContext) {
  const version = ++skillsVersion;
  const workspace = ctx.state.get("workspace.selected") as any;
  const workspaceId = workspace?.id || null;
  ctx.state.set("files.skills", { workspaceId, skills: [], loading: !!workspaceId, error: null });
  if (!workspaceId) return;
  try {
    const skills = await workspaceSkills(ctx, await desc(ctx, workspaceId));
    if (version === skillsVersion) ctx.state.set("files.skills", { workspaceId, skills, loading: false, error: null });
  } catch (e) {
    if (version === skillsVersion) ctx.state.set("files.skills", { workspaceId, skills: [], loading: false, error: errMsg(e) });
  }
}

const mod: AppModule = {
  id: "files",
  moduleApiVersion: 1,
  async activate(ctx) {
    ctx.events.on("git.changed", (event: any) => {
      if (!event.worktreeChanged || event.workspaceId !== selected?.id || !selected) return;
      invalidateSearch(selected); invalidateIgnored(selected);
      docCache.clear();
      ctx.events.emit("files.changed", { workspaceId: selected.id });
      void publishSkills(ctx);
    });
    watcher = fileWatch(ctx, workspaceId => {
      if (changeTimer) clearTimeout(changeTimer);
      changeTimer = setTimeout(() => {
        if (selected?.id !== workspaceId) return;
        invalidateSearch(selected); invalidateIgnored(selected);
        docCache.clear();
        ctx.events.emit("files.changed", { workspaceId });
        void publishSkills(ctx);
      }, 200);
    });
    // View-state updates (tabs, preview) also change `workspace.selected`; skills only depend on
    // which workspace it is.
    let skillsFor = (ctx.state.get("workspace.selected") as any)?.id || null;
    ctx.state.watch("workspace.selected", (ws: any) => {
      const id = ws?.id || null;
      if (id !== skillsFor) { skillsFor = id; void publishSkills(ctx); }
      void watchSelected(ctx);
    });
    await watchSelected(ctx);
    ctx.events.on("ai.skillsRequested", () => { void publishSkills(ctx); });
    await publishSkills(ctx);
  },
  async deactivate() {
    selection++; skillsVersion++;
    if (changeTimer) clearTimeout(changeTimer);
    await watcher?.stop(); watcher = null;
  },
  methods: {
    async search(ctx, a) {
      const query = String(a.query || "").slice(0, 300).trim();
      if (!query && a.refresh) invalidateSearch(await desc(ctx, a.workspaceId));
      if (!query) return { entries: [], matchCount: 0, indexedCount: 0, partial: false, skipped: 0 };
      const d = await desc(ctx, a.workspaceId);
      if (a.refresh) invalidateIgnored(d);
      const found = await searchFiles(ctx, d, query, !!a.refresh);
      if (!a.hideIgnored) return found;
      const ignored = await ignoredSet(ctx, d);
      const entries = found.entries.filter((e: any) => !isIgnored(ignored, e.relativePath));
      // Recount among visible paths: ancestor folders are included for display, not as matches.
      const w = words(query), hits = entries.filter((e: any) => w.every(x => e.relativePath.toLowerCase().includes(x))).length;
      return { ...found, entries, matchCount: found.partial ? Math.max(hits, found.matchCount - (found.entries.length - entries.length)) : hits, hiddenIgnored: found.entries.length - entries.length };
    },
    /** Literal, case-insensitive search of file contents (git grep; grep outside repositories). */
    async grep(ctx, a) {
      const query = String(a.query || "").slice(0, 300);
      if (query.trim().length < 2) return { files: [], matchCount: 0, fileCount: 0, truncated: false };
      const d = await desc(ctx, a.workspaceId);
      return grepFiles(ctx, d, query, !a.hideIgnored, Math.min(2000, Math.max(1, Number(a.maxMatches) || 500)));
    },
    async list(ctx, a) {
      const d = await desc(ctx, a.workspaceId);
      const rel = cleanRel(a.relativeDir);
      return withWorkspace(ctx, d, async () => {
        const g = await workspaceGrant(ctx, d, "fs");
        const r = await ctx.host.fs.list(g.grant, rel);
        const hidden = new Set([".git", ".DS_Store"]);
        let entries = r.entries
          .filter((e) => a.showHidden || !hidden.has(e.name))
          .sort((x, y) => (x.kind === "dir" ? 0 : 1) - (y.kind === "dir" ? 0 : 1) || x.name.localeCompare(y.name))
          .map((e) => ({ ...e, relativePath: rel === "." ? e.name : `${rel}/${e.name}` }));
        let hiddenIgnored = 0;
        if (a.hideIgnored && entries.length) {
          const ignored = await ignoredAmong(ctx, d, entries);
          hiddenIgnored = ignored.size;
          entries = entries.filter((e) => !ignored.has(e.relativePath));
        }
        return { workspaceId: d.id, machineId: d.machineId, root: d.rootAbsolutePath, relativeDir: rel, entries, hiddenIgnored };
      });
    },

    /** Read a file and open a native document handle (syntax highlighting is native). */
    async open(ctx, a) {
      const d = await desc(ctx, a.workspaceId);
      const rel = cleanRel(a.relativePath);
      return withWorkspace(ctx, d, async () => {
        const g = await workspaceGrant(ctx, d, "fs");
        const st = await ctx.host.fs.stat(g.grant, rel);
        if (st.kind === "dir") throw new Error(`${rel} is a directory`);
        const key = `${d.id}|${rel}`;
        const cached = docCache.get(key);
        if (cached && cached.mtime === st.mtime && cached.size === st.size) {
          return { workspaceId: d.id, relativePath: rel, document: cached.document, language: langFromPath(rel), size: st.size, mtime: st.mtime, binary: false, truncated: false, cached: true };
        }
        const r = await ctx.host.fs.read(g.grant, rel, MAX_VIEW_BYTES);
        if (r.binary) {
          return { workspaceId: d.id, relativePath: rel, document: null, language: "binary", size: st.size, binary: true, truncated: r.truncated, message: `Binary file (${st.size} bytes) — not shown.` };
        }
        const language = langFromPath(rel);
        const text = r.truncated ? r.text + `\n\n… truncated: file is larger than ${MAX_VIEW_BYTES} bytes` : r.text!;
        const document = await ctx.host.ui.documentOpen(d.id, text, language, { path: rel });
        docCache.set(key, { document, mtime: st.mtime, size: st.size });
        return { workspaceId: d.id, relativePath: rel, document, language, size: st.size, mtime: st.mtime, binary: false, truncated: r.truncated };
      });
    },

    /** Write a text file atomically. When `expectedMtime` is given and the file changed on disk
     *  since then, fails with a conflict unless `force`. The first write under a workspace root
     *  asks for native approval of a write grant. */
    async save(ctx, a) {
      const d = await desc(ctx, a.workspaceId);
      const rel = cleanRel(a.relativePath);
      if (rel === ".") throw new Error("a file path is required");
      if (typeof a.text !== "string") throw new Error("text must be a string");
      return withWorkspace(ctx, d, async () => {
        if (a.expectedMtime != null && !a.force) {
          const g = await workspaceGrant(ctx, d, "fs");
          const st = await ctx.host.fs.stat(g.grant, rel).catch(() => null);
          if (st && st.mtime != null && st.mtime !== a.expectedMtime) {
            const err: any = new Error(`${rel} changed on disk since it was opened`); err.code = "ECONFLICT"; throw err;
          }
        }
        const key = `${d.machineId}|${d.rootAbsolutePath}`;
        const w = await writeGrant(ctx, d);
        try { await ctx.host.fs.writeAtomic(w.grant, rel, a.text, { reason: `Save ${rel}` }); }
        catch (e: any) { if (e && ["ENOTCONN", "ESTALE", "EBADF"].includes(e.code)) writeGrants.delete(key); throw e; }
        docCache.delete(`${d.id}|${rel}`);
        const g = await workspaceGrant(ctx, d, "fs");
        const st = await ctx.host.fs.stat(g.grant, rel);
        return { workspaceId: d.id, relativePath: rel, size: st.size, mtime: st.mtime };
      });
    },

    async stat(ctx, a) {
      const d = await desc(ctx, a.workspaceId);
      const g = await workspaceGrant(ctx, d, "fs");
      try { return await ctx.host.fs.stat(g.grant, cleanRel(a.relativePath)); } catch (e) { return { error: errMsg(e) }; }
    },
  },
};
export default mod;
