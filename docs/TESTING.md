# Running the integration suites

All suites run the real kernel headless (`--headless-script`) with a privileged `__driver` module that
exists only in that mode. They use real Git, PTYs, SQLite, ACP adapters and SSH — no mocks.

```sh
cargo build && npm run modules:build
FX=/tmp/hato-fx; eval "$(tests/integration/fixtures.sh $FX)"
COPY=$(tests/integration/mkcopy.sh /tmp/hato-repocopy)     # disposable repo copy (agents patch sources)
export HATO_T_BUILD=$COPY/build/modules HATO_T_REPO_ROOT=$COPY

# M2–M4 + hot swap, then M9 on the same data dir (restart recovery)
tests/integration/run-integration.sh tests/integration/m2m4-local.js /tmp/hato-d1 --root $HATO_T_REPO_A --repo-root $COPY
tests/integration/run-integration.sh tests/integration/m9-reliability.js /tmp/hato-d1 --root $HATO_T_REPO_A --repo-root $COPY

# M6/M8 with a real, logged-in ACP adapter
source tests/integration/agent-env.sh
export HATO_T_ACP=$(command -v claude-agent-acp) HATO_T_ACP_PROVIDER=claude
tests/integration/run-integration.sh tests/integration/m6m8-acp-local.js /tmp/hato-d6 --root $HATO_T_REPO_A --repo-root $COPY
```

## SSH suite with a throwaway user-level sshd

`cargo test --no-default-features --test ssh_builtin` checks the built-in SSH client on its own: it starts a
user-level `/usr/sbin/sshd` on a free loopback port with everything in a temp directory (skipped without
`sshd`), then covers host key trust, key login, commands, SFTP, terminals, signals, session limits and
reverse forwards. The suite below runs the whole app against such a server.

```sh
D=/tmp/hato-sshd; mkdir -p $D; cd $D
ssh-keygen -q -t ed25519 -N "" -f host_key; ssh-keygen -q -t ed25519 -N "" -f client_key
cp client_key.pub authorized_keys; : > kh_test
cat > sshd_config <<C
Port 2222
ListenAddress 127.0.0.1
HostKey $D/host_key
AuthorizedKeysFile $D/authorized_keys
PasswordAuthentication no
KbdInteractiveAuthentication no
UsePAM no
StrictModes no
PidFile $D/sshd.pid
AllowTcpForwarding yes
Subsystem sftp /usr/libexec/sftp-server
C
/usr/sbin/sshd -f $D/sshd_config
cd -
cp -R $HATO_T_REPO_A /tmp/hato-remote-gamma   # remote project root (a Git repo)
export HATO_SSH_KNOWN_HOSTS=$D/kh_test HATO_T_SSH_USER=$USER HATO_T_SSH_KEY=$D/client_key \
  HATO_T_REMOTE_REPO=$(cd /tmp/hato-remote-gamma && pwd -P) HATO_T_SSHD_PIDFILE=$D/sshd.pid HATO_T_SSHD_CONFIG=$D/sshd_config
tests/integration/run-integration.sh tests/integration/m5m7-ssh.js /tmp/hato-d5 --root $HATO_T_REPO_A --repo-root $COPY
```

When the SSH "remote" is the same machine, the suite writes `~/.local/state/hato/{bin,worktrees}` in
your home directory; remove it afterwards. Perf: `tests/integration/perf.js` (results in modules.log).

## Workspace layout

After `npm run modules:build` and `cargo build`, run both phases with the same fresh data directory:

```sh
HATO_T_PHASE=1 tests/integration/run-integration.sh tests/integration/layout.js /tmp/hato-layout-test
HATO_T_PHASE=2 tests/integration/run-integration.sh tests/integration/layout.js /tmp/hato-layout-test
```

These cover docking, resize/collapse events, floating and detached panel trees, bar controls,
recovery access when bars or the Layout item are hidden, persistence across restart, and reset.
Native pointer interactions and OS window appearance still require a desktop smoke test.

## Windows

`tests/integration/run-windows.sh`, run from WSL after `tools/release/package-windows.sh`, drives the packaged
`hato.exe` against a real distribution and a throwaway `sshd`, and removes everything it creates. Pass
`tools/release/smoke.js` as its argument for the packaged smoke test. Rust tests run on Windows through interop:
`cargo test --locked --no-default-features --target x86_64-pc-windows-gnu`. Neither opens a window; see
[WINDOWS.md](WINDOWS.md).

## SSH password logins

`tests/integration/ssh-password.sh` needs `gcc`, `openssl` and `/usr/sbin/sshd`, and no root: it starts throwaway servers and
preloads a shim that supplies a test password's hash. Build first with `cargo build --no-default-features && npm run modules:build`.

## Language plugins

`tests/integration/languages.js` uses disposable files and real language servers through the
kernel's scoped process/stream primitives. Build the native host and prepare marketplace artifacts
with `npm run release:prepare --prefix Hato-plugins` first, then run:

```sh
HATO_T_TS_SERVER=/absolute/path/to/typescript-language-server \
HATO_T_JDTLS=/absolute/path/to/jdtls JAVA_HOME=/path/to/supported/jdk \
  tests/integration/run-integration.sh tests/integration/languages.js /tmp/hato-language-check
```

The TypeScript launcher is required; JDTLS is optional. The driver checks SAP CDS/MTAEXT and TS
highlight registrations, cross-file definitions, viewer target/reveal routing, and optional Java
navigation, automatic startup, project settings, source-folder browsing, hover and the method picker. To add real SSH transport coverage against a throwaway loopback sshd, also set
`HATO_T_SSH_KEY`, `HATO_T_SSH_USER`, `HATO_T_SSH_PORT`, and an isolated `HATO_SSH_KNOWN_HOSTS`.
The SSH endpoint must see the same temporary directory and server executable as the local host.
It registers the SSH project without selecting it, avoiding remote daemon auto-installation.
Native Ctrl/Cmd-click and on-screen highlighting still need a desktop visual check.

## Marketplace catalogue lag and local installs

After preparing marketplace artifacts, run the real Settings install flow in an isolated profile:

```sh
tests/integration/run-integration.sh tests/integration/marketplace-local.js /tmp/hato-marketplace-check
```

This driver reads the public GitHub catalogue, installs the prepared SAP package through Settings,
and checks that the other language offers remain visible, system plugins are preserved, and the
normal native installation approval occurs. It needs network access. Deterministic catalogue-lag,
integrity-failure and fresh-profile staging regressions also run in `Hato-plugins/tests/marketplace.test.mjs`.

## Language dependency buttons and Markdown terminal close

After preparing the latest packages, this test checks the real Settings action buttons, downloads
JDTLS into a temporary tool directory, persists/verifies the workspace launcher, then closes a
running Markdown shell-block terminal and verifies that its PTY is released:

```sh
HATO_LANGUAGE_TOOLS_HOME=/tmp/hato-dependency-tools \
  tests/integration/run-integration.sh tests/integration/dependency-settings.js /tmp/hato-dependency-data
```

Use fresh directories for a download test; reuse the tool directory to exercise installation reuse.
It needs Python 3.8+ and network access. Installer unit tests cover hashes, archive containment,
launcher quoting, missing Java/Node runtime downloads, interrupted-install locks, errors and local/SSH
routing. Terminal regressions cover full colon-containing tab IDs, closing/reopening, and empty-workspace startup.
