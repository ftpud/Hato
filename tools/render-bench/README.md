# Isolated native render benchmark

Build once: `cargo build --features snapshot`. Run from the repository root:

```sh
node tools/render-bench/run.mjs --out /tmp/hato-render-bench --rounds 2 --frames 80
node tools/render-bench/run.mjs --list
node tools/render-bench/run.mjs --case '^(flat|glow-|shadow-)' --out /tmp/hato-effects
# Separate run: pure GPU intervals from Instruments (requires Xcode and local tracing access):
node tools/render-bench/run.mjs --metal --rounds 1 --frames 120 --case '^(flat|spinners-1|canvas-edges-1|glow-ember)$' --out /tmp/hato-metal
```

Uses real Hato UiNode rendering at 1280×832 logical pixels (2560×1664 on a 2× display),
fixed test data and a fresh temporary data directory per case. No modules or project services
boot. Nothing is activated in the running application. Fixtures, images, raw measurements,
logs and CSV are saved together. Repeats use deterministic shuffled order to reduce order bias.
Use `--size WIDTHxHEIGHT`, `--binary PATH` or `--generate-only` to change the setup.

The suite sweeps eager/lazy labels, buttons, fixed/intrinsic trees, spinner/ring sprites,
ambient glow radius/count, overlapping opaque/translucent/gradient layers, shadow radius/count,
Markdown and transcripts, then builds up a representative workspace one feature at a time.
Cases intentionally include stress loads above typical usage. Equal-looking offscreen rows
remain relevant: eager layout can consume CPU even when clipped. Inspect PNGs before interpreting
a cheap case as success. Input/switch and canvas edge/grid cases cover further native controls
and path rendering. Cached workspace cases use actual slot boundaries through a fixture bundle
`{ "tree": UiNode, "modules": { "__rail": UiNode, "__body": UiNode } }`. Fixture module IDs must
start with `__` (reserved `__snapshot` is the root); normal plugin enablement checks still apply.
`ember-panels-*` keeps the same content and rounded/bordered panels, then adds the actual dark
Ember gradient and card shadows from `sdk/halo-glass.ts` and workspace-layout's palette.
Add fixtures here, not application-specific cases to the Rust renderer.

Each case warms 16 frames then measures 80 frames per mode. `retained` draws without forced
view invalidation; `invalidated` forces a complete native view rebuild on each frame. Both
rasterize the whole surface. Event-loop timers do not run during measurement. Motion is off
except in ambient cases, since reduced motion suppresses ambient drawing entirely. Glow-only
cases have no particles; sprites in the ambient workspace may advance phase when painted.
These measure primitive costs, not animation scheduling or display FPS. Measure scrolling,
hover, service updates and active animation scheduling separately in the live application.

`draw_ms` measures CPU scene construction (render/layout/prepaint/paint). **`raster_readback_ms`
includes command encoding, GPU wait and CPU pixel readback. It is not pure GPU duration.**
PNG encoding is outside the measured region. `--metal` records/exports a Metal System Trace for
each case and runs `metal-summary.py` to isolate active GPU intervals and encoder counts by
command buffer. Offscreen frames are not presented, so display frame numbers are unsuitable
grouping keys. It excludes the first 20 buffers and final buffer; this removes startup, not
every warmup boundary. Keep traced runs separate because instrumentation affects wall timings.
Do not subtract wall timings and label the difference GPU time. Keep surface size, power mode, build
profile and machine constant. Debug-build CPU results are diagnostic, not release FPS claims.

Native development-only seam:

```sh
target/debug/hato --repo-root . --data-dir /tmp/hato-one/data \
  --snapshot /tmp/hato-one/frame.png --snapshot-tree /tmp/hato-render-bench/flat.tree.json \
  --snapshot-size 1280x832 --snapshot-bench /tmp/hato-one/timing.json --snapshot-frames 80
```

`--snapshot-bench` requires `--snapshot-tree` to keep measurements isolated. It is compiled
only with the existing `snapshot` feature and needs no changes or restart in the live app.
