# Signed releases

Push `.github/workflows/release.yml` to the default branch, then select **Actions → Build signed release → Run workflow**. The workflow builds Apple Silicon (`arm64`) and Intel (`x64`) DMGs, static Linux `hatod` archives for x86_64 and aarch64, and SHA-256 checksums. Both Linux daemons are bundled in each Mac app for existing automatic SSH installation.

The optional version accepts `Beta-0.0.1`, `0.2.0`, or `0.2.0-beta.1`. Empty means the highest numeric version among repository tags and Cargo.toml, with its minor incremented and patch reset to zero (initially `0.2.0`). Prefixes/suffixes are ignored when calculating that maximum. Existing tags are rejected. Runs are serialized. The version is recorded by a GitHub release tag after all builds succeed; failures consume no version. Cargo and Apple bundle metadata receive the numeric portion, while asset names and tags preserve the entered label. Labels containing a prefix/suffix other than `v` produce GitHub prereleases. Version changes apply only in CI, without committing changes to the branch.

## GitHub Actions secrets

Configure these under repository **Settings → Secrets and variables → Actions**:

| Secret | Value |
| --- | --- |
| `MACOS_CERTIFICATE_BASE64` | Base64 of an exported **Developer ID Application** `.p12`, including its private key. On macOS: `base64 -i certificate.p12 | pbcopy`. |
| `MACOS_CERTIFICATE_PASSWORD` | Password protecting that `.p12`. |
| `MACOS_SIGNING_IDENTITY` | Full identity, e.g. `Developer ID Application: Your Name (TEAMID)`. Find it with `security find-identity -v -p codesigning`. |
| `APPLE_API_PRIVATE_KEY` | Raw contents of an App Store Connect API `.p8` key authorized for notarization. |
| `APPLE_API_KEY_ID` | That API key's ID. |
| `APPLE_API_ISSUER_ID` | That API key's issuer UUID. This workflow uses a team API key. |

A `.p8` authenticates notarization; it does not replace the Developer ID signing certificate. A subscription/StoreKit key is not a notarization API key. Confirm the key type in App Store Connect; the filename alone does not prove compatibility. Never commit the `.p8`, `.p12`, or their passwords. CI imports the certificate into a temporary keychain, signs with hardened runtime and timestamps, submits each DMG to Apple, staples the accepted ticket, and deletes credentials even on failure.

The workflow publishes a GitHub release only when all four platform builds succeed. Artifacts remain available on successful individual jobs if a later job fails. The repository must permit Actions to create releases using `GITHUB_TOKEN`.

## Installed modules and updates

The signed app carries immutable module seeds, sources, SDK, esbuild, and Linux daemon binaries. Its launcher copies modules, grants, SDK, and build seeds to `~/Library/Application Support/Hato/runtimes/<release>/` on first launch. Subsequent launches reuse that directory, so approved source patches and module builds are writable and survive relaunches without altering the signed app. Tools and Linux binaries are linked from the app bundle.

Existing staging, approval, activation, rollback, and application data persistence continue to use kernel-owned storage. Each app release seeds a separate source tree; earlier edited source trees remain on disk. Source edits are not automatically merged into a newer release's sources. The launcher also accepts `HATO_RUNTIME_HOME` to relocate runtime source trees. Native kernel updates still require a new app build and restart.

## Local checks

Use `bash -n tools/release/{launcher,package-macos}.sh`, run `tools/release/version.py` with `RELEASE_VERSION` set, and run `actionlint` against the workflow. The Mac job typechecks/tests and builds modules, signs the bundle, boots the packaged app outside the checkout with a headless module smoke test, and validates the stapled DMG. Linux jobs execute the compiled binaries' help command on their native architecture. Full release verification requires GitHub runners, signing credentials, and Apple's notarization service.
