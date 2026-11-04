// Presentation choices for the workflow designer: block colors, icons, card geometry and
// connection styling. Kept as data so it can be edited and hot reloaded with the module.
import type { WorkflowBlockStatus, WorkflowBlockType, WorkflowEdgeType, WorkflowRunStatus } from "../../../../sdk/workflows";

const svg = (paths: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;

export const CARD = { width: 228, height: 88, grid: 24, snap: 12 };

export const blockColor: Record<WorkflowBlockType, string> = {
  start_button: "#2f9e5b", start_input: "#2f9e5b", ai: "#7c6cf0", chatbox: "#4f8fde", skill: "#d08b2c", text: "#6f8f5f", markdown: "#6f8f5f",
  script: "#c0603f", run_app: "#c0603f", timer: "#8a8f99", user_prompt: "#c99a12", yes_no_prompt: "#c99a12", meeting: "#3aa98e",
  terminal_control: "#7d7d7d", task_controls: "#7d7d7d", mcp: "#7d7d7d",
};

export const blockIcon: Record<string, string> = {
  start_button: svg("<polygon points='7 4 20 12 7 20 7 4'/>"),
  start_input: svg("<polygon points='5 4 15 12 5 20 5 4'/><path d='M18 6v12'/>"),
  ai: svg("<rect x='4' y='7' width='16' height='12' rx='3'/><path d='M12 3v4M9 12h.01M15 12h.01M9 16h6'/>"),
  chatbox: svg("<path d='M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z'/>"),
  skill: svg("<path d='M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5z'/><path d='M8 7h8M8 11h6'/>"),
  text: svg("<path d='M4 6h16M4 12h16M4 18h10'/>"),
  markdown: svg("<rect x='3' y='5' width='18' height='14' rx='2'/><path d='M7 15V9l2.5 3L12 9v6M16 9v6M14 13l2 2 2-2'/>"),
  script: svg("<polyline points='4 17 10 11 4 5'/><line x1='12' y1='19' x2='20' y2='19'/>"),
  run_app: svg("<rect x='3' y='4' width='18' height='16' rx='2'/><path d='M3 9h18M9 14l2 2 4-4'/>"),
  timer: svg("<circle cx='12' cy='13' r='8'/><path d='M12 9v4l2 2M9 2h6'/>"),
  user_prompt: svg("<circle cx='12' cy='12' r='9'/><path d='M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01'/>"),
  yes_no_prompt: svg("<path d='M20 6 9 17l-5-5'/>"),
  meeting: svg("<circle cx='9' cy='8' r='3'/><circle cx='17' cy='9' r='2.5'/><path d='M3 20a6 6 0 0 1 12 0M14.5 15a5 5 0 0 1 6.5 5'/>"),
  terminal_control: svg("<rect x='3' y='4' width='18' height='16' rx='2'/><path d='m7 9 3 3-3 3M13 15h4'/>"),
  task_controls: svg("<circle cx='6' cy='6' r='2'/><circle cx='18' cy='18' r='2'/><path d='M6 8v6a4 4 0 0 0 4 4h6M18 16V6'/>"),
  mcp: svg("<path d='M9 3v4m6-4v4M7 7h10v4a5 5 0 0 1-10 0V7Zm5 9v5'/>"),
  workflow: svg("<rect x='3' y='3' width='6' height='6' rx='1'/><rect x='15' y='15' width='6' height='6' rx='1'/><rect x='15' y='3' width='6' height='6' rx='1'/><path d='M9 6h6M18 9v6M6 9v6a3 3 0 0 0 3 3h6'/>"),
  play: svg("<polygon points='6 4 20 12 6 20 6 4'/>"),
  stop: svg("<rect x='6' y='6' width='12' height='12' rx='1'/>"),
  save: svg("<path d='M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z'/><path d='M17 21v-8H7v8M7 3v5h8'/>"),
  undo: svg("<path d='M9 14 4 9l5-5'/><path d='M4 9h10a6 6 0 0 1 0 12h-3'/>"),
  redo: svg("<path d='m15 14 5-5-5-5'/><path d='M20 9H10a6 6 0 0 0 0 12h3'/>"),
  window: svg("<rect x='3' y='4' width='18' height='16' rx='2'/><path d='M3 9h18'/>"),
  sparkles: svg("<path d='M12 3l1.8 4.7L18 9l-4.2 1.3L12 15l-1.8-4.7L6 9l4.2-1.3z'/><path d='M19 15l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z'/>"),
  "chevron-down": svg("<path d='m6 9 6 6 6-6'/>"),
  "chevron-up": svg("<path d='m18 15-6-6-6 6'/>"),
  maximize: svg("<path d='M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7'/>"),
  minimize: svg("<path d='M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7'/>"),
  rerun: svg("<path d='M3 12a9 9 0 1 0 3-6.7L3 8'/><path d='M3 3v5h5'/>"),
  "circle-play": svg("<circle cx='12' cy='12' r='9'/><polygon points='10 8 16 12 10 16 10 8'/>"),
  edit: svg("<path d='M12 20h9'/><path d='M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z'/>"),
  copy: svg("<rect x='9' y='9' width='12' height='12' rx='2'/><path d='M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1'/>"),
  chat: svg("<path d='M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z'/>"),
};

export const edgeStyle: Record<WorkflowEdgeType, { color: string; dashed: boolean; fromSide: "right" | "bottom"; toSide: "left" | "top"; name: string }> = {
  follow: { color: "muted", dashed: false, fromSide: "right", toSide: "left", name: "Follow" },
  use: { color: "#4f8fde", dashed: true, fromSide: "bottom", toSide: "top", name: "Use" },
  path: { color: "#c99a12", dashed: false, fromSide: "right", toSide: "left", name: "Path" },
};

export const statusColor = (s: WorkflowBlockStatus | WorkflowRunStatus | string) =>
  s === "succeeded" ? "success" : s === "failed" ? "danger" : s === "running" ? "primary" : s === "cancelled" || s === "skipped" ? "muted"
  : s === "awaiting_user_input" || s === "awaiting_permission" || s === "waiting" ? "warning" : s === "waiting_timer" ? "info" : "muted";

export const statusText: Record<string, string> = {
  idle: "idle", queued: "queued", running: "running", succeeded: "done", failed: "failed", cancelled: "cancelled", skipped: "skipped",
  waiting_timer: "timer", awaiting_user_input: "needs answer", awaiting_permission: "needs approval", waiting: "waiting",
};
