# Handover: plugin platform + remote runtime rework

The goal (from the user): everything in Hato is an enable/disable-able plugin. The core handles
plugin loading, reloading and interaction. The core can also install a "Tier 2" daemon on SSH hosts
and talk to it, so terminals, agent processes and plugins keep running while the desktop is offline.
Users must be able to remake layouts, panels, AI/chat UIs, watchers and runners as plugins.

Nothing is committed. The working tree also holds the user's own earlier uncommitted work (git
panel, links, layout changes). Don't revert those.

## Status by phase

| Phase | Status |
|---|---|
| 1. Plugin lifecycle in core | **Done, verified** |
| 2. Generic renderer (no app UI in Rust) | **Done, tests pass; GUI not visually checked** |
| 3. `hatod` remote runtime | **Done, verified over real SSH**; follow-ups listed below |
| 4. Settings scopes + revisions + sync | **Done**: built and tested; optional preference migration deferred |

---

## Phase 1: plugins (done)

- `kernel/src/plugins.rs`: `PluginRegistry`. It stores enabled state and an optional root override
  in `<data>/plugins.json`. Built-ins are enabled by default; user plugins start disabled. It also
  covers manifest reading, the user seed (`dist/<id>.mjs`) and folder copy.
- `grants.rs`: manifest schema v2 adds `name`, `provides`, `requires`, `calls`, `runsOn`
  (ui|workspace|either) and `contributes` (free-form, forwarded to modules without interpretation).
  `escalation()` now also reports `call:<id>`. User plugins get capabilities and calls only through
  approvals (`approved-grants.json`). `forget()` and `is_first_party()` were added.
- `kernel.rs`:
  - `discover_all()` reads built-ins from `modules/` plus user plugins from `<data>/plugins/<id>/`.
  - Boot was refactored into `register_discovered` + `load_plugin`.
  - New: `enable_plugin`, `disable_plugin` (cascades transitively over dependencies and over
    `requires` contracts whose only provider is going away), `unload_plugin` (releases owned
    handles), `install_plugin`, `uninstall_plugin`, `rescan_plugins`, `plugins_json`, `providers`,
    `root_module()`.
  - The root module is the provider of the `shell.root` contract, not the hardcoded
    `workspace-layout`.
- Ops: `plugins.list/providers/dependents` (open to all modules) and
  `plugins.enable/disable/setRoot/install/uninstall/rescan` (need the `plugins.manage` capability).
  Prelude: `ctx.host.plugins.*`. SDK types: `PluginInfo`, `NativeHost.plugins`.
- Shell: disabled slots render empty. Safe mode can re-enable plugins that need no new approvals.
- TS:
  - `sdk/plugins.ts` collects contributions: panels (with `activity` sidebar buttons), sidebars,
    overlays.
  - `sdk/activity-sidebar.ts` is the generic sidebar.
  - The layout model's `PANELS` is now filled by `setPanels()` from contributions, and
    `defaultLayout()` is built from each panel's `dock`.
  - Built-in manifests now carry `contributes`.
  - Settings has a "Plugins" page: toggle, install from folder, rescan, uninstall, window root,
    cascade confirmation.
- Fixed a git-panel bug: activation crashed with no workspace and no previous state.

## Phase 2: generic renderer (done)

- `kernel/src/ui/style.rs`: generic `style` (colors are tokens or `#hex`, plus borders per side,
  padding, size, font, justify, shadow, `position: relative`, …). `theme.rs` adds `color()`,
  `terminal_palette()`, `chrome()`. The theme node now accepts `mode`, `terminal` and
  `chrome.toasts`.
- Removed from Rust: `chat_style.rs`, `file_icons.rs`, all `surface` presets, icon names,
  `usageMeter`, `appearanceControl`, `fileList`, `chatTranscript` and tree `appearance`.
- Added: a generic `transcript` node (children are module nodes; keeps native scroll anchoring),
  inline `markdown` (`text`, `inline`), `label.selectable`, `button.copyText`, a configurable
  `imagePicker` with native limit ceilings, `textInput.prefixSvg`, `select.buttonStyle`, tree
  geometry (`rowHeight`, `indent`, `iconSize`, row `weight`), popover/modal geometry.
- TS: `sdk/ui-icons.ts`, `sdk/chat-style.ts`, `sdk/chat-transcript.ts`, and `usagePieSvg` in
  `sdk/context-usage.ts`. All modules were converted. The appearance mode moved to a
  `workspace-layout` setting, stored as `appearance.mode`.
- **Not done:** a visual check of the GUI. Screen capture permission was missing, so the app only
  booted with no render errors. Ask the user to look at the chat panel, the trees and the sidebars.

## Phase 3: remote runtime (done)

- `Cargo.toml`: feature `gui` (default). The headless daemon builds with `--no-default-features`.
  `log` needs the `std` feature.
- `kernel/src/daemon/`:
  - `mod.rs`: frames, CLI, `home_dir`.
  - `server.rs`: PTY and process holders, a headless kernel for pushed plugins, a Unix socket in
    `<dir>/run`, a peer-uid check, idle exit, and acknowledged process output (`F_ACK`), so output
    is never lost when a viewer dies.
  - `client.rs`: `ensure` (setsid; replaces the daemon on a different binary unless it holds
    resources, in which case it reports `stale`), `ctl`, `pty-attach` (raw mode + resize),
    `proc-attach`, `bridge` (stdin lines go to a plugin method).
- `kernel/src/host/daemon_link.rs`, the desktop side:
  - `ensure_ssh` runs `uname`, picks a binary (this exe, or `target/<triple>/release/hato`, or
    `<data>/daemon/<os>-<arch>/hato`), streams the upload to `~/.hato/bin/hato-<ver>-<sha>`, then
    runs `ensure`.
  - Also `ensure_local`, `request`, and per-module key scoping.
  - Env `HATO_REMOTE_DAEMON_DIR` relocates the remote daemon home (used by tests).
- Ops: `daemon.ensure/status/request` (capability `remote.daemon`; `remote.daemon.admin` sees every
  module's resources). `plugins.push` only pushes plugins that are installed **and approved**
  locally. `pty.open` and `process.spawn` accept `persist: {key}`.
- Modules:
  - The terminals service keeps SSH shells in the daemon by default and local shells optionally;
    both are settings.
  - New `remote-runtime` service: auto-starts the daemon on SSH workspace selection and auto-pushes
    `runsOn: "workspace"` plugins.
  - New `remote-panel` UI module: "Remote runtime" panel, hidden by default, with a right-sidebar
    button.
- `tools/build-hatod.sh` handles Linux cross builds via cargo-zigbuild. Zig and cargo-zigbuild
  are installed. On 2026-11-03, `tools/build-hatod.sh x86_64-unknown-linux-musl` succeeded,
  producing `target/x86_64-unknown-linux-musl/release/hato` (5,812,040 bytes, rebuilt with filesystem notifications). `file` and
  `llvm-readelf` confirm a stripped, statically linked x86-64 ELF with no dynamic loader or
  shared-library dependencies. It has not been run on Linux; runtime SSH tests remain macOS →
  macOS. ARM64 Linux has not been built.

### Phase 3 follow-ups (not done)

1. **ACP agents persisting across disconnects.** The `persist` primitive exists. The acp module
   still has to spawn with `persist: {key: "acp/<conversationId>"}` and handle the ACP
   re-handshake on reattach. Make it opt-in.
2. **Offline MCP for remote agents.** Run internal-mcp (or a tool plugin) on the daemon, and point
   the agent's MCP config at `hato daemon bridge --plugin X --method Y`. Nothing is wired yet.
3. **Upgrading a daemon that holds live resources.** It's kept as `stale` for now. The planned
   design is a shim process per resource (like containerd-shim).
4. **Approvals on the daemon.** They're auto-denied today, because nothing on the server can show
   them. Pre-approved, scoped grants were planned.
5. The `persist` key on `process.run` is ignored, which is intentional. Process `closeStdin` while
   attached just detaches; use `daemon.request proc.closeStdin`.

## Phase 4: settings scopes (done)

- Migration `003_scoped_settings.sql` and persistence methods `scoped.get/set/list/resolve`
  support user, machine and workspace scopes. Writes are serialized so concurrent compare-and-set
  requests cannot both succeed. Revisions must be safe integers; stale `expectedRev` fails with
  `ECONFLICT:`. Sync can supply a newer explicit revision.
- `sdk/scoped-settings.ts` supplies `scopesFor(ws)`, `get`, `set` and `syncScope`.
  Resolution order is workspace → machine → user; explicit null remains an override.
- `remote-runtime` pushes persistence and reconciles the SSH machine scope on ensure and after
  local `persistence.settingChanged` events. The explicit `sync {workspaceId}` method fetches
  remote changes too. Sync is serialized per machine and uses compare-and-set on destinations.
- Higher revisions win. Equal-revision divergent values retain the desktop value, advance its
  revision on both peers, and report conflicting keys in runtime status. JSON object property
  ordering does not create conflicts. Remote changes are fetched on ensure/explicit sync, not
  continuously polled. Failures are retryable through those same methods.
- Existing module preferences remain on `settings.get/set`; migration was optional and is deferred.
  No scoped delete API is implemented.
- Added five SDK tests, four settings integration checks and three real-SSH sync checks.
  Updated the migration test for schema v3 and made daemon isolation checks use the configured
  test directory instead of a hardcoded name.
- Added [plugin authoring and runtime documentation](docs/PLUGINS.md), linked from README.

### Verification and activation (2026-11-03)

- `npm test`: typecheck and **78/78** TypeScript tests pass.
- `npm run modules:build`: all bundles built; persistence and remote-runtime changed.
- Settings headless integration: **15/15** pass. The sandbox blocked internal-mcp's listener,
  which is unrelated to these settings checks.
- Real SSH daemon integration: **25/25** pass, including both sync directions and stale-revision rejection.
- No Rust changes were needed for phase 4; native checks from earlier phases were not repeated.
- Bundles were exercised in isolated headless test instances. They have **not been activated in
  the user's running desktop**. Hot reload persistence and remote-runtime to use this phase's
  changes; no additional Rust rebuild or restart is needed for phase 4.
- Phase 3 follow-ups and GUI visual verification remain as listed above.

## How to build and verify

```sh
cargo build && cargo test                 # Rust (27 lib + arch gate). Also: cargo check --no-default-features
npm run typecheck && node --test tests/ts/   # 78 TS tests, all passing
npm run modules:build

# headless integration suites (all passing at handover):
tests/integration/run-integration.sh tests/integration/plugins.js /tmp/x1      # 31/31
tests/integration/run-integration.sh tests/integration/settings.js /tmp/x2     # 15/15
HATO_T_PHASE=1 tests/integration/run-integration.sh tests/integration/layout.js /tmp/x3   # 18; then PHASE=2 same dir: 3

# daemon over real SSH (25 checks): start the throwaway sshd from docs/TESTING.md on :2222 first
D=/tmp/hato-sshd; : > $D/kh_test
export HATO_SSH_KNOWN_HOSTS=$D/kh_test HATO_T_SSH_USER=$USER HATO_T_SSH_KEY=$D/client_key \
  HATO_T_REMOTE_REPO=<abs path of a git repo> HATO_REMOTE_DAEMON_DIR=/tmp/hato-daemon-test HATO_T_BUILD=$PWD/build/modules
tests/integration/run-integration.sh tests/integration/daemon.js /tmp/hato-it-daemon
pkill -f "daemon serve --dir /tmp/hato-daemon"   # test daemons hold shells and won't idle-exit
```

## Known test issues (all pre-existing)

- `m1-runtime.js` doesn't parse: it redefines `results` and `check` from `lib.js`.
- `m5m7-ssh.js`: all terminal and SSH checks pass. It fails at `COUNT=16`, which is hardcoded while
  there are now 21+ modules, and at live-agent patch/rollback steps that need a logged-in Claude.

## Gotchas

- `grants/first-party.json` is compiled into the binary. Rebuild Rust after editing it. New
  built-in modules need an entry there.
- Changes to the kernel or prelude need `cargo build` and an app restart. Module changes need
  `npm run modules:build`, then hot activation or a restart.
- `kernel/tests/arch_gate.rs` forbids domain words in Rust: no `jsonrpc`, `tools/call`, `codex`,
  `claude`, `worktree`, …
- Driver (headless test) capabilities are set in `kernel/src/headless.rs`. Plugin test ops:
  `test.pluginEnable/Disable/Root/Rescan/Install/Uninstall`.

## Files and Git watchers (2026-11-03)

- Added scoped `fs.watch` and `hato daemon watch`, backed by notify/FSEvents/inotify. The same
  notification helper runs over SSH; no remote watcher utility dependency is required.
- Files invalidates search/document caches and emits debounced workspace events. Explorer reloads
  its listings/search while retaining expansion and query. Git watches private/shared repository
  metadata separately, including linked checkouts, and consumes Files events for tree edits.
- Git panel uses events instead of interval polling; an automatic refresh toggle preserves the
  previous Off preference. Events during an in-flight status request trigger a follow-up refresh.
- Verified: 81 TS tests, 27 Rust library tests plus 2 architecture checks, 9 local watcher
  integration checks, 27 SSH daemon checks. SSH runtime verification used the macOS test host.
- Built desktop debug binary, all modules and the static x86-64 Linux daemon. Linux execution
  remains unverified. No changes activated in the running desktop: restart is required for the
  new native primitive, prelude API and compiled first-party grants.

## Independent background agents and split MCP (2026-11-03)

- New modules: agent-runner (daemon-owned ACP/history), persistent-agents (desktop gateway),
  agents-panel (separate UI), internal-local-mcp (desktop facade), internal-remote-mcp (workspace
  agent/terminal/skill tools, daemon-hosted or standalone locally). Existing chatbox remains on
  its existing controller and conversation tables.
- Added generic daemon pty.read/write operations; brokered calls keep owner-prefixed keys.
- Agent selections include provider, negotiated model, agent instructions, MCP servers and skills.
  Provider-native tools retain provider permissions; instruction selection is not an OS sandbox.
- History and queued steering live in the runner SQLite namespace. Desktop exit does not stop
  accepted turns. Daemon restart marks interruption and requires provider-supported session/load.
  Permissions wait for trusted desktop review. Child agents inherit the parent's configuration.
- Desktop, modules and static x86-64 Linux daemon built. Changes are not activated in the user's
  running desktop. Native APIs and first-party bounds require restart; older live daemons may
  need separate maintenance. Never force-replace a runtime holding agents to update its bundle.
- See docs/PERSISTENT_AGENTS.md and the skill's service-flows reference for source wiring and tests.

Verification for this addition: 84 TypeScript tests; 27 Rust library tests and 2 architecture/grant
checks; 12 local background-session checks, 12 real-SSH background-session checks, and 12 workspace
MCP checks. ACP behavior uses the deterministic test provider, not paid/live provider requests.
Both local and SSH tests verify a turn finishing between separate desktop process runs.

### Background agent UI refinement

Agents now use a Projects-style searchable tree. Selecting/creating a row opens the existing AI
chatbox bound to that background session; the list no longer embeds its own transcript/composer.
The normal and background services remain independent. Module-owned events provide the narrow
chat adapter and layout reveal action, so this refinement needs no native rebuild or restart.
Verified 85 TS tests plus 6 headless integration checks for list, selection, panel reveal, prompt
routing and returning to regular chats without stopping the agent. Modules built, not activated.
