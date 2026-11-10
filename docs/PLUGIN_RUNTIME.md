# Independent plugin runtime

Hato contains the native kernel, SDK, trusted install bounds, and `plugins.lock.json`.
[Hato-plugins](https://github.com/ftpud/Hato-plugins) owns all module sources, manifests,
package metadata, build/release tools, and generated marketplace artifacts.

## Development

```sh
npm ci
npm run plugins:setup
npm run dev
```

Edit `Hato-plugins/modules/`. The watcher builds into `Hato-plugins/build/modules/`; the host's
explicit `--dev-watch` mode activates changed seeds, retaining resources and module snapshots.
Installed overrides do not shadow checkout modules in this mode. Native permission enforcement
is unchanged. The existing module-dev build/stage/activate tools resolve this source tree and
the host SDK. A plain `npm run modules:build -- settings` builds without activating unless a
watching host is running. SDK helpers are bundled into consumers and rebuild with their modules.

The one-time migration changes native paths, startup, and install primitives, so an older running
host needs a rebuild/restart before these paths and new live package operations are available.
Subsequent TypeScript changes and compatible plugin updates do not require a restart.

## Installed runtime

The packaged application contains no `modules/`, plugin catalogue, or plugin bundles.
It ships a small lock describing a pinned initial module set, artifact URLs, and SHA-256 hashes.
The generic native installer validates paths, digests, IDs, kinds, and manifests, prepares the
whole initial set privately, and renames it into `<data>/runtime/plugins`. Installation failure
leaves no partially visible initial set. Native setup/retry UI remains available without plugins.

The baseline persists independently of host release versions. Boot verifies baseline files;
missing/damaged files are reconstructed from verified download cache, fetching only when no
valid cache exists. User-installed updates in `<data>/plugins` override the downloaded baseline.
Existing registry preferences and module IDs stay stable. Native artifact history supplies
healthy previous generations for rollback. Application data is never reset during upgrades.
The initial lock keeps the full existing module set so current cross-service dependencies remain
available; separating optional installation profiles is a later dependency change.

Settings → Plugins exposes Marketplace / Installed / System. Package `core` controls System
classification even after a system plugin is updated through an installed override. Actual
manifest versions determine update availability. Permission decisions remain native.

## Publish

1. In Hato-plugins run `npm test` and `npm run release:prepare`.
2. Review and publish its source changes, catalogue, and new versioned artifacts together.
3. In Hato, fetch the plugin checkout and run `npm run plugins:lock` to advance fresh-install
   defaults to a published commit. The pin command rejects dirty artifacts and commits absent
   from the fetched `origin/main` history. Commit the lock with the next native release.

Plugin-only publishing does not require repackaging Hato. Existing installs use Refresh and
Update all, or update individual packages. Downloads and their dependency closure come from one
revision and are validated before native installation. Native installation approves a prepared
set once; synchronous failures restore old files and generations. Self replacement waits for the
requesting event to finish and keeps its old copy if health checks fail. Explicit Roll back update
restores the prior healthy artifact through the same native install path.

The catalogue continues to declare Hato compatibility. New host primitives must be guarded or
require a newer host; they cannot be delivered by a TypeScript plugin update alone.

## Verification

```sh
npm test
cargo check
cargo test --no-default-features --lib
cargo test --no-default-features --test arch_gate --test plugin_runtime
cargo build --no-default-features --bin hato
tests/integration/run-integration.sh tests/integration/plugin-updates.js /tmp/hato-plugin-updates-check
```

Use fresh isolated data for integration checks. Release smoke now starts from downloaded plugin
artifacts rather than compiling sources embedded in the app. The development runtime test checks
that a changed bundle in an independent checkout activates live and retains snapshot state.
