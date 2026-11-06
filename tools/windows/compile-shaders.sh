#!/usr/bin/env bash
# Regenerate vendor/gpui-pre-windows/prebuilt/shaders_bytes.rs. Needs a Windows machine: run from
# WSL (interop), or from Git Bash with HATO_WIN_TEMP set. Only after changing the vendored shaders.
set -euo pipefail
cd "$(dirname "$0")/../.."
crate=vendor/gpui-pre-windows
win_temp="${HATO_WIN_TEMP:-$(wslpath "$(cmd.exe /c 'echo %TEMP%' 2>/dev/null | tr -d '\r')")}"
work="$win_temp/hato-shaders-$$"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work"
cp "$crate"/src/*.hlsl "$work/"
rustc --edition 2021 -O --target x86_64-pc-windows-gnu tools/windows/compile-shaders.rs -o "$work/compile-shaders.exe"
win_work="$(wslpath -w "$work")"
"$work/compile-shaders.exe" "$win_work" "$win_work\\shaders_bytes.rs"
mkdir -p "$crate/prebuilt"
cp "$work/shaders_bytes.rs" "$crate/prebuilt/shaders_bytes.rs"
grep -c '_BYTES' "$crate/prebuilt/shaders_bytes.rs"
