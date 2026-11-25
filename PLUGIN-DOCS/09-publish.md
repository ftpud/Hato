# 9. Publish to the marketplace

[← ACP providers](08-acp-providers.md) · [Index](README.md) · Next: [Troubleshooting →](10-troubleshooting.md)

The marketplace is the `Hato-plugins` Git repository. Clients read its published
`catalogue.json` (repository and branch are set in `modules/ui/settings/src/marketplace.ts`)
and download versioned artifacts from `packages/`.

## Files involved (in `Hato-plugins/`)

| File | Role |
|---|---|
| `modules/{services,ui}/<id>/` | source |
| `plugins.catalogue.json` | **you edit this**: package definitions |
| `build/modules/<id>.mjs` | local build output |
| `packages/<pkg>/<version>/<module>/{manifest.json,dist/<module>.mjs}` | immutable exported artifacts |
| `catalogue.json` | generated catalogue with paths and SHA-256 hashes |

## 1. Define the package

Add an entry to `plugins.catalogue.json`:

```json
{
  "id": "notes",
  "name": "Notes",
  "type": "Productivity",
  "core": false,
  "author": "You",
  "version": "0.1.0",
  "coreVersion": "^0.1.0",
  "description": "Short notes with a rail panel.",
  "dependencies": { "foundation": "^0.1.36" },
  "modules": ["notes", "notes-panel"]
}
```

Each member manifest must agree with it:
- `"pluginPackage": "notes"`, a matching `"pluginType"`, and **the same `version`**
- `"distribution": "marketplace"` (so it isn't auto-loaded as a built-in)

`core: false` alone **doesn't** stop built-in discovery. You need `distribution: "marketplace"`.
Don't add `grants/first-party.json` entries for marketplace plugins. Users approve their
permissions instead.

`dependencies` are **package** version ranges, enforced at install and update. Raise the
minimum when you rely on a newer feature of another package.

## 2. Prepare the release

```sh
cd Hato-plugins
npm test                 # typecheck + catalogue/marketplace/release tests
npm run release:prepare  # build, bump changed packages, sync member versions, export artifacts + hashes
```

`release:prepare` doesn't commit or push. The exporter **refuses to overwrite committed
artifact bytes**: a changed bundle needs a version bump. Never rewrite or delete a published
version, because users roll back to it.

Remember that SDK helpers are bundled. Editing one can legitimately bump several packages.

## 3. Test locally before publishing

- Settings → Plugins can read **prepared local artifacts** from your checkout and merge them
  with published offers. Install from the Marketplace tab.
- Or use **Installed → Install from folder** with `packages/notes/0.1.0/notes` (and the
  other members).
- Use an isolated data directory (`--data-dir /tmp/hato-notes-test`) to test fresh-install
  and enable flows without touching your real setup.

## 4. Publish

1. Review: source, `calls` / `capabilities` / `contributes`, version agreement, dependency
   minimums, and that every `catalogue.json` path and hash matches an exported file.
2. Commit the plugin source, `plugins.catalogue.json`, `catalogue.json` and the new
   `packages/...` in **Hato-plugins** only. Host repo changes are a separate commit.
3. Push normally (no force-push). If the remote moved, reconcile it and re-validate the artifacts.
4. Verify the catalogue at the pushed commit lists your version and the hashes resolve.

Users then go to **Settings → Plugins → Refresh → Update** (or Install). Publishing doesn't
activate anything on anyone's desktop or remote runtimes.

## Install / update / uninstall from the user's side

Settings → Plugins has three tabs:

- **Marketplace:** Install resolves the dependency closure, verifies hashes, installs all
  members and enables them (with permission approval).
- **Installed:** package-level Update, Enable, Disable, Uninstall, plus Install from folder.
  Disabling something others depend on is surfaced, not silently cascaded.
- **System:** built-in plugins.
