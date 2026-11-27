# Remote runtime: settings and safe boundaries

Goal: a settings button on the Remote runtime panel that configures, per machine, what the Hato
daemon (`hatod`) and the agents/plugins it runs may do.

Two layers, both edited from the panel's machine settings (sliders button):

1. **Desktop-applied policy** (`remote-runtime.policy`, `machine:<id>` scope): what the desktop
   sends and keeps there, plus agent limits handed to the agent runtime. Module decisions.
2. **Daemon-enforced policy** (`DaemonPolicy`, `<daemon dir>/policy.json`): checked by the daemon
   kernel on every request from the plugins it runs.

## Phase 1: modules only (hot reload, no Rust)

- [x] **Unlimited switch** (on by default). On: everything is allowed and the limit settings are
      hidden; the daemon's enforced limits are lifted. Off: the settings show and apply. The saved
      limits (including the daemon's) are kept and restored when it is turned off again.
      Auto-start / auto-send overrides are preferences and stay visible either way.
- [x] **Force upgrade for the local daemon** (`daemon.forceUpgrade` with `{kind: "local"}`, trusted
      confirmation): restarts it with the app's build even while it holds terminals, then sends
      plugins and limits again. Highlighted when the daemon is stale.

- [x] **Settings button.** Sliders button in the `remote-panel` header; "Defaults…" opens the
      global Settings section.
- [x] **Per-machine policy** in `remote-runtime/src/policy.ts`, synced with machine settings.
- [x] **Per-machine overrides** for the global auto-start / auto-push ("use the default" / on / off).
- [x] **Plugin allow list** (all / selected / none) on every push path; blocked plugins listed
      with the reason. `persistence` is always allowed (machine-setting sync).
- [x] **Read-only mode**: blocks auto-push, Send/Update and force update.
- [x] **Idle cleanup** of detached terminals (15 min – 1 day, off by default), while connected.
- [x] **Stricter policy vs. running plugins**: decided: not stopped automatically. The panel
      shows "N running plugins are no longer allowed" with a "Stop them" button.
- [x] **Agent limits** (`AgentLimits` in `sdk/persistent-agents.ts`), sent by `remote-runtime` to
      `agent-runner.setLimits` on the machine and stored in its database:
  - [x] connected agents at once (checked when an agent connects)
  - [x] maximum turn length (the turn is cancelled, with a message)
  - [x] approval cap (autopilot / auto-low / ask), also refusing to turn autopilot on
  - [x] tool kinds always refused (execute, edit, delete, move, fetch)
  - [x] allowed providers and models (checked on connect, provider default model, model changes)
- [x] Agent limits are applied by the agent runtime; the panel says so and shows when the
      machine's runtime is too old to accept them.
- [x] Tests: `Hato-plugins/tests/remote-policy.test.mjs` (policy, pushes, idle timing, agent limits).
- [ ] Try it against a real SSH machine.
- [ ] Release step: bump `remote` (0.1.8 → 0.1.9) and `agents` (agent-runner 0.1.20 → 0.1.21)
      through `npm run release:prepare`.

## Phase 2: daemon-enforced limits (Rust, needs a `hatod` rebuild and upgrade)

- [x] `DaemonPolicy` / `DaemonPolicyStatus` contract in `sdk/types.ts`; kernel side in
      `kernel/src/host_policy.rs` (general operator limits; no agent concepts).
  - [x] `capabilityDeny`: checked on every capability use, so running plugins are affected too
  - [x] `fsRoots`: local fs / process / terminal scopes must fall inside (canonicalized)
  - [x] `maxProcesses`, `maxTerminals`: live programs / terminals started by plugins
  - [x] `processMemoryMb`: Windows Job Object (whole tree); Unix `RLIMIT_AS` (each process)
  - [ ] Network: dropped. Denying `net.*` / `ssh.*` capabilities covers plugin requests; blocking
        the network for programs plugins start needs OS sandboxing (namespaces / AppContainer).
- [x] Stored in `<daemon dir>/policy.json`, loaded before plugins boot, kept across restarts. An
      unreadable file blocks every capability until a valid policy is saved.
- [x] `policy.get` / `policy.set` daemon ops, `remote.daemon.admin` only; `policy.set` is audited.
- [x] Denials are logged, audited and listed in the panel ("Recently refused").
- [x] Panel section "Enforced by the daemon"; older daemons get a "use Force upgrade" hint.
- [x] Tests: `host_policy` unit tests, Windows memory-limit enforcement test
      (`host::process::memory_limit_tests`), `kernel/tests/daemon_policy.rs` end to end.
- [ ] Linux: cgroup limits (CPU, whole-tree memory) instead of per-process `RLIMIT_AS`.
- [ ] Run the Unix tests (`allocation_past_the_limit_fails`, `daemon_policy`) on Linux/macOS.
- [ ] Hardening: an older or mismatched `hatod` crashed the desktop when the chat model picker
      was opened (exit 0xc000041d, fixed by restarting the daemon). A daemon reply the desktop
      cannot handle should become an error, not a crash.

## Limits of this design

- Programs that plugins start (an agent's own shell commands) run as the same user. They are bound
  by the program count and memory limits, but not by capabilities or folders, and they can read or
  edit `~/.hato/policy.json` or talk to the daemon socket. Real isolation needs OS sandboxing.
- Desktop-applied rules (layer 1) only act while that desktop is connected or when it pushes.

## Decisions taken (were open questions)

- Limits apply to every machine with a daemon, including local and WSL. Defaults are unlimited,
  so nothing changes until a limit is set.
- A stricter policy is not retroactive for running plugins or connected agents (they are marked,
  and can be stopped from the panel). Daemon capability denials do apply immediately.
