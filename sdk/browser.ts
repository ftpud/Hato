// Browser sessions: shared contract between the `browser` service, its panel and workflow designer.
// The service owns the Chrome processes and DevTools connections; consumers render the published
// `browser.state` and call service methods. Nothing here runs on its own.

export type BrowserLocation =
  | { kind: "local" }
  /** The machine of a (usually SSH) workspace; Chrome runs there, held by its daemon. */
  | { kind: "workspace"; workspaceId: string; label?: string }
  /** An existing DevTools endpoint: ws(s)://…/devtools/browser/… or http(s)://host:port. */
  | { kind: "endpoint"; url: string };

export interface BrowserSessionSpec {
  id: string;
  name: string;
  location: BrowserLocation;
  /** Show a real window (local Chrome only). Default headless. */
  headed?: boolean;
  /** Keep cookies/storage between launches (a profile directory per session). Default true. */
  keepProfile?: boolean;
  /** Agents (MCP tools) and workflow browser blocks may use this session. */
  agentAccess?: boolean;
  viewport?: { width: number; height: number };
  startUrl?: string;
  /** Explicit browser executable on the session's machine; empty auto-detects. */
  executable?: string;
}

export type BrowserStatus = "stopped" | "starting" | "running" | "error";

export interface BrowserTabView { id: string; title: string; url: string; loading: boolean; active: boolean }

export interface BrowserSessionView {
  id: string; name: string; location: BrowserLocation; locationLabel: string;
  status: BrowserStatus; error?: string; progress?: string;
  agentAccess: boolean; headed: boolean; keepProfile: boolean;
  viewport: { width: number; height: number };
  /** Pushed-frame surface handle for `surface` nodes (null until running). */
  surface: string | null;
  tabs: BrowserTabView[]; activeTab: string | null;
  url: string; title: string; loading: boolean; canGoBack: boolean; canGoForward: boolean;
  /** Last agent action, for the "agent is driving" indicator. */
  agent?: { at: number; text: string; caller?: string };
  network: { count: number; seq: number };
  executable?: string;
}

export interface BrowserState { sessions: BrowserSessionView[]; rev: number }

export interface BrowserNetworkEntry {
  seq: number; requestId: string; tab: string; url: string; method: string; type?: string;
  status?: number; statusText?: string; mimeType?: string; startedAt: number; durationMs?: number;
  encodedBytes?: number; failed?: boolean; error?: string; fromCache?: boolean;
  requestHeaders?: Record<string, string>; responseHeaders?: Record<string, string>; postData?: string;
}

export const DEFAULT_VIEWPORT = { width: 1280, height: 800 };

export function locationLabel(l: BrowserLocation): string {
  switch (l.kind) {
    case "local": return "This computer";
    case "workspace": return l.label ? `Workspace · ${l.label}` : "Workspace machine";
    case "endpoint": return l.url.replace(/^(wss?|https?):\/\//, "").replace(/\/devtools\/.*$/, "").replace(/[?#].*$/, "");
  }
}
