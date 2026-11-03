# UI composition and event routing

## Composition tree

```text
UI manifest.contributes
└── sdk/plugins.ts collects enabled plugin contributions
    ├── panels: stable id, title, module, dock, defaultHidden, activity button
    ├── sidebars: module, side, width, order
    └── overlays: module
        └── workspace-layout (default shell.root provider)
            ├── model.ts: setPanels, defaultLayout and persisted geometry
            ├── docked/floating/detached panels → slot nodes
            ├── activity sidebars → sdk/activity-sidebar.ts
            ├── overlays → slots such as Settings
            └── theme and window composition
                └── each UI plugin render(ctx) → UiNode tree
                    └── kernel/src/ui/mod.rs → native controls
```

Contributions are validated in `sdk/plugins.ts`. The kernel forwards contribution JSON without
knowing what a Files panel or activity icon means. `watchContributions` reloads on
`kernel.modules.changed`. Use existing manifests for exact fields; disabled plugins contribute
no active UI. Stable panel ids matter because layout preferences refer to them.

## Render and interaction

`render(ctx)` returns declarative data described by `UiNode` in `sdk/types.ts`. Native controls
send actions to the owning module's `onEvent(ctx, event)`. A module may call a service, update
its state, emit an event and use `ctx.ui.invalidate()` to request another render. Slot nodes render
another module; they do not transfer the caller's host capabilities.

```text
control action → UI onEvent
└── ctx.modules.call(service, method, args)
    └── service updates persistence/resources
        └── service event or published state
            └── subscriber updates UI state → invalidate → render
```

Keep panel labels, navigation, ordering, SVG selection, spacing, colors and feature-specific
composition in UI modules. Native code supplies reusable controls and trusted approval chrome.

## Presentation sources

- `sdk/ui-icons.ts`, `sdk/file-icons.ts`, `sdk/sidebar-icons.ts`: module-selected SVG assets.
- `sdk/chat-style.ts`, `sdk/chat-transcript.ts`: chat composition and presentation helpers.
- `sdk/context-usage.ts`: usage visualization helpers.
- `kernel/src/ui/style.rs`: generic style interpretation, including tokens/hex, borders,
  dimensions, padding and typography.
- `kernel/src/ui/theme.rs`: theme token resolution, terminal palette and native chrome values.
- Theme node: module supplies palette/mode/typography/terminal/chrome data.
- Transcript node: native scroll anchoring around module-supplied child nodes.

Prefer composing the existing generic primitives over adding a domain-named renderer node.
When adding a reusable primitive, update both SDK and native handling and test actual behavior.

## Settings wiring

```text
module → exportSettings(ctx, sections, applyEdit) in sdk/settings.ts
└── <moduleId>.settings published state
    └── settings UI discovers sections and renders fields
        └── settings.change event → owning module validates/applies/persists
            └── confirmed values or save error published back
```

Use the owning module for preference semantics. Settings UI presents contributions rather than
hardcoding each service's preferences. Layout/appearance preferences belong to workspace-layout.
Follow workspace and async request versions in UI modules so late responses cannot replace a
newly selected workspace. Explorer refresh retains expansion/query; Git queues another refresh
if an event arrives during a status call.
