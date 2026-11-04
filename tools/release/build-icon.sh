#!/usr/bin/env bash
# Convert the source artwork into the macOS icon representations, preserving alpha.
set -euo pipefail
source_image="${1:-assets/hato-icon.png}"
destination="${2:-build/Hato.icns}"
if [ ! -f "$source_image" ]; then
  echo "Icon source not found: $source_image" >&2
  exit 1
fi
temporary="$(mktemp -d)"
trap 'rm -rf "$temporary"' EXIT
iconset="$temporary/Hato.iconset"
mkdir -p "$iconset" "$(dirname "$destination")"
for size in 16 32 128 256 512; do
  sips -s format png -z "$size" "$size" "$source_image" --out "$iconset/icon_${size}x${size}.png" >/dev/null
  retina=$((size * 2))
  sips -s format png -z "$retina" "$retina" "$source_image" --out "$iconset/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$iconset" -o "$destination"
