#!/usr/bin/env bash
# End-to-end test of the packaged hato.exe against a WSL distribution. Run from WSL, after
# tools/release/package-windows.sh. Everything it creates in Windows and Linux is removed at exit.
#   tests/integration/run-windows.sh [driver.js] [distribution]
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
driver_src="${1:-$here/windows-wsl.js}"
wsl=/mnt/c/Windows/System32/wsl.exe
distro="${2:-$("$wsl" -l -q | tr -d '\000\r' | grep -v '^docker-desktop' | head -1)}"
in_distro() { "$wsl" -d "$distro" --cd '~' --exec /bin/sh -c "$@"; }

temp="$(wslpath "$(/mnt/c/Windows/System32/cmd.exe /c 'echo %TEMP%' 2>/dev/null | tr -d '\r')")/hato-e2e-$$"
base="$(in_distro 'mktemp -d /tmp/hato-win-e2e.XXXXXX' | tr -d '\r')"
root="$base/My Проект"
daemon_dir="$base/daemon"
cleanup() {
  status=$?
  in_distro 'cd "$1" 2>/dev/null && git worktree list --porcelain | sed -n "s/^worktree //p" | tail -n +2 | while IFS= read -r w; do git worktree remove --force "$w"; done; [ -x "$3" ] && "$3" daemon stop --dir "$2" >/dev/null 2>&1; [ -f "$4/ssh/pid" ] && kill "$(cat "$4/ssh/pid")"; rmdir /tmp/hato-ssh-windows 2>/dev/null; rm -rf "$4"' sh "$root" "$daemon_dir" "$(ls_daemon)" "$base" || true
  # Killing this script does not end a Windows process it started.
  /mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='hato.exe'\" | Where-Object { \$_.CommandLine -like '*hato-e2e-$$*' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force }" >/dev/null 2>&1 || true
  sleep 1
  rm -rf "$temp"
  exit "$status"
}
ls_daemon() { in_distro 'ls "$1"/bin/hato-* 2>/dev/null | head -1' sh "$daemon_dir" | tr -d '\r'; }
trap cleanup EXIT

in_distro 'set -e; mkdir -p "$1/src"; cd "$1"; printf "fn main() { /* hato-wsl */ }\n" > src/main.rs; printf "текст\n" > "файл с пробелом.txt"; ln -s /etc escape-link
  git init -q -b main .; git -c user.name=t -c user.email=t@t add -A; git -c user.name=t -c user.email=t@t commit -qm init' sh "$root"

# A throwaway sshd in the distribution, for SSH projects through WSL's OpenSSH client.
ssh_port=$((22000 + $$ % 1000))
ssh_ready="$(in_distro 'set -e; d="$1/ssh"; [ -x /usr/sbin/sshd ] || exit 0; mkdir -m 700 "$d"; ssh-keygen -q -t ed25519 -N "" -f "$d/host"; ssh-keygen -q -t ed25519 -N "" -f "$d/client"; cp "$d/client.pub" "$d/authorized"
  printf "Port %s\nListenAddress 127.0.0.1\nHostKey %s/host\nAuthorizedKeysFile %s/authorized\nStrictModes no\nPermitRootLogin prohibit-password\nPasswordAuthentication no\nPidFile %s/pid\nSubsystem sftp internal-sftp\n" "$2" "$d" "$d" "$d" > "$d/config"
  mkdir -p /run/sshd 2>/dev/null || true; /usr/sbin/sshd -f "$d/config" && id -un' sh "$base" "$ssh_port" | tr -d '\r' | tail -1)"

mkdir -p "$temp"
cp -R "$repo/dist/windows/Hato" "$temp/Hato"
cat "$here/lib.js" "$driver_src" > "$temp/driver.js"
win() { wslpath -w "$1"; }
export HATO_T_DISTRO="$distro" HATO_T_ROOT="$root" HATO_REMOTE_DAEMON_DIR="$daemon_dir"
export HATO_T_SSH_USER="$ssh_ready" HATO_T_SSH_PORT="$ssh_port" HATO_T_SSH_KEY="$base/ssh/client" HATO_SSH_KNOWN_HOSTS="$base/ssh/known_hosts"
export WSLENV="HATO_T_DISTRO:HATO_T_ROOT:HATO_REMOTE_DAEMON_DIR:HATO_T_SSH_USER:HATO_T_SSH_PORT:HATO_T_SSH_KEY:HATO_SSH_KNOWN_HOSTS${WSLENV:+:$WSLENV}"
cd "$temp"
"$temp/Hato/hato.exe" --repo-root "$(win "$temp/Hato")" --data-dir "$(win "$temp/data")" --headless-script "$(win "$temp/driver.js")"
