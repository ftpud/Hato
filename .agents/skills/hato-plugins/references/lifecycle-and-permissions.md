# Plugin lifecycle and permissions

## Manifest wiring

Read `kernel/src/grants.rs` for native schema parsing, `sdk/types.ts` for runtime contracts and
real manifests for supported examples.

| Field | Purpose |
|---|---|
| `schemaVersion` | Manifest schema; v2 adds plugin contracts and contributions |
| `id`, `name`, `kind`, `entry` | Identity, display label, service/UI role and source entry |
| `moduleApiVersion` | Module API compatibility |
| `dependencies` | Required module ids |
| `provides`, `requires` | Provided and required contracts, e.g. `shell.root` |
| `capabilities` | Requested native capabilities |
| `calls` | Declared additional module-call permissions |
| `runsOn` | `ui`, `workspace` or `either`; interpreted by remote policy |
| `contributes` | Opaque data forwarded by kernel; interpreted by UI modules/SDK |
| `stateVersion` | Declared state version; inspect the module's snapshot compatibility handling |

A default-exported `AppModule` supports `activate`, `deactivate`, `snapshot`, `canSwap`, service
`methods`, UI `render` and `onEvent`. Refer to the current interface for exact signatures.

## Discovery and enablement tree

```text
kernel.discover_all()
├── repository modules/                         Built-ins, enabled by default
└── <data>/plugins/<id>/                        Installed user plugins, disabled by default
    └── registry <data>/plugins.json            Enabled state and root override
        └── grant checks and dependency/contract ordering
            └── artifact versions → active JS generation
```

`kernel/src/plugins.rs` handles registry and installation mechanics. `kernel/src/kernel.rs`
handles enable/disable, dependency cascades, rescan, installation and selection of the `shell.root`
provider. A root is a plugin contract provider, not a fixed Rust reference to workspace-layout.
Disabling a provider can require cascading when dependents lose their only required provider.

`ctx.host.plugins.list/providers/dependents` supports discovery. Management operations require
`plugins.manage`. Settings exposes enable/disable, install, uninstall, rescan and window-root
selection; see `modules/ui/settings/src/index.ts`.

## Swap tree

```text
new source/bundle → stage artifact
└── activate staged generation
    ├── canSwap on previous generation, if exported (a veto returns EDEFERRED; `force` skips this step)
    ├── fence incoming calls and pause stream delivery
    ├── snapshot previous generation
    ├── candidate.activate(ctx, snapshot)
    ├── health: UI render, or service health method if present
    ├── failure → keep previous active generation, unfence
    └── success → cut over routing, resume streams, mark last-known-good
        └── deactivate/drain/retire previous generation
```

See `Kernel::swap`, `router.rs` and `artifacts.rs`. Globals belong to one JS generation;
important transient state needs snapshot/restore, while durable preferences belong in persistence.
Candidate activation happens before old deactivation: avoid cleanup that accidentally releases
resources transferred to the new generation.

Kernel handles are owned by logical module id, stable across generations. `resources.retainForWorkspace` and
lookup support named reuse; inspect `handles.rs` and the SDK before transferring resources.
Streams replace subscriptions from the same logical module and reject ownership violations.
Plugin unload and generation retirement are different operations; do not assume all native
resources should be destroyed on each code reload.

## Permission path

```text
manifest request
├── built-in → grants/first-party.json install bounds (compiled into binary)
└── user plugin → trusted approval → <data>/approved-grants.json
    └── effective generation capabilities/call permissions
        └── ops broker
            ├── generation status
            ├── capability
            ├── handle kind + logical owner
            ├── grant liveness, target and canonical scope
            └── trusted per-operation approval where required
```

A dependency, UI button, module setting or helper function cannot grant itself native privileges.
Do not move these checks into TypeScript. Source read/write and build grants are specialized
primitives; `module-dev` uses them rather than arbitrary shell or unrestricted source access.
