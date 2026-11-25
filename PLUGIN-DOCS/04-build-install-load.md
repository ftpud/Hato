# 4. Build, install and load

[← Rails](03-rails.md) · [Index](README.md) · Next: [Update, reload and roll back →](05-update-reload.md)

A plugin goes through distinct states. Keep them apart when reporting or debugging:

```text
source (.ts)  →  built (.mjs bundle)  →  installed (in <data>/plugins/<id>/)
              →  enabled + approved   →  active generation (running)
```

**A build alone changes nothing in a running app.**

## 1. Typecheck and build

From `Hato-plugins/`:

```sh
npm run typecheck                  # tsc --noEmit over all modules + SDK
npm run build -- notes notes-panel # bundle selected modules → build/modules/<id>.mjs
npm run build                      # or bundle everything
npm run watch                      # rebuild on module/SDK edits
npm test                           # typecheck + plugin repo tests
```

The builder (`tools/build-modules.mjs`) uses esbuild to produce ESM, platform `neutral`, ES2020.
It maps `@hato/sdk` to the host's `sdk/` folder (`../sdk`, or set `HATO_SDK_ROOT`). It checks
that each folder name matches its manifest id and only rewrites bundles whose bytes changed.
Modules marked `distribution: "marketplace"` are built too. They just aren't auto-loaded as
built-ins.

## 2. Make an installable folder

An installable module folder looks like this:

```text
notes/
├── manifest.json
└── dist/notes.mjs      (or dist/index.mjs)
```

You have two options:

- **Quick, local:** copy `modules/services/notes/manifest.json` and
  `build/modules/notes.mjs` → `dist/notes.mjs` into a scratch folder. Do the same for
  `notes-panel`.
- **Proper, versioned:** add a package to `plugins.catalogue.json` (see
  [Publish](09-publish.md)) and run `npm run export` (or `npm run release:prepare`).
  This writes `packages/notes/0.1.0/notes/{manifest.json,dist/notes.mjs}` with hashes.

## 3. Install in the app

1. Open **Settings → Plugins** (rail footer menu → Plugins).
2. Go to **Installed → Install from folder** and pick the module folder, for example
   `packages/notes/0.1.0/notes`.
3. Install **every member** of a multi-module feature. Install the service first, then
   the UI, because the UI depends on it. The marketplace package flow installs all members at once.
4. **Enable** the plugin. Installed user plugins start **disabled**.
5. **Approve** the trusted native dialog that lists the requested capabilities and
   `call:<module>` permissions.

The kernel copies the plugin to `<data>/plugins/<id>/` and records enabled state in
`<data>/plugins.json`. On macOS `<data>` is `~/Library/Application Support/Hato` (or whatever
`--data-dir` points to).

Installation **doesn't run npm or compile TypeScript**. You always install a built bundle.

## 4. Verify it's running

- The rail button appears (if the plugin has `activity`), and clicking it opens the panel.
- The **Modules** panel (rail footer menu → Modules) lists the module, its active build and logs.
- Agents connected through Hato's MCP can use `modules_list`, `modules_describe` and `modules_logs`.

## Development loop for built-in sources

If you run Hato from a checkout, you can skip install for modules **without**
`distribution: "marketplace"`:

```sh
cargo run -- --repo-root "$PWD" --dev-watch     # from the Hato repo
npm run watch                                   # from Hato-plugins, in another terminal
```

With `--dev-watch`, changed seed bundles are staged and activated automatically. Remember
that a *new* built-in needs a grant entry in `grants/first-party.json`, which is compiled
into Rust. That's why new plugins should use the installed/marketplace route instead.

## Where the running app reads code

A packaged app keeps an editable runtime under
`~/Library/Application Support/Hato/runtimes/<release>/`. A dev launch uses your checkout.
**Don't assume your checkout is what's running.** `module-dev.describe` (or `modules_describe`
over MCP) reports the real source, compiler and data paths.

Next: [Update, reload and roll back →](05-update-reload.md)
