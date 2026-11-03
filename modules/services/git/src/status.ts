// Pure parsers for `git status --porcelain=v1 -z` and `git diff --numstat -z` (unit-testable).
export type ChangeKind = "modified" | "added" | "deleted" | "renamed" | "copied" | "untracked" | "conflicted" | "typechange";
export interface GitChange {
  path: string; origPath: string | null;
  index: string; worktree: string; kind: ChangeKind;
  staged: boolean; unstaged: boolean;
  additions: number | null; deletions: number | null; binary: boolean;
}

const CONFLICT = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

function kindOf(x: string, y: string): ChangeKind {
  const xy = x + y;
  if (xy === "??") return "untracked";
  if (CONFLICT.has(xy)) return "conflicted";
  for (const c of [x, y]) {
    if (c === "R") return "renamed";
    if (c === "C") return "copied";
  }
  if (x === "A") return "added";
  if (x === "D" || y === "D") return "deleted";
  if (x === "T" || y === "T") return "typechange";
  return "modified";
}

export function parseStatus(out: string): GitChange[] {
  const parts = out.split("\0");
  const changes: GitChange[] = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (entry.length < 4) continue;
    const x = entry[0], y = entry[1], path = entry.slice(3);
    if (x === "!") continue;
    let origPath: string | null = null;
    if (x === "R" || x === "C" || y === "R" || y === "C") origPath = parts[++i] || null;
    const kind = kindOf(x, y);
    changes.push({ path, origPath, index: x, worktree: y, kind,
      staged: x !== " " && x !== "?", unstaged: y !== " ",
      additions: null, deletions: null, binary: false });
  }
  return changes.sort((a, b) => a.path.localeCompare(b.path));
}

/** Map of path -> line counts from `git diff --numstat -z` (renames keyed by the new path). */
export function parseNumstat(out: string): Map<string, { additions: number | null; deletions: number | null; binary: boolean }> {
  const result = new Map();
  const parts = out.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(parts[i]);
    if (!m) continue;
    let path = m[3];
    if (path === "") { i++; path = parts[++i] || ""; } // rename: "\0old\0new"
    const binary = m[1] === "-";
    result.set(path, { additions: binary ? null : Number(m[1]), deletions: binary ? null : Number(m[2]), binary });
  }
  return result;
}
