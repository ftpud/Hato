const svg = (paths: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
export const terminalIcons = {
  splitRight: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16m3-11 3 3-3 3m-1-3h4"/>'),
  splitDown: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 12h18m-12 3 3 3 3-3m-3-1v4"/>'),
};
