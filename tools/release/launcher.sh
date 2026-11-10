#!/bin/bash
set -euo pipefail
contents="$(cd "$(dirname "$0")/.." && pwd)"
# Plugin runtime lives in app data and survives host application upgrades.
# The host installs the pinned initial set on first launch; no plugin seeds ship in the app.
exec "$contents/MacOS/hato" --repo-root "$contents" "$@"
