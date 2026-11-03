#!/usr/bin/env bash
# Build the headless daemon binary (no window) for a remote platform.
#   tools/build-hatod.sh                               # this machine (release)
#   tools/build-hatod.sh x86_64-unknown-linux-musl     # Linux servers (static)
#   tools/build-hatod.sh aarch64-unknown-linux-musl
# Cross builds use cargo-zigbuild (`brew install zig && cargo install cargo-zigbuild`).
# The desktop kernel finds the result under target/<triple>/release/hato and uploads it on
# `daemon.ensure`; or copy it to <data dir>/daemon/<os>-<arch>/hato.
set -euo pipefail
cd "$(dirname "$0")/.."
triple="${1:-}"
if [ -z "$triple" ]; then
  exec cargo build --release --no-default-features
fi
rustup target add "$triple" >/dev/null
if command -v cargo-zigbuild >/dev/null; then
  cargo zigbuild --release --no-default-features --target "$triple"
else
  echo "cargo-zigbuild not found; trying plain cargo (needs a linker for $triple)" >&2
  cargo build --release --no-default-features --target "$triple"
fi
ls -la "target/$triple/release/hato"
