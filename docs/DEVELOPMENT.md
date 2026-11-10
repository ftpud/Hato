# Development notes

A native, GPU-rendered (GPUI) desktop app whose **Rust kernel only provides primitives** — window +
native controls, QuickJS module runtimes, a capability broker, resource handles, trusted approval
chrome — while **all application behavior is hot-swappable TypeScript**: projects, Git task worktrees,
SSH workflow, files, terminals, the ACP agent client, conversations, the internal MCP server, and every
UI panel. An agent can patch, build, activate and roll back those modules through MCP, with explicit
native approval, **without rebuilding or restarting the Rust kernel**.

Spec: [architecture-2.md](../architecture-2.md). Versions/platforms: [COMPATIBILITY.md](COMPATIBILITY.md).

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
workspaces, e.g. `npm i -g @agentclientprotocol/claude-agent-acp` or `@agentclientprotocol/codex-acp`, and
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
  Autopilot. The separate Background agents list opens daemon-owned sessions in the same chatbox.
  MCP server configurations are managed in their own panel; see [PERSISTENT_AGENTS.md](PERSISTENT_AGENTS.md).
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
* Desktop MCP uses a loopback listener with session tokens and SSH reverse forwarding for remote
  callers. Workspace MCP runs on the workspace machine (hatod or standalone locally), so its
  daemon-hosted tools do not depend on a desktop reverse tunnel. See [PERSISTENT_AGENTS.md](PERSISTENT_AGENTS.md).
* Each module generation runs in its own QuickJS runtime (256 MB memory cap, 4 s CPU slice per entry,
  bounded queues). QuickJS is not treated as a sandbox for privileged APIs.
* Agents are intentionally powerful **inside their workspace** (they can run commands there).

## Tests

```sh
npm test                   # TypeScript checks and unit tests
npm run modules:build
cargo test                 # Kernel tests and architecture checks
cargo check --no-default-features
```

Headless integration drivers live in `tests/integration/`. See [TESTING.md](TESTING.md) for fixture
setup, including SSH and live provider tests, and [PERSISTENT_AGENTS.md](PERSISTENT_AGENTS.md)
for background-session and workspace MCP tests. Use isolated data/daemon directories. Live agent
suites require an installed, authenticated adapter on the workspace machine.

## Historical prototype measurements

These measurements describe the earlier 16-module prototype in a debug build with dependencies
at opt-level 2. They are retained as background, not benchmarks for the current application.

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

## Implementation decisions and verification limits

* **SSH via a built-in client** (`russh`, one connection per machine, channels in-process) + own SFTP v3
  client instead of libssh2 — "or equivalent" per §3; details in COMPATIBILITY.md.
* `sdk/` instead of `.sdk/` (visible directory; same role).
* `select` is rendered as a native button + dropdown menu. Split panes support resizing and collapse;
  workspace-layout persists panel placement and top/bottom bar controls.
* Test-only surfaces: `--headless-script` adds `test.*` ops for a `__driver` module (only in that mode);
  `HATO_SSH_KNOWN_HOSTS` points OpenSSH at an alternate known_hosts file (host keys still verified).
* `--dev-watch` activates changed seed builds without approval — explicit developer opt-in, off by default.
* Each module stage triggers one approval ("build & stage"); the esbuild run itself is constrained by the
  build grant (fixed executable, entry inside `modules/`, output only to stdout).
* Earlier GUI verification used logs and headless render/event tests; it did not include visual
  inspection of every panel. Consult current test output rather than treating these notes as a
  blanket verification claim.

Plugin authoring and runtime APIs: [PLUGINS.md](PLUGINS.md).
