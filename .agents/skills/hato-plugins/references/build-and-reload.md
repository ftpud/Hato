# Build, activation and verification

Run commands from the repository root. Inspect `package.json` and `tools/build-modules.mjs`
when changing build behavior.

## Build tree

```text
modules/{services,ui}/<id>/manifest.json
└── manifest.entry (normally src/index.ts)
    ├── imports inside the module
    ├── imports from sdk/              Bundled into this consumer
    └── .sql / .md imports             Embedded as text
        └── esbuild: ESM, neutral platform, ES2020, bundle enabled
            └── build/modules/<id>.mjs Built-in seed artifact
                ├── startup imports changed seed into artifact store
                ├── --dev-watch stages/activates changed seeds
                └── explicit module tools build/stage/activate at runtime
```

The builder discovers manifest folders, checks id/folder agreement and only rewrites bundles
whose contents changed. Type checking is separate from esbuild. Modules run inside the embedded
JS runtime, not Node or a browser; use `ctx.host`, not Node filesystem APIs or DOM globals.

```sh
npm run typecheck
npm run modules:build                    # all built-in seeds
npm run modules:build -- files git       # selected seeds
npm run modules:watch                    # rebuild seeds on module/SDK edits
node --test tests/ts/                    # module/helper tests
```

`modules:watch` alone does not update a running app. Developer seed auto-activation requires the
app to have been launched with `--dev-watch`:

```sh
cargo run -- --repo-root "$PWD" --dev-watch
```

For normal live updates use the existing module tools. `module-dev` implements source browsing,
patching, compile/build, stage, activate, rollback and update scans in
`modules/services/module-dev/src/index.ts`. Its build flags match the standalone builder;
build output is staged through native module APIs. Check current method arguments there before
calling. The `module-dev` method named `build` compiles **and stages**, returning `stageId`; it does not
activate. `activate {id, stageId}` performs cutover; `buildAndActivate {id}` combines both.
The standalone builder only writes seed bundles. Build, stage and activation are separate states;
native approval requirements still apply.

For optional marketplace modules, versioned artifacts, local installs and publication, follow
[marketplace](marketplace.md). A source folder need not be a bundled system plugin.

## Adding a built-in plugin

- Create `modules/services/<id>/` or `modules/ui/<id>/`, with a manifest and default AppModule
  export. See the lifecycle reference for schema and permissions.
- Add install bounds in `grants/first-party.json`; this is compiled into the native binary.
  Grant only capabilities and module calls actually used.
- For UI panels, put composition data in manifest contributions. Do not add a Rust panel branch.
- Build and check the module. A new install bound requires a Rust rebuild and app restart.
  Existing module source edits ordinarily only require rebuilding/activating that module.

Installed user plugins use their own folder and `dist/<id>.mjs` seed convention. The built-in
builder only discovers `modules/`; do not assume it bundles arbitrary installed plugin folders.

## Which layer changed?

| Change | Required work |
|---|---|
| Module TS only | Typecheck, affected bundles, relevant tests, activate affected modules |
| Shared SDK helper | Find imports, rebuild and activate each affected consumer |
| Manifest/contributions | Check plugin discovery/rescan and module consumers; verify activation |
| Compiled first-party grants | Native rebuild and restart |
| Rust host/UI or JS prelude | Native checks/build and restart; rebuild remote binary if affected |
| Persistence schema | Add module-owned migration and test upgrade/idempotence; bundle and activate |

```sh
cargo check --no-default-features
cargo build
cargo test
# An isolated headless app; choose a fresh task-specific data directory:
tests/integration/run-integration.sh tests/integration/file-watch.js /tmp/hato-watch-check
# Static Linux x86-64 remote binary (Zig + cargo-zigbuild required):
tools/build-hatod.sh x86_64-unknown-linux-musl
```

Tests that need fixtures or SSH require the setup in `docs/TESTING.md`. Do not run all integration
drivers blindly against a user's app data or repositories. Use relevant checks, preserve existing
workspace/resources and state explicitly whether the final running desktop was activated.
