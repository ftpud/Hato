import { fileIcons } from "../../../../sdk/file-icons";
import type { TreeRow } from "../../../../sdk/types";

export interface Change { path: string; origPath: string | null; kind: string; index: string; worktree: string; staged: boolean; unstaged: boolean; additions: number | null; deletions: number | null; binary: boolean }

const LETTER: Record<string, string> = { modified: "M", added: "A", deleted: "D", renamed: "R", copied: "C", untracked: "U", conflicted: "!", typechange: "T" };
const COLOR: Record<string, TreeRow["iconColor"]> = { added: "success", untracked: "success", deleted: "warning", conflicted: "warning", renamed: "accent", copied: "accent", modified: "accent", typechange: "accent" };
const LABEL: Record<string, string> = { modified: "Modified", added: "Added", deleted: "Deleted", renamed: "Renamed", copied: "Copied", untracked: "Untracked", conflicted: "Conflicted", typechange: "Type changed" };

export function changeBadge(c: Change): string {
  const counts = c.binary ? "bin" : [c.additions ? `+${c.additions}` : "", c.deletions ? `−${c.deletions}` : ""].filter(Boolean).join(" ");
  return [LETTER[c.kind] || "?", counts].filter(Boolean).join(" ");
}

export function changeRows(changes: Change[], selected: string | null): TreeRow[] {
  return changes.slice(0, 5000).map((c) => {
    const at = c.path.lastIndexOf("/");
    const dir = at < 0 ? "" : c.path.slice(0, at);
    const state = [LABEL[c.kind] || c.kind, c.staged && c.unstaged ? "partly staged" : c.staged ? "staged" : ""].filter(Boolean).join(", ");
    return {
      key: c.path, label: c.path.slice(at + 1), depth: 0, expandable: false, expanded: false,
      selected: c.path === selected, badge: changeBadge(c),
      detail: [c.origPath ? `from ${c.origPath}` : dir, state].filter(Boolean).join(" · "),
      iconSvg: fileIcons.file, iconColor: COLOR[c.kind] || "muted",
    };
  });
}

/** Cheap fingerprint so polling only re-renders (and notifies the viewer) on real changes. */
export function signature(r: { branch?: string | null; files?: Change[] } | null): string {
  if (!r) return "";
  return (r.branch || "") + "\n" + (r.files || []).map((c) => `${c.index}${c.worktree} ${c.path} ${c.additions}/${c.deletions}`).join("\n");
}
