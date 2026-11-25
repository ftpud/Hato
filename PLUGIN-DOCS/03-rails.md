# 3. Put a plugin on the rails

[← Create a plugin](02-create-plugin.md) · [Index](README.md) · Next: [Build, install and load →](04-build-install-load.md)

The Halo rails are Hato's two sidebars:

- **Left rail, "Workspace":** projects and tasks, run controls, workspace panels, machine menu.
  The `left-sidebar` module renders it.
- **Right rail, "Assistant":** new chat, recent chats, agent panels, plan usage. The `sidebar`
  module renders it.

Both are thin TypeScript modules built on `sdk/activity-sidebar.ts`, and `sdk/halo-rail.ts`
draws them. **Nothing about the rails is in Rust**, so adding a button never needs a rebuild.

## How a panel gets onto a rail

```text
your manifest  contributes.panels[].activity
└── sdk/plugins.ts         validates contributions of enabled plugins
    └── sdk/sidebar-placement.ts   decides position: user choice ▸ manifest default
        └── sdk/activity-sidebar.ts builds rail items (icon, badge, children, tasks)
            └── sdk/halo-rail.ts → UiNode → native renderer
```

The rails watch the plugin list (`watchContributions`). When your plugin is installed, enabled,
disabled or reloaded, its button appears or disappears right away.

## The `activity` block

```json
"contributes": {
  "panels": [
    {
      "id": "notes",
      "title": "Notes",
      "module": "notes-panel",
      "defaultHidden": true,
      "dock": { "column": 1 },
      "activity": {
        "side": "left",
        "order": 50,
        "icon": "code",
        "title": "My notes"
      }
    }
  ]
}
```

| Field | Meaning |
|---|---|
| `panels[].id` | **Stable** panel id. Saved layouts and rail order refer to it, so don't rename it casually. |
| `title` | panel title (and the default tooltip) |
| `module` | module rendered inside the panel. Defaults to the contributing plugin. |
| `defaultHidden` | start closed. The rail button opens it. |
| `dock` | default placement: `"bottom"`, or `{ "column": n, "size"?: px }` |
| `dockBelow` | when shown, stack below this panel id if it's docked in a column |
| `pinned` | can't be hidden (used by the main editor area) |
| `activity.side` | `"left"` or `"right"`. Rail placement. **Without `activity`, the panel isn't on a rail.** |
| `activity.order` | sort key within the rail (default 100, ties sort by id) |
| `activity.icon` | name of a built-in icon from `sdk/sidebar-icons.ts` |
| `activity.iconSvg` | inline SVG string. Takes precedence over `icon`. Use `stroke="currentColor"` so it follows the theme. |
| `activity.title` | tooltip/label override |

Built-in icon names: `projects`, `files`, `git`, `server`, `code`, `history`, `workflow`,
`ai`, `bot`, `plug`, `cloud`, `terminal`, `remote` (check `sdk/sidebar-icons.ts` for the current
list). A custom `iconSvg` uses a 24×24 viewBox, for example:

```json
"iconSvg": "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.8\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M4 4h16v16H4z\"/></svg>"
```

## Where the button lands

Each rail has a **top** and a **bottom** group, so there are four positions: `left-top`,
`left-bottom`, `right-top`, `right-bottom`, plus `hidden`.

1. **User choice wins.** `workspace-layout` stores a panel-id → position map
   (`activity-sidebar.v1`) and publishes it as state `workspace-layout.sidebarButtons`.
2. **Otherwise the manifest decides.** With `activity.side: "left"` the panel goes to
   `left-top`. With no `activity`, it's `hidden`.
3. **Order inside a group:** the saved order list (`sidebar-order.v1`, state
   `workspace-layout.sidebarOrder`) comes first. New panels follow, sorted by
   `activity.order` and then by id. Users edit the order and spacers in
   **Settings → Sidebar order & spacers**.

> Note: at the time of writing, the shipped settings only edit **order and spacers**. The
> position map is loaded from the defaults and reset with them, so to put a plugin on a
> particular rail, set `activity.side`. Bottom groups are only reachable through the defaults
> map in `workspace-layout` (`defaultSettings["activity-sidebar.v1"]`).

## Making the rail button live

The rail watches three state keys **published by the panel's module**. The key format is
`<module>.<kind>.<panelId>`:

| State key | Value | Effect |
|---|---|---|
| `<module>.panelBadge.<panelId>` | number | count badge on the button (hidden if 0) |
| `<module>.panelChildren.<panelId>` | `[{ id, label, count?, selected? }]` (max 50) | makes the button an **expandable navigation group** with child rows |
| `<module>.panelTasks.<panelId>` | `[{ id, label, progress?: 0..1, state?: "running"\|"done"\|"error" }]` (max 5) | progress tiles. A running task that disappears animates as done. |

Example (from `git-panel`):

```ts
ctx.state.set("git-panel.panelBadge.git", files.length);
```

Child rows (from `workflows-panel`). Clicks arrive as an event from the rail module:

```ts
ctx.state.set("notes-panel.panelChildren.notes", [
  { id: "today", label: "Today", count: 3 },
  { id: "archive", label: "Archive" },
]);

for (const rail of ["left-sidebar", "sidebar"])
  ctx.events.on(`${rail}.panelChild`, (e: { panel: string; child: string }) => {
    if (e.panel !== "notes") return;
    // open / select e.child
  });
```

Clicking the button itself toggles the panel's visibility. You don't need code for that.

## Checklist

- [ ] `contributes.panels[]` has a stable `id` and an `activity.side`
- [ ] the icon is a known name or an inline `currentColor` SVG
- [ ] the plugin is **enabled** (disabled plugins contribute nothing)
- [ ] optional: badge, children and tasks state keys published under your module id

## Changing the rails themselves

If you want to change rail *behaviour or look* (sections, motion, widths), edit
`sdk/activity-sidebar.ts` or `sdk/halo-rail.ts`. Those are bundled into `left-sidebar`,
`sidebar` (and `workspace-layout` for widths), so rebuild and activate those modules. You still
don't need to restart the app.
