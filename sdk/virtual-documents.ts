// Viewer tabs for documents that are not workspace files (for example Library pages).
//
// A tab id is `virtual:<provider module id>/<opaque key>`; the key should end with the file name
// so the viewer can pick a language and a tab label. The provider owns content and persistence;
// the viewer owns tabs, buffers, autosave and presentation.
//
//   provider → viewer method `virtual.show`   VirtualShow (only the provider named in the tab may call it)
//   viewer   → event `viewer.virtualRequest`  {workspaceId, tab}            reply with virtual.show (reveal false)
//   viewer   → event `viewer.virtualSave`     {workspaceId, tab, requestId} then the provider calls
//              viewer `virtual.take` {requestId} → {text, force}, persists it, and reports
//              viewer `virtual.saved` {requestId, error?, conflict?}
//   viewer   → event `viewer.virtualLink`     {workspaceId, tab, href}       relative link in a preview
//   viewer   → event `viewer.virtualClosed`   {workspaceId, tab}
// Event payloads never carry document text, so a module that can only emit events cannot write
// through a provider: `virtual.take` answers only the provider that owns the tab.
import type { Handle } from "./types";

export const VIRTUAL_TAB_PREFIX = "virtual:";

export interface VirtualShow {
  workspaceId: string;
  tab: string;
  /** Status bar and tooltip text, e.g. "Library · Release readiness / SKILL.md". */
  title: string;
  /** Read-only kernel document owned by the provider (`ctx.host.ui.documentOpen`). */
  document?: Handle | null;
  text?: string;
  editable?: boolean;
  /** Select the tab (default true). Refreshes and restores pass false. */
  reveal?: boolean;
  /** Show this instead of content (e.g. the entry was deleted). */
  error?: string;
}

export const virtualTab = (provider: string, key: string) => `${VIRTUAL_TAB_PREFIX}${provider}/${key}`;

export function parseVirtualTab(tab: string | null | undefined): { provider: string; key: string } | null {
  if (!tab || !tab.startsWith(VIRTUAL_TAB_PREFIX)) return null;
  const rest = tab.slice(VIRTUAL_TAB_PREFIX.length), slash = rest.indexOf("/");
  if (slash <= 0 || slash === rest.length - 1) return null;
  return { provider: rest.slice(0, slash), key: rest.slice(slash + 1) };
}
