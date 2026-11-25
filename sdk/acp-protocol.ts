/** ACP v1 system-level instructions. Agents advertise append support with
 * `sessionCapabilities.systemPrompt`; omitting the capability must omit the field. */
export interface AcpSystemPrompt {
  mode: "append";
  content: Array<{ type: "text"; text: string }>;
}

export function acpSystemPrompt(agentCapabilities: any, trustedInstructions: unknown): AcpSystemPrompt | null {
  if (!agentCapabilities?.sessionCapabilities?.systemPrompt || typeof trustedInstructions !== "string") return null;
  const text = trustedInstructions.trim();
  if (!text) return null;
  let bytes = 0;
  for (const character of text) {
    const point = character.codePointAt(0)!;
    bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
  }
  if (bytes > 128 * 1024) throw new Error("Trusted ACP systemPrompt exceeds the 128 KiB instruction budget");
  return { mode: "append", content: [{ type: "text", text }] };
}

/** Boundary normalization for untrusted adapter metadata. */
export function authMethods(value: unknown, terminal: boolean): any[] {
  const seen = new Set<string>();
  return (Array.isArray(value) ? value : []).filter(m => {
    if (!m || typeof m.id !== "string" || !m.id || m.id.length > 1024 || seen.has(m.id)) return false;
    const isTerminal = m.type === "terminal" || !!m._meta?.["terminal-auth"];
    if (isTerminal && !terminal || m.type != null && !["agent", "terminal"].includes(m.type)) return false;
    seen.add(m.id); return true;
  }).slice(0, 64).map(m => ({ ...m, name: typeof m.name === "string" ? m.name.slice(0, 4096) : m.id, description: typeof m.description === "string" ? m.description.slice(0, 16384) : undefined }));
}
export function sessionPage(value: any): { sessions: any[]; nextCursor: string | null } {
  if (!value || typeof value !== "object" || !Array.isArray(value.sessions)) throw new Error("Invalid session/list response");
  const seen = new Set<string>();
  const sessions = value.sessions.filter((s: any) => s && typeof s.sessionId === "string" && s.sessionId.length > 0 && s.sessionId.length <= 4096 && !seen.has(s.sessionId) && (seen.add(s.sessionId), true)).slice(0, 500).map((s: any) => ({ sessionId: s.sessionId, ...(typeof s.title === "string" ? { title: s.title.slice(0, 4096) } : {}), ...(typeof s.cwd === "string" ? { cwd: s.cwd.slice(0, 4096) } : {}), ...(typeof s.updatedAt === "string" ? { updatedAt: s.updatedAt.slice(0, 128) } : {}) }));
  return { sessions, nextCursor: typeof value.nextCursor === "string" && value.nextCursor.length > 0 && value.nextCursor.length <= 16384 ? value.nextCursor : null };
}
export function terminalAuthEnvironment(base: Record<string,string>, value: any, removed: string[] = []) {
  if (value != null && (typeof value !== "object" || Array.isArray(value))) throw new Error("Invalid authentication environment");
  const entries = Object.entries(value || {});
  if (entries.length > 64) throw new Error("Too many authentication environment variables");
  const blocked = /^(?:PATH|PATHEXT|HOME|USERPROFILE|COMSPEC|SHELL|ENV|BASH_ENV|ZDOTDIR|IFS|CDPATH|GLOBIGNORE|LD_.*|DYLD_.*|NODE_.*|PYTHON.*|RUBY.*|PERL.*|_?JAVA_.*|JDK_.*|CLASSPATH|DOTNET_.*|MONO.*|GCONV_PATH|LOCPATH|OPENSSL_.*|BUNDLE_.*|GEM_.*|GIT_.*|.*_PROXY|ALL_PROXY|NO_PROXY|SSL_.*|CURL_.*|REQUESTS_.*|AWS_.*|AZURE_.*|GOOGLE_.*)$/i;
  const env = { ...base };
  for (const [key, raw] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || ["__proto__", "constructor", "prototype"].includes(key) || blocked.test(key) || removed.some(k => k.toUpperCase() === key.toUpperCase()) || typeof raw !== "string" || raw.includes("\0") || raw.length > 16384) throw new Error(`Unsafe authentication environment variable '${key}'`);
    env[key] = raw;
  }
  for (const key of removed) delete env[key];
  return { env, keys: entries.map(([key]) => key) };
}
