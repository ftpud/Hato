# 11. Primitives: what a plugin can use

[← Index](README.md) · Related: [Create a plugin](02-create-plugin.md), [Permissions](06-permissions.md)

A plugin builds everything from two kinds of native primitives:

1. **UI nodes:** the declarative `UiNode` tree your `render(ctx)` returns. The native renderer
   draws them, and you need no capability to use them.
2. **Host APIs** (`ctx.host.*`): native operations such as files, processes, terminals,
   SSH and network. These are gated by [capabilities](06-permissions.md).

Anything else (lists, cards, rails, chat bubbles, settings pages) is **composition** of these
primitives in TypeScript, often through an SDK helper. If something truly can't be composed,
that's when a new native primitive is added. See [When a primitive is missing](#when-a-primitive-is-missing).

The source of truth is `UiNode`, `UiStyle` and `NativeHost` in `sdk/types.ts`.

---

## Part 1: UI nodes

### Props every node has (`Base`)

| Prop | Meaning |
|---|---|
| `key` | **required**, stable within siblings (drives diffing and focus) |
| `grow`, `width`, `height`, `maxHeight`, `minWidth` | sizing (px) |
| `padding`, `gap` | spacing |
| `bg` (`panel`/`muted`/`accent`/`none`), `border`, `borderSide` | quick surface presets |
| `style` | full `UiStyle` (below) |
| `tooltip`, `tooltipKeys`, `tooltipPlacement` | hover help, optional shortcut chips |
| `layoutTransition`, `layoutId` | animate size and position changes; shared-geometry identity |
| `visibleWhen` | `windowed` / `fullscreen` only |
| `windowDrag` | this region drags the native window |

### Layout and containers

| Node | Use |
|---|---|
| `row`, `column` | flex layout. Optional `backgroundImage`, virtualised `itemHeight`. |
| `scroll` | scrollable area |
| `split` | resizable panes (`horizontal`/`vertical`, `sizes`) |
| `tabs` | tab header + content |
| `tabStrip` | editor-style tab strip (closable, draggable tabs) |
| `transcript` | chat-style scroller: bottom anchoring, "load older", follow key |
| `slot` | **embed another module's render** (`module: "id"`). Doesn't share capabilities. |
| `floating` | absolutely placed movable box (`x`,`y`,`width`,`height`,`moveAction`) |
| `window` | separate native window (`titlebar:false` for custom chrome) |
| `titleBar` | custom window title bar row |
| `modal` | blocking dialog card |
| `popover` | anchored popup content |
| `dropdown` | button + menu (`open`, `action`, `children` are the menu) |
| `divider`, `spacer` | separators, flexible space |

### Text and display

| Node | Use |
|---|---|
| `label` | text: `size`, `weight`, `color`, `mono`, `wrap`, `selectable` |
| `markdown` | rendered Markdown from `text` or a document handle; `linkAction` for custom links |
| `icon` | inline SVG (`svg`, `size`, `color`). Icons are module data, not native assets. |
| `image` | an image attachment |
| `status` | inline info/warn/error/success message |
| `progress` | bar, determinate or `indeterminate` |
| `meter` | segmented meter (usage bars) |
| `ring` | circular gauge |
| `spinner` | activity spinner |

### Input and controls

| Node | Use | Fires |
|---|---|---|
| `button` | text and/or `iconSvg`, `variant`, `badge`, `small` | `action` (+ `value`) |
| `textInput` | single or `multiline`, `secret`, `placeholder`, image paste | `submitAction`, `changeAction`, `cancelAction`, `pasteImageAction` |
| `select` | dropdown list of options | `action` with chosen value |
| `choice` | selectable row (radio/check-like) | `action` |
| `switch`, `toggle` | boolean | `action` with `true`/`false` |
| `slider` | numeric range | `action`, `changeAction` |
| `colorPicker` | color + swatches | `action` |
| `imagePicker` | file dialog for images | `action` |
| `tree` | virtualised rows with expand, select, activate and hover (file trees, lists) | `selectAction`, `expandAction`, `activateAction`, `hoverAction` |
| `dragHandle` | drag source carrying `payload` | `clickAction` |
| `dropZone` | drop target with regions (left/right/top/bottom/center) | `action` |
| `canvas` | free-form items + edges on a grid (graphs, workflows) | item and edge actions |

Text from every `textInput` in your tree arrives in `event.inputs[key]` with **every** event,
so you rarely need change handlers.

### Rich, native-backed views (they take a handle)

| Node | Use | Backed by |
|---|---|---|
| `codeViewer` | source editor/viewer: highlighting, editable, LSP definition hooks | document handle (`ui.documentOpen`) |
| `diff` | split/unified diff | document handle |
| `terminal` | interactive terminal | PTY handle (`pty.open`) |
| `surface` | pixel surface you draw frames into (pointer, wheel, key, resize actions) | surface handle (`ui.surfaceOpen`) |

### Shell and system nodes (normally used by shell modules only)

| Node | Use |
|---|---|
| `theme` | palette (light/dark), mode, typography, terminal colors, motion, table density. Emitted by `workspace-layout`. |
| `approvalPanel`, `securityPreferences` | **trusted native** approval and security UI. Modules place them but can't fake or alter them. |

### Events

Every interactive node names an `action` string. When it fires, your `onEvent(ctx, e)` gets:

```ts
{ action: string; key: string; rowKey?: string; value?: Json; inputs: Record<string, string> }
```

Update your state, call services, then `ctx.ui.invalidate()`.

### Styling (`UiStyle`)

Colors can be `#rrggbb[aa]`, a theme palette token, or a semantic name (`background`, `text`,
`muted`, `raised`, `panel`, `border`, `primary`, `primaryText`, `selection`, `hover`,
`danger`, `warning`, `success`, `info`, `transparent`). **Prefer tokens** so light/dark and
theme switches just work.

| Group | Fields |
|---|---|
| Color | `background`, `color`, `borderColor`, `gradient`, `opacity` |
| Border and shape | `borderWidth`, `borderTop/Bottom/Left/Right`, `radius`, `shadow` preset, `shadows[]` (glows, inset) |
| Spacing and size | `padding`, `paddingX/Y`, `gap`, `width`, `height`, `minHeight`, `maxWidth`, `fullWidth`, `noShrink`, `wrap` |
| Type | `font` (`ui`/`mono`), `fontSize`, `fontWeight`, `lineHeight`, `italic`, `letterSpacing` |
| Position | `position: absolute` + `top/right/bottom/left`, `justify`, `clip`, `rotate` (icons) |

There are no named style presets in the renderer. Share styles as TS data. Look at
`sdk/chat-style.ts` and `sdk/halo-rail.ts` for real examples.

### SDK composition helpers (bundled TS, not native)

| Helper | Gives you |
|---|---|
| `sdk/halo-rail.ts`, `sdk/activity-sidebar.ts` | the rails ([chapter 3](03-rails.md)) |
| `sdk/ui-icons.ts`, `sdk/sidebar-icons.ts`, `sdk/file-icons.ts` | SVG icon sets |
| `sdk/chat-style.ts`, `sdk/chat-transcript.ts` | chat bubbles and transcript composition |
| `sdk/usage-meter.ts`, `sdk/context-usage.ts` | usage meters |
| `sdk/settings.ts` | Settings sections ([chapter 7](07-settings-and-state.md)) |
| `sdk/file-watch.ts` | watch + retry + workspace switching |

---

## Part 2: Host APIs (`ctx.host`)

Every call goes through the kernel's broker. It checks your **capabilities**, handle ownership
and scope. File, process and PTY work first needs a **scoped grant**:

```ts
// root is absolute on the target machine; add `target` for SSH, `write: true` to write.
const { grant } = await ctx.host.capabilities.request({ kind: "fs", root, purpose: "Read notes folder" });
const file = await ctx.host.fs.read(grant, "notes.md");   // → { text?, base64?, binary, size, truncated }
// … later: await ctx.host.capabilities.release(grant);
```

| Namespace | Methods | Typical capability |
|---|---|---|
| `env` | `info` (platform, paths) | none |
| `capabilities` | `request`, `release` (scoped grants for fs, process, PTY) | `fs.scope` / `process.scope` / `pty.scope` |
| `fs` | `read`, `writeAtomic`, `list`, `stat`, `realpath`, `mkdir`, `watch`, `importFile`, `exportFile` | `fs.scope` |
| `process` | `spawn`, `run`, `write`, `closeStdin`, `terminate`, `wait`, `info` | `process.scope` |
| `pty` | `open`, `write`, `resize`, `read`, `close`, `info` | `pty.scope` |
| `streams` | `listen`, `subscribe`, `unsubscribe` (stdout/stderr/exit of processes, PTYs, watchers) | owner of the handle |
| `resources` | `retainForWorkspace`, `lookup`, `info`, `release` (survive reloads, named reuse) | owner of the handle |
| `db` | `openNamespace`, `exec`, `transaction` | `db:<name>` |
| `net` | `fetch`, `websocket`, `listenLoopback`, `write`, `close` | `net.fetch`, `net.websocket`, `net.loopback` |
| `ssh` | `connect`, `disconnect`, `status`, `forwardLoopback`, `localForward`, `cancelForward`, `wslDistributions` | `ssh.connect` (+ forward caps) |
| `daemon` | `ensure`, `status`, remote program/terminal ops | `remote.daemon` |
| `ui` | `invalidate`, `documentOpen`, `pickFolder`, `openUrl`, `toast`, `surfaceOpen/Frame/Cursor/Clear` | `ui.document`, `ui.pickFolder`, `ui.openUrl`… |
| `approvals` | `request` (trusted per-operation approval) | `approvals.request` |
| `plugins` | `list`, `providers`, `dependents`; `install`, `enable`, `disable`, `uninstall`, `rescan`, `setRoot`… | listing: none; management: `plugins.manage` |
| `modules` | `list`, `describe`, `logs`, `stageArtifact`, `activate`, `rollback`, `discard`, `sourceInfo` | `modules.read` / `modules.admin` |
| `cloud` | account, device, share and SSH enrolment ops | `cloud.account`, `cloud.events` |

The capability column is a guide. Exact names are in `kernel/src/ops.rs` and
`kernel/src/grants.rs`. Real manifests are the best examples.

### Runtime facts

- No Node, no DOM. `fetch`, `fs` and `child_process` don't exist, so use `ctx.host`.
- Over SSH, the same APIs run against the remote machine when given an SSH target. The kernel
  routes them, and you don't write separate remote code.
- Handles are owned by your **module id**, so they survive hot reloads. Release them when done.

---

## When a primitive is missing

1. First try composing it: rows, columns, `canvas`, `surface`, SVG `icon`, `style`.
2. If it really needs native support (a new control, OS adapter or host op), add the
   **smallest reusable** primitive: its contract in `sdk/types.ts`, its handling in
   `kernel/src/ui/` or `kernel/src/ops.rs` + `host/`. Keep all feature decisions in TS.
3. That requires a **Rust rebuild and app restart**. Everything that only uses existing
   primitives doesn't.
