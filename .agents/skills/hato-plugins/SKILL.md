---
name: hato-plugins
description: Build, extend, debug, or explain Hato plugins and their wiring across TypeScript services, UI contributions, hot reload, native capabilities, and SSH daemons. Use for Hato architecture, plugin development, marketplace packaging, installation, updates and publishing references.
---

# Hato plugin development

Read the repository's [AGENTS.md](../../../AGENTS.md) first. This skill is a source-navigation
map and development reference, not an expansion of the task's authorization.

## Reference tree

```text
hato-plugins/
├── SKILL.md                         Start here; choose the relevant branch
└── references/
    ├── architecture.md              Repository tree and end-to-end execution path
    ├── build-and-reload.md          Bundling, activation, tests and native rebuild boundaries
    ├── marketplace.md               Optional packages, install/update/run, dependencies and publishing
    ├── lifecycle-and-permissions.md Manifests, discovery, swaps, handles and approvals
    ├── ui-composition.md            Contributions → layout → UiNode → native renderer
    ├── service-flows.md             Workspace, persistence, Files/Git, terminal and AI wiring
    ├── visual-review.md                Screenshot helper and native UI design checks
    └── native-and-remote.md         Host broker, streams, watchers, SSH and daemon boundaries
```

Read only the branches needed for the current task:

- Finding an owner or tracing behavior: [architecture](references/architecture.md).
- Building, adding a module, or making a running app use edits: [build and reload](references/build-and-reload.md).
- Marketplace packaging, installing/updating/running optional plugins, or publishing a catalogue:
  [marketplace](references/marketplace.md).
- Plugin enablement, missing dependencies, hot-swap failure, or permission errors:
  [lifecycle and permissions](references/lifecycle-and-permissions.md).
- Panels, sidebars, settings UI, rendering or styling: [UI composition](references/ui-composition.md).
- Inspecting the actual design of a panel, popup or element: [visual review](references/visual-review.md).
- Source editor, syntax highlighting, color schemes or LSP editor features: the sibling
  [hato-editor skill](../hato-editor/SKILL.md).
- Application data, refresh events, workspace routing or agent behavior:
  [service flows](references/service-flows.md).
- A missing native primitive, resource stream, remote install, or disconnect behavior:
  [native and remote](references/native-and-remote.md).

## Working rules

1. Locate the owning module, its manifest, SDK helpers and direct consumers before editing.
   Implement application behavior and presentation in TypeScript; add a Rust primitive only
   when the existing host/UI contract cannot express the change.
2. Verify API names and behavior against current source. References describe the implementation
   when written; `sdk/types.ts`, manifests and call sites settle questions after code evolves.
3. Shared SDK code is bundled into each consumer. Rebuild and activate affected consumers.
   A successful bundle build does not by itself activate a running module.
4. Preserve workspace state and reusable kernel-owned resources during reloads. Keep ownership,
   canonical-path scope checks and trusted approval enforcement in the kernel.
5. Run checks appropriate to the changed layer and report whether changes are built, staged,
   activated, or require restart. Preserve existing uncommitted work.

For the public API overview, see [docs/PLUGINS.md](../../../docs/PLUGINS.md). For integration
fixtures and SSH setup, see [docs/TESTING.md](../../../docs/TESTING.md). Treat
[handover.md](../../../handover.md) as historical status and limitations, not an API contract.
