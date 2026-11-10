#!/usr/bin/env bash
# Run after building desktop modules and downloading both Linux daemon artifacts.
set -euo pipefail
: "${RELEASE_VERSION:?}" "${NUMERIC_VERSION:?}" "${MACOS_ARCH:?}" "${SIGNING_IDENTITY:?}" "${SIGNING_KEYCHAIN:?}"
app="$PWD/dist/Hato.app"
contents="$app/Contents"
# Recreate generated staging directories on persistent runners.
rm -rf "$app" "$PWD/dist/image"
mkdir -p "$contents/MacOS" "$contents/Resources" "$contents/node_modules/@esbuild"
bash tools/release/build-icon.sh assets/hato-icon.png "$contents/Resources/Hato.icns"
cp target/release/hato "$contents/MacOS/hato"
cp tools/release/launcher.sh "$contents/MacOS/hato-launcher"
chmod +x "$contents/MacOS/hato-launcher"
printf '%s\n' "$RELEASE_VERSION" > "$contents/Resources/release-version"
cp -R grants sdk "$contents/"
cp plugins.lock.json "$contents/"
# Preserve the existing module build capability without requiring Node on users' Macs.
cp -R "node_modules/@esbuild/darwin-$MACOS_ARCH" "$contents/node_modules/@esbuild/"
for arch in x86_64 aarch64; do
  destination="$contents/target/$arch-unknown-linux-musl/release"
  mkdir -p "$destination"
  tar -xzf "daemon-artifacts/hatod-linux-$arch/hatod-$RELEASE_VERSION-linux-$arch.tar.gz" -C "$destination"
  mv "$destination/hatod" "$destination/hato"
done
/usr/libexec/PlistBuddy -c 'Clear dict' "$contents/Info.plist"
/usr/libexec/PlistBuddy -c 'Add :CFBundleIdentifier string app.hato.desktop' "$contents/Info.plist"
/usr/libexec/PlistBuddy -c 'Add :CFBundleName string Hato' "$contents/Info.plist"
/usr/libexec/PlistBuddy -c 'Add :CFBundleIconFile string Hato.icns' "$contents/Info.plist"
/usr/libexec/PlistBuddy -c 'Add :CFBundleExecutable string hato-launcher' "$contents/Info.plist"
/usr/libexec/PlistBuddy -c 'Add :CFBundlePackageType string APPL' "$contents/Info.plist"
/usr/libexec/PlistBuddy -c "Add :CFBundleShortVersionString string $NUMERIC_VERSION" "$contents/Info.plist"
/usr/libexec/PlistBuddy -c "Add :CFBundleVersion string $GITHUB_RUN_NUMBER" "$contents/Info.plist"
/usr/libexec/PlistBuddy -c 'Add :NSHighResolutionCapable bool true' "$contents/Info.plist"
codesign --keychain "$SIGNING_KEYCHAIN" --force --options runtime --timestamp --sign "$SIGNING_IDENTITY" "$contents/node_modules/@esbuild/darwin-$MACOS_ARCH/bin/esbuild"
codesign --keychain "$SIGNING_KEYCHAIN" --force --options runtime --timestamp --sign "$SIGNING_IDENTITY" "$contents/MacOS/hato"
codesign --keychain "$SIGNING_KEYCHAIN" --force --options runtime --timestamp --sign "$SIGNING_IDENTITY" "$app"
codesign --verify --deep --strict --verbose=2 "$app"
# Exercise packaged path discovery outside the checkout.
(cd /private/tmp && HATO_RUNTIME_HOME="$RUNNER_TEMP/hato-runtimes" "$contents/MacOS/hato-launcher" --headless --data-dir "$RUNNER_TEMP/hato-smoke" --headless-script "$GITHUB_WORKSPACE/tools/release/smoke.js")
mkdir -p dist/image
mv "$app" dist/image/
ln -s /Applications dist/image/Applications
dmg="$PWD/dist/Hato-$RELEASE_VERSION-macos-$MACOS_ARCH.dmg"
hdiutil create -volname Hato -srcfolder dist/image -ov -format UDZO "$dmg"
codesign --keychain "$SIGNING_KEYCHAIN" --timestamp --sign "$SIGNING_IDENTITY" "$dmg"
xcrun notarytool submit "$dmg" --key "$NOTARY_KEY_PATH" --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER_ID" --wait --timeout 45m
xcrun stapler staple "$dmg"
xcrun stapler validate "$dmg"
