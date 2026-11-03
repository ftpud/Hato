// Shared between git-panel and viewer: viewer tabs for diffs are stored as prefixed preview paths.
export const DIFF_TAB_PREFIX = "git-diff:";
export const diffTab = (path: string) => DIFF_TAB_PREFIX + path;
/** The file path of a diff tab, or null for an ordinary file tab. */
export const diffTabPath = (tab: string | null | undefined) => tab && tab.startsWith(DIFF_TAB_PREFIX) ? tab.slice(DIFF_TAB_PREFIX.length) : null;
