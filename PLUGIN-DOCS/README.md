# Hato plugin guide

Start here. This guide explains how Hato plugins work. It covers how to write a plugin, put it
on the Halo rails, build it, load it, update it, publish it, and add a new AI agent over ACP.

> **The short version:** plugins are TypeScript. Writing, loading, updating and placing a
> plugin on the rails **never** needs a Rust rebuild. You only need native work when a plugin
> requires a host primitive that doesn't exist yet. See [Permissions](06-permissions.md) and
> [Concepts](01-concepts.md#what-needs-rust).

## Reading order

| # | Guide | Read it when you want to… |
|---|---|---|
| 1 | [Concepts](01-concepts.md) | understand modules, packages, the kernel boundary and the repo layout |
| 2 | [Create a plugin](02-create-plugin.md) | write a manifest plus a service or UI module, step by step |
| 3 | [Put it on the rails](03-rails.md) | show your panel as a button in the left or right Halo rail |
| 4 | [Build, install and load](04-build-install-load.md) | turn source into a bundle and get it running in the app |
| 5 | [Update, reload and roll back](05-update-reload.md) | hot-swap a new version without restarting |
| 6 | [Permissions](06-permissions.md) | pick capabilities and module calls, and see what approval looks like |
| 7 | [Settings, state and persistence](07-settings-and-state.md) | expose preferences, share state, react to events |
| 8 | [ACP agent providers](08-acp-providers.md) | add a new AI agent (Claude, Codex and Copilot are examples) |
| 9 | [Publish to the marketplace](09-publish.md) | package, version and release through the catalogue |
| 10 | [Troubleshooting](10-troubleshooting.md) | fix a plugin that doesn't show up, is denied, or won't swap |
| 11 | [Primitives](11-primitives.md) | see every UI node, style option and `ctx.host` API a plugin can use (reference; read alongside 2) |

## Fast paths

- **"I want a new panel on the rail"** → read 2 → 3 → 4.
- **"I changed my plugin, now what?"** → read 5.
- **"I want to add a new coding agent"** → read 8. Often this is a manifest-only plugin.
- **"It says permission denied"** → read 6 and 10.

## Where things live

```text
Hato/                         host repo: kernel (Rust), sdk/ (shared TS), docs
├── sdk/                      types + helpers, bundled into each plugin
├── kernel/                   native runtime, renderer, permission broker
├── grants/first-party.json   permission bounds for built-ins (compiled into the binary)
└── Hato-plugins/             separate Git repo: all plugin sources
    ├── modules/services/<id>/   service plugins (logic, data, workflows)
    ├── modules/ui/<id>/         UI plugins (panels, rails, overlays)
    ├── build/modules/<id>.mjs   build output
    ├── packages/<pkg>/<ver>/    exported, versioned marketplace artifacts
    └── plugins.catalogue.json   package definitions
```

`Hato-plugins/` has its own Git history. Keep plugin commits there, and keep SDK and kernel
commits in the host repo.

## Authoritative sources

These docs summarise the code. When they disagree with it, the code wins:

- `sdk/types.ts`: `AppModule`, `ModuleContext`, `UiNode`, `NativeHost`
- `sdk/plugins.ts`: the contribution schema (panels, sidebars, overlays, bar items)
- `sdk/sidebar-placement.ts`, `sdk/activity-sidebar.ts`, `sdk/halo-rail.ts`: the rails
- `sdk/agent-providers.ts`, `Hato-plugins/modules/services/acp/`: ACP
- `kernel/src/grants.rs`, `kernel/src/ops.rs`: permission enforcement
- Deeper maintainer references: `.agents/skills/hato-plugins/references/*.md` and `docs/PLUGINS.md`
