# 7. Settings, state and persistence

[← Permissions](06-permissions.md) · [Index](README.md) · Next: [ACP agent providers →](08-acp-providers.md)

## Three kinds of data

| Kind | API | Lifetime | Use for |
|---|---|---|---|
| Module globals + `snapshot()` | JS variables | one generation, carried by snapshot | UI state: selection, open menus |
| Published state | `ctx.state.set/get/watch` | app session | sharing live values with other modules and the rails |
| Persistence | `ctx.modules.call("persistence", …)` | on disk | preferences and user data |

## Published state and events

```ts
ctx.state.set("notes.list", notes);                        // owner-namespaced key
const stop = ctx.state.watch("workspace.selected", v => {   // watch someone else's key
  ctx.ui.invalidate();
});
ctx.events.emit("notes.changed", { count });               // topic: <yourId>.*
const off = ctx.events.on("git.changed", ({ workspaceId }) => {/* refresh */});
```

- You can only publish keys under your own module id. `kernel.*` topics are reserved.
- Keep the unsubscribe functions and call them in `deactivate`.
- Pattern: **UI event → service method → service publishes state or event → UI
  invalidates → render.**

## Persistence

Add `"persistence"` to both `dependencies` and `calls`, then:

```ts
const v = await ctx.modules.call("persistence", "settings.get", { key: "notes.v1" });
await ctx.modules.call("persistence", "settings.set", { key: "notes.v1", value: data });
```

- Version your keys (`*.v1`) so you can migrate later.
- For your own tables, request `db:<yourId>` and ship `.sql` migrations (imported as text).
  `services/library` is an example.
- Per-workspace or per-machine scoped values: `sdk/scoped-settings.ts` (workspace ▸ machine ▸ user).

## Exposing preferences in Settings

Use `exportSettings` from `@hato/sdk/settings`. Settings UI discovers your sections from
published state `<yourId>.settings` and sends edits back to you. You validate and persist them.

```ts
import { exportSettings } from "@hato/sdk/settings";

let compact = false;

// in activate():
compact = !!(await ctx.modules.call("persistence", "settings.get", { key: "notes.compact" }));
exportSettings(ctx, () => [{
  key: "notes", title: "Notes", fields: [
    { key: "compact", label: "Compact list", type: "toggle", value: compact },
  ],
}], async (_section, key, value) => {
  if (key !== "compact" || typeof value !== "boolean") throw new Error("Invalid preference");
  await ctx.modules.call("persistence", "settings.set", { key: "notes.compact", value });
  compact = value;
});
```

Field types: `toggle`, `text`, `select`, `action` (button), `order` (reorderable list with
optional spacers), `color`, `range`. See `SettingField` in `sdk/types.ts`. A thrown error is
shown to the user, and the confirmed value is re-published.

## Exposing tools to AI agents (optional)

Modules can publish MCP tools that chats and agents can call. See `exportMcpTools` in
`git-panel` and `docs/MODULE_MCP.md`.
