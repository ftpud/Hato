# Application service wiring

Read the relevant module's `methods` and manifest before changing a flow. Names in this guide
are search anchors, not a replacement for current method signatures.

## Workspace and persistence

```text
projects-panel → projects / git-tasks → persistence records
└── workspace.select / workspace.resolve
    ├── WorkspaceDescriptor (sdk/runtime.ts): id, machine, root, SSH metadata
    ├── persisted per-workspace view state
    └── workspace.selected state
        ├── Files and Git watcher selection
        ├── explorer / viewer / git-panel selection
        ├── terminals attach target
        └── remote-runtime SSH policy
```

`workspace` is the resolver; callers should not reconstruct roots from ids. `sdk/runtime.ts`
provides `targetFor`, `workspaceGrant`, SSH caching and reconnect helpers. Every FS/process/PTY
operation uses the workspace's actual machine; failures must not silently fall back to local.

`persistence` owns the application SQLite namespace and SQL migrations under its module folder.
Other modules call typed methods rather than issuing application SQL from Rust. `sdk/settings.ts`
handles publishing editable settings; persistence stores values.

`sdk/scoped-settings.ts` resolves workspace → machine → user. `scoped.set` supports `expectedRev`
for optimistic concurrency and explicit newer `rev` for sync. Writes are serialized in persistence.
Remote-runtime synchronizes machine scopes on SSH ensure/local changes or explicit sync. Equal
revision conflicts keep desktop values, advance the revision and report keys. Existing ordinary
`settings.get/set` preferences coexist with scoped values; do not assume automatic migration.

## Files and Git refresh tree

```text
workspace.selected
├── files → workspace FS grant → sdk/file-watch.ts → host fs.watch
│   └── debounced files.changed {workspaceId}
│       ├── invalidate search/document caches and refresh skills
│       ├── explorer reloads listings/search, retaining expansion/query
│       └── git service schedules git.changed
└── git → git rev-parse resolves private/shared metadata dirs
    └── independently scoped watches (including linked checkout metadata outside root)
        └── debounced git.changed {workspaceId}
            └── visible git-panel → git.status → statusChanged → viewer consumers
```

Implementation: `modules/services/files/src/index.ts`, `search.ts`, `skills.ts`;
`modules/services/git/src/index.ts`, `status.ts`; `modules/ui/explorer/`;
`modules/ui/git-panel/`; `modules/ui/viewer/`. Git status/diff run argv-based Git on the target
machine, and patches become native document handles. Git panel automatic refresh is event-driven;
its preference migrates the old polling Off value. Hidden panels refresh when shown.

The Files watch covers the selected workspace recursively. Watcher failures retry with backoff,
not directory-content polling. Native streams issue coarse invalidations, not a complete file
operation journal. Workspace-switch/version guards prevent stale results from replacing new UI.

## Terminal flow

```text
terminal-panel → terminals.attach(workspaceId, key)
└── workspace target + scoped PTY grant
    ├── ordinary native PTY
    └── persistent PTY via daemon (SSH default, local optional setting)
        └── native PTY handle → terminal node
```

`modules/services/terminals` chooses keys, persistence defaults and reconnect policy. Native code
owns PTYs and rendering. Releasing a viewer of a persistent shell detaches it; daemon kill
operations terminate the held resource. Preserve stable resource keys across module reloads.

## AI and tools flow

```text
UI ai → ai-sessions (conversation/workflow/persistence)
└── acp (agent process, protocol peer, adapters and reconnect policy)
    ├── process streams → ACP notifications → session/UI updates
    ├── permission requests → ai-sessions → trusted approval API
    └── internal-mcp → application tools → services / module-dev
```

Protocol helpers live in SDK and ACP module sources. Conversation/provider/tool meanings stay
outside Rust. `internal-mcp` provides the agent-facing application tool surface; `module-dev`
implements module editing/build/activation policy over constrained native APIs. Remote daemon
support does not automatically make ACP re-handshake or offline agent tools persistent; verify
those separately against implementation and `handover.md` follow-ups.

## Independent background agents

`agents-panel → persistent-agents → hatod → agent-runner` is independent of the existing chatbox.
The runner owns ACP processes, protocol state, history, steering and pending provider permissions
on the workspace machine, including a local daemon for local sessions. Desktop projections do
not drive turns. Provider permissions wait offline and are reviewed through trusted desktop UI.

`internal-local-mcp` presents desktop/UI tools over the compatible legacy transport.
`internal-remote-mcp` hosts workspace-bound agent/terminal/selected-skill tools on hatod, or in the
desktop for ordinary local non-daemon terminals. The runtime-facing server does not expose UI
or module mutation tools. Child workers inherit the parent's selected configuration.

See [docs/PERSISTENT_AGENTS.md](../../../../docs/PERSISTENT_AGENTS.md) for tool names, endpoint
modes, restart/upgrade boundaries and integration fixture setup. Session/model contracts are in
`sdk/persistent-agents.ts`. Do not replace the daemon runtime while it has live agents.

MCP configuration has its own `modules/ui/mcp-panel` plugin. It uses a narrow owner-namespaced
`mcp-panel.request` / `persistent-agents.mcpResponse` adapter for catalog CRUD; no native capabilities
or direct call grants are needed. Configuration is still persisted at `persistent-agents.mcps`.
The agent form consumes enabled entries. During activation, event-based requests must be started
without awaiting their responses: the router fences event delivery until activation cuts over.
