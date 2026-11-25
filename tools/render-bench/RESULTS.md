# Native render baseline — 2026-11-25

The isolated fixture suite exposes clear scaling cliffs and validates the current view caching.
These are development-build measurements on this Mac, not promised release frame rates or a
claim that every interaction bottleneck has been found.

## Setup

67 deterministic cases, two untraced rounds, 60 measured frames plus 16 warmup frames per mode.
1280×832 logical / 2560×1664 physical pixels, optimized dev build (`cargo build --features
snapshot`), hidden windows, throwaway data directories, no module/service boot. Cases run in a
fixed shuffled order. CPU numbers below are the range of the two per-run medians. `retained`
allows native cache reuse; `invalidated` forces all views to rebuild.

The live application remained open. Device clocks/contention cause variation; small differences
should not be interpreted as wins. Early cases that overlapped a test compilation were repeated
without compilation. An initial cached-workspace fixture used unregistered slot IDs and rendered
empty panels; those six measurements are excluded and replaced by the validated `__` fixtures.
Actual PNGs were inspected for sidebar/content geometry and enabled glow rendering.

## CPU findings

| Fixture | Full rebuild, ms | Implication |
| --- | ---: | --- |
| Flat window | 0.05–0.06 | Renderer/Shell baseline is small with no content |
| 1,000 intrinsic tree rows | 17.61 | Already exceeds a 16.67 ms CPU frame budget |
| 5,000 intrinsic tree rows | 92.52–134.57 | Severe scaling cliff on invalidation |
| 1,000 fixed-height tree rows | 0.71–0.74 | Virtualization removes the row-count cliff |
| 5,000 fixed-height tree rows | 0.71–0.74 | Similar cost despite five times the data |
| 1,500 eager labels | 4.39–4.45 | Clipping does not avoid eager layout |
| 1,500 lazy labels | 0.31–0.32 | About 14× less CPU for this workload |
| 100-message transcript | 6.52–7.04 | Message rebuild cost still scales with history |
| Cached workspace, 25 messages | 2.44–2.58 | Reused frame: **0.22–0.27 ms** |
| Cached workspace, 100 messages | 7.70–7.71 | Reused frame: **0.38–0.43 ms**, about 19× less |
| 32 native text inputs | 0.94–0.98 | Ordinary control counts are modest here |
| 512 buttons | 10.84–10.90 | Eager control construction becomes expensive at stress counts |

Most shipped tree panels already supply `rowHeight`, including projects and explorer. The
intrinsic-tree result is a proven failure mode, **not evidence that those live panels currently
pay that cost**. The browser network-request tree omits `rowHeight`; inspect that caller before
allowing large request histories. Long transcript updates remain a more relevant candidate for
history virtualization or finer cache boundaries, while preserving selection/follow/anchoring.

## Direct GPU findings

Separate Metal System Trace runs use 120 measured frames per mode. The summary groups active
fragment intervals by command buffer, because offscreen frames are never presented. Each case
has 253 retained buffers after startup trimming. CPU pixel readback is excluded from these GPU
numbers. Vertex and fragment stages can overlap, so their durations are not added.

| Fixture | Median active fragment time, ms | Fragment encoders per buffer |
| --- | ---: | ---: |
| Flat | 2.21 | 1 |
| One spinner sprite | 1.81 | 1 |
| 128 spinner sprites | 2.52 | 1 |
| Canvas, no edges/grid | 2.27 | 1 |
| Canvas, one connector | 5.74 | 3 |
| Canvas grid | 3.52 | 3 |
| Actual Ember static glows (170/120 px) | 2.34 | 1 |
| Three 640 px glows (stress) | 9.61 | 1 |
| 32 overlapping 760×520 panels, 128 px shadows (stress) | 16.87 | 1 |
| Cached workspace, 25 messages | 2.15 | 1 |
| Actual Ember panels, flat rounded/bordered surfaces | 2.72 | 1 |
| Same panels, actual gradient added | 4.18 | 1 |
| Same panels, gradient and actual card shadows | 5.31 | 1 |

A tiny native path still activates GPUI's window-sized MSAA intermediate/resolve. Sprite-based
spinners avoid it; canvas curves/grid retain it. Encoder counts are stable structural evidence.
Absolute GPU timings have broad tails (flat p95 8.42 ms), so the small normal-glow/flat difference
is within noise. Large effects are expensive under stress; this does not establish normal Ember
glows as the current problem.

Actual panel styles are a more relevant target: keeping the same two panels, content, border,
radius and ambient glows, the captured medians increase from 2.72 ms (flat) to 4.18 ms (gradient)
to 5.31 ms (gradient + shadows). All remain one encoder, so this is fragment work rather than
the extra MSAA passes seen with canvas paths. The separate untraced raster+readback medians
were 12.93–13.68 / 12.96–13.91 / 15.69–16.42 ms respectively. Both methods support investigating
the combined card effects; the small untraced gradient-only difference is not resolved. These
are per-case captures, not a measured improvement from changing the running app's appearance.

The runner also records `raster_readback_ms`; its ~10 ms flat baseline includes GPU wait and a
full CPU image copy and **must not be described as GPU execution cost**.

## Next measurements

1. Optimize or expose quality settings for large card gradients/shadows, then compare the exact
   same fixtures before changing appearance defaults. Keep this policy in modules/SDK styles;
   introduce a native primitive only if needed to preserve the appearance efficiently.
2. Replay scrolling and streamed message updates at fixed rates. Determine which events invalidate
   the whole transcript and how cost grows with retained history.
3. Cover editor/diff/terminal/image/surface primitives using disposable document/resource handles;
   a static JSON tree cannot faithfully populate those resources.
4. Compare any proposed optimization against the same fixture, surface and build profile, then
   verify the interaction in the live app. Static sweeps do not cover hover, drag, service polling,
   animation scheduling or variable-height scroll anchoring.

Raw files remain local under `/private/tmp/hato-render-{bench,extra,repeat,panels}-20261125` and
`/private/tmp/hato-render-metal{,-panels}-20261125`. The accompanying baseline JSON stores the
validated per-case summaries. See [README.md](README.md) for reproduction commands.
