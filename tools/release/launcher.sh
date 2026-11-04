#!/bin/bash
set -euo pipefail
contents="$(cd "$(dirname "$0")/.." && pwd)"
version="$(cat "$contents/Resources/release-version")"
runtime_home="${HATO_RUNTIME_HOME:-$HOME/Library/Application Support/Hato/runtimes}"
runtime="$runtime_home/$version"
mkdir -p "$runtime_home"
if [ ! -d "$runtime" ]; then
  staging="$(mktemp -d "$runtime_home/.seed.XXXXXX")"
  trap 'rm -rf "$staging"' EXIT
  for directory in modules grants sdk build; do
    ditto "$contents/$directory" "$staging/$directory"
  done
  # rename(2) ensures another launch cannot observe a partially seeded runtime.
  if [ ! -d "$runtime" ]; then mv -n "$staging" "$runtime"; fi
  rm -rf "$staging"
  trap - EXIT
fi
# Tools and remote binaries stay signed/sealed in the app; refresh paths if the app moves.
ln -sfn "$contents/node_modules" "$runtime/node_modules"
ln -sfn "$contents/target" "$runtime/target"
exec "$contents/MacOS/hato" --repo-root "$runtime" "$@"
