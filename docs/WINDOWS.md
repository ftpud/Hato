# Hato on Windows

The window runs natively on Windows. **Projects live in Linux**: in a WSL distribution, or on a Linux host
over SSH. Files, Git, terminals, agents and workflows all run on that Linux machine. Hato does not run
projects on the Windows filesystem, and there is no Windows daemon or Windows-side Git integration.

## Requirements

* Windows 10 version 1903 or later, or Windows 11 (64-bit x86), with Direct3D 11.
* For WSL projects: WSL with at least one distribution (`wsl --install`). In that distribution:
  * `git`, and the `openssh-sftp-server` package, which Hato uses for file access (often already present).
* SSH projects need no WSL: Hato has its own SSH client. It uses the Windows side's `%USERPROFILE%\.ssh` (keys and
  `known_hosts`), the Windows OpenSSH agent service or Pageant, and key paths are Windows paths. Keys kept only in a
  WSL distribution's `~/.ssh` must be copied there or added to the agent.

## Install and launch

Unzip `Hato-<version>-windows-x86_64.zip` to a folder you can write to, and run `Hato\hato.exe`. In-app module
builds write to that folder. Node is not needed on Windows; the package includes esbuild. Application data is in
`%APPDATA%\Hato`.

To add a project, press **+** in the project panel. **WSL** takes a distribution and a Linux path, or a folder under
`\\wsl.localhost` chosen with **Browse…**. **SSH host** adds a Linux host, signing in with the SSH agent, a key file or a password. `hato.exe --root
\\wsl.localhost\Ubuntu\home\me\project` registers a project on first launch.

## How it works

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
