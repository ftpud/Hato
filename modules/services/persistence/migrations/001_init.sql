-- modules/services/persistence/migrations/001_init.sql
CREATE TABLE IF NOT EXISTS ssh_profiles (
  id TEXT PRIMARY KEY, host TEXT NOT NULL, port INTEGER NOT NULL,
  username TEXT NOT NULL, auth_ref TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('local','ssh')),
  root_path TEXT NOT NULL, ssh_profile_id TEXT REFERENCES ssh_profiles(id),
  expanded INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
  name TEXT NOT NULL, branch TEXT NOT NULL,
  worktree_path TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'ready',
  created_at TEXT NOT NULL,
  UNIQUE(project_id, branch)
);
CREATE TABLE IF NOT EXISTS workspace_views (
  workspace_id TEXT PRIMARY KEY,
  explorer_relative_dir TEXT NOT NULL DEFAULT '.',
  preview_relative_path TEXT, terminal_key TEXT NOT NULL DEFAULT 'main',
  active_conversation_id TEXT, ui_state_json TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS acp_profiles (
  id TEXT PRIMARY KEY, machine_id TEXT NOT NULL,
  project_override_id TEXT, provider TEXT NOT NULL,
  name TEXT NOT NULL, executable TEXT NOT NULL,
  args_json TEXT NOT NULL DEFAULT '[]', env_refs_json TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS ai_conversations (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL,
  acp_profile_id TEXT NOT NULL, provider_session_id TEXT,
  title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'offline',
  approval_policy TEXT NOT NULL DEFAULT 'ask',
  mcp_selection_json TEXT NOT NULL DEFAULT '["internal"]',
  config_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ai_messages (
  id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES ai_conversations(id),
  sequence INTEGER NOT NULL, kind TEXT NOT NULL,
  payload_json TEXT NOT NULL, created_at TEXT NOT NULL,
  UNIQUE(conversation_id, sequence)
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
