#!/usr/bin/env bash
# Usage: tests/integration/run-integration.sh <test.js> [data-dir] [extra kernel args...]
# Concatenates lib.js + the test into a driver module and runs the kernel headless.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
test="$1"; shift
data="${1:-$(mktemp -d)}"; [ $# -gt 0 ] && shift
driver="$(mktemp -t hato-driver-XXXX).js"
cat "$here/lib.js" "$test" > "$driver"
exec "$repo/target/debug/hato" --repo-root "$repo" --data-dir "$data" --headless-script "$driver" "$@"
