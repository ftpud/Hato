// MCP commands for Git tasks. The project always comes from the authenticated session's workspace
// (a project root or one of its task worktrees), never from agent-supplied arguments.
import type { ModuleContext } from "../../../../sdk/types";
import type { McpScope, ModuleMcpTool } from "../../../../sdk/mcp";

interface TaskOps {
  create(args: { projectId: string; name?: string; branch?: string; select: boolean }): Promise<any>;
  reconcile(projectId: string): Promise<any>;
}

const object = (properties: Record<string, any>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });

export function taskTools(ctx: ModuleContext, ops: TaskOps): ModuleMcpTool[] {
  const projectOf = async (scope: McpScope) => {
    const d = await ctx.modules.call("workspace", "resolve", { workspaceId: scope.workspaceId });
    return { projectId: String(d.projectId), currentTaskId: d.taskId as string | null };
  };
  const view = (t: any, currentTaskId: string | null) => ({
    id: t.id, workspaceId: `task:${t.id}`, name: t.name, branch: t.branch, worktreePath: t.worktreePath, status: t.status, current: t.id === currentTaskId,
  });
  return [
    {
      name: "list",
      title: "List Git tasks",
      description: "List the Git tasks (branch + linked worktree) of the current project, including status and worktree path.",
      inputSchema: object({}),
      annotations: { readOnlyHint: true },
      async handler(_args, scope) {
        const { projectId, currentTaskId } = await projectOf(scope);
        const tasks = await ctx.modules.call("persistence", "tasks.list", { projectId });
        return tasks.map((t: any) => view(t, currentTaskId));
      },
    },
    {
      name: "create",
      title: "Create a Git task",
      description: "Create a Git task in the current project: a linked worktree on its own branch. With `branch`, an existing local branch is checked out, a branch existing on exactly one remote is tracked, and otherwise a new branch is created from HEAD. Without it, a task/<name>-<id> branch is generated. Does not switch the user's view.",
      inputSchema: object({
        name: { type: "string", maxLength: 100, description: "Task name shown in Hato. Defaults to the branch name." },
        branch: { type: "string", maxLength: 200, description: "Optional full branch name, e.g. feature/login-fix." },
      }),
      timeoutMs: 300000,
      async handler(args, scope) {
        const name = typeof args.name === "string" ? args.name : undefined;
        const branch = typeof args.branch === "string" ? args.branch : undefined;
        if (!name?.trim() && !branch?.trim()) throw new Error("Provide a task name or a branch");
        const { projectId } = await projectOf(scope);
        return ops.create({ projectId, name, branch, select: false });
      },
    },
    {
      name: "reconcile",
      title: "Reconcile Git tasks",
      description: "Compare the current project's tasks with `git worktree list` and update task statuses (missing, prunable, branch-mismatch). Never deletes anything.",
      inputSchema: object({}),
      annotations: { idempotentHint: true },
      async handler(_args, scope) {
        const { projectId } = await projectOf(scope);
        return ops.reconcile(projectId);
      },
    },
  ];
}
