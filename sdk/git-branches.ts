/** Workspace Git branch catalog shared by the service and branch picker. */
export interface GitBranch {
  ref: string; name: string; commit: string | null; current: boolean;
  upstream: string | null; worktree: string | null; unborn?: boolean;
}
export interface GitBranches {
  workspaceId: string; repo: boolean; current: string | null; head: string | null;
  local: GitBranch[]; remote: GitBranch[]; remotes: string[];
}
