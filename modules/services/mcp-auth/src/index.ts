// mcp-auth: OAuth 2.1 sign-in for remote MCP servers, following the MCP authorization spec.
// Discovery (RFC 9728 protected-resource metadata → RFC 8414/OIDC server metadata, with the
// 2025-03-26 origin fallback), dynamic client registration (RFC 7591) when no client id is
// configured, authorization code + PKCE through the system browser and a loopback redirect, resource
// indicators (RFC 8707) and refresh. Tokens never leave this module except as an Authorization
// header handed to persistent-agents when it starts an agent session.
import type { AppModule, Handle, HttpRequest, HttpResponse, ModuleContext } from "../../../../sdk/types";
import { errMsg } from "../../../../sdk/runtime";
import { authServerMetadataUrls, callbackPage, canonicalResource, form, parseCallbackRequest, parseWwwAuthenticate, pkceChallenge, protectedResourceMetadataUrls, withQuery } from "../../../../sdk/mcp-oauth";
import { parseHttpUrl } from "../../../../sdk/mcp-servers";

const CALLBACK_PATH = "/mcp/oauth/callback";
const STORE = "mcp-auth.tokens.v1";
const SIGN_IN_TIMEOUT = 5 * 60_000;
const REFRESH_EARLY = 120_000;

interface TokenRecord {
  resource: string; issuer: string; tokenEndpoint: string; revocationEndpoint?: string;
  clientId: string; clientSecret?: string; authMethod: "none" | "client_secret_post" | "client_secret_basic";
  accessToken: string; refreshToken?: string; expiresAt: number | null; scope?: string; obtainedAt: number;
}
interface Flow { status: "discovering" | "waiting" | "exchanging" | "done" | "error"; authorizeUrl?: string; error?: string; issuer?: string; startedAt: number }
interface Discovery { requiresAuth: boolean | null; status: number | null; issuer: string | null; scopes: string | null; metadata: any | null; legacy: boolean }

let tokens: Record<string, TokenRecord> = {};
const flows: Record<string, Flow> = {};
const cancels = new Map<string, (reason: string) => void>();
const refreshing = new Map<string, Promise<TokenRecord>>();

const publishFlows = (ctx: ModuleContext) => ctx.state.set("mcp-auth.flows", { ...flows });
const changed = (ctx: ModuleContext, serverId: string) => ctx.events.emit("mcp-auth.changed", { serverId });
async function load(ctx: ModuleContext) { const v = await ctx.modules.call("persistence", "settings.get", { key: STORE }); tokens = v && typeof v === "object" ? v : {}; }
async function save(ctx: ModuleContext) { await ctx.modules.call("persistence", "settings.set", { key: STORE, value: tokens }); }

// ---- HTTP ------------------------------------------------------------------------------------

function resolveLocation(base: string, location: string): string {
  if (/^https?:\/\//i.test(location)) return location;
  const u = parseHttpUrl(base)!;
  return location.startsWith("/") ? u.origin + location : u.origin + u.path.replace(/[^/]*$/, "") + location;
}
/** net.fetch with bounded redirect following (each hop is validated natively). */
async function http(ctx: ModuleContext, req: HttpRequest): Promise<HttpResponse> {
  let r = { ...req };
  for (let hop = 0; hop < 5; hop++) {
    const res = await ctx.host.net.fetch({ timeoutMs: 20000, maxBytes: 512 * 1024, ...r });
    if (![301, 302, 303, 307, 308].includes(res.status) || !res.headers.location) return res;
    r = { ...r, url: resolveLocation(r.url, res.headers.location), ...(res.status === 303 ? { method: "GET", body: undefined } : {}) };
  }
  throw new Error("too many redirects");
}
const json = (r: HttpResponse) => { try { return JSON.parse(r.body); } catch { return null; } };
async function getJson(ctx: ModuleContext, url: string): Promise<any | null> {
  try { const r = await http(ctx, { url, headers: { Accept: "application/json", "MCP-Protocol-Version": "2025-06-18" } }); return r.status === 200 ? json(r) : null; }
  catch { return null; }
}
function oauthError(r: HttpResponse, what: string): Error {
  const body = json(r);
  const detail = body?.error_description || body?.error || r.body.slice(0, 200).trim();
  return new Error(`${what} failed (HTTP ${r.status})${detail ? `: ${detail}` : ""}`);
}

// ---- discovery -------------------------------------------------------------------------------

async function discover(ctx: ModuleContext, url: string, transport: string, headers: Record<string, string>): Promise<Discovery> {
  let status: number | null = null, requiresAuth: boolean | null = null, challenge: Record<string, string> = {};
  if (transport !== "sse") {
    // An unauthenticated initialize tells us whether OAuth is needed and where its metadata lives.
    const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "hato", version: "0.1.0" } } };
    try {
      const r = await http(ctx, { url, method: "POST", body: JSON.stringify(init), timeoutMs: 15000, maxBytes: 64 * 1024,
        headers: { ...headers, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-06-18" } });
      status = r.status;
      requiresAuth = r.status === 401 || r.status === 403 ? true : r.status < 400 ? false : null;
      challenge = parseWwwAuthenticate(r.headers["www-authenticate"]);
    } catch (e: any) {
      if (e?.code !== "ETIMEDOUT") throw new Error(`Cannot reach ${url}: ${errMsg(e)}`);
    }
  }
  let prm: any = null;
  for (const candidate of [challenge.resource_metadata, ...protectedResourceMetadataUrls(url)].filter(Boolean) as string[]) {
    prm = await getJson(ctx, candidate);
    if (prm && Array.isArray(prm.authorization_servers) && prm.authorization_servers.length) break;
    prm = null;
  }
  const origin = parseHttpUrl(url)!.origin;
  const issuer: string = prm?.authorization_servers?.[0] || origin;
  let metadata: any = null;
  for (const candidate of authServerMetadataUrls(issuer)) {
    metadata = await getJson(ctx, candidate);
    if (metadata?.authorization_endpoint && metadata?.token_endpoint) break;
    metadata = null;
  }
  let legacy = false;
  if (!metadata && !prm && requiresAuth) {
    // 2025-03-26 servers without metadata: default endpoints on the server origin.
    metadata = { issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, registration_endpoint: `${origin}/register` };
    legacy = true;
  }
  const scopes = challenge.scope || (Array.isArray(prm?.scopes_supported) ? prm.scopes_supported.join(" ") : null);
  if (metadata && requiresAuth === null && transport === "sse") requiresAuth = true;
  return { requiresAuth, status, issuer: metadata ? metadata.issuer || issuer : null, scopes, metadata, legacy };
}

// ---- loopback redirect -----------------------------------------------------------------------

async function waitForCallback(ctx: ModuleContext, listener: Handle, state: string, onCancel: (fn: (reason: string) => void) => void): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let done = false;
    const finish = (err: Error | null, code?: string) => { if (done) return; done = true; clearTimeout(timer); err ? reject(err) : resolve(code!); };
    const timer = setTimeout(() => finish(new Error("Sign-in timed out — the browser did not return to Hato within 5 minutes")), SIGN_IN_TIMEOUT);
    onCancel((reason) => finish(new Error(reason)));
    let pending = "";
    void ctx.host.streams.listen(listener, { encoding: "utf8" }, (chunk) => {
      pending += chunk;
      let i: number;
      while ((i = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, i); pending = pending.slice(i + 1);
        let conn: Handle | null = null;
        try { conn = JSON.parse(line).connection; } catch { conn = null; }
        if (conn) handleConnection(conn);
      }
    });
    const handleConnection = (conn: Handle) => {
      let buf = "";
      void ctx.host.streams.listen(conn, { encoding: "utf8" }, (chunk) => {
        buf += chunk;
        if (!buf.includes("\r\n\r\n") && buf.length < 16384) return;
        const req = parseCallbackRequest(buf);
        buf = "";
        let page: string;
        if (!req || req.path !== CALLBACK_PATH) page = callbackPage(false, "Not found", "This address only accepts the sign-in redirect.");
        else if (req.query.state !== state) page = callbackPage(false, "Sign-in not recognised", "The response did not match the sign-in Hato started. Start again from Hato.");
        else if (req.query.error) {
          const msg = req.query.error_description || req.query.error;
          page = callbackPage(false, "Sign-in was not completed", msg);
          finish(new Error(req.query.error === "access_denied" ? "Access was denied in the browser" : `Authorization failed: ${msg}`));
        } else if (!req.query.code) page = callbackPage(false, "Missing authorization code", "Start the sign-in again from Hato.");
        else { page = callbackPage(true, "Connected to Hato", "You can close this tab and return to Hato."); finish(null, req.query.code); }
        void ctx.host.net.write(conn, page).finally(() => ctx.host.net.close(conn).catch(() => {}));
      });
    };
  });
}

// ---- client registration & tokens ------------------------------------------------------------

async function register(ctx: ModuleContext, metadata: any, redirectUri: string, scope: string | null) {
  if (!metadata.registration_endpoint) throw new Error("This server does not support automatic client registration. Open Advanced and enter a client ID registered with the provider (and its redirect port).");
  const r = await http(ctx, { url: metadata.registration_endpoint, method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ client_name: "Hato", client_uri: "https://github.com/ftpud/hato", redirect_uris: [redirectUri], grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"], token_endpoint_auth_method: "none", ...(scope ? { scope } : {}) }) });
  if (r.status !== 200 && r.status !== 201) throw oauthError(r, "Client registration");
  const c = json(r);
  if (!c?.client_id) throw new Error("Client registration returned no client_id");
  const method = c.token_endpoint_auth_method === "client_secret_basic" ? "client_secret_basic" : c.client_secret ? "client_secret_post" : "none";
  return { clientId: String(c.client_id), clientSecret: c.client_secret ? String(c.client_secret) : undefined, authMethod: method as TokenRecord["authMethod"] };
}
function b64(text: string): string {
  const s = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/", bytes = new TextEncoder().encode(text);
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += s[(n >> 18) & 63] + s[(n >> 12) & 63] + (i + 1 < bytes.length ? s[(n >> 6) & 63] : "=") + (i + 2 < bytes.length ? s[n & 63] : "=");
  }
  return out;
}
async function tokenRequest(ctx: ModuleContext, rec: Pick<TokenRecord, "tokenEndpoint" | "clientId" | "clientSecret" | "authMethod">, params: Record<string, string | undefined>) {
  const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" };
  const body: Record<string, string | undefined> = { ...params, client_id: rec.clientId };
  if (rec.clientSecret && rec.authMethod === "client_secret_basic") headers.Authorization = `Basic ${b64(`${encodeURIComponent(rec.clientId)}:${encodeURIComponent(rec.clientSecret)}`)}`;
  else if (rec.clientSecret) body.client_secret = rec.clientSecret;
  const r = await http(ctx, { url: rec.tokenEndpoint, method: "POST", headers, body: form(body) });
  const t = json(r);
  if (r.status !== 200 || !t?.access_token) { const err: any = oauthError(r, params.grant_type === "refresh_token" ? "Token refresh" : "Token exchange"); err.oauth = t?.error; throw err; }
  return t;
}
function applyToken(rec: Omit<TokenRecord, "accessToken" | "expiresAt" | "obtainedAt"> & Partial<TokenRecord>, t: any): TokenRecord {
  const now = Date.now();
  return { ...rec, accessToken: String(t.access_token), refreshToken: t.refresh_token ? String(t.refresh_token) : rec.refreshToken,
    expiresAt: Number.isFinite(Number(t.expires_in)) && Number(t.expires_in) > 0 ? now + Number(t.expires_in) * 1000 : null,
    scope: typeof t.scope === "string" ? t.scope : rec.scope, obtainedAt: now } as TokenRecord;
}

async function signIn(ctx: ModuleContext, a: any) {
  const serverId = String(a.serverId), url = String(a.url || ""), auth = a.auth || {};
  if (!parseHttpUrl(url)) throw new Error("A remote server URL is required");
  cancels.get(serverId)?.("Sign-in restarted");
  flows[serverId] = { status: "discovering", startedAt: Date.now() }; publishFlows(ctx);
  let listener: Handle | null = null;
  let cancelled: ((reason: string) => void) | null = null;
  cancels.set(serverId, (reason) => { cancelled?.(reason); if (!cancelled) flows[serverId] = { status: "error", error: reason, startedAt: Date.now() }; });
  try {
    const headers = Object.fromEntries((Array.isArray(a.headers) ? a.headers : []).map((h: any) => [h.name, h.value]));
    const d = await discover(ctx, url, String(a.transport || "http"), headers);
    if (!d.metadata) throw new Error(d.requiresAuth === false ? "This server accepts requests without signing in — set authentication to None." : "Could not find OAuth metadata for this server.");
    if (Array.isArray(d.metadata.code_challenge_methods_supported) && !d.metadata.code_challenge_methods_supported.includes("S256")) throw new Error("The authorization server does not support PKCE (S256), which MCP requires.");
    const l = await ctx.host.net.listenLoopback({ port: Number(auth.redirectPort) || 0 });
    listener = l.handle;
    const redirectUri = `http://127.0.0.1:${l.port}${CALLBACK_PATH}`;
    const scope = (auth.scopes as string) || d.scopes || null;
    const client = auth.clientId ? { clientId: String(auth.clientId), clientSecret: auth.clientSecret ? String(auth.clientSecret) : undefined,
      authMethod: (auth.clientSecret ? "client_secret_post" : "none") as TokenRecord["authMethod"] } : await register(ctx, d.metadata, redirectUri, scope);
    const verifier = crypto.randomHex(48), state = crypto.randomHex(16), resource = canonicalResource(url);
    const authorizeUrl = withQuery(d.metadata.authorization_endpoint, { response_type: "code", client_id: client.clientId, redirect_uri: redirectUri,
      code_challenge: pkceChallenge(verifier), code_challenge_method: "S256", state, scope, resource });
    flows[serverId] = { status: "waiting", authorizeUrl, issuer: d.issuer || undefined, startedAt: Date.now() }; publishFlows(ctx);
    await ctx.host.ui.openUrl(authorizeUrl).catch((e) => ctx.log.warn("open browser", errMsg(e)));
    const code = await waitForCallback(ctx, listener, state, (fn) => { cancelled = fn; });
    flows[serverId] = { ...flows[serverId], status: "exchanging" }; publishFlows(ctx);
    const base = { resource, issuer: d.issuer || "", tokenEndpoint: d.metadata.token_endpoint, revocationEndpoint: d.metadata.revocation_endpoint, ...client };
    const t = await tokenRequest(ctx, base, { grant_type: "authorization_code", code, redirect_uri: redirectUri, code_verifier: verifier, resource });
    tokens = { ...tokens, [serverId]: applyToken(base, t) };
    await save(ctx);
    flows[serverId] = { status: "done", issuer: d.issuer || undefined, startedAt: Date.now() };
    changed(ctx, serverId);
  } catch (e) {
    flows[serverId] = { ...(flows[serverId] || { startedAt: Date.now() }), status: "error", error: errMsg(e) };
  } finally {
    cancels.delete(serverId);
    if (listener) await ctx.host.net.close(listener).catch(() => {});
    publishFlows(ctx);
  }
}

async function fresh(ctx: ModuleContext, serverId: string, url: string): Promise<TokenRecord> {
  const rec = tokens[serverId];
  if (!rec || rec.resource !== canonicalResource(url)) throw new Error("Sign-in required");
  if (rec.expiresAt === null || rec.expiresAt - Date.now() > REFRESH_EARLY) return rec;
  if (!rec.refreshToken) throw new Error("Session expired — sign in again");
  let p = refreshing.get(serverId);
  if (!p) {
    p = (async () => {
      try {
        const t = await tokenRequest(ctx, rec, { grant_type: "refresh_token", refresh_token: rec.refreshToken, resource: rec.resource });
        tokens = { ...tokens, [serverId]: applyToken(rec, t) };
      } catch (e: any) {
        if (e?.oauth === "invalid_grant") { const { [serverId]: _gone, ...rest } = tokens; tokens = rest; await save(ctx); changed(ctx, serverId); throw new Error("Session expired — sign in again"); }
        throw e;
      }
      await save(ctx); changed(ctx, serverId);
      return tokens[serverId];
    })().finally(() => refreshing.delete(serverId));
    refreshing.set(serverId, p);
  }
  return p;
}

function statusOf(serverId: string, url?: string) {
  const rec = tokens[serverId];
  const flow = flows[serverId];
  if (!rec || (url && rec.resource !== canonicalResource(url))) return { state: "signedOut" as const, flow: flow || null };
  const expired = rec.expiresAt !== null && rec.expiresAt <= Date.now();
  return { state: expired && !rec.refreshToken ? "expired" as const : "signedIn" as const, expiresAt: rec.expiresAt, refreshable: !!rec.refreshToken,
    issuer: rec.issuer, scope: rec.scope || null, obtainedAt: rec.obtainedAt, flow: flow || null };
}

const mod: AppModule = {
  id: "mcp-auth",
  moduleApiVersion: 1,
  async activate(ctx) { await load(ctx); publishFlows(ctx); },
  async deactivate() { for (const cancel of cancels.values()) cancel("Hato reloaded the sign-in service"); },
  methods: {
    /** Probe a remote server: reachability, whether OAuth is needed, issuer and suggested scopes. */
    async probe(ctx, a) {
      if (!parseHttpUrl(a?.url)) throw new Error("Enter an http(s) URL");
      const headers = Object.fromEntries((Array.isArray(a.headers) ? a.headers : []).map((h: any) => [h.name, h.value]));
      const d = await discover(ctx, String(a.url), String(a.transport || "http"), headers);
      return { status: d.status, requiresAuth: d.requiresAuth, oauth: !!d.metadata, issuer: d.issuer, scopes: d.scopes, legacy: d.legacy,
        dynamicRegistration: !!d.metadata?.registration_endpoint };
    },
    status(_ctx, a) {
      const list: any[] = Array.isArray(a?.servers) ? a.servers : [];
      return Object.fromEntries(list.map(s => [String(s.id), statusOf(String(s.id), s.url)]));
    },
    /** Start the browser sign-in; progress is published at `mcp-auth.flows`. Returns immediately. */
    signIn(ctx, a) { void signIn(ctx, a); return { started: true }; },
    cancel(ctx, a) { const id = String(a?.serverId); cancels.get(id)?.("Sign-in cancelled"); delete flows[id]; publishFlows(ctx); return null; },
    async signOut(ctx, a) {
      const id = String(a?.serverId), rec = tokens[id];
      if (rec?.revocationEndpoint) {
        await tokenRequest(ctx, { ...rec, tokenEndpoint: rec.revocationEndpoint }, { token: rec.refreshToken || rec.accessToken, token_type_hint: rec.refreshToken ? "refresh_token" : "access_token" })
          .catch(() => {}); // Revocation is best-effort; the local copy is removed regardless.
      }
      const { [id]: _gone, ...rest } = tokens; tokens = rest; delete flows[id];
      await save(ctx); publishFlows(ctx); changed(ctx, id);
      return null;
    },
    /** `Authorization` header value for starting an agent session (refreshes when close to expiry). */
    async authorization(ctx, a, meta) {
      if (meta.caller !== "persistent-agents") throw new Error("Tokens are only issued to the agent launcher");
      const rec = await fresh(ctx, String(a.serverId), String(a.url));
      return `Bearer ${rec.accessToken}`;
    },
  },
};
export default mod;
