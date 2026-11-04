// Pure helpers for MCP OAuth (authorization code + PKCE, RFC 9728 protected-resource metadata,
// RFC 8414 / OIDC discovery, RFC 7591 dynamic registration, RFC 8707 resource indicators).
// No host calls: the mcp-auth service performs requests through `net.fetch`.
import { sha256Hex } from "./sha256";
import { parseHttpUrl } from "./mcp-servers";

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
export function base64UrlFromHex(hex: string): string {
  const bytes = hex.match(/../g)!.map(h => parseInt(h, 16));
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (i + 1 < bytes.length ? B64[(n >> 6) & 63] : "") + (i + 2 < bytes.length ? B64[n & 63] : "");
  }
  return out;
}
/** RFC 7636 S256 challenge for an ASCII verifier. */
export const pkceChallenge = (verifier: string) => base64UrlFromHex(sha256Hex(verifier));

export function form(params: Record<string, string | undefined | null>): string {
  return Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== "").map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join("&");
}
export function withQuery(url: string, params: Record<string, string | undefined | null>): string {
  const q = form(params);
  return q ? `${url}${url.includes("?") ? "&" : "?"}${q}` : url;
}
export function parseQuery(q: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of q.replace(/^\?/, "").split("&")) {
    if (!part) continue;
    const i = part.indexOf("=");
    const dec = (s: string) => { try { return decodeURIComponent(s.replace(/\+/g, " ")); } catch { return s; } };
    out[dec(i < 0 ? part : part.slice(0, i))] = i < 0 ? "" : dec(part.slice(i + 1));
  }
  return out;
}

/** `WWW-Authenticate: Bearer resource_metadata="…", scope="…", error="…"`. */
export function parseWwwAuthenticate(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  const re = /([a-zA-Z_][a-zA-Z0-9_-]*)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(header))) out[m[1].toLowerCase()] = (m[2] ?? m[3]).replace(/\\(.)/g, "$1");
  return out;
}

const trimSlash = (p: string) => p === "/" ? "" : p.replace(/\/+$/, "");
/** RFC 9728 §3.1: path-aware well-known first, then the origin root. */
export function protectedResourceMetadataUrls(serverUrl: string): string[] {
  const u = parseHttpUrl(serverUrl);
  if (!u) return [];
  const path = trimSlash(u.path);
  return [...new Set([`${u.origin}/.well-known/oauth-protected-resource${path}`, `${u.origin}/.well-known/oauth-protected-resource`])];
}
/** RFC 8414 §3.1 and OIDC discovery, in the order the MCP spec recommends. */
export function authServerMetadataUrls(issuer: string): string[] {
  const u = parseHttpUrl(issuer);
  if (!u) return [];
  const path = trimSlash(u.path);
  return path
    ? [`${u.origin}/.well-known/oauth-authorization-server${path}`, `${u.origin}/.well-known/openid-configuration${path}`, `${u.origin}${path}/.well-known/openid-configuration`]
    : [`${u.origin}/.well-known/oauth-authorization-server`, `${u.origin}/.well-known/openid-configuration`];
}
/** The canonical resource indicator: the server URL without query/fragment or trailing slash. */
export function canonicalResource(serverUrl: string): string {
  const u = parseHttpUrl(serverUrl);
  return u ? `${u.origin}${trimSlash(u.path)}` : serverUrl;
}

/** First line of an HTTP request read from the loopback socket: `GET /callback?code=… HTTP/1.1`. */
export function parseCallbackRequest(text: string): { method: string; path: string; query: Record<string, string> } | null {
  const m = /^([A-Z]+) (\S+) HTTP\/1\.[01]\r?\n/.exec(text);
  if (!m) return null;
  const [path, q = ""] = m[2].split("?", 2);
  return { method: m[1], path, query: parseQuery(q) };
}

/** A small, self-contained page shown in the browser after the redirect. */
export function callbackPage(ok: boolean, title: string, detail: string): string {
  const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
  const body = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>
body{margin:0;height:100vh;display:grid;place-items:center;font:15px -apple-system,system-ui,sans-serif;background:#14131c;color:#ecebf5}
.card{padding:32px 40px;border-radius:16px;background:#1f1d2b;box-shadow:0 10px 40px #0006;text-align:center;max-width:420px}
.icon{width:56px;height:56px;border-radius:50%;margin:0 auto 16px;display:grid;place-items:center;font-size:28px;background:${ok ? "#1f3d2c;color:#5fd38d" : "#3d1f24;color:#f07a7a"}}
h1{font-size:19px;margin:0 0 8px}p{margin:0;color:#a9a6bf;line-height:1.5}</style></head>
<body><div class="card"><div class="icon">${ok ? "✓" : "!"}</div><h1>${esc(title)}</h1><p>${esc(detail)}</p></div></body></html>`;
  const bytes = new TextEncoder().encode(body).length;
  return `HTTP/1.1 ${ok ? "200 OK" : "400 Bad Request"}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: ${bytes}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n${body}`;
}
