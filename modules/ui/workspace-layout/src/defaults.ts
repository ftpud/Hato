// First-party workspace defaults. User settings replace these maps, including empty maps.
//
// Shared spaces follow screen geography, and sidebar buttons are grouped the same way, so a group
// of adjacent buttons = one slot on screen (opening one member replaces the others):
//   Left sidebar, top     Projects │ Navigator: Files · Git · Remote │ Editor: Editor · Latest changes · Workflows
//   Left sidebar, bottom  Terminal (bottom dock)
//   Right sidebar, top    Assistant: AI Chat · Background agents · MCP servers
import type { SidebarButtons, SidebarOrder } from '../../../../sdk/sidebar-placement';
import type { PanelSharing } from './panel-sharing';

/** Display names for the default shared spaces (others are "Shared space N"). */
export const SPACE_NAMES: Record<string, string> = { 'space-1': 'Editor area', 'space-2': 'Navigator', 'space-3': 'Assistant' };

export function defaultSidebarButtons(): SidebarButtons {
  return {
    projects: 'left-top', files: 'left-top', git: 'left-top', remote: 'left-top',
    viewer: 'left-top', 'git-changes': 'left-top', workflows: 'left-top',
    terminal: 'left-bottom',
    ai: 'right-top', agents: 'right-top', mcps: 'right-top',
  };
}
/** Order within each position. Groups are separated automatically by shared space (see the
 *  "Group sidebar buttons by shared space" setting), so no explicit spacers are needed. */
export function defaultSidebarOrder(): SidebarOrder {
  return {
    'left-top': ['projects', 'files', 'git', 'remote', 'viewer', 'git-changes', 'workflows'],
    'left-bottom': ['terminal'],
    'right-top': ['ai', 'agents', 'mcps'],
    'right-bottom': [],
  };
}
export function defaultPanelSharing(): PanelSharing {
  return {
    viewer: 'space-1', 'git-changes': 'space-1', workflows: 'space-1',
    files: 'space-2', git: 'space-2', remote: 'space-2',
    ai: 'space-3', agents: 'space-3', mcps: 'space-3',
  };
}

// Previous defaults. A saved value identical to one of these was never customized, so it is
// upgraded to the current default instead of pinning the old arrangement forever.
const LEGACY = {
  "activity-sidebar.v1": {
    projects: 'left-top', files: 'left-top', git: 'left-top', viewer: 'left-top', 'git-changes': 'left-top',
    terminal: 'left-bottom', remote: 'left-bottom',
    ai: 'right-top', agents: 'right-top', workflows: 'right-top', mcps: 'right-bottom',
  },
  "sidebar-order.v1": {
    'left-top': ['projects', 'files', 'git', '@spacer:source', 'viewer', 'git-changes'],
    'left-bottom': ['terminal', '@spacer:runtime', 'remote'],
    'right-top': ['ai', 'agents', '@spacer:automation', 'workflows'],
    'right-bottom': ['mcps'],
  },
  "panel-sharing.v1": {
    viewer: 'space-1', 'git-changes': 'space-1', workflows: 'space-1',
    files: 'space-2', git: 'space-2', mcps: 'space-2', remote: 'space-2',
    ai: 'space-3', agents: 'space-3',
  },
} as Record<string, unknown>;

const canonical = (v: unknown): string => JSON.stringify(v, (_k, x) => x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x);
/** Treat an uncustomized legacy default as unset. */
export function upgradeLegacy(key: string, saved: unknown): unknown {
  return saved != null && key in LEGACY && canonical(saved) === canonical(LEGACY[key]) ? null : saved;
}
