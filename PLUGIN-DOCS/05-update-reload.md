# 5. Update, reload and roll back

[← Build, install and load](04-build-install-load.md) · [Index](README.md) · Next: [Permissions →](06-permissions.md)

Hato hot-swaps modules. Workspace state, open panels, terminals and processes survive a reload.

## Which route to use

| Situation | Route |
|---|---|
| Iterating on an **existing** module's source | Modules panel / `module-dev` tools: patch → build (stage) → activate |
| Built-in seed in a dev checkout | `npm run watch` + app launched with `--dev-watch` |
| Shipping a new **version** of an installed plugin | bump `version`, rebuild/export, then Settings → Plugins → **Update** (marketplace) or reinstall from folder |
| Manifest changes (calls, capabilities, contributions) | new version + update/reinstall; approve new permissions |

> Editing the source manifest **doesn't** change an installed copy. Installed plugins only
> change through install/update or the stage/activate tools.

## Stage → activate (module-dev)

`module-dev` (`Hato-plugins/modules/services/module-dev/src/index.ts`) is the supported live
tool. Its methods:

| Method | What it does |
|---|---|
| `build {id}` | compiles **and stages**, returns a `stageId`. **Not live yet.** |
| `activate {id, stageId}` | cuts over to the staged build |
| `buildAndActivate {id}` | both steps in one |
| rollback | returns to the previous or last-known-good build |

Agents can reach these over MCP as `modules_build`, `modules_activate`, `modules_rollback`,
`modules_apply_patch`, `modules_read_source`. Each mutation requires **native user approval**.
These tools only edit **existing** modules. To add a new module, install it ([chapter 4](04-build-install-load.md)).

## What happens during a swap

```text
activate staged build
├── canSwap() on the old generation (if exported). A veto returns EDEFERRED.
├── fence incoming calls, pause stream delivery
├── old.snapshot()
├── new.activate(ctx, snapshot)
├── health check: UI renders / service health
├── fail → keep old generation running, unfence
└── ok   → route to new generation, resume streams, mark last-known-good,
           then deactivate and retire the old generation
```

Design for it:

- **`snapshot()` / `activate(ctx, previous)`:** carry transient state such as selection,
  scroll and open menus across reloads. Bump `stateVersion` when the shape changes, and
  tolerate old shapes.
- **Durable data goes to persistence**, not module globals. Globals die with the generation.
- **`canSwap()`:** return `{ ok: false, reason }` while busy, for example mid-request.
- **Don't release shared resources in `deactivate`** that the new generation inherits. The new
  generation activates *before* the old one deactivates. Handles belong to the module id, not
  the generation.

## Saved builds and rollback

The **Modules** panel has a per-module selector:

- **Bundled / Installed:** the shipped seed or the installed version (the baseline).
- **Updated:** the latest custom build that activated successfully.

Switching between them uses the same approved rollback/activation path and keeps your sources.
Build numbers like `notes@0004` are local build counters, **not** marketplace versions.

## SDK changes

SDK code is bundled into each consumer. After editing `sdk/foo.ts`:

```sh
grep -rl "@hato/sdk/foo" Hato-plugins/modules   # find consumers
```

Then rebuild and activate **each** consumer. Rebuilding one doesn't update the others.

## When a restart *is* needed

Only when the native side changed: `kernel/` Rust, the JS prelude, or
`grants/first-party.json`. Plugin code, manifests, contributions and SDK helpers never need one.
