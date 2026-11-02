#!/usr/bin/env bash
# Make a disposable copy of the repository (sources + built seeds; node_modules symlinked) so tests
# that let an agent patch module sources never touch the real checkout.
set -euo pipefail
src="$(cd "$(dirname "$0")/../.." && pwd)"; dst="$1"
rm -rf "$dst"; mkdir -p "$dst"
rsync -a --exclude target --exclude node_modules --exclude .git --exclude .dev-data "$src/" "$dst/"
ln -s "$src/node_modules" "$dst/node_modules"
echo "$dst"
