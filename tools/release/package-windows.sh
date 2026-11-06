#!/usr/bin/env bash
# Build dist/Hato-<version>-windows-x86_64.zip from Linux or WSL (MinGW and the Rust target
# x86_64-pc-windows-gnu are required). The app window runs on Windows; projects, Git, terminals and
# agents run in WSL or on Linux hosts, so the package carries the Linux daemon for them.
#   RELEASE_VERSION=0.2.0 tools/release/package-windows.sh
# Shaders come from vendor/gpui-pre-windows/prebuilt (tools/windows/compile-shaders.sh).
set -euo pipefail
cd "$(dirname "$0")/../.."
version="${RELEASE_VERSION:-$(sed -n 's/^version = "\(.*\)"/\1/p' Cargo.toml | head -1)}"
esbuild_version="$(node -p "require('./package.json').devDependencies.esbuild")"

npm ci --no-audit --no-fund >/dev/null
npm run -s modules:build
cargo build --release --locked --target x86_64-pc-windows-gnu

# Prefer static musl daemons (any distribution); fall back to glibc from this machine.
daemon_triples=()
if command -v cargo-zigbuild >/dev/null; then
  for triple in x86_64-unknown-linux-musl aarch64-unknown-linux-musl; do
    rustup target add "$triple" >/dev/null
    cargo zigbuild --release --locked --no-default-features --target "$triple"
    daemon_triples+=("$triple")
  done
else
  echo "cargo-zigbuild not found: bundling a glibc daemon, which needs a distribution at least as new as this machine" >&2
  cargo build --release --locked --no-default-features --target x86_64-unknown-linux-gnu
  daemon_triples+=(x86_64-unknown-linux-gnu)
fi

stage="dist/windows/Hato"
rm -rf dist/windows
mkdir -p "$stage/build" "$stage/node_modules/@esbuild/win32-x64"
x86_64-w64-mingw32-strip -o "$stage/hato.exe" target/x86_64-pc-windows-gnu/release/hato.exe
cp -R modules grants sdk "$stage/"
cp -R build/modules "$stage/build/"
# Keeps in-app module builds working without Node on the Windows side.
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
(cd "$work" && npm pack --silent "@esbuild/win32-x64@$esbuild_version" >/dev/null && tar -xzf ./*.tgz)
cp "$work/package/esbuild.exe" "$stage/node_modules/@esbuild/win32-x64/"
for triple in "${daemon_triples[@]}"; do
  mkdir -p "$stage/target/$triple/release"
  install -m 755 "target/$triple/release/hato" "$stage/target/$triple/release/hato"
done
python3 - "$PWD/dist/Hato-$version-windows-x86_64.zip" dist/windows <<'PY'
import os, sys, zipfile
out, base = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for d, _, names in os.walk(base):
        for n in sorted(names):
            p = os.path.join(d, n)
            z.write(p, os.path.relpath(p, base))
print(out, os.path.getsize(out))
PY
