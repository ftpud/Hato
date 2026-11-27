# Native Windows workspaces — TODO

Goal: Windows projects (`C:\…`, and later Windows SSH hosts) with native terminals (pwsh/cmd), Git for Windows,
language servers and ACP agents — alongside today's WSL/SSH-Linux projects (`docs/WINDOWS.md`).

**Scope: Windows x64 only.** No Windows on ARM (desktop or daemon); Windows-side downloads, builds and platform
detection target `x86_64` and report a clear "unsupported" error on ARM64.

Rule of thumb (AGENTS.md): Rust adds small reusable primitives; shells, defaults, URLs, versions and policy live in
modules/`sdk`. Legend: **[N]** native (rebuild + restart), **[M]** module (hot reload), **[S]** sdk (rebuild consumers).

## Decision — no `sh` in modules
Modules never invoke `sh`/`bash`/`loginShell` themselves; they spawn executables with argv and parse output in
TypeScript. Git Bash is **not** a module dependency — only an optional user shell profile.
- Tool lookup and PATH go through the `sdk` resolver (the only place allowed to run the Unix login shell for PATH;
  on Windows it reads the registry).
- File tests (`test -x`, `[ -w ]`) → kernel fs calls; pipelines → separate argv calls + TS parsing.
- User-authored commands (run configurations, workflow steps, terminals) run through a **user-selected shell
  profile** per workspace: Windows default `pwsh` → `powershell` → `cmd`; Unix default login shell; Git Bash, cmd
  and WSL selectable. Profile stored via the persistence service, never hardcoded.

## Decision — default Windows shell
Auto order `pwsh` 7 → Windows PowerShell 5.1 → `cmd`; a user choice (per workspace, persistence service) overrides it.
- Interactive terminal profile: `-NoLogo`, user profile loaded.
- Command profile (run configs, workflow steps): `-NoLogo -NoProfile -NonInteractive`.
- UTF-8 everywhere: ConPTY code page 65001; command profiles set output encoding to UTF-8 at startup.
- Never override execution policy. Detect the "running scripts is disabled" error and show a hint
  (`Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`, or switch the profile to `cmd`).

## Decision — per-agent Windows support
Providers declare `platforms.windows: { status: "supported" | "untested" | "unsupported", requires?: string[],
note?: string }`; status comes from the smoke test, never from assumptions.
- `untested` (default) runs with a warning badge; only `unsupported` disables the agent, showing `note`.
- `requires: ["git-bash"]` is allowed (agent's own need, not a module shell): resolve Git for Windows' `bash.exe`,
  pass it via the agent's documented setting if any, else show an install hint.
- WSL-only agents are `unsupported` for Windows projects, with a hint to open the project as a WSL project; no
  cross-machine agent runs over `/mnt/c`.
- Record the tested adapter version in `note`; re-run the smoke test when the adapter version changes.

## Phase 0 — Inventory & contracts
- [x] Audit Unix assumptions in kernel: `daemon/server.rs` (`/bin/sh`, `passwd_shell`, `$SHELL`), `host/daemon_link.rs`
      (`uname -sm`, `platform()`, `sh_quote`, socket paths), `host/pty.rs`, `ops.rs` process/terminal ops.
      _Done:_ local Windows already had canonical paths, ConPTY and tree kill; daemon remains Unix-only (Phase 5).
- [x] Audit modules using `sh`/`loginShell`/`command -v`: acp, agent-runner, browser, debug, files (search, gitignore,
      change-capture), git, git-tasks, language-service, opencode-provider, projects, run, run-configurations,
      workflow-runner, ui/explorer, ui/terminal-panel, ui/viewer. Classify each call: tool lookup / fs test /
      pipeline / user command.
      _Done:_ remaining POSIX-only uses are allowlisted in `Hato-plugins/tests/no-module-shell.test.mjs`.
- [x] **[S]** Shared shell-profile type + `runUserCommand(desc, profile, commandText)` helper in `sdk` (the one
      sanctioned path for user-authored command strings).
      _Done:_ named `userCommandLaunch` / `userCommand` (+ `ShellChoice`, `shellChoiceFor`).
- [x] Lint/test guard: fail module build/tests on `"sh"`, `"bash"`, `/bin/sh` or `loginShell` outside the `sdk`
      resolver and `runUserCommand` (explicit allowlist).
      _Done:_ `loginShell` stays allowed (it is the kernel's remote PATH setup, a no-op locally).
- [x] Add `os: "linux" | "macos" | "windows"` (+ arch) to the workspace descriptor / machine info in `sdk/types.ts`
      so modules branch on the workspace machine, never on the desktop OS.
      _Done:_ derived by `workspaceOs(ctx, desc)` in `sdk/platform.ts` (local → host OS; SSH/WSL/Cloud → POSIX) rather than a stored field.
- [x] Decide path convention end to end: kernel canonical `C:/x`; what modules see; what goes to tools/LSP.
      _Done:_ kernel `C:/x`; modules use `isAbsolutePath`/`slashPath`; LSP matching is case-insensitive.

## Phase 1 — Local Windows projects + native terminals
- [x] **[N]** Allow non-WSL local roots on the Windows desktop (lift the "projects live in Linux" restriction;
      keep `grants::join_windows` and scope checks).
      _Done:_ the restriction was in the `projects` module, not the kernel.
- [x] **[N]** PTY spawn takes an explicit program/args/env profile; ConPTY via `portable-pty` (verify resize, UTF-8,
      `TERM`, Ctrl+C/Ctrl+Break, process-tree kill with Job Objects).
      _Done:_ as `pty.open` `shellCandidates`; resize/Ctrl+C need on-device verification.
- [x] **[M]** Terminal shell profiles in `terminals` settings: default `pwsh` → `powershell` → `cmd`, plus Git Bash
      and WSL distros as extra profiles; persisted via persistence service.
- [x] **[M]** pwsh detection: resolver, then `%ProgramFiles%\PowerShell\7\pwsh.exe`; fall back to
      `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`, then `%COMSPEC%`.
- [x] **[S]** Separate terminal vs command flag sets per profile (`-NoLogo` vs `-NoLogo -NoProfile -NonInteractive`).
- [x] **[N]** ConPTY sessions start with UTF-8 code page (65001); **[S]** command profiles prepend UTF-8 output
      encoding setup.
      _Done:_ done in the shell arguments (`chcp 65001`, PowerShell `OutputEncoding`) instead of a native code-page call.
- [x] **[M]** Execution-policy error detection in terminal/run output → actionable hint; no `-ExecutionPolicy Bypass`.
      _Done:_ in run output and workflow scripts; not scanned in interactive terminals.
- [x] **[N]** Process kill semantics on Windows (Job Object per run so children die with the run).
      _Done:_ processes already used `taskkill /T`; PTYs now do too, only while the shell is alive (no Job Objects).
- [x] **[M]** `projects` UI: "Local folder" option on Windows next to WSL/SSH; `hato.exe --root C:\…`.
- [ ] **[M]** `files`: search/gitignore/change-capture without `sh` (use kernel fs + `rg.exe`/`git.exe` directly);
      CRLF and case-insensitive path handling.
- [ ] **[M]** `git` / `git-tasks`: run `git.exe` directly (no `sh -c`), worktrees on Windows paths,
      `core.autocrlf`/long paths notes; detect Git for Windows and show install hint if missing.
- [x] **[M]** `run` / `run-configurations` / `workflow-runner`: user commands via `runUserCommand` and the selected
      shell profile (pwsh `-NoProfile -Command`, `cmd /d /s /c`, Git Bash `-lc`, login shell on Unix); per-config
      shell override in the run-configuration editor; detection of npm/cargo/dotnet scripts on Windows.
      _Done:_ run resolves `npm`/`mvnw.cmd`/`gradlew.bat` via `windowsLaunch`; per-config shell override not added (configs are argv, not shell text).
- [x] **[M]** Remove remaining `sh` from browser, debug, projects, opencode-provider, ui/explorer, ui/terminal-panel,
      ui/viewer (argv spawns / kernel fs).
      _Done:_ git-tasks uses `printenv`; browser/opencode/acp/agent-runner keep POSIX-only branches (allowlisted).
- [ ] **[M]** `ui/explorer`, `ui/viewer`: path display, reveal-in-Explorer, drive roots.
- [x] Update `docs/WINDOWS.md` and `docs/COMPATIBILITY.md`.
      _Done:_ `docs/WINDOWS.md` and `ARCHITECTURE.md`; `docs/COMPATIBILITY.md` not changed.

## Phase 2 — Tool resolution (shared)
- [x] **[S]** `sdk` helper `resolveExecutable(desc, name)`: Unix → login/interactive shell PATH (current acp logic);
      Windows → `where.exe` with PATH rebuilt from `HKCU\Environment` + system `Environment`.
      _Done:_ as `resolveWindowsExecutable` / `windowsLaunch`; POSIX lookup unchanged.
- [x] **[S]** `.cmd` shim handling: parse npm shims to `node.exe <entry.js>` and spawn that directly; never pass
      user-influenced args through `cmd.exe`.
- [x] **[N]** Fallback primitive: safe `cmd.exe` invocation with correct quoting (only if shims can't be resolved).
      _Done:_ non-node batch files start by path (Rust std escapes batch arguments and refuses unsafe ones); `verbatimArgs` covers user `cmd` commands.
- [x] **[M]** Move acp `detect()` / `npmRunner()` onto the sdk helper; drop the `/`-prefix absolute-path check.

## Phase 3 — ACP providers
- [x] **[M]** `npm install -g` on Windows uses `%APPDATA%\npm` (no `$HOME/.local` fallback); keep `ai-sessions` approval.
- [x] **[M]** Re-run detection after install with refreshed registry PATH (no app restart).
      _Done:_ every detection reads the registry PATH.
- [x] **[S]** `platforms.windows` (`status`, `requires`, `note`) in the provider manifest type in `sdk/types.ts`.
- [x] **[M]** Fill it for claude, codex, copilot, opencode from smoke-test results (default `untested`).
      _Done:_ all four are `untested` until the smoke test runs.
- [x] **[M]** UI: warning badge for `untested`, disabled + note for `unsupported`, WSL-project hint for WSL-only agents.
      _Done:_ as text in Settings → ACP adapters plus a one-time toast; no dedicated badge node.
- [x] **[M]** `requires` detection: `git-bash` → resolve Git for Windows `bash.exe`, pass via the agent's documented
      option/env (verify e.g. Claude Code's Git Bash path setting against current docs), else install hint.
      _Done:_ manifest form `requires: [{ tool: "git-bash", env: "<VAR>" }]`.
- [ ] Smoke-test each adapter on Windows: claude, codex, copilot, opencode — spawn, auth, prompt, tool calls,
      cancel, terminal tool, file edits with CRLF; record tested adapter version in the manifest `note`.
- [ ] Re-run the adapter smoke test when an adapter version changes (CI job or release checklist item).
- [x] **[M]** `agent-runner` / `persistent-agents`: env and cwd on Windows; no `sh` wrappers.
      _Done:_ agent-runner only; it needs the daemon, which is not on Windows yet.

## Phase 4 — Language servers & runtimes
- [ ] **[N]** Reusable primitive: HTTPS download → sha256 verify → extract `.zip`/`.tar.gz` into a granted dir
      (contract in `sdk/types.ts`).
      _Interim:_ the Python installer now supports Windows x64 (zip, `.exe`, `.cmd` wrappers, safe lock); Python is
      still required. The download must run on the workspace machine, so for SSH this primitive belongs in the daemon.
- [ ] **[M]** Rewrite `language-service` dependency installer in TypeScript on that primitive (removes Python
      requirement on all platforms); Windows URLs: Adoptium `os=windows` zip, Node `win-x64.zip`;
      root `%LOCALAPPDATA%\Hato\language-tools`; `bin\java.exe`, `node.exe`.
- [ ] **[M]** jdtls: launch `java -jar …launcher.jar -configuration config_win` instead of `jdtls.bat`.
      _Interim:_ a `.cmd` wrapper runs jdtls's Python launcher (which picks `config_win`).
- [x] **[M]** typescript-language-server via resolved shim (`node.exe …cli.mjs --stdio`).
- [x] **[M]** LSP URI mapping: `C:/x` ↔ `file:///c%3A/x`, case-insensitive compare; tests for definition/
      references/diagnostics/rename round-trips.
      _Done:_ `workspacePath` accepts `file:///c%3A/…` case-insensitively; round-trip tests against a real server still to do.
- [ ] **[M]** Per-platform `installHint` in language manifests (`language-typescript`, `language-java`, `language-sap`).
- [x] **[M]** `debug` (DAP): adapter launch without `sh`; Windows path mapping.
      _Done:_ uses `python` on Windows and Windows path mapping; relay still needs Python.

## Phase 5 — Windows daemon & SSH to Windows hosts
- [ ] **[N]** Port `daemon/server.rs`: named pipes instead of Unix sockets, ConPTY terminals, Windows default shell
      (`%COMSPEC%`/pwsh) instead of `passwd_shell`/`/bin/sh`, durable terminals across app restart.
- [ ] **[N]** Daemon on local Windows projects too (terminals survive app restart, like Linux).
- [ ] **[N]** `daemon_link.rs`: platform detection without `uname` (try `uname -sm`, then
      `powershell -NoProfile -Command [Environment]::OSVersion…`/`%PROCESSOR_ARCHITECTURE%`); upload path `%LOCALAPPDATA%`.
- [ ] **[N]** Per-platform remote quoting (`sh_quote` vs PowerShell/cmd) behind one function.
- [ ] **[N]** SFTP on Windows OpenSSH: path form `/C:/…` ↔ `C:/…`.
- [ ] Build: `x86_64-pc-windows-gnu` daemon bundled (x64 only).

## Phase 6 — Tests, packaging, docs
- [ ] Integration suite for local Windows projects (extend `tests/integration/run-windows.sh`): terminal, files,
      git, run config, LSP (TS + Java), one ACP adapter.
- [x] Unit tests: path canonicalization, URI mapping, shim parsing, cmd quoting, platform detection.
      _Done:_ `tests/ts/platform.test.mjs`, kernel `find_program`/`shell_candidate` tests; integration tests still to do.
- [ ] Code signing for the Windows package (SmartScreen) and add it to the release workflow.
- [x] Docs: rewrite `docs/WINDOWS.md` (native + WSL + SSH matrix), update `ARCHITECTURE.md` machine model.

## Open questions
- None currently.
