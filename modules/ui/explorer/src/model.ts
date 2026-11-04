import { fileIcons } from "../../../../sdk/file-icons";
import type { TreeRow } from "../../../../sdk/types";
export interface Entry { name: string; kind: string; relativePath: string; size?: number }
/** Reconstruct the normal filtered tree from content-matching file paths and their parents. */
export function matchingFileEntries(files: { relativePath: string }[]): Entry[] {
  const entries = new Map<string, Entry>();
  for (const file of files) {
    const parts = file.relativePath.split("/");
    for (let i = 1; i <= parts.length; i++) {
      const relativePath = parts.slice(0, i).join("/");
      entries.set(relativePath, { relativePath, name: parts[i - 1], kind: i === parts.length ? "file" : "dir" });
    }
  }
  return [...entries.values()];
}
export function fileIcon(entry: Entry): TreeRow["icon"] {
  if (entry.kind === "dir") return "folder";
  if (entry.kind === "symlink") return "link";
  const ext = entry.name.toLowerCase().split(".").pop() || "";
  if (["json", "jsonc", "yaml", "yml", "toml", "xml", "ini", "env"].includes(ext)) return "config";
  if (["md", "mdx", "txt", "rst"].includes(ext)) return "text";
  if (["ts", "tsx", "js", "jsx", "mjs", "rs", "py", "go", "rb", "java", "c", "cpp", "h", "swift", "sh", "css", "scss", "html", "sql"].includes(ext)) return "code";
  if (["png", "jpg", "jpeg", "webp", "gif", "svg", "ico"].includes(ext)) return "image";
  if (["zip", "gz", "tar", "bz2", "xz", "7z"].includes(ext)) return "archive";
  return "file";
}
export function directories(entries: Entry[]): Map<string, Entry[]> {
  const dirs = new Map<string, Entry[]>();
  for (const entry of entries) { const at = entry.relativePath.lastIndexOf("/"); const parent = at < 0 ? "." : entry.relativePath.slice(0, at); const items = dirs.get(parent) || []; items.push(entry); dirs.set(parent, items); }
  return dirs;
}
export function treeRows(dirs: Map<string, Entry[]>, expanded: Set<string>, selected: string | null, filtering = false, filterCollapsed = new Set<string>()): TreeRow[] {
  const rows: TreeRow[] = [];
  const visit = (parent: string, depth: number) => {
    for (const entry of [...(dirs.get(parent) || [])].sort((a, b) => Number(b.kind === "dir") - Number(a.kind === "dir") || a.name.localeCompare(b.name))) {
      if (rows.length >= 5000) return;
      const folder = entry.kind === "dir";
      const open = folder && (filtering ? !filterCollapsed.has(entry.relativePath) : expanded.has(entry.relativePath));
      const kind = fileIcon(entry) || "file";
      const drawing = folder ? open ? fileIcons.folderOpen : fileIcons.folder : fileIcons[kind as keyof typeof fileIcons] || fileIcons.file;
      // Soften only the explorer's icons; keep the shared tab drawings unchanged.
      const softDrawing = drawing.replace('stroke-width="1.7"', 'stroke-width="1.5" stroke-opacity="0.7"');
      const iconColor: TreeRow["iconColor"] = kind === "config" ? "warning" : ["text", "code"].includes(kind) ? "accent" : "muted";
      rows.push({ iconSvg: softDrawing, iconColor, key: entry.relativePath, label: entry.name, depth, expandable: folder, expanded: open, selected: entry.relativePath === selected, icon: fileIcon(entry) });
      if (open) visit(entry.relativePath, depth + 1);
    }
  };
  visit(".", 0);
  return rows;
}
