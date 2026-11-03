-- Settings with scopes and revisions. scope: "user", "machine:<machineId>" or "workspace:<workspaceId>".
-- rev increases on every write; writers may pass the revision they read to detect conflicts.
CREATE TABLE IF NOT EXISTS scoped_settings (
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  rev INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (scope, key)
);
