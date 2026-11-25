# 1. Concepts

[← Index](README.md) · Next: [Create a plugin →](02-create-plugin.md)

## Module, plugin, package

- A **module** is one running unit of JavaScript with a `manifest.json` and a logical `id`.
  There are two kinds:
  - **service** (`kind: "service"`): logic, data, workflows and processes. It exposes `methods`
    that other modules call.
  - **ui** (`kind: "ui"`): `render(ctx)` returns a declarative `UiNode` tree, and `onEvent`
    handles clicks and input.
- A **plugin** is an installed or built-in module as the kernel sees it: whether it's enabled,
  its grants, and its active build.
- A **package** is a marketplace unit that groups one or more modules into a feature, for
  example `library` = `library` service + `library-panel` UI. You install, update, enable and
  uninstall packages as a whole.

A typical feature is one **service** (data and logic) plus one **UI** module (panel). The UI
calls the service through `ctx.modules.call`.

## Who owns what

| Layer | Owns | Language |
|---|---|---|
| Plugins (`Hato-plugins/modules`) | behaviour, workflows, defaults, layout, labels, icons, ordering | TypeScript |
| SDK (`sdk/`) | shared types and helpers, **bundled into each plugin** (not a running service) | TypeScript |
| Kernel (`kernel/`) | JS runtimes, rendering native controls, OS adapters (fs, processes, PTY, SSH), resource handles, permission checks, trusted approval UI | Rust |

The kernel knows nothing about projects, chats, Git or rails. It forwards a manifest's
`contributes` JSON unchanged, and TypeScript modules interpret it.

## How a plugin runs

```text
kernel discovers manifests (built-ins + <data>/plugins/<id>/)
└── checks enabled state, dependencies, contracts, grants
    └── loads the active JS build (a "generation")
        ├── activate(ctx, previousSnapshot)
        ├── methods      ← other modules: ctx.modules.call(id, method, args)
        ├── render(ctx)  → UiNode JSON → native renderer
        ├── onEvent(ctx, event) ← clicks, input
        └── ctx.host.*   → permission broker → native OS adapter
```

Every reload creates a new **generation**. The old one hands its state to the new one through
`snapshot()` → `activate(ctx, previousState)`. Kernel-owned resources such as terminals,
processes and watchers belong to the module id, not the generation, so they survive reloads.

## Built-in vs installed plugins

| | Built-in | Installed user plugin |
|---|---|---|
| Source | `Hato-plugins/modules/...` without `distribution: "marketplace"` | a folder holding `manifest.json` + `dist/<id>.mjs` |
| Discovery | always, enabled by default | `<data>/plugins/<id>/`, **disabled until enabled** |
| Permissions | bounded by `grants/first-party.json`, which is compiled into Rust | user approves in a trusted native dialog |
| Adding one | needs a grant entry, so **Rust rebuild + restart** | **no rebuild**, install through Settings → Plugins |

**For new plugins, use an installed (marketplace) plugin.** Set
`"distribution": "marketplace"` in the manifest. You can still develop it in
`Hato-plugins/modules/`, and the source folder won't be auto-loaded as a built-in.

## What needs Rust?

| Change | Rust rebuild? |
|---|---|
| New plugin (installed/marketplace), new panel, rail button, settings, events | No |
| Editing any plugin source, manifest `contributes`, or SDK helper | No (rebuild + activate affected modules) |
| New ACP agent provider | No |
| New **built-in** plugin, or wider first-party grants (`grants/first-party.json`) | **Yes**, restart |
| A missing native primitive (new `UiNode` type, new `ctx.host` op, OS adapter) | **Yes**, restart |

## Generations, contracts, shell root

- `provides` / `requires` declare contracts. Examples: `shell.root` is the window
  composition, normally `workspace-layout`, and `ai.provider` is an agent provider.
- Disabling the only provider of a required contract cascades to its dependents.
- `dependencies` controls load order and lifecycle only. **It does not grant call access.**
  You declare that separately in `calls` (see [Permissions](06-permissions.md)).
