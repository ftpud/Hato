// Bundled into each sidebar module: edit drawings here, then hot reload that sidebar.
// Use currentColor so the native button supplies active/inactive theme colors.
// Each panel gets a distinct silhouette (Lucide-derived, see sdk/icons/LICENSE-lucide.txt) so
// neighbours in the same shared-space group stay recognisable at 22 px.
const outline = (paths: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
export const sidebarIcons = {
  // Workspace
  projects: outline('<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M3 13h18"/>'),
  // Navigator space
  files: outline('<path d="M13 10h7a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1h-3l-1.5-2H13a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1ZM13 21h7a1 1 0 0 0 1-1v-3a1 1 0 0 0-1-1h-3l-1.5-2H13a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1ZM3 3v13a2 2 0 0 0 2 2h4M3 5a2 2 0 0 0 2 2h4"/>'),
  git: outline('<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="8" r="2"/><path d="M6 7v10M18 10c0 4-4 4-10 7.5"/>'),
  server: outline('<rect x="3" y="3" width="18" height="7" rx="2"/><rect x="3" y="14" width="18" height="7" rx="2"/><path d="M7 6.5h.01M7 17.5h.01M11 6.5h6M11 17.5h6"/>'),
  // Editor space
  code: outline('<path d="m16 18 6-6-6-6M8 6l-6 6 6 6"/>'),
  history: outline('<path d="M3 12a9 9 0 1 0 2.6-6.4L3 8"/><path d="M3 3v5h5M12 7v5l3.5 2"/>'),
  workflow: outline('<rect x="3" y="3" width="6" height="6" rx="1"/><rect x="15" y="15" width="6" height="6" rx="1"/><rect x="15" y="3" width="6" height="6" rx="1"/><path d="M9 6h6M18 9v6M6 9v6a3 3 0 0 0 3 3h6"/>'),
  // Assistant space
  ai: outline('<path d="M21 15a2 2 0 0 1-2 2H7l-5 5V4a2 2 0 0 1 2-2h15a2 2 0 0 1 2 2Z"/><path d="M8 9h8M8 13h5"/>'),
  bot: outline('<rect x="4" y="8" width="16" height="12" rx="3"/><path d="M12 8V4M10 4h4M2 14h2M20 14h2M9 13v2M15 13v2"/>'),
  plug: outline('<path d="M9 2v5M15 2v5M6 7h12v4a6 6 0 0 1-12 0V7ZM12 17v5"/>'),
  // Bottom dock
  terminal: outline('<path d="m4 17 6-6-6-6M12 19h8"/>'),
  // Kept for user plugins that reference the old name.
  remote: outline('<rect x="3" y="3" width="18" height="7" rx="2"/><rect x="3" y="14" width="18" height="7" rx="2"/><path d="M7 6.5h.01M7 17.5h.01M11 6.5h6M11 17.5h6"/>'),
};
