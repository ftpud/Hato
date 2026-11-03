# Architecture and source map

All code paths below are relative to the repository root.

## Repository tree

```text
Hato/
├── AGENTS.md                          Application/native boundary and verification rules
├── modules/
│   ├── services/<id>/
│   │   ├── manifest.json              Identity, dependencies, capabilities, contracts
│   │   └── src/index.ts               AppModule activation, methods, state and workflows
│   └── ui/<id>/
│       ├── manifest.json              UI plugin plus shell contributions
│       └── src/index.ts               UiNode render tree, events and presentation
├── sdk/
│   ├── types.ts                       AppModule, ModuleContext, NativeHost, UiNode contracts
│   ├── runtime.ts                     WorkspaceDescriptor, scoped grants, SSH helpers
│   ├── plugins.ts                     Contribution validation/discovery
│   ├── settings.ts                    Settings contribution/edit helper
│   ├── scoped-settings.ts             Scope precedence and revision sync
│   ├── file-watch.ts                  Watch-stream ownership, switching and retry
│   └── ...                            Bundled UI, protocol and domain helpers
├── tools/build-modules.mjs            esbuild module discovery and seed builds
├── tools/build-hatod.sh               Headless native cross-build wrapper
├── build/modules/<id>.mjs             Generated built-in seed bundles
├── grants/first-party.json            Install-time permission upper bounds; compiled into Rust
├── kernel/src/
│   ├── config.rs / main.rs            Startup flags and desktop/headless/daemon entry
│   ├── kernel.rs                      Discovery, boot, lifecycle and hot-swap orchestration
│   ├── plugins.rs                     Install folders, enabled state and root override
│   ├── artifacts.rs                   Bundle versions, active and last-known-good records
│   ├── router.rs                      Generations, calls, fencing, state and events
│   ├── js/worker.rs / js/prelude.js    JS runtime and ctx.host bridge
│   ├── ops.rs                         Trusted host operation broker
│   ├── grants.rs / approvals.rs       Capabilities, scopes and trusted approval decisions
│   ├── handles.rs                     Resource ownership and stable handle keys
│   ├── host/                          FS, processes, PTYs, DB, streams, SSH and watchers
│   ├── daemon/                        Remote runtime CLI, server and attachment clients
│   └── ui/                            Generic native node rendering and controls
└── tests/
    ├── ts/                            Node tests bundling TS entry points with esbuild
    └── integration/                   Headless app drivers and isolated fixture setup
```

## Execution tree

```text
startup configuration
└── kernel discovery: built-in manifests + installed user plugins
    └── enabled plugins, dependencies, contracts and grants
        └── seed/artifact selection
            └── JS generation evaluates default AppModule export
                ├── activate(ctx, previousSnapshot)
                ├── methods ← ctx.modules.call(target, method, args)
                ├── state + events → subscribers in other modules
                ├── render(ctx) → UiNode JSON → native renderer
                └── ctx.host API → prelude → ops broker → native adapter/resource
```

`modules/services/` owns workflows and data interpretation. `modules/ui/` owns panel composition,
labels, actions, spacing and visuals. `sdk/` is shared source bundled into consumers, not a
separately running service. The kernel owns mechanisms and trust boundaries, not projects,
conversations or Git policy.

A module's folder, manifest id and exported AppModule id should agree. Existing manifests are
the best starting examples: `files` for a service, `git-panel` for a contributed panel,
`workspace-layout` for a shell, and `remote-runtime` for remote policy.

To trace an unfamiliar behavior, follow its UI action into a service method, then an SDK helper
or `ctx.host` call. For host calls, follow the operation name through `js/prelude.js` into
`ops.rs`, then the selected `host/` implementation. For a live refresh, trace the publisher's
event/state key and every subscriber rather than searching only for render functions.

State publications are owner-namespaced, and event topics normally use `<moduleId>.*`;
`kernel.*` topics are reserved. Keep cross-module event consumers paired with their publishers.
