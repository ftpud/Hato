# Windows status

Scope: **the window runs on Windows; projects live in WSL or on Linux hosts.** A Windows daemon, Windows-side Git and
native Windows projects are out of scope. Usage and design: [docs/WINDOWS.md](docs/WINDOWS.md).

## Needs a logged-in Windows desktop

Automated runs happen in Windows session 0, which has no desktop, so `hato.exe` cannot create its window there
(`DXGI_ERROR_NOT_CURRENTLY_AVAILABLE`). This has **never been seen running**:

- [ ] Launch `hato.exe`: window creation, rendering (first use of the prebuilt shaders), fonts, icons.
- [ ] Title bar controls, resizing, clipboard, keyboard shortcuts, IME.
- [ ] Add a project with the form and with the folder picker under `\\wsl.localhost`.
- [ ] The SSH password prompt: focus, masking, Enter, Cancel, and a reconnect after a restart.
- [ ] Type in a terminal: colors, TUI programs (`vim`, `htop`), resizing by dragging.
- [ ] Hot reload from the UI with a project open.
- [ ] Smoke-test the zip on a clean Windows machine without the developer toolchain.

## Not verified

- [ ] A real ACP agent and a workflow run in a WSL project. Their transport is covered; these features were not run.
- [ ] A distribution other than Ubuntu; a real remote Linux host (only a local `sshd` in WSL); WSL mirrored networking.
- [ ] macOS and Linux GUI builds of these changes. macOS needs a Mac; Linux here lacks `fontconfig` headers. The headless
      Linux build and the Windows GUI build both compile.

## Possible follow-ups

- [ ] Code signing.
- [ ] A Windows job in `.github/workflows/release.yml`.
- [ ] Static (musl) daemons in local builds: install `cargo-zigbuild`.

## Verified on Windows 10.0.26300, with Ubuntu 22.04 in WSL2

`tests/integration/run-windows.sh` passes against the packaged `hato.exe`, and so does the packaged smoke test:

- Native process, plain kernel paths; Windows folders refused as projects; `\\wsl.localhost` paths mapped to WSL projects.
- WSL and SSH projects with Git detection, files, symlink-escape refusal, Unicode paths and worktrees.
- Argument quoting, exit codes, 6 MB output, and terminating a Linux process.
- Terminals through ConPTY: direct and daemon-held, resize, UTF-8.
- Linux daemon upload and start, pushed services, file watching, and forwards to Windows listeners.
- In-app builds with `esbuild.exe`, hot reload keeping the selected workspace and terminal, plugin install.
- Local scope enforcement: traversal, drive paths, data streams, device names, drive roots, kernel state.
- `hato.exe` imports only DLLs that ship with Windows.
