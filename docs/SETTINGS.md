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
