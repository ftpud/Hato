# 6. Permissions

[← Update](05-update-reload.md) · [Index](README.md) · Next: [Settings, state and persistence →](07-settings-and-state.md)

The kernel enforces every native operation and every cross-module call. A plugin can't grant
itself anything. Neither can a UI button, setting or SDK helper.

## What you declare

```json
"capabilities": ["fs.scope", "process.scope"],
"calls": ["workspace", "persistence"]
```

- **`capabilities`:** native powers used through `ctx.host`. Examples from real manifests:
  - `fs.scope`, `process.scope`: filesystem and processes within granted scopes
  - `db:<name>`: the module's own database
  - `ssh.connect`, `remote.daemon`: SSH and the remote runtime
  - `net.fetch`, `net.loopback`, `ui.openUrl`: network and opening URLs
  - `ui.document`: document-style UI
  - `approvals.request`: ask for trusted per-operation approval
  - `plugins.manage`: install, enable or disable plugins

  See `kernel/src/grants.rs` and `grants/first-party.json` for the full set.
- **`calls`:** modules you `ctx.modules.call`. **`dependencies` doesn't imply call access.**
  List the same module in both when you need it loaded *and* callable.

Request only what you use. Each extra item shows up in the user's approval dialog.

## How it's resolved

```text
manifest request
├── built-in  → upper bound = grants/first-party.json  (compiled into the binary)
└── installed → user approves in a trusted native dialog → <data>/approved-grants.json
    effective = requested ∩ (install bound ∪ approved)
        └── checked on every op: capability, handle owner, scope, liveness
            and on every modules.call: "module 'x' is not allowed to call 'y'"
```

- Installed plugins: permissions not yet approved appear as an **escalation** (`call:<id>` for
  calls) and need approval on install or enable.
- Adding a new capability or call in an update → the user approves it again.
- Uninstalling forgets the plugin's approvals.

## Rules

- **Never** edit `approved-grants.json`, installed manifests or cached artifacts by hand to
  "fix" a denial. Update the manifest, reinstall or update, and approve.
- Ownership, scope checks and trusted approvals stay in the kernel. Don't reimplement them in TS.
- Modules rendered inside another module's slot **don't** inherit the host module's capabilities.
- Built-in grants changing = Rust rebuild. Installed plugins avoid that entirely.
