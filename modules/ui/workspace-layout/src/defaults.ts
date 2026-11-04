// First-party workspace defaults. User settings replace these maps, including empty maps.
import type { SidebarButtons, SidebarOrder } from '../../../../sdk/sidebar-placement';
import type { PanelSharing } from './panel-sharing';

export function defaultSidebarButtons(): SidebarButtons {
  return {
    projects: 'left-top', files: 'left-top', git: 'left-top', viewer: 'left-top', 'git-changes': 'left-top',
    terminal: 'left-bottom', remote: 'left-bottom',
    ai: 'right-top', agents: 'right-top', workflows: 'right-top', mcps: 'right-bottom',
  };
}
export function defaultSidebarOrder(): SidebarOrder {
  return {
    'left-top': ['projects', 'files', 'git', '@spacer:source', 'viewer', 'git-changes'],
    'left-bottom': ['terminal', '@spacer:runtime', 'remote'],
    'right-top': ['ai', 'agents', '@spacer:automation', 'workflows'],
    'right-bottom': ['mcps'],
  };
}
export function defaultPanelSharing(): PanelSharing {
  return {
    viewer: 'space-1', 'git-changes': 'space-1', workflows: 'space-1',
    files: 'space-2', git: 'space-2', mcps: 'space-2', remote: 'space-2',
    ai: 'space-3', agents: 'space-3',
  };
}
