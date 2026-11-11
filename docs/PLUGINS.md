# Plugins

Hato services and UI panels are TypeScript plugins. The kernel provides native controls,
resource handles, capability checks, approvals and module lifecycle. Application policy belongs
in modules. Start with an existing module's `manifest.json` and `src/index.ts`; SDK contracts
are in `sdk/types.ts`.

## Manifest v2

```json
{
  "schemaVersion": 2,
  "id": "example",
  "name": "Example",
  "kind": "service",
  "entry": "src/index.ts",
  "moduleApiVersion": 1,
  "dependencies": ["persistence"],
  "capabilities": [],
  "provides": ["example.service"],
  "requires": [],
  "calls": [],
  "runsOn": "either",
  "stateVersion": 1
}
```

`dependencies` names plugins; `requires` names contracts supplied through `provides`.
`calls` declares additional module-call permissions. `runsOn` is `ui`, `workspace`, or
`either`; the remote-runtime service automatically pushes enabled workspace service plugins.
`contributes` is module-interpreted data. See `sdk/plugins.ts` for panel, sidebar and overlay
schemas, and built-in UI manifests for examples. Panels describe their title, dock and activity
button. Settings → Side panels lets the user hide or place each button at left top, left bottom,
right top or right bottom; choices override plugin defaults and persist in `activity-sidebar.v1`.
Settings → Sidebar order & spacers supports reordering each sidebar group and inserting/removing
fixed-height gaps; choices persist in `sidebar-order.v1`. Settings supports a reusable `order`
field (JSON array of allowed item IDs plus optional spacer IDs), validated before owner edits.
The searchable, grouped settings UI renders table-layout sections with module-supplied controls.
Tables & lists configures density, alternating backgrounds and dividers; Bars & panel controls
exposes sidebar/bar/header visibility. Table choices persist in `ui-tables.v1` and are passed to
the native renderer as generic `theme.controls` data, with explicit panel row sizes taking priority.

Settings → Panel sharing assigns panels to shared spaces (`panel-sharing.v1`): opening a member
replaces the visible member in its existing dock slot or window geometry, preserving module state
and kernel resources. Source-file selection reveals Source viewer if another panel occupies its
shared space. Independent panels keep their separate placement.

A provider of `shell.root` supplies the window composition; Settings can select an override.

## Lifecycle and permissions

Settings → Plugins supports folder installation, rescan, enable/disable, removal and root
selection. Built-ins start enabled; installed user plugins start disabled. User capabilities and
calls require trusted approval. Disabling a provider cascades to dependent plugins when their
requirements can no longer be met. Unloading releases module-owned handles.

`ctx.host.plugins` exposes listing, contract providers and management. Management requires
`plugins.manage`; enabling a plugin does not bypass approval. Remote push accepts only locally
installed, approved plugins. Capability enforcement remains in the kernel.

Run `npm run typecheck`, `node --test tests/ts/`, and `npm run modules:build` after edits.
A build creates bundles; activate them through module tools to change a running app. Shared SDK
helpers are bundled into consumers, so rebuild and reload each affected consumer. Kernel and
prelude edits require a native rebuild and restart. Preserve workspace state and kernel resources
through module reloads.

## Remote daemon and persistent resources

`ctx.host.daemon.ensure(target)` installs/starts a daemon, `status(target)` checks it and
`request(target, op, args)` invokes an allowed operation. These APIs require `remote.daemon`;
`remote.daemon.admin` permits inspecting resources across modules. Targets are local or SSH
connections. See the `DaemonTarget` and `NativeHost` types in `sdk/types.ts`.

Requests include `hello`, `resources.list`, `pty.kill`, `proc.kill`, `proc.closeStdin`,
`plugins.list/push/enable/disable` and `modules.call {target, method, args}`.
Resource keys are scoped to their owning plugin. `pty.open` and `process.spawn` accept
`persist: {key: "stable-resource-id"}`; reconnect with the same key to reattach. Closing the
viewer detaches it. Persistent `process.run` is not supported. Terminal settings control
persistence for local and SSH shells.

The daemon retains PTYs, processes and pushed plugins when the desktop disconnects. The
`hato daemon bridge --plugin ID --method METHOD` CLI forwards stdin lines to a plugin method.
ACP re-handshake, offline agent MCP wiring and live-resource daemon upgrades remain follow-ups.
Daemon approval requests are currently denied; approve required permissions before pushing.
Linux daemon builds use `tools/build-hatod.sh`; cross-platform operation needs separate validation.

## Scoped settings

`sdk/scoped-settings.ts` exports `scopesFor`, `get`, and `set`. Resolution checks workspace,
machine, then user. Persistence methods `scoped.get/list/resolve/set` expose values and revisions.
Use `expectedRev: 0` for create-only writes, or the read revision for updates; stale writes fail
with `ECONFLICT:`. Values can be JSON null, which counts as an explicit override. There is no
scoped delete API. Existing `settings.get/set` preferences remain compatible and are not migrated.

On SSH daemon ensure, remote-runtime pushes persistence and syncs `machine:<machineId>`.
It also syncs after local machine-setting changes. Explicit `remote-runtime.sync {workspaceId}`
fetches remote changes; remote edits are not continuously polled. Higher revisions win.
Equal revisions with different values retain the desktop value, advance the revision and report
the conflicting keys in runtime status. Compare-and-set protects edits made during sync;
a failed sync can be retried by ensuring or explicitly syncing the runtime.

## UI and styles

UI plugins return generic nodes defined in `sdk/types.ts`. Compose panels using slots and pass
layout, SVGs, geometry and style as data. `style` supports theme tokens or hex colors, padding,
size, typography, justification, borders, positioning and shadows. A `theme` node selects mode,
terminal palette and chrome. Use built-in UI modules for complete examples.

Native `window` nodes accept `titlebar: false`; a dedicated row with `windowDrag: true` supplies
a drag handle without native titlebar chrome. Keep close/move controls in the UI module.

`sdk/ui-icons.ts`, `sdk/chat-style.ts`, `sdk/chat-transcript.ts` and `sdk/activity-sidebar.ts`
provide reusable TypeScript presentation helpers. The native `transcript` node handles scrolling;
its children supply content. Tree nodes accept row height, indent and icon size. Markdown,
selectable labels, copy buttons and configurable image pickers are native primitives. Feature
names, layouts, icon choices and policies belong in plugins.

## Filesystem notifications

`ctx.host.fs.watch(grant, path, {recursive: true})` starts a scoped OS notification stream.
The default is recursive. The broker checks grant ownership, type, liveness and canonical path
containment; recursive watches do not follow symlinks. The returned `{handle}` is a process
resource. Listen through `ctx.host.streams.listen(handle, {channel: "stdout"}, ...)`;
stdout contains `ready` followed by `changed` lines. Chunks may coalesce lines. Notifications
invalidate cached state; they are not a complete file operation log. `resources.release(handle)`
stops the watcher. SSH requires `remote.daemon` and uploads the matching helper binary.
It uses native OS notifications remotely, without requiring inotifywait or Python on the host.

`sdk/file-watch.ts` manages subscription cleanup, workspace switches and retries after stream
failure. Modules choose debounce timing and which caches/views to refresh. Files publishes
`files.changed {workspaceId}`; Git publishes `git.changed {workspaceId}` for file changes and
repository metadata notifications, including metadata outside linked checkouts. The Git panel
uses those events while visible. Its Automatic refresh setting replaces the polling interval;
previously disabled automatic refresh stays disabled. Manual refresh remains available.

Independent background agents and the desktop/workspace MCP split are documented in
[PERSISTENT_AGENTS.md](PERSISTENT_AGENTS.md).

## Self-configuration and saved builds

For packaged launches, the macOS app supplies the native executable, compiler, remote binaries and
initial module seeds. Its launcher creates an editable runtime under
`~/Library/Application Support/Hato/runtimes/<release>/`. A development launch can use a checkout
instead. `module-dev.describe.runtime` reports the actual source, compiler and data locations;
never assume the current workspace checkout is the running app's editable tree.

The Modules panel shows runtime paths and a per-module saved-build selector. Bundled is the imported
seed recorded by the kernel (`seedVersion`); for a user plugin, the baseline is labeled Installed.
Updated is the latest custom build that successfully activated. Staged and failed builds are excluded.
Switching uses the existing native-approved rollback/activation protocol without compiling or erasing
sources. Saved custom artifacts remain available when switching back to the baseline. The layout
module stays updated to keep the selector available. In development, the baseline is the imported
seed, not a separately installed release. Older kernels use seed-origin history as a fallback.

Selections persist in the artifact registry while the supplied seed is unchanged. A new seed can
replace the baseline on startup. A module build number is not an app-release number; local source
changes may remain after switching an active artifact. Native changes require a rebuilt app/relaunch.
Keep workspace-daemon upgrades separate and preserve live agents/workflows.

The internal MCP server advertises `skills_get self-configure` plus focused inspect, patch, build,
activate/verify and rollback guides. These Markdown guides are bundled into internal-mcp; rebuild
and activate that module after editing them. Reconnect MCP clients if their advertised instructions
are cached. Updating internal-mcp over its own MCP connection cannot activate mid-call: stage it,
then activate from the Modules panel once the call ends. Its in-flight guard stays in place.
Source patch tools edit existing modules only. To add a new plugin, prepare a manifest
and runnable JavaScript bundle, install its folder through Settings → Plugins, then enable it and
approve its permissions. Installation does not run npm or compile TypeScript automatically.

## Language packages and editor providers

Language registrations are `contributes.languages` data, discovered from enabled/active plugins.
See `sdk/languages.ts` and [the language package guide](../Hato-plugins/LANGUAGES.md) for the contract,
server prerequisites, SAP file coverage and SSH routing. The viewer consumes contributions even
without the optional language-service plugin, so syntax-only packages need no process capability.

`codeViewer` accepts a grammar override, ordered `syntaxRules`, one-shot UTF-16 `reveal` positions,
and a `definitionMethod` on its owning UI module. Native definition requests invoke only that owner;
its ordinary module-call permissions control any downstream language-service call. The optional
`openLocationAction` handles activated LSP locations in TypeScript. Server protocols, language
selection, URI/workspace mapping, and navigation policy stay outside the native renderer.

Settings fields may use `type: "text"`; their text input submits on Enter. Consumers should read
submitted text from the event's `inputs[key]`, since native text-input submission has a null value.

A manifest may declare `distribution: "marketplace"` to exclude its source folder from built-in
runtime discovery, including in development checkouts. Builders still compile/export it. Installing
its versioned artifact creates a normal user plugin, initially disabled, with the usual native
permission approval during installation or enablement. The language packages use this setting and have no install-time
system grant. An omitted distribution preserves existing built-in discovery behavior.

Artifact reuse includes the manifest as well as JavaScript bytes. Seed records track
`seedManifestHash` separately from `seedHash`, so changing calls/capabilities with unchanged code
imports the correct manifest. Older registries migrate from their stored seed manifest without
replacing an active custom build when the seed is unchanged. Stored rollback artifacts remain immutable.

Settings contributions can declare `type: "action"` fields with `buttonLabel`, `disabled`, and
`description`. Settings validates the active field before emitting `settings.action {module, section,
key}`; `exportSettings(..., {action})` validates it again and delegates to the owning module.
Owners publish progress/disabled state, errors and completion through their settings export.
Language providers may supply `server.dependencySetup` recipes; language-service owns target-side
checks, verified user-space installs, and workspace-scoped executable configuration. These are
module-only workflows over existing process APIs, including SSH.
