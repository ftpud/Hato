import type { ModuleContext } from "../../../../sdk/types";
import { workspaceGrant, withWorkspace, type WorkspaceDescriptor } from "../../../../sdk/runtime";

export interface WorkspaceSkill { name: string; description: string; path: string }
function metadata(text: string, key: string): string {
  const header = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)?.[1];
  if (!header) return "";
  const lines = header.split(/\r?\n/);
  const index = lines.findIndex((line) => line.startsWith(key + ":"));
  if (index < 0) return "";
  const value = lines[index].slice(key.length + 1).trim();
  if (/^[>|][-+]?\s*$/.test(value)) {
    const continuation: string[] = [];
    for (const line of lines.slice(index + 1)) { if (line && !/^\s/.test(line)) break; continuation.push(line.trim()); }
    return continuation.join(" ").trim();
  }
  return value.replace(/^(["'])([\s\S]*)\1$/, "$2");
}

export async function workspaceSkills(ctx: ModuleContext, desc: WorkspaceDescriptor): Promise<WorkspaceSkill[]> {
  return withWorkspace(ctx, desc, async () => {
    const grant = await workspaceGrant(ctx, desc, "fs");
    let entries;
    try { entries = (await ctx.host.fs.list(grant.grant, ".agents/skills")).entries; }
    catch (e: any) { if (["ENOENT", "ENOTDIR"].includes(e?.code)) return []; throw e; }
    const skills: WorkspaceSkill[] = [];
    for (const entry of entries.filter((e) => ["dir", "symlink"].includes(e.kind)).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = `.agents/skills/${entry.name}/SKILL.md`;
      try {
        const file = await ctx.host.fs.read(grant.grant, path, 64 * 1024);
        if (file.binary || !file.text || file.truncated) continue;
        skills.push({ name: metadata(file.text, "name") || entry.name, description: metadata(file.text, "description"), path });
      } catch (e: any) {
        if (!["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes(e?.code)) throw e;
      }
    }
    return skills;
  });
}
