#!/usr/bin/env bash
# Creates fixture repositories for integration tests under $1 and prints export lines.
set -euo pipefail
base="$1"; rm -rf "$base"; mkdir -p "$base"
base="$(cd "$base" && pwd -P)"
mk_repo() {
  mkdir -p "$1/src"; cd "$1"; git init -q -b main
  printf 'fn main() {\n    println!("hello from %s");\n}\n' "$(basename "$1")" > src/main.rs
  printf '# %s\n' "$(basename "$1")" > README.md
  printf '\x00\x01\x02binary' > logo.bin
  ln -s /etc escape-link
  git add -A; git -c user.email=t@t -c user.name=t commit -q -m init; cd - >/dev/null
}
mk_repo "$base/alpha"; mk_repo "$base/beta"
mkdir -p "$base/plain"; echo "notes" > "$base/plain/notes.txt"
echo "export HATO_T_REPO_A=$base/alpha HATO_T_REPO_B=$base/beta HATO_T_PLAIN=$base/plain"
