// Shared between git-panel and viewer: viewer tabs for diffs are stored as prefixed preview paths.
export const DIFF_TAB_PREFIX = "git-diff:";
const TASK_DIFF_TAB_PREFIX = "git-task-diff:";
export const diffTab = (path: string) => DIFF_TAB_PREFIX + path;
export const taskDiffTab = (path: string) => TASK_DIFF_TAB_PREFIX + path;
export const isTaskDiffTab = (tab: string) => tab.startsWith(TASK_DIFF_TAB_PREFIX);
/** The file path of a diff tab, or null for an ordinary file tab. */
export const diffTabPath = (tab: string | null | undefined) => {
  if (tab?.startsWith(DIFF_TAB_PREFIX)) return tab.slice(DIFF_TAB_PREFIX.length);
  if (tab?.startsWith(TASK_DIFF_TAB_PREFIX)) return tab.slice(TASK_DIFF_TAB_PREFIX.length);
  return null;
};
