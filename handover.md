> Current ACP status: see **Roadmap implementation and verification (2026-11-26)** at the end. Earlier sections are historical.

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

---

# ACP capability roadmap work-in-progress handover (2026-11-26)

## Stop point

The user asked to stop implementation and record the current state. **This is an incomplete,
testable worktree, not a finished roadmap.** No commits, pushes, pull requests, module activation, or
Rust changes were made.

The outer task worktree did not contain the ignored nested `Hato-plugins/` repository. A detached
nested worktree was created at:

```text
Hato-plugins/  -> parent Hato-plugins HEAD 30c7d5a75b25fca9eb7aedcd0814fbd64feca5f8
```

The parent repositories were left untouched. The outer Git status and nested Git status must be
checked separately.

## Implemented before the stop

### Phase 1 — protocol correctness

- Desktop and background clients advertise `session.configOptions.boolean`.
- Boolean `session/set_config_option` requests send `type: "boolean"`.
- ACP usage cost is parsed and retained as `{ amount, currency }`; the context tooltip shows it.
- `additionalDirectories` is sent only when the agent advertises
  `sessionCapabilities.additionalDirectories`; otherwise Hato returns an explicit unsupported error.
- `session/list` no longer sends the non-standard `limit` field.
- Desktop replay is staged and deduplicated by provider session/message ID with a content fallback.
  Anonymous replay chunks preserve role transitions. Background `session/load` replay is suppressed
  against persisted local history.
- Background transcript persistence/projection keeps ACP `messageId` boundaries.
- `session.compaction` is no longer advertised.

### Phase 2 — authentication

- `ai-sessions` exposes `authenticate`, `authInput`, and `cancelAuth`.
- The AI panel renders advertised auth methods and a bounded authentication console.
- Standard `type: "terminal"` and legacy `_meta["terminal-auth"]` methods are recognized.
- The launch reproduces the configured provider invocation, appends method args, validates method
  `env`, hides env values in launch details, and supports output/input/cancel.
- Successful terminal or agent-driven authentication reconnects through `ai-sessions`.
- This is a **line-oriented process console, not a PTY emulator**. `auth.terminal` is currently
  advertised; see the unresolved PTY/honesty issue below.

### Phase 3 — provider sessions

- `ai-sessions` exposes provider list/new/resume/load/fork/close/delete methods.
- The AI panel has a Provider Sessions modal with opaque cursor paging and capability-gated actions.
- Reconnect prefers `session/resume`, falls back to `session/load`, and keeps Copilot on load.
- Provider-session changes retain Hato's local transcript.

### Phase 4 — system prompts

- `sdk/acp-protocol.ts` builds capability-gated `systemPrompt` append payloads.
- Desktop trusted progress instructions and background instruction/skill context use append mode when
  advertised. Dialogue handoff/model output stays in user messages.
- Background prompt text is redacted from public session projections.

### Phase 5 — slash commands

- `available_commands_update` feeds composer suggestions with descriptions/input hints.
- `/command args` is submitted unchanged as a normal `session/prompt`.

### Phase 6 — form elicitation

- A schema helper provides defaults, required fields, enums, primitive validation, multi-selects,
  malformed-schema rejection, safe-pattern restrictions, and accept/decline/cancel responses.
- The AI panel renders forms and routes responses through `ai-sessions` to ACP.
- `elicitation.form` is advertised after the first end-to-end implementation/tests.

### Phase 7 — background parity

- Background runner has boolean config, structured cost, resume-by-default/load fallback, Copilot load
  preference, systemPrompt append, replay suppression, and message-ID persistence/projection.
- Desktop-only auth/session-browser/slash/form UI was not cloned into the runner.

### Phase 8 — partial verification/docs

- Added/extended deterministic ACP, provider, replay, auth, session UI, slash, elicitation, usage,
  system-prompt, and background-runner tests.
- Updated `docs/COMPATIBILITY.md` with the captured 2026-11-25 adapter versions and verified behavior.
- Added `capability_matrix.md` with per-adapter advertisements, implemented state, and deferred work.

## Files changed

Outer repository:

```text
docs/COMPATIBILITY.md
capability_matrix.md                 # new
sdk/context-usage.ts
sdk/persistent-agents.ts
sdk/acp-protocol.ts                  # new
tests/ts/context-usage.test.mjs
tests/ts/chat-history.test.mjs
tests/ts/agent-runner-chat.test.mjs
tests/ts/agent-progress.test.mjs
tests/ts/ai.test.mjs
handover.md
```

Nested `Hato-plugins/` repository:

```text
modules/services/acp/src/index.ts
modules/services/agent-runner/src/index.ts
modules/services/ai-sessions/src/index.ts
modules/ui/ai/src/index.ts
modules/ui/ai/src/commands.ts         # new
modules/ui/ai/src/elicitation.ts      # new
tests/acp-protocol.test.mjs
tests/ai-commands.test.mjs            # new
tests/elicitation.test.mjs            # new
```

Generated `Hato-plugins/build/modules/*.mjs` files are ignored build output. Affected modules were
built with `npm run build -- acp ai-sessions ai agent-runner`; they were **not activated**.

## Verification completed at the last stable checkpoint

- `Hato-plugins`: `npm run typecheck` passed.
- Focused ACP/command/elicitation tests: **22/22 passed**.
- Focused root usage/replay/background/progress tests: **33/33 passed**.
- Focused AI UI tests for auth/provider sessions/slash/forms: **6/6 passed**.
- Full `Hato-plugins` `npm test`: **147/147 passed** in a clean physical temp copy. One additional ACP
  agent-driven-auth test was added afterward, so the full count must be rerun.
- Root `npm test`: typecheck passed; **283/314 passed, 31 failed** on existing/unrelated tests. Failures
  include old UI/workflow assertions and test helpers that use encoded `URL.pathname` under the
  space-containing worktree path.
- Running `Hato-plugins` tests directly in this space-containing path still hits the existing `%20`
  path problem in several test helpers. Use a clean physical temp copy (with sibling `sdk/` and
  `grants/`) for the full suite.
- No Rust checks were run because no Rust files changed.

**Important:** after the final review-driven edits began, TypeScript/tests were not rerun. The
worktree may temporarily fail typecheck/tests. In particular, UI tests still use old action names,
input keys, button value shapes, and `\r` auth input expectations.

## Review findings already addressed

- Structured cost and honest capability payloads.
- Session-scoped desktop provider message keys and anonymous replay ordering.
- Replay messages are closed after commit so late duplicate chunks are ignored.
- Background public sessions redact `systemPrompt`.
- Background transcript projection preserves distinct provider message IDs.
- Provider Sessions close/reopen loading invalidation and conversation-scoped list/delete state.
- Duplicate modal keys were renamed.
- Elicitation pattern-matching strings are now included in accepted content.
- Elicitation schema normalization, unsafe field rejection, safe regex subset, primitive enum checks,
  request-scoped form tokens/input keys, and auth secret/newline handling were added in the final
  in-progress edits.

## Unresolved high-priority issues

### Desktop replay/transcript

1. **Full-history replay longer than 80 messages is not fully reconciled.** `loadConversation()` caches
   only the newest page; replay dedup currently checks the cached page. A full provider replay can
   duplicate/reorder older persisted messages. Reconcile against a persistence-level full-history
   index and insert unmatched replay items relative to known anchors.
2. **Closed/deleted current provider sessions can leave `c.live` ready with `sessionClosed: true`.**
   `send()` can then skip reconnect and fail. Treat closed/no-session live state as disconnected or
   stop/reset the ACP connection after close/delete. Set `__hatoHandoff` when a fresh session should
   receive prior local dialogue.
3. **Live `user_message_chunk` handling does not coalesce by `messageId`.**
4. **Hato-added marker/handoff prompt prefixes can defeat replay text fingerprints.** Persist the
   actual outgoing prompt body or a correlation digest with the local user row.
5. **Tool/plan boundaries reset and retire the current assistant message ID.** Later chunks with the
   same ID can be dropped. Separate pointer reset from message retirement.
6. **Tool IDs are not scoped by provider session.**
7. **Replay matched by provider ID does not consume its fingerprint occurrence**, and multiple plans
   are staged under one key.
8. **Failed `session/load` currently commits partial replay.** Emit success/failure with replay
   completion and discard staged replay on failure.

### ACP service concurrency/security

9. **Concurrent `start()` can spawn duplicate agents or return a half-started connection.** Add a
   per-conversation startup promise map and include it in swap guards.
10. **Lifecycle operations are not serialized with prompts/each other.** Add a per-connection operation
    lock/state and reject prompt/config/auth/lifecycle races.
11. **An old prompt response can finish a newer turn.** Capture turn identity and only finish the
    matching active turn; send `$/cancel_request` for timed-out requests where possible.
12. **Agent-supplied terminal-auth `env` is still too permissive.** Reject loader/startup/PATH/proxy/TLS
    lookup variables and prevent method env from reintroducing policy-removed credentials, or require
    a trusted pre-launch approval showing exact names/args.
13. **`auth.terminal` honesty/PTY issue:** the current console uses pipes, not a PTY. Existing PTY
    contracts open shells but do not launch arbitrary argv on local/SSH targets. Either add the
    smallest approved PTY launch primitive/grant (Rust + rebuild/restart), or temporarily remove
    `auth.terminal` and terminal methods from negotiation.
14. **Concurrent authentication can pass the pre-await `authProcess` check.** Add `authStarting` before
    the first await and include it in lifecycle/swap guards.
15. **Resume/load fallback treats every error as a missing session.** Only `-32002`/not-found should
    fall back to another method/new session; surface auth, invalid-params, timeout, internal, and
    transport errors.
16. Lifecycle IDs/response validation, additional-directory rollback, and idempotent close/delete
    not-found handling remain incomplete.
17. Current ACP content-block validation still needs alignment with the current schema (nested embedded
    `resource`, required image `data`, audio fields, resource-link `name`). Accepted elicitation
    `content: null`/omitted should be allowed.

### Background runner

18. `create()` still spreads caller runtime fields; allowlist `AgentSpec` and force internal fields
    (`contextSent:false`, `systemPrompt:null`, `systemPromptSent:false`, `sentDigests:undefined`).
19. `systemPromptSent` was added to the type but **not yet wired into logic**. `contextSent` currently
    doubles as dialogue history and system-prompt state; separate them before relying on handoff or
    resume-loss behavior.
20. Workspace-MCP/progress instruction changes can leave stale system instructions.
21. Background resume fallback also needs not-found-only error classification.
22. Hot-swap guard misses startup, locks, and pending writes; message identity comparisons should
    include provider session ID.

### AI panel

23. Final request-scoped form/auth/provider edits are unverified and tests need updating:
    - form actions now include `uiKey` and `fN`/`oN` tokens;
    - form text keys are `${uiKey}-fN`;
    - provider button values are `{conversationId, sessionId}`;
    - auth input sends `\n`, is secret, and rotates its key.
24. Native events still need origin tokens for all async actions (conversation/request/session/attempt),
    especially auth input and provider mutations.
25. `load()` is not latest-request-wins; add a load/selection generation and suppress stale errors.
26. Add UI `canSwap`/operation tracking and avoid clearing another operation's global `busy` marker.
27. Provider/auth/form state should be fully scoped and reset on desktop conversation changes.
28. Long provider/auth calls can exceed the native `onEvent` deadline; start tracked background work
    and return promptly, or otherwise keep handlers below the host timeout.
29. Normalize raw provider session/auth arrays at the ACP/UI boundary; filter malformed entries, cap
    pages, and detect repeated cursors/no-progress pagination.
30. Emit `acp.elicitationComplete` on timeout/cancel/stop/EOF so forms do not remain answerable locally
    after ACP has already settled them.

## Suggested next steps

1. Run `npm run typecheck` in both repositories and fix compile errors from the final in-progress UI
   edits. Update `tests/ts/ai.test.mjs` to drive rendered request-scoped controls instead of old
   hard-coded action/input keys.
2. Implement full-history replay reconciliation and closed-session reconnect/handoff behavior.
3. Add ACP startup/lifecycle/turn identity locks and not-found-only resume fallback.
4. Decide the terminal-auth PTY path; do not leave `auth.terminal` advertised if only pipes are
   supported.
5. Finish background trust/context-state/hot-swap fixes.
6. Complete UI origin scoping, latest-load-wins, operation tracking, and settlement cleanup.
7. Rerun focused tests, full `Hato-plugins` `npm test` in a clean physical copy, root tests, typechecks,
   and affected module builds. Update verification counts in `capability_matrix.md`.
8. Do not activate modules or rebuild Rust without the required user approval.


## Takeover checkpoint (2026-11-26)

Continued from the stopped ACP roadmap with a bounded correctness/security checkpoint. The roadmap
is **still incomplete**. Existing user work was preserved in both repositories. No commits, pushes,
module activation, or Rust changes were made. This section supersedes conflicting status above.

### Changes in this pass

- Fixed the in-progress form-schema type guard and nullable provider-delete rendering errors;
  both repository typechecks now pass.
- Updated form tests to use rendered request-specific controls, provider tests to use structured
  button values, and auth-input tests to use the secret rotating input and newline contract.
- Coalesced ACP startup with a per-conversation promise covering pre-spawn work and negotiation.
  Startup reservations and operation reservations block hot swaps.
- Synchronously reserve lifecycle/config/auth/stop operations; competing calls and prompts fail
  before their first await. Stop is allowed during turns, but rejected during startup/other
  reserved operations. Additional-directory state rolls back when a lifecycle request fails.
- Prompt completion callbacks capture their turn identity. A delayed response after a timeout
  cannot end a newer turn. Timeout sends `$/cancel_request` as well as `session/cancel`.
- Desktop and background resume/load fallback now accepts only RPC `-32002` as not-found;
  authentication, parameter, internal, transport and timeout errors surface without creating a
  replacement session.
- Replay completion includes success/failure. Desktop discards staged replay from failed loads.
- Closed/deleted-current sessions reconnect on send, including no-session ready state. Closing,
  deleting the current session, or explicitly starting a fresh session flags a local dialogue
  handoff. New/fork response IDs and explicit load/resume/fork IDs require nonempty strings.
- Removed pipe-based terminal-auth launch. Neither terminal-auth capability is advertised;
  standard and legacy terminal methods are filtered and direct stale method calls fail. This
  also removes the untrusted method-env override path. Agent-driven authentication remains.
  No new native primitive was added: terminal login stays disabled pending a proper PTY design.
- Background `create` allowlists AgentSpec fields and forces clean context/system-prompt/runtime
  fields instead of spreading caller data.
- Elicitation emits `acp.elicitationComplete` when the request settles, including cancellation,
  stop, EOF, timeout, and normal response. Accept permits null/omitted content.

### Verification

- Root `npm run typecheck`: passed. Plugin typecheck also passed as part of its full suite.
- Focused protocol/form/history/background suite: **47/47 passed**.
- Selected request-scoped form/provider/auth UI, closed-session handoff, and image-service tests:
  **5/5 passed** (19 unrelated tests skipped by name filter).
- Full plugin `npm test`: **153/153 passed**, in `/tmp/hato-acp-verify-ue6kt1ms` with physical source,
  sibling SDK/grants and linked dependencies. Initial sandboxed run was 152/153; the debug relay
  test could not listen on localhost (`EPERM`). The rerun with listeners allowed passed all tests.
- Full root `npm test`: **286/317 passed, 31 failed**. Failures include URL.pathname `%20` source
  resolution, old UI assertions, changed default panels/migrations, and incomplete test host mocks.
  Do not describe the root suite as green.
- Built `acp`, `ai-sessions`, `ai`, `agent-runner` using the nested repository builder.
  Bundles are **built only**, not staged or activated. No restart is required for this module-only
  checkpoint. The running desktop has not been verified with these changes.
- Both `git diff --check` commands passed. No native checks were needed.

### Remaining priorities (use judgment; do not treat the old list as an unquestioned plan)

1. Full-history replay remains the highest transcript issue: persistence-level reconciliation,
   anchored insertion of provider-only messages, outgoing prompt correlation, scoped tool IDs,
   live user-chunk coalescing, assistant retirement at tool/plan boundaries, and fingerprint
   occurrence accounting still need design and tests. Do not fix the 80-message limitation merely
   by eagerly loading all history into every conversation.
2. Background `systemPromptSent` is still not wired into instruction delivery; separate it from
   dialogue context, handle changed MCP/progress instructions, and cover startup/queued writes
   in runner swap guards. Caller field injection is fixed; these other trust/state issues are not.
3. Async UI still needs latest-load-wins, complete origin/attempt tokens, safe busy ownership,
   operation tracking/swap guards, prompt-return handlers for long calls, and malformed provider
   session/auth data plus cursor-loop handling. Existing console UI is dormant compatibility code;
   terminal authentication must stay disabled until proper PTY support exists.
4. Lifecycle response validation beyond nonempty IDs, idempotent close/delete not-found handling,
   uncertain state after remote timeouts, and rich content-block schema validation remain open.
   Timed-out requests remain pending in JsonRpcPeer until response/EOF, conservatively blocking swap.
5. Run live adapter checks and visual verification only after deterministic gaps are resolved.
   Do not claim the roadmap finished or activate these modules as a verified release yet.


## Roadmap implementation and verification (2026-11-26)

Implemented the six requested follow-ups. This supersedes the open implementation list in the
previous takeover checkpoint. Both repositories retain their separate Git histories; nothing was
committed or pushed. Existing work was preserved.

### Implementation

- Added `sdk/chat-replay.ts` and persistence `messages.reconcileReplay`: build a full-history index
  transiently inside persistence, consume ID/fingerprint matches once, enrich local rows with
  provider correlation, preserve local-only rows, and insert missing runs beside known anchors.
  A single SQLite transaction moves existing sequences negative before assigning the merged
  positive order, preserving row IDs and uniqueness. Chat still caches paginated history. Replay
  and live projection are ordered; pagination cannot race a replay resequence. Failed loads are
  discarded, failed persistence stays retryable, and dirty rows are not lost on write failure.
- Submitted user prompts retain their actual outgoing text separately from display text so Hato
  progress/handoff prefixes correlate on replay. Live user chunks coalesce; message identity
  includes role/session, tool IDs are session-scoped, and tool/plan boundaries reset pointers
  without retiring streaming messages. Turn completion retires IDs against late duplicate chunks.
- Background `systemPromptSent` is independent of dialogue `contextSent`. Changed instruction files
  refresh through resume/load lifecycle with full trusted instructions. Fallback progress instructions
  also refresh after workspace-MCP changes. New/fork/clear/provider-loss states reset their respective
  fields. Queued writes capture provider session identity; startup, locks, pending writes, and active
  operations veto swaps.
- Native UI events carry render-origin tokens; stale clicks cannot retarget another conversation,
  session or authentication attempt. Long native handlers dispatch tracked background work and
  return promptly. Loads are latest-request-wins; operation owners prevent one completion clearing
  another spinner. Form requests and auth attempts settle explicitly. Provider/auth arrays are
  normalized and bounded; repeated/no-progress cursors terminate paging.
- Lifecycle responses/IDs and rich content blocks follow ACP v1. Close/delete not-found is
  idempotent. RPC timeout cancellation removes pending bookkeeping and marks uncertain lifecycle
  connections as requiring reconnect. Only session-not-found triggers resume fallback. Form regex
  validation excludes overlapping repeats, optional chains, unanchored repeats and unsafe groups.
- Added the reusable `pty.spawn` host primitive: SDK/prelude/broker/backend, using existing process
  grants, canonical cwd/target checks and resource ownership. No new compiled first-party grant is
  needed. Local argv launches and SSH/Cloud quoting reuse existing mechanisms. The native host
  advertises `hostFeatures: ["pty.spawn"]`. PTY specs now support inherited env removal.
- Terminal login is enabled only on hosts advertising that feature. The module previews the exact
  configured invocation and env names, requires a one-use expiring launch token, rejects dangerous
  env overrides and policy-removed credentials, then presents a real native terminal. All output,
  input, cancellation and completion are attempt-scoped. Successful login reconnects the provider.

### Verification and deployment

- Root full suite: **328/328**; nested plugin full suite: **157/157**. Both TypeScript checks pass.
  Fixed URL-to-file-path test helpers and updated stale UI assertions/host mocks instead of
  accepting the old 31 failing tests. No tests were disabled.
- Native library tests: **53/53**; architecture checks: **2/2**. The initial sandboxed run could not
  open relay listeners; all passed with localhost access allowed.
- New `tests/integration/acp-roadmap.js`: **7/7** real PTY/SQLite checks (interactive argv, literal
  args, cwd denial, bounded replay cache, full-history idempotence, anchored insertion, sequences).
- Live Codex 2.10.0, Claude ACP 0.110.0, OpenCode 2.4.1 and Copilot 1.0.109: initialize/new/minimal
  OK prompt/list/load/close passed. All advertised resume/fork/delete operations passed for the
  three providers supporting them, including forks of non-empty sessions. Copilot rejects load
  while already loaded; closing before load succeeded. Tests used only disposable workspaces and
  sessions created for verification. Existing account authentication was preserved; no installs or
  logouts occurred. Actual interactive sign-in was tested through controlled native PTY fixtures.
- Inspected offscreen native renders of representative module-generated form, provider-session and
  auth-preview states. Corrected an empty select-label colon and removed misleading pre-launch
  output text. These are fixture trees, not the user's running desktop UI.
- Built all plugin bundles and the snapshot-enabled native debug binary. The normal debug build
  exceeded available disk; removed artifacts created during this task and rebuilt with
  `CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_DEV_INCREMENTAL=false`. The compact build succeeded.
- Changes ran in isolated headless instances. **The user's desktop has not been restarted or
  activated.** Restart with the rebuilt host and current bundles to use native terminal login;
  the existing host keeps that capability off. No module activation tools are exposed in this
  agent session, and existing running agents/workspace resources were not disturbed.
- `git diff --check` passes in both repositories. Native SSH/Cloud argv routing reuses the audited
  existing transport path; new real-PTY integration was local. Optional protocol extensions listed
  in `capability_matrix.md` remain outside this request.
