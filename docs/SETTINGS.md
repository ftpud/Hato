# Module settings

The `settings` UI module owns the Settings menu. `workspace-layout` opens it from
its top bar with `ctx.modules.call("settings", "open")` and mounts its UI slot.
Appearance uses the kernel's `appearanceControl` primitive and retains the saved
light/dark preference. Settings remains accessible when its bar item is hidden.

UI and service modules can contribute toggle and select fields with the shared SDK:

```ts
import { exportSettings } from "../../../../sdk/settings";

// In activate(), load your persisted preferences first.
exportSettings(ctx, () => [{
  key: "general",
  title: "My module",
  fields: [{ key: "enabled", label: "Enabled", type: "toggle", value: enabled }],
}], async (section, key, value) => {
  // Validate domain constraints, persist, then update your local state.
  await ctx.modules.call("persistence", "settings.set", {
    key: `${ctx.moduleId}.${key}`, value,
  });
  enabled = value as boolean;
});
```

A select field has `type: "select"`, a string `value`, and
`options: [{ value: "compact", label: "Compact" }]`. Fields may include a
`description`. Section and field keys must be stable and unique within their
parent. Export only public preferences; these values are shared application state.

The helper publishes sections and confirmed values at `<moduleId>.settings`.
The Settings module discovers active modules and watches their exports, including
after hot swaps. Edits travel through `settings.change`; the provider validates
field types and allowed options, serializes edits, and handles its own persistence.
Failed saves show an error and retain the last confirmed values. The helper returns
a publish function for updates made elsewhere in the provider.

Contributors need no new capabilities to publish settings. If a provider uses
`persistence`, include it in its manifest dependencies and install-time call grant.
The Settings module needs only `modules.read` for discovery; it has no module RPC
grants. Source viewer's “Show file metadata” setting is a complete working example.

After adding the Settings module for the first time, rebuild module seeds and the
native binary (`npm run modules:build`, `cargo build --offline`) and restart Hato.
The native rebuild includes its install-time grant and appearance control.

## Module-defined colors

`workspace-layout` supplies the application's palette with a zero-content `theme`
node, using `sdk/color-scheme.ts`. The node contains `palette.light` and
`palette.dark` maps of semantic color tokens to `#RRGGBB` strings. The renderer
applies these tokens to native controls and chat surfaces; invalid or missing
values fall back to the existing theme. The saved light/dark preference is retained.

The reference light palette uses white surfaces, pale blue fields and selections,
slate text, and indigo accents. Changing these tokens requires rebuilding and hot
activating `workspace-layout`, with no native rebuild after the theme-node support
has been installed. Colors do not control layout, typography, spacing, or geometry.

Typography is contributed by `workspace-layout` under **Typography → Interface
font**. The selected family is persisted as `appearance.fontFamily` and supplied
through the theme node's `typography` data. JetBrains Mono is bundled with its OFL
license, and is the default; System font, Menlo, and Monaco are also available.
System font retains JetBrains Mono for code and terminals. Font changes apply
without restarting after native typography support has been installed.

File and terminal tab colors and weights are defined in `sdk/tab-style.ts`.
Explorer icons use the Lucide outline subset in `sdk/file-icons.ts`, with the ISC
license retained in `sdk/icons/LICENSE-lucide.txt`. Tree rows pass SVGs and semantic
color roles to the renderer, so icon selection and drawings remain module-owned.

## Settings categories

Every section published through `exportSettings` becomes a selectable category in
Settings' left-hand list. The right-hand pane shows only that category's fields.
A module can publish multiple sections, each with its own stable `key`, readable
`title`, optional `description`, and `fields`. Existing contributors work without
changes. Use descriptive titles such as “Terminal behavior” rather than repeating
“General” across modules.

```ts
exportSettings(ctx, () => [
  { key: "behavior", title: "Terminal behavior", description: "Options for new shells.",
    fields: [{ key: "restore", label: "Restore terminals", type: "toggle", value: restore }] },
  { key: "display", title: "Terminal display", fields: [/* display preferences */] },
], savePreference);
```

Category identity combines the module ID and section key, so different modules
can reuse section keys. Switching categories leaves preferences unchanged.
Contributions update live; disappearing categories fall back to Appearance.
The selected category survives a hot swap of Settings.

Call `settings.open` with `{ module: "viewer", section: "viewer" }` to open a
particular category (subject to the caller's existing module RPC grant).

Modules may also contribute internal MCP commands through `exportMcpTools` in
`sdk/mcp.ts`. The broker supplies separate Settings categories with allow/deny
controls for those commands. See [Module MCP commands](MODULE_MCP.md). Service
settings contributors should pass `{ invalidate: false }` as the fourth argument
to `exportSettings`; publishing state already refreshes the Settings UI, and a
service has no UI tree to invalidate.
