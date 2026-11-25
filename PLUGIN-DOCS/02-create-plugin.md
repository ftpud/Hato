# 2. Create a plugin

[← Concepts](01-concepts.md) · [Index](README.md) · Next: [Put it on the rails →](03-rails.md)

This walkthrough builds a **Notes** feature: a `notes` service that stores text and a
`notes-panel` UI that shows it. Copy the pattern for your own plugin.

## 1. Create the folders

Work in `Hato-plugins/`:

```text
Hato-plugins/modules/
├── services/notes/
│   ├── manifest.json
│   └── src/index.ts
└── ui/notes-panel/
    ├── manifest.json
    └── src/index.ts
```

Rules:
- The folder name, the manifest `id` and the exported `AppModule.id` **must match**.
- Ids match `^[a-z0-9][a-z0-9._-]{0,47}$`.

## 2. Service manifest

`modules/services/notes/manifest.json`:

```json
{
  "schemaVersion": 2,
  "id": "notes",
  "name": "Notes",
  "kind": "service",
  "entry": "src/index.ts",
  "moduleApiVersion": 1,
  "dependencies": ["persistence"],
  "calls": ["persistence"],
  "capabilities": [],
  "stateVersion": 1,
  "description": "Stores short notes.",
  "author": "You",
  "version": "0.1.0",
  "pluginPackage": "notes",
  "pluginType": "Productivity",
  "distribution": "marketplace"
}
```

### Manifest fields

| Field | Meaning |
|---|---|
| `schemaVersion` | `2` (supports `contributes`, `provides`, `requires`) |
| `id`, `name`, `kind`, `entry` | identity, display name, `service` or `ui`, TypeScript entry |
| `moduleApiVersion` | `1` |
| `dependencies` | modules that must be loaded first (lifecycle only) |
| `calls` | modules this one may `ctx.modules.call` (**permission**, approved at install) |
| `capabilities` | native capabilities used, e.g. `fs.scope`, `process.scope`, `db:<name>`, `net.fetch`, `ui.document` |
| `provides` / `requires` | contracts, e.g. `ai.provider`, `shell.root` |
| `contributes` | data for UI hosts: `panels`, `sidebars`, `overlays`, `barItems`, `agentProviders`, `languages`… |
| `runsOn` | `ui`, `workspace` or `either` (where it runs when the workspace is remote over SSH) |
| `stateVersion` | bump this when your snapshot shape changes |
| `version`, `pluginPackage`, `pluginType` | marketplace version, package id, category |
| `distribution` | `"marketplace"`, so it isn't auto-loaded as a built-in (recommended) |

## 3. Service code

`modules/services/notes/src/index.ts`:

```ts
import type { AppModule } from "@hato/sdk/types";

const KEY = "notes.v1";
let notes: string[] = [];

export default {
  id: "notes",
  moduleApiVersion: 1,

  async activate(ctx, previous) {
    // Restore from a hot-swap snapshot first, otherwise from persistence.
    notes = previous?.notes ?? (await ctx.modules.call("persistence", "settings.get", { key: KEY })) ?? [];
    ctx.state.set("notes.list", notes);           // published state, readable by other modules
  },

  snapshot: () => ({ notes }),                     // handed to the next generation on reload

  methods: {
    list: () => notes,
    async add(ctx, args: { text: string }) {
      notes = [...notes, String(args.text).slice(0, 2000)];
      await ctx.modules.call("persistence", "settings.set", { key: KEY, value: notes });
      ctx.state.set("notes.list", notes);
      ctx.events.emit("notes.changed", { count: notes.length });
      return notes.length;
    },
  },
} satisfies AppModule;
```

## 4. UI manifest with a panel

`modules/ui/notes-panel/manifest.json`:

```json
{
  "schemaVersion": 2,
  "id": "notes-panel",
  "name": "Notes panel",
  "kind": "ui",
  "entry": "src/index.ts",
  "moduleApiVersion": 1,
  "dependencies": ["notes"],
  "calls": ["notes"],
  "capabilities": [],
  "stateVersion": 1,
  "description": "Panel for the Notes service.",
  "author": "You",
  "version": "0.1.0",
  "pluginPackage": "notes",
  "pluginType": "Productivity",
  "distribution": "marketplace",
  "contributes": {
    "panels": [
      {
        "id": "notes",
        "title": "Notes",
        "defaultHidden": true,
        "dock": { "column": 1 },
        "activity": { "side": "left", "order": 50, "icon": "code" }
      }
    ]
  }
}
```

The `activity` block is what puts the panel on a rail. [Chapter 3](03-rails.md) covers it in detail.

## 5. UI code

`modules/ui/notes-panel/src/index.ts`:

```ts
import type { AppModule, UiNode } from "@hato/sdk/types";

let stopWatch: (() => void) | null = null;

export default {
  id: "notes-panel",
  moduleApiVersion: 1,

  activate(ctx) {
    stopWatch = ctx.state.watch("notes.list", () => ctx.ui.invalidate()); // re-render on change
  },
  deactivate() { stopWatch?.(); },

  render(ctx): UiNode {
    const notes = ctx.state.get<string[]>("notes.list") ?? [];
    return {
      type: "column", key: "root", gap: 6, padding: 8, children: [
        { type: "row", key: "compose", gap: 4, children: [
          { type: "textInput", key: "text", placeholder: "New note…", grow: true, submitAction: "add" },
          { type: "button", key: "add", text: "Add", action: "add" },
        ] },
        ...notes.map((n, i): UiNode => ({ type: "label", key: `n${i}`, text: n })),
      ],
    } as UiNode;
  },

  async onEvent(ctx, e) {
    if (e.action === "add" && e.inputs.text?.trim()) {
      await ctx.modules.call("notes", "add", { text: e.inputs.text });
    }
  },
} satisfies AppModule;
```

> For the full list of UI nodes, styles and host APIs, see [Primitives](11-primitives.md).
> Check the exact node props in `UiNode` in `sdk/types.ts` (for example `textInput`'s submit
> action name). The compiler catches mismatches when you run `npm run typecheck`.

## The `AppModule` interface

```ts
interface AppModule {
  id: string; moduleApiVersion: 1;
  activate?(ctx, previousState?): void | Promise<void>;
  deactivate?(ctx): void | Promise<void>;
  snapshot?(ctx): object;                    // state handed to the next generation
  canSwap?(ctx): { ok: boolean; reason?: string }; // veto a hot swap while busy
  render?(ctx): UiNode;                      // UI modules
  onEvent?(ctx, event: UiEvent): void;       // UI modules
  methods?: Record<string, (ctx, args, meta: { caller }) => any>; // services
}
```

## The `ModuleContext` (`ctx`)

| API | Use |
|---|---|
| `ctx.modules.call(id, method, args, {timeoutMs})` | RPC to another module (needs `calls`) |
| `ctx.events.emit(topic, payload)` / `on(topic, fn)` | pub/sub. Topics are `<yourId>.*`, and `kernel.*` is reserved |
| `ctx.state.set(key, v)` / `get` / `watch` | published state. Keys are owner-namespaced (`<yourId>.*`) |
| `ctx.ui.invalidate()` | request a re-render |
| `ctx.host.*` | native operations (fs, processes, streams, plugins, daemon…), gated by capabilities |
| `ctx.log` | logging (shows up in module logs) |

## Runtime rules

- Modules run in an **embedded JS runtime**, not Node and not a browser. There is no `fs` and no
  DOM. Use `ctx.host`.
- Anything imported from `@hato/sdk/*` is **bundled into your module**. If the SDK changes, rebuild.
- `.sql` and `.md` imports are embedded as text.
- Keep presentation (labels, icons, spacing, ordering) in the UI module, as data.

## Good starting examples

| Want | Look at |
|---|---|
| Small service + panel | `services/library` + `ui/library-panel` |
| Compact UI widget | `ui/language-status` |
| Manifest-only provider | `services/copilot-provider` |
| Settings export | any module calling `exportSettings` (see [chapter 7](07-settings-and-state.md)) |

Next: [Put it on the rails →](03-rails.md)
