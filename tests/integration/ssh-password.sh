#!/usr/bin/env bash
# Runs ssh-password.js against two throwaway sshds, one with password logins and one without. A
# non-root sshd cannot read /etc/shadow, so a preloaded shim supplies the test password's hash.
#   cargo build --no-default-features && npm run modules:build && tests/integration/ssh-password.sh
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
base="$(mktemp -d)"
trap 'for f in "$base"/*.pid; do [ -f "$f" ] && kill "$(cat "$f")" 2>/dev/null; done; rm -rf "$base"' EXIT
cat > "$base/shim.c" <<'C'
#include <shadow.h>
#include <stdlib.h>
static struct spwd entry;
struct spwd *getspnam(const char *name) {
  entry.sp_namp = (char *)name; entry.sp_pwdp = getenv("HATO_T_PW_HASH");
  entry.sp_lstchg = entry.sp_min = entry.sp_max = entry.sp_warn = entry.sp_inact = entry.sp_expire = -1;
  return &entry;
}
C
gcc -shared -fPIC -o "$base/shim.so" "$base/shim.c"
ssh-keygen -q -t ed25519 -N "" -f "$base/host"
export HATO_T_PW="c0rrect horse \$'\"\\ pass" HATO_T_PW_PORT=$((23000 + $$ % 1000)) HATO_T_PW_KEYONLY_PORT=$((24000 + $$ % 1000))
export HATO_T_PW_USER="$(id -un)" HATO_T_PW_ROOT="$base/root" HATO_T_PW_DATA="$base/data" HATO_SSH_KNOWN_HOSTS="$base/known_hosts"
start_sshd() { # port, password logins
  printf 'Port %s\nListenAddress 127.0.0.1\nHostKey %s/host\nPasswordAuthentication %s\nKbdInteractiveAuthentication no\nUsePAM no\nStrictModes no\nPidFile %s/%s.pid\nSubsystem sftp internal-sftp\n' "$1" "$base" "$2" "$base" "$1" > "$base/$1.config"
  HATO_T_PW_HASH="$(openssl passwd -6 -stdin <<< "$HATO_T_PW")" LD_PRELOAD="$base/shim.so" /usr/sbin/sshd -f "$base/$1.config" -E "$base/$1.log"
}
start_sshd "$HATO_T_PW_PORT" yes
start_sshd "$HATO_T_PW_KEYONLY_PORT" no
git init -q -b main "$base/root"
echo hello > "$base/root/hello.txt"
git -C "$base/root" -c user.name=t -c user.email=t@t add -A
git -C "$base/root" -c user.name=t -c user.email=t@t commit -qm init
"$here/run-integration.sh" "$here/ssh-password.js" "$base/data"
