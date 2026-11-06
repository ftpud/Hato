// persistence: owns the app database (namespace "persistence"), its migrations and typed CRUD.
// Other services never send SQL; they call these methods. The kernel only provides the generic
// SQLite primitive.
import type { AppModule, Handle, Json, ModuleContext } from "../../../../sdk/types";
import m001 from "../migrations/001_init.sql";
import m002 from "../migrations/002_indexes.sql";
import m003 from "../migrations/003_scoped_settings.sql";
import m004 from "../migrations/004_ssh_transport.sql";

const MIGRATIONS: { version: number; name: string; sql: string }[] = [
  { version: 1, name: "001_init", sql: m001 },
  { version: 2, name: "002_indexes", sql: m002 },
  { version: 3, name: "003_scoped_settings", sql: m003 },
  { version: 4, name: "004_ssh_transport", sql: m004 },
];

let db: Handle | null = null;
let ready: Promise<void> | null = null;
let settingsWrite: Promise<any> = Promise.resolve();
function serializeSetting<T>(write: () => Promise<T>): Promise<T> {
  const next = settingsWrite.catch(() => {}).then(write);
  settingsWrite = next;
  return next;
}
const now = () => new Date().toISOString();

async function migrate(ctx: ModuleContext) {
  db = await ctx.host.db.openNamespace("persistence");
  await ctx.host.db.exec(db, "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
  const rows = await ctx.host.db.query<{ version: number }>(db, "SELECT version FROM schema_migrations");
  const have = new Set(rows.map((r) => r.version));
  for (const m of MIGRATIONS) {
    if (have.has(m.version)) continue;
    await ctx.host.db.transaction(db, [
      { sql: m.sql },
      { sql: "INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)", params: [m.version, m.name, now()] },
    ]);
    ctx.log.info(`applied migration ${m.name}`);
  }
}

async function q<T = any>(ctx: ModuleContext, sql: string, params: Json[] = []): Promise<T[]> {
  await ready;
  return ctx.host.db.query<T>(db!, sql, params);
}
async function x(ctx: ModuleContext, sql: string, params: Json[] = []) {
  await ready;
  return ctx.host.db.exec(db!, sql, params);
}

function str(v: any, name: string, max = 4096): string {
  if (typeof v !== "string" || v.length === 0 || v.length > max) throw new Error(`invalid ${name}`);
  return v;
}
function scopeName(v: any): string {
  if (v === "user" || (typeof v === "string" && /^(machine|workspace):[A-Za-z0-9:._@-]{1,200}$/.test(v))) return v;
  throw new Error(`invalid settings scope ${JSON.stringify(v)}`);
}
function optStr(v: any): string | null { return typeof v === "string" ? v : null; }
const parse = (s: any, d: any) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };

const projectRow = (r: any) => ({ id: r.id, name: r.name, kind: r.kind, rootPath: r.root_path, sshProfileId: r.ssh_profile_id, expanded: !!r.expanded, createdAt: r.created_at });
const taskRow = (r: any) => ({ id: r.id, projectId: r.project_id, name: r.name, branch: r.branch, worktreePath: r.worktree_path, status: r.status, createdAt: r.created_at });
const sshRow = (r: any) => ({ id: r.id, host: r.host, port: r.port, user: r.username, authRef: r.auth_ref, transport: r.transport });
const viewRow = (r: any, id: string) => r ? ({ workspaceId: r.workspace_id, explorerDir: r.explorer_relative_dir, previewPath: r.preview_relative_path, terminalKey: r.terminal_key, activeConversationId: r.active_conversation_id, ui: parse(r.ui_state_json, {}) })
  : ({ workspaceId: id, explorerDir: ".", previewPath: null, terminalKey: "main", activeConversationId: null, ui: {} });
const convRow = (r: any) => ({ id: r.id, workspaceId: r.workspace_id, acpProfileId: r.acp_profile_id, providerSessionId: r.provider_session_id, title: r.title, status: r.status, approvalPolicy: r.approval_policy, mcpSelection: parse(r.mcp_selection_json, ["internal"]), config: parse(r.config_json, {}), createdAt: r.created_at, updatedAt: r.updated_at });
const profileRow = (r: any) => ({ id: r.id, machineId: r.machine_id, projectOverrideId: r.project_override_id, provider: r.provider, name: r.name, executable: r.executable, args: parse(r.args_json, []), envRefs: parse(r.env_refs_json, {}), enabled: !!r.enabled });

const mod: AppModule = {
  id: "persistence",
  moduleApiVersion: 1,
  async activate(ctx) {
    ready = migrate(ctx);
    await ready;
  },
  methods: {
    health: async (ctx) => { await q(ctx, "SELECT 1"); return { ok: true }; },
    schemaVersion: async (ctx) => (await q(ctx, "SELECT max(version) AS v FROM schema_migrations"))[0]?.v ?? 0,

    // ---- settings
    "settings.get": async (ctx, a) => { const r = await q(ctx, "SELECT value_json FROM settings WHERE key = ?", [str(a.key, "key")]); return r.length ? parse(r[0].value_json, null) : null; },
    "settings.set": async (ctx, a) => { await x(ctx, "INSERT INTO settings(key, value_json) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json", [str(a.key, "key"), JSON.stringify(a.value ?? null)]); return null; },

    // ---- scoped settings (user / machine:<id> / workspace:<id>) with revisions
    "scoped.get": async (ctx, a) => {
      const r = await q(ctx, "SELECT value_json, rev, updated_at FROM scoped_settings WHERE scope = ? AND key = ?", [scopeName(a.scope), str(a.key, "key")]);
      return r.length ? { value: parse(r[0].value_json, null), rev: r[0].rev, updatedAt: r[0].updated_at } : null;
    },
    /** Write a value. With `expectedRev`, fails with "ECONFLICT" if someone else wrote since.
     *  With `rev` (sync only), stores that exact revision when it is newer than the local one. */
    "scoped.set": (ctx, a) => serializeSetting(async () => {
      const scope = scopeName(a.scope), key = str(a.key, "key");
      for (const name of ["rev", "expectedRev"]) {
        if (a[name] !== undefined && (!Number.isSafeInteger(a[name]) || a[name] < (name === "rev" ? 1 : 0))) throw new Error(`invalid ${name}`);
      }
      const cur = (await q(ctx, "SELECT rev FROM scoped_settings WHERE scope = ? AND key = ?", [scope, key]))[0]?.rev ?? 0;
      if (a.expectedRev !== undefined && a.expectedRev !== null && a.expectedRev !== cur) throw new Error(`ECONFLICT: ${scope}/${key} is at revision ${cur}, not ${a.expectedRev}`);
      let rev = cur + 1;
      if (typeof a.rev === "number") { if (a.rev <= cur) return { rev: cur, applied: false }; rev = a.rev; }
      await x(ctx, "INSERT INTO scoped_settings(scope, key, value_json, rev, updated_at) VALUES(?,?,?,?,?) ON CONFLICT(scope, key) DO UPDATE SET value_json = excluded.value_json, rev = excluded.rev, updated_at = excluded.updated_at",
        [scope, key, JSON.stringify(a.value ?? null), rev, now()]);
      ctx.events.emit("persistence.settingChanged", { scope, key, rev });
      return { rev, applied: true };
    }),
    "scoped.list": async (ctx, a) => (await q(ctx, "SELECT key, value_json, rev, updated_at FROM scoped_settings WHERE scope = ? ORDER BY key", [scopeName(a.scope)]))
      .map((r: any) => ({ key: r.key, value: parse(r.value_json, null), rev: r.rev, updatedAt: r.updated_at })),
    /** First value found in `scopes` order (most specific first). */
    "scoped.resolve": async (ctx, a) => {
      for (const scope of Array.isArray(a.scopes) ? a.scopes : []) {
        const r = await q(ctx, "SELECT value_json, rev FROM scoped_settings WHERE scope = ? AND key = ?", [scopeName(scope), str(a.key, "key")]);
        if (r.length) return { value: parse(r[0].value_json, null), rev: r[0].rev, scope };
      }
      return null;
    },

    // ---- ssh profiles (metadata only; never key material)
    "ssh.upsert": async (ctx, a) => {
      const p = a.profile;
      if (p.authRef && /BEGIN [A-Z ]*PRIVATE KEY/.test(p.authRef)) throw new Error("refusing to store private key material; store a key file path or 'agent'");
      await x(ctx, "INSERT INTO ssh_profiles(id, host, port, username, auth_ref, transport) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET host=excluded.host, port=excluded.port, username=excluded.username, auth_ref=excluded.auth_ref, transport=excluded.transport",
        [str(p.id, "id"), str(p.host, "host"), Number(p.port) || 22, str(p.user, "user"), String(p.authRef || "agent"), p.transport === "wsl" ? "wsl" : "ssh"]);
      return null;
    },
    "ssh.get": async (ctx, a) => { const r = await q(ctx, "SELECT * FROM ssh_profiles WHERE id = ?", [str(a.id, "id")]); return r.length ? sshRow(r[0]) : null; },
    "ssh.list": async (ctx) => (await q(ctx, "SELECT * FROM ssh_profiles ORDER BY host")).map(sshRow),

    // ---- projects
    "projects.list": async (ctx) => (await q(ctx, "SELECT * FROM projects ORDER BY created_at")).map(projectRow),
    "projects.get": async (ctx, a) => { const r = await q(ctx, "SELECT * FROM projects WHERE id = ?", [str(a.id, "id")]); return r.length ? projectRow(r[0]) : null; },
    "projects.insert": async (ctx, a) => {
      const p = a.project;
      await x(ctx, "INSERT INTO projects(id, name, kind, root_path, ssh_profile_id, expanded, created_at) VALUES(?,?,?,?,?,?,?)",
        [str(p.id, "id"), str(p.name, "name", 200), p.kind === "ssh" ? "ssh" : "local", str(p.rootPath, "rootPath"), optStr(p.sshProfileId), 1, now()]);
      return null;
    },
    "projects.findByRoot": async (ctx, a) => { const r = await q(ctx, "SELECT * FROM projects WHERE root_path = ? AND COALESCE(ssh_profile_id,'') = COALESCE(?, '')", [str(a.rootPath, "rootPath"), optStr(a.sshProfileId)]); return r.length ? projectRow(r[0]) : null; },
    "projects.setExpanded": async (ctx, a) => { await x(ctx, "UPDATE projects SET expanded = ? WHERE id = ?", [a.expanded ? 1 : 0, str(a.id, "id")]); return null; },
    "projects.rename": async (ctx, a) => { await x(ctx, "UPDATE projects SET name = ? WHERE id = ?", [str(a.name, "name", 200), str(a.id, "id")]); return null; },

    // ---- tasks
    "tasks.list": async (ctx, a) => (a && a.projectId ? await q(ctx, "SELECT * FROM tasks WHERE project_id = ? ORDER BY created_at", [a.projectId]) : await q(ctx, "SELECT * FROM tasks ORDER BY created_at")).map(taskRow),
    "tasks.get": async (ctx, a) => { const r = await q(ctx, "SELECT * FROM tasks WHERE id = ?", [str(a.id, "id")]); return r.length ? taskRow(r[0]) : null; },
    "tasks.insert": async (ctx, a) => {
      const t = a.task;
      await x(ctx, "INSERT INTO tasks(id, project_id, name, branch, worktree_path, status, created_at) VALUES(?,?,?,?,?,?,?)",
        [str(t.id, "id"), str(t.projectId, "projectId"), str(t.name, "name", 200), str(t.branch, "branch", 250), str(t.worktreePath, "worktreePath"), t.status || "ready", now()]);
      return null;
    },
    "tasks.setStatus": async (ctx, a) => { await x(ctx, "UPDATE tasks SET status = ? WHERE id = ?", [str(a.status, "status", 40), str(a.id, "id")]); return null; },

    // ---- per-workspace view state
    "views.get": async (ctx, a) => { const id = str(a.workspaceId, "workspaceId"); const r = await q(ctx, "SELECT * FROM workspace_views WHERE workspace_id = ?", [id]); return viewRow(r[0], id); },
    "views.patch": async (ctx, a) => {
      const id = str(a.workspaceId, "workspaceId");
      const cur: any = viewRow((await q(ctx, "SELECT * FROM workspace_views WHERE workspace_id = ?", [id]))[0], id);
      const p = a.patch || {};
      const next = { ...cur, ...p, ui: { ...cur.ui, ...(p.ui || {}) } };
      await x(ctx, `INSERT INTO workspace_views(workspace_id, explorer_relative_dir, preview_relative_path, terminal_key, active_conversation_id, ui_state_json) VALUES(?,?,?,?,?,?)
        ON CONFLICT(workspace_id) DO UPDATE SET explorer_relative_dir=excluded.explorer_relative_dir, preview_relative_path=excluded.preview_relative_path, terminal_key=excluded.terminal_key, active_conversation_id=excluded.active_conversation_id, ui_state_json=excluded.ui_state_json`,
        [id, next.explorerDir || ".", next.previewPath ?? null, next.terminalKey || "main", next.activeConversationId ?? null, JSON.stringify(next.ui || {})]);
      return next;
    },

    // ---- ACP agent profiles
    "acpProfiles.list": async (ctx) => (await q(ctx, "SELECT * FROM acp_profiles ORDER BY machine_id, name")).map(profileRow),
    "acpProfiles.upsert": async (ctx, a) => {
      const p = a.profile;
      await x(ctx, `INSERT INTO acp_profiles(id, machine_id, project_override_id, provider, name, executable, args_json, env_refs_json, enabled) VALUES(?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET machine_id=excluded.machine_id, project_override_id=excluded.project_override_id, provider=excluded.provider, name=excluded.name, executable=excluded.executable, args_json=excluded.args_json, env_refs_json=excluded.env_refs_json, enabled=excluded.enabled`,
        [str(p.id, "id"), str(p.machineId, "machineId"), optStr(p.projectOverrideId), str(p.provider, "provider", 40), str(p.name, "name", 100), str(p.executable, "executable"), JSON.stringify(p.args || []), JSON.stringify(p.envRefs || {}), p.enabled === false ? 0 : 1]);
      return null;
    },

    // ---- conversations & messages
    "conversations.list": async (ctx, a) => (await q(ctx, "SELECT * FROM ai_conversations WHERE workspace_id = ? ORDER BY updated_at DESC", [str(a.workspaceId, "workspaceId")])).map(convRow),
    "conversations.get": async (ctx, a) => { const r = await q(ctx, "SELECT * FROM ai_conversations WHERE id = ?", [str(a.id, "id")]); return r.length ? convRow(r[0]) : null; },
    "conversations.insert": async (ctx, a) => {
      const c = a.conversation;
      const t = now();
      await x(ctx, "INSERT INTO ai_conversations(id, workspace_id, acp_profile_id, provider_session_id, title, status, approval_policy, mcp_selection_json, config_json, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
        [str(c.id, "id"), str(c.workspaceId, "workspaceId"), str(c.acpProfileId, "acpProfileId"), null, str(c.title, "title", 200), "offline", c.approvalPolicy || "ask", JSON.stringify(c.mcpSelection || ["internal"]), JSON.stringify(c.config || {}), t, t]);
      return null;
    },
    "conversations.update": async (ctx, a) => {
      const id = str(a.id, "id");
      const f = a.fields || {};
      const cols: [string, Json][] = [];
      if ("providerSessionId" in f) cols.push(["provider_session_id", f.providerSessionId ?? null]);
      if ("title" in f) cols.push(["title", String(f.title).slice(0, 200)]);
      if ("status" in f) cols.push(["status", String(f.status)]);
      if ("approvalPolicy" in f) cols.push(["approval_policy", String(f.approvalPolicy)]);
      if ("mcpSelection" in f) cols.push(["mcp_selection_json", JSON.stringify(f.mcpSelection)]);
      if ("config" in f) cols.push(["config_json", JSON.stringify(f.config)]);
      if ("acpProfileId" in f) cols.push(["acp_profile_id", String(f.acpProfileId)]);
      cols.push(["updated_at", now()]);
      await x(ctx, `UPDATE ai_conversations SET ${cols.map(([c]) => c + " = ?").join(", ")} WHERE id = ?`, [...cols.map(([, v]) => v), id]);
      return null;
    },
    "messages.list": async (ctx, a) => {
      const limit = Math.max(1, Math.min(Math.floor(Number(a.limit) || 500), 5000));
      const before = a.beforeSequence;
      if (before !== undefined && (!Number.isSafeInteger(before) || before <= 0)) throw new Error("invalid message cursor");
      const filter = before === undefined ? "" : " AND sequence < ?";
      const params: Json[] = [str(a.conversationId, "conversationId")];
      if (before !== undefined) params.push(before);
      params.push(limit);
      const rows = await q(ctx, `SELECT * FROM (SELECT * FROM ai_messages WHERE conversation_id = ?${filter} ORDER BY sequence DESC LIMIT ?) ORDER BY sequence ASC`, params);
      return rows.map((r: any) => ({ id: r.id, sequence: r.sequence, kind: r.kind, payload: parse(r.payload_json, {}), createdAt: r.created_at }));
    },
    /** Insert or update a message by id; sequence is assigned on first insert. */
    "messages.upsert": async (ctx, a) => {
      const id = str(a.id, "id");
      const cid = str(a.conversationId, "conversationId");
      const payload = JSON.stringify(a.payload ?? {});
      const kind = str(a.kind, "kind", 40);
      const existing = await q(ctx, "SELECT sequence FROM ai_messages WHERE id = ?", [id]);
      if (existing.length) {
        await x(ctx, "UPDATE ai_messages SET payload_json = ?, kind = ? WHERE id = ?", [payload, kind, id]);
        return { sequence: existing[0].sequence };
      }
      await ready;
      await ctx.host.db.transaction(db!, [
        { sql: "INSERT INTO ai_messages(id, conversation_id, sequence, kind, payload_json, created_at) VALUES(?, ?, (SELECT COALESCE(MAX(sequence), 0) + 1 FROM ai_messages WHERE conversation_id = ?), ?, ?, ?)", params: [id, cid, cid, kind, payload, now()] },
        { sql: "UPDATE ai_conversations SET updated_at = ? WHERE id = ?", params: [now(), cid] },
      ]);
      return null;
    },
  },
};
export default mod;
