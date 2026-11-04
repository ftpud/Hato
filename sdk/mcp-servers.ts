// User-configured MCP servers: model, validation, conversion to ACP `mcpServers` entries and
// import from common JSON config shapes. Bundled into persistent-agents, agent-runner and the panel.
import type { AgentMcp, McpAuth, McpTransport } from "./persistent-agents";

export const transportOf = (m: Partial<AgentMcp>): McpTransport => m.transport === "http" || m.transport === "sse" ? m.transport : "stdio";
const isPair = (v: any) => v && typeof v.name === "string" && typeof v.value === "string";

/** Host and path of an http(s) URL, or null. No WHATWG URL in the module runtime. */
export function parseHttpUrl(url: string): { scheme: "http" | "https"; origin: string; host: string; path: string } | null {
  const m = /^(https?):\/\/([^/?#@\s]+)([^?#\s]*)(?:\?[^#\s]*)?(?:#\S*)?$/i.exec(String(url || "").trim());
  if (!m) return null;
  const scheme = m[1].toLowerCase() as "http" | "https", host = m[2].toLowerCase();
  return { scheme, host, origin: `${scheme}://${host}`, path: m[3] || "/" };
}
export const isLoopbackHost = (host: string) => /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host);

export function validateMcp(value: any): AgentMcp {
  if (!value || typeof value.id !== "string" || !value.id || typeof value.name !== "string") throw new Error("MCP requires id and name");
  if (value.id.startsWith("internal-") || value.id.length > 120) throw new Error("Reserved or invalid MCP server id");
  const name = value.name.trim();
  if (!name) throw new Error("Server name is required");
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") throw new Error("Enabled must be a boolean");
  const transport = transportOf(value);
  const base = { id: value.id, name, transport, enabled: value.enabled !== false };
  if (transport === "stdio") {
    if (typeof value.command !== "string" || !value.command.trim()) throw new Error("Command is required");
    if (!Array.isArray(value.args) || !value.args.every((a: any) => typeof a === "string")) throw new Error("Arguments must be strings");
    const env = Array.isArray(value.env) ? value.env : [];
    const names = new Set<string>();
    for (const item of env) {
      if (!isPair(item) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(item.name) || names.has(item.name)) throw new Error("Environment variable names must be valid and unique");
      names.add(item.name);
    }
    return { ...base, command: value.command.trim(), args: value.args, env };
  }
  const url = parseHttpUrl(value.url);
  if (!url) throw new Error("Enter an http(s) URL for the remote server");
  if (url.scheme === "http" && !isLoopbackHost(url.host)) throw new Error("Remote servers must use https (plain http is allowed only for localhost)");
  const headers = Array.isArray(value.headers) ? value.headers : [];
  const seen = new Set<string>();
  for (const h of headers) {
    if (!isPair(h) || !/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(h.name) || seen.has(h.name.toLowerCase())) throw new Error("Header names must be valid and unique");
    seen.add(h.name.toLowerCase());
  }
  const a = value.auth || {};
  const type = a.type === "oauth" || a.type === "bearer" ? a.type : "none";
  if (type !== "none" && seen.has("authorization")) throw new Error("Remove the Authorization header or set authentication to None");
  const auth: McpAuth = { type };
  if (type === "bearer") { if (typeof a.token !== "string" || !a.token.trim()) throw new Error("Enter the bearer token"); auth.token = a.token.trim(); }
  if (type === "oauth") {
    for (const k of ["clientId", "clientSecret", "scopes"] as const) if (typeof a[k] === "string" && a[k].trim()) auth[k] = a[k].trim();
    if (a.redirectPort !== undefined && a.redirectPort !== null && a.redirectPort !== "") {
      const port = Number(a.redirectPort);
      if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Redirect port must be 1024–65535");
      auth.redirectPort = port;
    }
  }
  return { ...base, command: "", args: [], env: [], url: String(value.url).trim(), headers, auth };
}

/** The ACP `mcpServers` entry. `authorization` is a ready header value (e.g. a fresh OAuth token). */
export function acpServer(m: AgentMcp, authorization?: string | null): any {
  const transport = transportOf(m);
  if (transport === "stdio") return { name: m.name, command: m.command, args: m.args, env: m.env };
  const headers = [...(m.headers || [])];
  const auth = authorization ?? (m.auth?.type === "bearer" && m.auth.token ? `Bearer ${m.auth.token}` : null);
  if (auth) headers.push({ name: "Authorization", value: auth });
  return { type: transport, name: m.name, url: m.url, headers };
}

/** Parse a pasted config: Claude/Cursor `{"mcpServers": {...}}`, VS Code `{"servers": {...}}`,
 *  a single `{command|url, ...}` object, or a bare URL. Returns drafts without ids. */
export function importMcpConfig(text: string): Omit<AgentMcp, "id">[] {
  const raw = text.trim();
  if (!raw) return [];
  if (/^https?:\/\//i.test(raw) && !/\s/.test(raw)) return [remoteDraft(nameFromUrl(raw), { url: raw })];
  let json: any;
  try { json = JSON.parse(raw); } catch { throw new Error("Paste JSON (e.g. {\"mcpServers\": {...}}) or a server URL"); }
  const map = json?.mcpServers || json?.servers || json?.mcp?.servers;
  const entries: [string, any][] = map && typeof map === "object" ? Object.entries(map)
    : json && (json.command || json.url) ? [[String(json.name || (json.url ? nameFromUrl(json.url) : json.command)), json]] : [];
  if (!entries.length) throw new Error("No MCP servers found in the pasted JSON");
  return entries.map(([name, s]) => {
    if (typeof s?.url === "string") return remoteDraft(name, s);
    if (typeof s?.command !== "string") throw new Error(`Server "${name}" needs a command or url`);
    const env = s.env && typeof s.env === "object" ? Object.entries(s.env).map(([k, v]) => ({ name: k, value: String(v) })) : [];
    return { name, transport: "stdio" as const, command: s.command, args: Array.isArray(s.args) ? s.args.map(String) : [], env, enabled: true };
  });
}
function remoteDraft(name: string, s: any): Omit<AgentMcp, "id"> {
  const headers = s.headers && typeof s.headers === "object" ? Object.entries(s.headers).map(([k, v]) => ({ name: k, value: String(v) })) : [];
  const bearer = headers.find(h => h.name.toLowerCase() === "authorization" && /^bearer\s+/i.test(h.value));
  const type = String(s.type || s.transport || "").toLowerCase();
  return { name, transport: type === "sse" || /\/sse\/?$/.test(s.url) ? "sse" : "http", command: "", args: [], env: [], url: s.url, enabled: true,
    headers: headers.filter(h => h !== bearer),
    auth: bearer ? { type: "bearer", token: bearer.value.replace(/^bearer\s+/i, "") } : { type: s.oauth === false ? "none" : "oauth" } };
}
export function nameFromUrl(url: string): string {
  const host = parseHttpUrl(url)?.host.replace(/:\d+$/, "") || "Remote server";
  const parts = host.split(".").filter(p => !["mcp", "api", "www", "com", "app", "dev", "io", "ai", "net", "org"].includes(p));
  const word = parts[parts.length - 1] || host;
  return word.charAt(0).toUpperCase() + word.slice(1);
}
