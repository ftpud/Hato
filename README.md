# Hato — self-modifying native desktop platform (microkernel POC)

A native, GPU-rendered (GPUI) desktop app whose **Rust kernel only provides primitives** — window +
native controls, QuickJS module runtimes, a capability broker, resource handles, trusted approval
chrome — while **all application behavior is hot-swappable TypeScript**: projects, Git task worktrees,
SSH workflow, files, terminals, the ACP agent client, conversations, the internal MCP server, and every
UI panel. An agent can patch, build, activate and roll back those modules through MCP, with explicit
native approval, **without rebuilding or restarting the Rust kernel**.

Spec: [`architecture-2.md`](architecture-2.md). Versions/platforms: [`docs/COMPATIBILITY.md`](docs/COMPATIBILITY.md).

```
┌ Rust microkernel (kernel/src) ───────────────────────────────────────────────────────────┐
│ GPUI shell + keyed-tree renderer (ui/)   QuickJS worker per generation (js/)             │
│ generation router: RPC, fencing, events (router.rs)   swap/rollback + artifacts (kernel.rs)│
│ capability broker (ops.rs, grants.rs)    handles (handles.rs)   approvals (approvals.rs)  │
│ adapters (host/): fs · process · PTY+alacritty grid · OpenSSH master · SFTP v3 · SQLite ·  │
│                   loopback net · bounded byte streams                                      │
└──────────────── versioned host ABI: ctx.host.* (sdk/types.ts) ─────────────────────────────┘
  services (modules/services): persistence workspace projects git-tasks files terminals
                               acp ai-sessions internal-mcp module-dev
  ui       (modules/ui):       workspace-layout projects-panel explorer viewer terminal-panel ai
```

## Repository layout

| Path | What |
| --- | --- |
| `kernel/src` | Rust microkernel (no project/task/Git/ACP/MCP logic — enforced by `kernel/tests/arch_gate.rs`) |
| `kernel/src/js/prelude.js` | In-VM SDK implementing `ModuleContext` on top of 4 native functions |
| `grants/first-party.json` | Install-time capability upper bounds (compiled into the kernel binary) |
| `modules/{services,ui}/<id>/` | `manifest.json` (static, separately validated) + `src/index.ts` |
| `modules/services/persistence/migrations/*.sql` | The app's SQLite schema — owned by TS |
| `modules/services/internal-mcp/skills/*.md` | Versioned MCP skills |
| `sdk/` | Module SDK types + shared helpers (bundled statically; not a live module) |
| `tools/build-modules.mjs` | Builds every module to `build/modules/<id>.mjs` (seed artifacts) |
| `tests/` | `ts/` unit tests, `integration/` headless end-to-end suites |

Runtime data (default `~/Library/Application Support/Hato`, or `--data-dir`):
`artifacts/<id>/NNNN.mjs` (+ manifest, SHA-256 in `module-registry.json`), `sqlite/<namespace>.db`,
`logs/{kernel,modules,audit}.log`, `shared/` (module-writable app data: worktrees, MCP proxy, backups).

## Build and run

Prerequisites (macOS tested): Xcode + Metal toolchain, Rust stable, Node ≥ 20, Git, OpenSSH.

```sh
npm ci                     # esbuild + typescript (dev only)
npm run modules:build      # TS -> build/modules/*.mjs
cargo run -- --root .      # first launch registers --root (default: cwd) as a project
# flags: --data-dir DIR  --repo-root DIR  --safe-mode  --dev-watch  --headless[-script FILE]

npm run modules:watch      # incremental rebuilds of seed artifacts
cargo run -- --dev-watch   # opt-in: changed seeds are hot-swapped WITHOUT approval (trusted local dev only)
```

ACP agents are **not** bundled or installed by Hato. Install an adapter on each machine that hosts
workspaces, e.g. `npm i -g @agentclientprotocol/claude-agent-acp` or `@zed-industries/codex-acp`, and
authenticate it there. Profiles (`Codex`, `Claude`, or custom commands/absolute paths) are stored in SQLite.

## Using it

* **Projects panel**: `+ Local` (native folder picker) or type a path; `+ SSH` opens a form (host, user,
  port, absolute remote path, optional key *path*). Chevron = expand/collapse; row = select workspace.
  `+ New Git Task` creates branch `task/<slug>-<id>` and a linked worktree **on the project's machine**
  (local: `<data>/shared/worktrees/…`, remote: `~/.local/state/hato/worktrees/…`).
* **Files / Source viewer**: native, read-only, Tree-sitter highlighted editor; binary files are detected.
* **Terminal**: real PTY (local login shell or `ssh -tt` in the remote directory) rendered by a native
  alacritty grid; survives every TS hot swap.
* **AI / ACP**: per-workspace conversations; agent/model/reasoning/mode selectors come from the agent's
  advertised `configOptions` (disabled with a reason otherwise); policy Ask / Auto-approve low-risk /
  Autopilot; Internal MCP toggle (External MCP shown as "coming later").
* **Modules** (header button): Rebuild & activate / Roll back per module. Builds, activations, rollbacks,
  module-source writes, grant escalations, remote writes and unknown SSH host keys all go through the
  kernel's **native approval dialog**, which no module can render or answer.

### Self-modification demo (spec §10.3 / §17.10)

1. Select a project, open the AI panel, `+ New chat`, `Connect` (agent starts on the workspace machine).
2. Ask: *"Using the hato-internal MCP tools, change the Projects panel title to 'PROJECTS ★', build and
   activate projects-panel."*
3. Approve the native dialogs (diff of `modules/ui/projects-panel/src/index.ts`, stage, activate).
4. The panel updates live; terminals and the agent session stay up. `Modules → Roll back` (or ask the
   agent to call `modules_rollback`) restores the previous version.

Service swap demo: change the sort in `modules/services/projects/src/index.ts` (`tree` method), then
`Modules → projects → Rebuild & activate`; the tree order changes, data is untouched.

## Security model (summary)

* The trust boundary is the **kernel capability broker** (`kernel/src/ops.rs`), checked on every call:
  generation status → effective capabilities (manifest ∩ compiled-in grants ∪ natively approved extras) →
  handle kind + owning module → scope grant (canonical root on a specific machine, symlinks resolved,
  kernel state dirs never grantable).
* Handles are random 128-bit ids bound to an owner module; forged/foreign handles fail (`EBADF`/`EPERM`).
* Module source writes show a **kernel-computed diff**; stage/activate/rollback show hashes and
  capabilities. Approvals are resolved only by GPUI click handlers in kernel chrome; Autopilot affects only
  the agent's own tool permissions, never these.
* Remote execution: explicit machine identity on every request; a dead SSH master is an error — never a
  local fallback. Remote command lines come from one audited POSIX quoting adapter.
* Internal MCP: loopback-only listener; every connection must present a per-conversation token; remote
  agents reach it through a loopback-only SSH reverse forward that is revoked with the session.
* Each module generation runs in its own QuickJS runtime (256 MB memory cap, 4 s CPU slice per entry,
  bounded queues). QuickJS is not treated as a sandbox for privileged APIs.
* Agents are intentionally powerful **inside their workspace** (they can run commands there).

## Tests (actually executed on the dev machine, macOS 27 / Apple M-series)

```sh
cargo test                 # 10 kernel unit tests + architecture gate (2)
npm test                   # tsc --noEmit + 6 TS unit tests
eval "$(tests/integration/fixtures.sh /tmp/hato-fx)"; export HATO_T_BUILD=$PWD/build/modules
tests/integration/run-integration.sh tests/integration/m2m4-local.js /tmp/hato-d1 --root $HATO_T_REPO_A
```

| Suite | Result | Covers |
| --- | --- | --- |
| `cargo test` | 12/12 | handles, grants/escalation, containment, quoting, streams/backpressure, arch gate |
| `npm test` | typecheck + 6/6 | diff apply, JSON-RPC framing, migrations, key-material refusal, tree rendering |
| `m2m4-local.js` | 37/37 | projects (2 Git + non-Git), tree select/expand, explorer/viewer, symlink/traversal denial, real PTY, Git tasks (clean + dirty warning), UI + service hot swap, PTY survival, broken artifact, failing activate, rollback, stale listeners |
| `m9-reliability.js` | 19/19 | restart recovery, broker denials, manifest self-escalation, forged handles, revoked grant, hung JS interrupted, repeated swaps, persistence swap/DB reopen |
| `m6m8-acp-local.js` (Claude adapter) | 24/24 | real ACP session (cwd verified with `lsof`), streaming, set_config_option, ai/acp swap with live session, busy-swap deferral, cancel, MCP discovery, **agent patch → build → activate with native approvals**, Autopilot can't bypass, task-worktree session |
| `m5m7-ssh.js` (real sshd) | 23/23 |
| `m9-build-failure.js` | 4/4 | invalid TS through module-dev/esbuild → diagnostics, active version kept; diff outside module denied | SSH project form, host-key trust approval, SFTP, remote PTY, remote worktree, remote ACP under sshd, MCP over reverse forward, remote agent patching a local module, offline/no fallback, reconnect |

Agent suites need an installed + logged-in adapter (`HATO_T_ACP=/path/to/claude-agent-acp`); source
`tests/integration/agent-env.sh` to drop inherited API-key variables. The SSH suite needs an SSH server;
the run above used a user-level `sshd` on `127.0.0.1:2222` (see `docs/TESTING.md`). Codex: see
COMPATIBILITY.md (adapter/account incompatibility, not exercised end-to-end).

## Measurements (debug build, deps at opt-level 2; dev machine)

| Metric | Value |
| --- | --- |
| Module boot (16 modules, headless) | 124–140 ms |
| Window + module boot (GUI, populated data dir) | 333–406 ms to all trees requested |
| Idle RSS (GUI, 16 modules, 1 PTY) | ≈ 124 MB |
| Idle CPU | ≈ 0.4 % |
| In-app rebuild (esbuild) + stage + hot swap | ≈ 60 ms per module |
| Swap cutover (fence → activate → health → route) | < 2 ms for these modules |
| Cross-module RPC round trip | ≈ 0.07 ms |
| UI module render (projects-panel) | ≈ 0.08 ms |

## Deviations / decisions to review (reported per §17.9)

* **SSH via system OpenSSH** (ControlMaster) + own SFTP v3 client instead of libssh2 — "or equivalent" per
  §3; rationale in COMPATIBILITY.md.
* `sdk/` instead of `.sdk/` (visible directory; same role).
* `select` is rendered as a native button + dropdown menu; split panes have fixed proportions from the
  layout module (no drag-resize yet).
* Test-only surfaces: `--headless-script` adds `test.*` ops for a `__driver` module (only in that mode);
  `HATO_SSH_KNOWN_HOSTS` points OpenSSH at an alternate known_hosts file (host keys still verified).
* `--dev-watch` activates changed seed builds without approval — explicit developer opt-in, off by default.
* Each module stage triggers one approval ("build & stage"); the esbuild run itself is constrained by the
  build grant (fixed executable, entry inside `modules/`, output only to stdout).
* GUI visuals were verified via logs/render trees only (no screen-recording permission in this session);
  all behavior was verified through the same render/event paths headlessly.
