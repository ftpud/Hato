# Marketplace packages: build, install, run, update and publish

## Source ownership and distribution

Application sources belong to the independent `Hato-plugins` repository, normally nested at
`Hato/Hato-plugins`. The SDK/native host belongs to the parent repository. Inspect both Git
statuses and keep their changes/commits separate. Paths below refer to `Hato-plugins` unless
explicitly marked as host paths.

A module is one service/UI runtime with a manifest and logical id. A marketplace package owns
one or more modules and installs/manages them as a feature.

| Resource | Location |
| --- | --- |
| Source | `modules/{services,ui}/<id>/manifest.json` and `src/index.ts` |
| Package definitions | `plugins.catalogue.json` |
| Published catalogue with paths/hashes | `catalogue.json` |
| Immutable artifacts | `packages/<package>/<version>/<module>/manifest.json` and `dist/<module>.mjs` |
| Local builds | `build/modules/<module>.mjs` |

For an optional module, declare `distribution: "marketplace"`. This excludes its source folder
from built-in runtime discovery, including development checkouts. Set the package's `core: false`
and an appropriate `type`; match each member's `pluginPackage`, `pluginType`, and `version`.
`core: false` alone does not prevent built-in discovery/automatic enablement. Do not add first-party
install grants for ordinary marketplace plugins.

Choose `runsOn` for the execution model. A desktop coordinator can use scoped remote processes
without being a daemon plugin. Workspace services participate in remote-runtime's push/lifecycle
flow. See [native and remote](native-and-remote.md).

## Contracts and permissions

Keep feature policy, defaults and contribution data in modules. Examples include
`contributes.languages`, Settings fields/actions through `exportSettings`, and SDK panel schemas.

Declare native capabilities actually used and explicit `calls` for RPC targets. Module
`dependencies` controls lifecycle; it does not itself grant RPC access. Package dependency ranges
control installation/update requirements between features. Raise minimum versions when a new
contribution needs a newer consumer, such as Settings action-button support.

Installed user plugins start disabled unless the marketplace flow enables them. The native
install/enable flow approves capabilities and `call:<id>` permissions. Scope/ownership/trusted
approval enforcement stays in the kernel. Never repair this by editing live approval files,
installed manifests or protected cached artifacts directly.

## Installing, enabling, running and updating

Settings → Plugins provides Marketplace, Installed and System tabs.

- Marketplace Install resolves the package dependency closure, validates manifests/bundles/hashes,
  stages files, calls the normal native installer, and enables new packages/dependencies.
- Installed offers package-level Update, Enable, Disable and Uninstall. Check dependents before
  disabling/removing a feature; do not silently cascade into other packages.
- Installed → Install from folder accepts a member directory containing `manifest.json` and
  `dist/<id>.mjs`, for example `packages/<package>/<version>/<module>`. Multi-member packages need
  all members; prefer the marketplace package flow or supported installMany API.
- Refresh reads the published catalogue. Update all applies discovered updates. An installed
  package moves out of Marketplace; unrelated available offers must remain visible.

A development catalogue can be newer than GitHub. Settings merges bundled and published offers
and can read prepared local artifacts through a scoped grant. Do not replace newer local offers
wholesale with an older remote catalogue when Install first refreshes. An unavailable artifact
should give a useful error without erasing the browser list.

Editing a source manifest does not update an installed copy. Rebuild/export and install the new
version, or use supported stage/activate tools. Runtime labels such as `settings@0014` are local
build numbers, not marketplace versions. Inspect installed metadata and the active generation.

For language dependencies, select the intended workspace, then Settings → Languages → Check
dependencies / Install missing dependencies. The workspace determines the machine, login
environment, scope, user tool directory and persisted executable preference. Never run a local
fallback for an SSH workspace or store a local executable path as its remote configuration.
Dependency recipes belong to provider contributions (`server.dependencySetup`). Install is an
explicit user action, uses verified downloads/user directories, and configures the launcher only
after checks pass. Keep in-flight work bound to the captured workspace if selection changes.

The JVM running JDTLS is separate from the project's JDK. Inspect the pinned distribution's core
bundle requirements as well as its launcher: upstream checks/docs can lag the actual bundle.
Use a versioned managed runtime and launcher-specific `JAVA_HOME`, preserving the project and
machine environment. Current platform support, prerequisites and smoke tests are in `LANGUAGES.md`.

## Building, preparing and publishing

Inspect current package scripts, then run from `Hato-plugins`:

```sh
npm test
npm run release:prepare
```

Preparation builds modules, bumps changed packages, updates member versions, rebuilds catalogue
consumers, and exports versioned manifests/bundles/hashes. It does not commit or push. SDK helpers
are bundled into consumers, so a helper edit can legitimately affect several feature packages.

Keep older artifact versions immutable. Bump a prepared/installed package when its bytes change;
do not replace a published version or delete rollback artifacts. The exporter rejects changes to
committed artifact bytes. Review source changes, calls/capabilities/contributions, member/package
version agreement, dependency minimums and host API compatibility. Verify every catalogue path
and hash against exported files and include those files in the release commit.

When the user authorizes publishing, fetch the configured remote/branch and inspect divergence.
Commit the reviewed plugin source, metadata, tests/docs and new artifacts in the plugin repository.
Do not include unrelated user work or push the parent host repository implicitly. Push normally;
do not force-push. If the remote advanced, reconcile it and revalidate affected release artifacts.
Check `modules/ui/settings/src/marketplace.ts` for the repository/branch actually read by clients
(currently `ftpud/Hato-plugins`, `main`).

Verify the remote branch SHA and fetch the catalogue at that exact revision. Confirm advertised
versions and artifact hashes are reachable. Report published versions and direct the user to
Plugins → Refresh → Update. Publishing does not activate the desktop or install remote runtimes.

## Activation and troubleshooting

Prefer existing module tools when connected and authorized: build stages and returns a stageId;
activate performs cutover. Preserve snapshots and kernel-owned resources. Distinguish built,
staged, activated and published states. If MCP reports Transport closed, check the live connection
before declaring the service disabled; an app restart can invalidate an old proxy. Report blocked
activation instead of editing live runtime files.

For denied RPCs, compare source/installed manifests, approved permissions and the active artifact
manifest. An installed manifest can be correct while an older cached artifact lacks its calls.
Artifact reuse must include JavaScript and manifest identity; see host `artifacts.rs` and
`Kernel::load_plugin`. Repair through normal updates/reloads and retain rollback artifacts.

Use isolated data directories for installation, enable/restart and SSH tests. Focused plugin tests
include `catalogue.test.mjs`, `marketplace.test.mjs`, `release.test.mjs` and language/dependency tests.
Host `docs/TESTING.md` documents `marketplace-local.js`, `languages.js` and `dependency-settings.js`.
