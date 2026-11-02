# Compatibility matrix and dependency decisions

| Component | Pinned version | Notes |
| --- | --- | --- |
| Rust toolchain | rustc 1.99.1 (stable, aarch64-apple-darwin) | `Cargo.lock` committed |
| GPUI | `gpui-pre =0.3.10` via `gpui-kit =0.8.1` | GPUI's published crate family; `gpui-kit` pins the matching revision |
| gpui-component | `=0.8.1`, feature `tree-sitter-languages` | Native `Editor` (read-only, Tree-sitter highlighting), `Input`/`Textarea`, `Button`, dropdown menus, `Checkbox` |
| QuickJS | `rquickjs =0.14.0` (`std`) | One `Runtime` + `Context` per module generation, own OS thread, explicit job pump |
| SQLite | `rusqlite =0.41.1` (`bundled`, `limits`) | One DB file per namespace; `ATTACH` disabled |
| PTY | `portable-pty =0.9.0` | Local PTYs; remote PTYs are `ssh -tt` running inside a local PTY |
| Terminal emulator | `alacritty_terminal =0.26.0` (vte 0.15) | Grid + parser in the kernel, custom GPUI paint element |
| SSH | **system OpenSSH client** (ControlMaster multiplexing) | See below |
| SFTP | own SFTP v3 client (kernel/src/host/sftp.rs) over the `sftp` subsystem | realpath, stat, readdir, read, atomic write (posix-rename) |
| TS build | `esbuild 0.24.2`, `typescript 5.7.3` (typecheck only) | Dev-time only; artifacts are plain ESM run by QuickJS |
| Node.js | 20.17 (dev machine) | Build tooling, the tiny MCP stdio proxy, and Node-based ACP adapters; never embedded |
| ACP adapters tested | `@agentclientprotocol/claude-agent-acp 0.100.0`, `@zed-industries/codex-acp 0.16.0` | Installed by the user on each workspace machine; Hato never installs agents |
| MCP | protocol versions `2025-06-18`, `2025-03-26`, `2024-11-05` (stdio framing) | Server implemented in TS (`modules/services/internal-mcp`) |

## Platforms

* **Tested:** macOS 27 (Apple Silicon) as the desktop host; SSH targets tested: macOS via a user-level
  `sshd` on `127.0.0.1:2222` (real OpenSSH server, key auth, separate host key).
* **Untested:** Windows and Linux desktop builds (GPUI supports them, but nothing here was run there).
  Remote Linux SSH hosts are expected to work (POSIX-only remote commands, SFTP), but were not available.
* **Deferred:** remote Windows over SSH.

## Why OpenSSH instead of libssh2

The specification allows "a pinned compatible `ssh2`/libssh2 implementation **or equivalent**". The kernel
uses the system OpenSSH client with a per-profile ControlMaster:

* honours `~/.ssh/config`, ssh-agent, key files and **known_hosts verification** (unknown keys go through a
  native trust approval and `StrictHostKeyChecking=accept-new`; changed keys are always rejected);
* concurrent multiplexed channels (exec, PTY, SFTP subsystem, `-O forward -R 127.0.0.1:0:…` reverse
  forwards) without libssh2's global session lock issues in blocking mode;
* no credentials ever pass through Hato: only a key *path* may be stored.

All remote command lines are built by one audited POSIX quoting adapter (`kernel/src/quoting.rs`).

## Known limitations

* Codex: `codex-acp 0.16.0` (latest on npm at the time of testing) embeds an older Codex core; with the
  test account's ChatGPT login every model was rejected by the backend (`model_not_found`). Hato handles
  and displays the agent's error correctly; the end-to-end agent tests were therefore run with the Claude
  adapter. This is an adapter/account compatibility problem, not an ACP client problem.
* A shell or coding agent is powerful **within its approved workspace** (it can run arbitrary commands
  there). Hato does not claim to sandbox it; the kernel's guarantees concern module code, native
  resources, and module-source/activation approvals.
* QuickJS isolation separates module state and lifecycles; the real trust boundary is the kernel's
  capability broker.
* Split panes have fixed proportions defined by the layout module (no drag-resize yet).
