---
name: self-configure
version: 1
description: Choose the correct Hato runtime, update modules or install plugins, and verify or recover the live app.
---
# Self-configure Hato

Use this guide when changing Hato itself. It does not authorize unrelated changes or bypass native approvals.

## Find the live runtime first

Call `modules_list`, then `modules_describe` for the target. Its `runtime` reports exact `repoRoot`,
`modulesRoot`, `buildTool`, `pluginsDir`, `artifactsDir` and `dataDir`. Older module-dev versions may omit
`runtime`; use `modules_read_source` for the running module rather than guessing a source directory.
Do not assume the current workspace checkout is the source tree used by the app.

- The macOS `.app` contains the native executable, compiler, remote binaries and initial module seeds.
- A packaged launcher copies sources and seeds once per release to a writable runtime, normally
  `~/Library/Application Support/Hato/runtimes/<release>/`. Edit that runtime through module tools.
  Do not patch signed `.app/Contents` files. A development launch can instead use a checkout.
- Saved builds live in `<dataDir>/artifacts`; the active selection is recorded in the module registry.
  Module `@NNNN` numbers are saved builds, not release versions. Startup retains the selection while
  the supplied seed hash is unchanged; a changed seed on a new release can replace it.
- User plugins live in `<dataDir>/plugins/<id>`. Workflow definitions and script commands belong to
  workflow-runner on the workspace daemon, normally under `~/.hato/data/sqlite/` locally or remotely.
  Changing the desktop does not automatically replace already-running daemon code.

## Choose the smallest update

Keep behavior, defaults, layout and labels in TypeScript modules. Read manifests, SDK contracts and
callers before changing them. A missing native primitive, capability enforcement, trusted approvals,
or the native process runner needs a native build and relaunch; module activation cannot apply Rust.

For an existing module:
1. Read `inspect-module` and `patch-module`; inspect the active source, preserve unrelated edits and
   snapshot/workspace state, then apply the authorized change.
2. Read `build-and-test-module`; typecheck and run relevant checks when checkout tools are available.
   Call `modules_build`: this compiles and stages an artifact, without changing the active app.
3. Read `activate-and-verify`; call `modules_activate` with the returned stageId, inspect versions and
   logs, and verify the actual changed behavior. Report built, staged, activated, or restart required.

Shared SDK helpers are bundled into consumers: rebuild and activate every affected consumer.
Maintenance patch tools only write inside an existing module; they cannot edit SDK files, grants,
Rust, or arbitrary new module IDs. Use the authorized development checkout for those changes and
account for the live runtime separately. Do not claim a local seed build activates a packaged app.

## New plugins and JavaScript

A plain `.js` file is not a complete Hato plugin. Prepare a folder named after its unique module ID,
with `manifest.json` and a runnable entry. Supply `dist/<id>.mjs`, `dist/index.mjs`, or a JavaScript
`.js`/`.mjs` manifest entry. The default export must declare `moduleApiVersion: 1` and implement an
AppModule. Bundle TypeScript and external imports beforehand; installation is not an npm install.
The embedded JS runtime has no Node or browser globals: use the Hato SDK/host capabilities.

Install the folder through Settings → Plugins, then enable it and approve its declared permissions.
Existing module-maintenance MCP tools do not install new plugins or grant capabilities. Tell the user
which concrete installation step remains if current tools cannot perform it. New built-ins also need
compiled first-party install bounds and a native rebuild; prefer user plugins for ordinary extensions.

## Recovery and failed updates

The Modules selector uses saved artifacts: Bundled is the imported seed for that runtime (a development
seed in checkout mode); Updated is the latest custom build that activated successfully, not merely staged.
It does not erase source edits or rebuild anything. The Modules panel itself stays updated so the
selector remains available. `modules_rollback {id,toVersion}` can explicitly select a known saved build;
verify version/origin/status with describe first. Do not label the first or an arbitrary previous build
as the bundled release. On old kernels without seedVersion, seed-origin history is only a fallback.

A failed compile is not evidence that the active module stopped. Preserve the working generation,
inspect the full diagnostics, fix the cause and retry only when something changed. In older native
builds, compiler output above the 4 MB stream buffer can deadlock and time out; that needs the native
process-runner fix and a rebuilt app, not repeated builds or shorter approval prompts.

Native approvals remain required for source writes, staging and cutover. Stop on denial and report it.
Do not replace a daemon with live agents/workflows to force an upgrade. Report any pending daemon
upgrade separately from desktop activation, and do not start real workflows just to verify UI changes.

For an internal-mcp self-update over its own connection, build/stage first and activate from the
Modules panel when no MCP call is in flight. The server deliberately refuses to replace itself
mid-call. Keep that guard; report staged rather than active until the UI cutover is verified.
