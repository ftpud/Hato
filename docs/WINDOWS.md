# Hato on Windows

The window runs natively on Windows (x64 only; Windows on ARM is not supported). A project lives in one of three
places:

* **A native Windows folder** (`C:\…`, a network share): files, Git, terminals, run configurations, language servers
  and chat agents run on Windows itself. A local Windows daemon keeps terminals (Settings → Terminals → *Keep local
  terminals running after quitting*) and persistent processes alive across app restarts (see *Windows daemon*).
* **A WSL distribution**, or **a Linux host over SSH**: everything runs on that Linux machine, including the daemon.

## Requirements

* Windows 10 version 1903 or later, or Windows 11 (64-bit x86), with Direct3D 11.
* For native projects: [Git for Windows](https://git-scm.com/download/win) for Git features, Node.js/npm for ACP
  adapters and TypeScript tooling, and Python 3 (`python` or the `py` launcher) for automatic language-server and
  debugger installation. PowerShell 7 is used when installed; Windows PowerShell 5.1 otherwise.
* For WSL projects: WSL with at least one distribution (`wsl --install`). In that distribution:
  * `git`, and the `openssh-sftp-server` package, which Hato uses for file access (often already present).
* SSH projects need no WSL: Hato has its own SSH client. It uses the Windows side's `%USERPROFILE%\.ssh` (keys and
  `known_hosts`), the Windows OpenSSH agent service or Pageant, and key paths are Windows paths. Keys kept only in a
  WSL distribution's `~/.ssh` must be copied there or added to the agent.

## Install and launch

Unzip `Hato-<version>-windows-x86_64.zip` to a folder you can write to, and run `Hato\hato.exe`. In-app module
builds write to that folder. Node is not needed on Windows; the package includes esbuild. Application data is in
`%APPDATA%\Hato`.

To add a project, press **+** in the project panel. **Local folder** takes any Windows folder; **Browse…** picks one
(a folder under `\\wsl.localhost` switches to the WSL form). **WSL** takes a distribution and a Linux path. **SSH host** adds a Linux host, signing in with the SSH agent, a key file or a password. `hato.exe --root
C:\src\app` (or a `\\wsl.localhost\…` path) registers a project on first launch.

## Native Windows projects

Modules never start `sh` for their own work: they spawn programs with argv (`@hato/sdk/platform`). The pieces:

* **Shell profile.** Settings → Terminals → *Shell* (default) and *Shell for this workspace* (override, a scoped
  setting `shell.profile`). *Automatic* uses PowerShell 7 (`pwsh`), then Windows PowerShell 5.1, then `cmd`; Git Bash
  and WSL distributions can be chosen. Terminals load the user's PowerShell profile (`-NoLogo`); run configurations
  and workflow scripts run with `-NoLogo -NoProfile -NonInteractive` and keep a failing native command's exit code.
  Output is UTF-8 (code page 65001 / `[Console]::OutputEncoding`). Terminals end their whole process tree on close.
* **Execution policy.** Hato never passes `-ExecutionPolicy`. When PowerShell refuses a script (for example
  `npm.ps1`), run output shows the fix: `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`, or choose `cmd`.
* **Finding tools.** Programs are looked up on the PATH stored in the registry (machine + user), so tools installed
  after Hato started are found. npm `.cmd` shims start as `node.exe <entry script>`; other batch files (`mvn.cmd`,
  `gradlew.bat`) are started by path, and the kernel escapes their arguments for `cmd.exe` (refusing unsafe ones).
* **ACP agents.** `npm install -g` uses npm's own prefix (`%APPDATA%\npm`). Each provider declares
  `platforms.windows` (`supported` / `untested` / `unsupported`, `requires`, `note`) from its Windows smoke test:
  untested agents run with a warning, unsupported ones are disabled with a WSL hint, and a `git-bash` requirement
  is located and passed in the environment variable the provider names.
* **Language servers and debuggers.** Automatic installs go to `%LOCALAPPDATA%\Hato\language-tools` (zip archives,
  `.cmd` wrappers). LSP `file://` URIs (`file:///c%3A/…`) are matched case-insensitively.
* **Markdown code blocks** run in the terminal when its shell matches: `powershell`/`pwsh` blocks in PowerShell,
  `cmd`/`bat` blocks in `cmd`, and `sh`/`bash` blocks in Git Bash or WSL.

Native primitives used: `pty.open` `shellCandidates` (first installed program), `process.spawn` `verbatimArgs`
(local `cmd.exe` by absolute path only) and `env.info().windows` (system folders).

### Windows daemon

`hato daemon` runs natively for local projects (`env.info().hostFeatures` includes `daemon.local`):

* It listens on an AF_UNIX socket in `%USERPROFILE%\.hato\run` (or `%TEMP%\hato` for long paths) and serves only
  processes of the same Windows user (the peer's process id, then its token's user SID).
* It runs from a content-named copy, `%USERPROFILE%\.hato\bin\hato-<version>-<hash>.exe`, because Windows locks a
  running executable: rebuilding or updating Hato never fails because a daemon holds terminals. Unused copies are
  removed on the next start.
* Terminals are ConPTY sessions in the daemon; the desktop attaches to them over the socket. Persistent processes
  are started from their program, arguments and environment (no shell) and are put in a Job Object, so stopping
  one ends its whole process tree. Windows has no signals here: `INT`, `TERM` and `KILL` all end the job.
* The daemon is started detached and outside the app's job when the job allows it, so it outlives Hato.

## How it works (WSL and SSH)

A WSL project is a machine like an SSH host: `SshProfile.transport: "wsl"` keeps everything above the kernel the same.

| Channel | SSH host | WSL distribution |
| --- | --- | --- |
| Command, PTY | channels of the built-in SSH connection | `wsl.exe -d <distro> --exec /bin/sh -c …` (ConPTY for terminals) |
| Files | SFTP subsystem | the distribution's `sftp-server` over the same pipe |
| Daemon | Linux `hato` uploaded, `daemon ensure` | the same |
| Forward to a Windows listener | SSH reverse forward, connected to Windows' loopback directly | `hato daemon forward` relay |

WSL2 does not share `127.0.0.1` with Windows under its default networking, so forwards go through a relay
(`kernel/src/host/relay.rs`) over `wsl.exe`'s stdio. Linux daemons come with the package.

Local paths in the kernel are canonical and `/`-separated (`C:/Users/me`): see `util::canonical_string`. Module-supplied
relative paths on Windows are refused if they contain separators, drives, alternate data streams, DOS device names or
trailing dots and spaces (`grants::join_windows`). Symlink resolution and containment checks are otherwise the
same as on Unix.

## Limitations

* The Windows daemon holds terminals and processes; background agents and workflows on it are untested in native
  projects (use a WSL or SSH project for them). Its SSH command route and the Cloud connector are Unix-only. SSH to
  Windows hosts is not supported (hosts must be Linux or macOS).
* Native ACP adapters are marked *untested* until their Windows smoke test is recorded in the provider manifest.
* Workflow File/Pipe Triggers watch files only: named pipes (`mkfifo`) do not exist on native Windows.
* Started from Explorer or the Start menu, Hato does not add its working folder as a project; pass
  `hato.exe --root C:\path` to open a folder on start.

* Terminals through the daemon survive an app restart as long as the distribution keeps running. WSL may stop an idle
  distribution once no Windows process is using it, which ends them.
* The build is not code-signed, so SmartScreen may warn on first launch.
* Without `cargo-zigbuild` on the build machine, the bundled daemon links glibc, and needs a distribution at least as
  new as the build machine's, on x86-64. With it, static x86-64 and ARM64 daemons are bundled.
* The Windows package is not part of the signed release workflow.

## Building

From Linux or WSL, with MinGW-w64 (`gcc-mingw-w64-x86-64`) and `rustup target add x86_64-pc-windows-gnu`:

```sh
tools/release/package-windows.sh      # dist/Hato-<version>-windows-x86_64.zip
tests/integration/run-windows.sh      # from WSL: end-to-end test of that package
```

Native rebuilds are needed only for kernel changes. Module changes hot-reload as on other platforms.

`build.rs` embeds `assets/hato.ico` in the executable with MinGW's `windres`. After changing `assets/hato-icon.png`, run
`tools/windows/build-icon.py` (needs Pillow) and rebuild.

Release builds embed compiled shaders. GPUI's build script needs `fxc.exe` from the Windows SDK, which cannot run during a
Linux build, so `vendor/gpui-pre-windows` uses `prebuilt/shaders_bytes.rs`. After changing a vendored `.hlsl` file, run
`tools/windows/compile-shaders.sh` from WSL; it uses Windows' own `d3dcompiler_47.dll`, and needs no SDK. Debug builds of
that crate load shader sources from a build-machine path at runtime, so cross-built debug binaries cannot render:
use release builds on Windows.
