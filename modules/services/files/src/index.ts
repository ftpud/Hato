// files: workspace-scoped listing and reading through scoped FS grants (local fs or SFTP on the
// workspace's machine). Returns native document handles for the viewer.
import type { AppModule, ModuleContext } from "../../../../sdk/types";
import { errMsg, langFromPath, withWorkspace, workspaceGrant, type WorkspaceDescriptor } from "../../../../sdk/runtime";

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

const mod: AppModule = {
  id: "files",
  moduleApiVersion: 1,
  methods: {
    async list(ctx, a) {
      const d = await desc(ctx, a.workspaceId);
      const rel = cleanRel(a.relativeDir);
      return withWorkspace(ctx, d, async () => {
        const g = await workspaceGrant(ctx, d, "fs");
        const r = await ctx.host.fs.list(g.grant, rel);
        const hidden = new Set([".git", ".DS_Store"]);
        const entries = r.entries
          .filter((e) => a.showHidden || !hidden.has(e.name))
          .sort((x, y) => (x.kind === "dir" ? 0 : 1) - (y.kind === "dir" ? 0 : 1) || x.name.localeCompare(y.name))
          .map((e) => ({ ...e, relativePath: rel === "." ? e.name : `${rel}/${e.name}` }));
        return { workspaceId: d.id, machineId: d.machineId, root: d.rootAbsolutePath, relativeDir: rel, entries };
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
          return { workspaceId: d.id, relativePath: rel, document: cached.document, language: langFromPath(rel), size: st.size, binary: false, truncated: false, cached: true };
        }
        const r = await ctx.host.fs.read(g.grant, rel, MAX_VIEW_BYTES);
        if (r.binary) {
          return { workspaceId: d.id, relativePath: rel, document: null, language: "binary", size: st.size, binary: true, truncated: r.truncated, message: `Binary file (${st.size} bytes) — not shown.` };
        }
        const language = langFromPath(rel);
        const text = r.truncated ? r.text + `\n\n… truncated: file is larger than ${MAX_VIEW_BYTES} bytes` : r.text!;
        const document = await ctx.host.ui.documentOpen(d.id, text, language, { path: rel });
        docCache.set(key, { document, mtime: st.mtime, size: st.size });
        return { workspaceId: d.id, relativePath: rel, document, language, size: st.size, binary: false, truncated: r.truncated };
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
