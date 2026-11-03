# Native primitives, streams and remote runtime

## Host-call wiring

```text
sdk/types.ts NativeHost contract
└── ctx.host API in kernel/src/js/prelude.js
    └── kernel/src/ops.rs operation dispatch
        ├── capabilities, owner/kind and scope checks
        ├── trusted approval when required
        └── kernel/src/host/<adapter>.rs
            └── handle-owned resource or JSON response
```

When a primitive is missing, define the smallest reusable contract and keep application decisions
in modules. Update the SDK, prelude and broker together. Keep `kernel/tests/arch_gate.rs` passing;
it forbids domain managers, application SQL and agent/Git protocol strings in Rust code.

## Streams and resource lifetime

`host/streams.rs` supplies bounded byte streams, backpressure and subscription handover.
`ctx.host.streams.listen` connects callbacks to resource channels. Processes expose stdout/stderr;
PTYs and native documents have their own contracts. See SDK types before mixing handle kinds.

Handles are opaque and owned by logical module id. A later generation can reattach using stable
resource keys. Close generation subscriptions deliberately; do not kill a long-lived terminal or
agent process just because its UI/plugin code reloads. `resources.release` explicitly ends a
resource. There is no implicit authorization to inspect another module's handles.

## Watch primitive

`fs.watch(grant, path, {recursive})` is brokered like a scoped read. It checks grant kind,
liveness, owner and canonical containment, and rejects protected local paths. Recursive watching
does not follow symlinks. It starts a process-backed OS watcher implemented by `host/watch.rs`:

```text
fs.watch → hato daemon watch --path <validated-root>
├── local: current executable
└── SSH: uploaded target executable, launched over the SSH channel
    └── notify native backend (FSEvents / inotify)
        └── stdout: ready / changed lines → streams.listen → module invalidation
```

Treat chunks as invalidations; chunks can coalesce lines. `ready` also invalidates to cover edits
during installation. Release the returned process handle to stop watching. EOF on helper stdin
ends the remote helper when its viewer disappears. SSH watch requires `remote.daemon` and a
matching target binary. `sdk/file-watch.ts` handles cleanup, obsolete callbacks and failed-stream
retry; debounce timing and refresh semantics belong to consumers.

## Remote policy and mechanism

```text
workspace.selected (SSH)
└── remote-runtime service (autoStart/autoPush settings)
    └── ctx.host.daemon.ensure(target)
        └── host/daemon_link.rs
            ├── detect remote OS/architecture
            ├── choose and upload matching binary
            └── hato daemon ensure → daemon/server.rs
                ├── user-only Unix socket and peer uid check
                ├── held PTYs/processes and buffered attachment streams
                └── headless kernel for pushed plugins
```

The desktop searches Linux builds under `target/<triple>/release/hato`, or overrides under
`<data>/daemon/<os>-<arch>/hato`; consult `daemon_link.rs` for current order and supported platforms.
`tools/build-hatod.sh` builds without the default GUI feature, using cargo-zigbuild for cross builds.
A successful cross-build is not Linux runtime verification.

`remote-runtime` chooses enabled `runsOn: "workspace"` service plugins and pushes them when
configured. Push requires a locally installed, approved plugin. It separately pushes persistence
for machine-setting sync. `remote-panel` presents runtime resources and plugin controls. The
kernel does not choose which application workflow should run remotely.

`daemon.request` permits a bounded operation set, including resource inspection/control, plugin
push/control and `modules.call`. `remote.daemon.admin` permits cross-module resource inspection.
Resource keys are otherwise scoped per module.

`pty.open` and `process.spawn` accept `persist: {key}` to attach through daemon-held resources.
Persistent `process.run` is not supported. Attachment loss detaches a viewer while daemon-owned
resources survive; acknowledged process output prevents replay/loss across attachment changes.
The bridge CLI forwards stdin lines to a plugin method for tool integration.

Known boundaries to recheck before promising behavior: a daemon with live resources can remain
stale across upgrades; daemon-side approvals are currently denied; agent persistence and offline
MCP wiring need application work beyond having a persistent process primitive.
