// Bundled into each sidebar module: edit drawings here, then hot reload that sidebar.
// Use currentColor so the native button supplies active/inactive theme colors.
const outline = (paths: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
export const sidebarIcons = {
  projects: outline('<path d="M6 7V3h6l2 2h8v12h-3M2 8h6l2 2h9v11H2Z"/>'),
  files: outline('<path d="M3 5h6l2 2h10v13H3Z"/>'),
  ai: outline('<path d="M21 15a2 2 0 0 1-2 2H7l-5 5V4a2 2 0 0 1 2-2h15a2 2 0 0 1 2 2Z"/>'),
  git: outline('<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="8" r="2"/><path d="M6 7v10M18 10c0 4-4 4-10 7.5"/>'),
  remote: outline('<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4M7 9h.01M11 9h6"/>'),
  terminal: outline('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3m6 0h4"/>'),
};
