# UI performance findings

Recorded 2026-11-25. This document consolidates the UI investigation, implemented fixes,
live profiles, and isolated primitive benchmarks. It describes the latest findings; older
entries in [ui-optimization.md](ui-optimization.md) include plans that have since been completed.

## Conclusion

The clearest remaining GPU target is **large panel gradients and shadows being rasterized on
every animation frame**. With identical content and rounded/bordered panels, captured median
fragment time was **2.72 ms flat → 4.18 ms with gradient → 5.31 ms with gradient and shadows**.
These are isolated captures, not measured savings from changing the running application.

A second GPU cost is **native path rendering**. Even a small canvas connector activates
additional full-window rendering passes. The spinner/ring conversion to SVG sprites removed
this cost for those common controls, but canvas curves and grid paths retain it.

The major CPU failure modes are **rebuilding large eager lists and transcripts** and
**unnecessary invalidation of otherwise unchanged views**. Native view caching and list
virtualization work: a cached 100-message workspace takes roughly 0.4 ms of CPU draw work on
a reused frame versus 7.7 ms when fully rebuilt.

Normal Ember glows were close to the flat baseline. Huge overlapping glows and shadows are
expensive in stress tests, but those tests do not establish that normal glow defaults are a
problem. The investigation has not covered every interaction or resource-backed control.

## Why a small animation can consume substantial GPU

Hato's current GPUI renderer rasterizes the window scene when a frame is requested. A spinner,
caret, scrollbar fade, terminal update, or surface update can therefore trigger rendering of
all visible backgrounds, borders, gradients, shadows, and text in that window.

There are three separate costs:

1. **Frame frequency:** how often animations, input, services, and tree updates request frames.
2. **CPU scene work:** constructing controls and performing layout, prepaint, and paint.
3. **GPU rasterization:** shading, blending, and compositing the resulting window scene.

GPUI view caching reduces CPU scene work by reusing layout and scene data. It is **not a
texture/raster cache**: a reused panel's effects still participate in GPU rendering. A static
shadow costs no continuous GPU work when nothing requests frames, but incurs work again when
another control keeps the window animating.

The current renderer uses whole-window rasterization. Avoiding all whole-window GPU work
would require further renderer support, such as retained raster surfaces or damage handling;
the current TypeScript tree/cache APIs do not provide that behavior. It is not a universal
requirement of native UI, nor a reason to rebuild every control for each frame.

## GPU evidence

### Actual panel styling

The `ember-panels-*` fixtures retain the same two panels, content, rounded corners, borders,
spacing, and normal Ember ambient glows. They add the actual dark panel gradient and card
shadows from [sdk/halo-glass.ts](sdk/halo-glass.ts),
[workspace-layout](Hato-plugins/modules/ui/workspace-layout/src/index.ts), and
[the Ember palette](Hato-plugins/modules/ui/workspace-layout/src/ember.ts).

| Appearance | Median active GPU fragment time | Fragment encoders per command buffer |
| --- | ---: | ---: |
| Flat rounded/bordered panels | 2.72 ms | 1 |
| Same panels with gradient | 4.18 ms | 1 |
| Same panels with gradient and shadows | 5.31 ms | 1 |

The gradient runs from `#181819` to `#0a0a0b`, with `toAt: 0.34`. The card shadows are a faint
inset highlight and a shadow with offset y=18, blur=40, and color `#00000099`.

The corresponding **untraced raster + GPU wait + CPU readback** medians across two runs were
12.93–13.68 / 12.96–13.91 / 15.69–16.42 ms. Both measurement methods support investigating
the combined card effects. The gradient-only difference is small in untraced wall timings;
the exact gradient-versus-shadow contribution needs further controlled comparison.

All three cases use one encoder, so the observed extra cost is within fragment rendering,
rather than the additional MSAA passes introduced by native paths. These measurements do not
provide per-shader counters or prove an exact percentage breakdown of the live application's GPU.

### Native paths and spinner sprites

Reviewing the pinned GPUI Metal renderer found that each native path batch:

1. Ends the current render encoder.
2. Clears and draws through a **window-sized 4× MSAA intermediate texture**.
3. Resolves the intermediate and resumes rendering the window.

The cost depends on more than the visible size of the path. The relevant dependency source is
`gpui-pre-apple-0.3.10/src/metal_renderer.rs`, particularly
`draw_primitives_to_texture` and `update_path_intermediate_textures`.

Spinners and ring gauges now use cached SVG alpha-mask sprites in
[node_paint.rs](kernel/src/ui/node_paint.rs). Spinners rotate an existing mask; gauges use
cached partial/full arc masks. The variant cache is bounded at 128 entries. The existing
module contract, sizes, thickness, color/alpha, labels, gauge caps, reduced-motion behavior,
and clock/FPS scheduling were preserved. General canvas paths were not converted.

Two live Metal captures before/after the sprite change recorded:

| Metric | Before sprites | After sprites |
| --- | ---: | ---: |
| Recorded frame numbers | 171 | 200 |
| Fragment encoder IDs per frame | 5 in every frame | 1 in every frame |
| Mean summed fragment intervals/frame | 12.634 ms | 7.970 ms |
| Median summed fragment intervals/frame | 11.843 ms | 7.576 ms |
| Mean vertex intervals/frame | ~0.264 ms | ~0.200 ms |

Mean fragment cost was about 37% lower in those captures. Content, device clocks, and activity
were not locked, so the stable **5→1 encoder change** is the strongest structural evidence.

The isolated suite independently found one encoder for both 1 and 128 spinner sprites.
A canvas without edges/grid used one encoder (~2.27 ms median fragment time); adding one
connector used three (~5.74 ms). A canvas grid also used three (~3.52 ms).

Before/after offscreen images covered spinner sizes 8–64 px and gauge values 0%, 1%, 25%, 74%,
99%, and 100%. Mean absolute RGB difference was 0.1136/255; 1.193% of pixels changed, and
0.165% differed by more than 32/255. Small edge/antialiasing differences were observed.

### Glows, overlap, and stress loads

- Actual Ember static glows (radii 170/120 px): ~2.34 ms, close to flat ~2.21 ms.
- Three large 640 px glows: ~9.61 ms.
- 32 overlapping 760×520 panels with 128 px shadow blur: ~16.87 ms.
- Overlapping opaque/translucent/gradient layers also increase raster/readback wall time;
  those wall measurements alone do not isolate GPU execution.

Ambient glow currently draws 16 concentric rounded quads per glow. Large coverage and overlap
can therefore become expensive. Normal Ember glows are much smaller and fainter than the
stress fixture. Removing normal glows is not justified by the stress result alone.

## CPU evidence and cache behavior

### List and transcript scaling

These ranges are the two untraced runs' median CPU draw times for a fully invalidated frame:

| Workload | CPU draw time |
| --- | ---: |
| Flat window | 0.046–0.061 ms |
| 1,000 intrinsic/content-sized tree rows | 17.607–17.615 ms |
| 5,000 intrinsic tree rows | 92.516–134.573 ms |
| 1,000 fixed-height virtualized tree rows | 0.706–0.735 ms |
| 5,000 fixed-height virtualized tree rows | 0.709–0.735 ms |
| 1,500 eager labels | 4.394–4.455 ms |
| 1,500 lazy labels | 0.307–0.317 ms |
| 25-message transcript | 1.572–1.654 ms |
| 100-message transcript | 6.524–7.045 ms |
| 32 native text inputs | 0.936–0.981 ms |
| 512 buttons | 10.843–10.896 ms |

Clipping offscreen content does not eliminate eager construction/layout. Virtualization is
the important distinction. Most existing tree panels, including projects and explorer,
already specify `rowHeight`. The browser network-request tree omits it and is worth auditing
for large histories. The intrinsic-tree result is a demonstrated failure mode, not evidence
that every live list currently pays that cost.

| Cached workspace | Retained CPU draw | Fully invalidated CPU draw |
| --- | ---: | ---: |
| 25 messages | 0.217–0.269 ms | 2.439–2.583 ms |
| 100 messages | 0.384–0.435 ms | 7.700–7.709 ms |

Long transcript rebuilds remain a target when streaming or scrolling invalidates content.
History virtualization or finer cache boundaries must preserve text selection, follow-to-bottom,
history paging, and scroll anchoring.

### Implemented native cache boundaries

- [tree.rs](kernel/src/ui/tree.rs): trees with independent layout allocations (`grow`, `height`,
  or `style.height`) use stable `CachedTree` entities. Intrinsically allocated tree controls
  retain the eager path; their row list can still be virtualized when a fixed row height exists.
- [panel_view.rs](kernel/src/ui/panel_view.rs): eligible module bodies use stable views per
  window/slot mount, planned once per immutable tree snapshot. Ordinary content, transcripts,
  Markdown, inputs, images, and native splits can reuse cached scenes.
- Eligibility is deliberately conservative. Frame-collected nodes, including popovers, modals,
  detached windows, slots, drop zones, theme/chrome, trusted controls, editors/canvas, presence,
  absolute children, item-height lazy lists, and unknown kinds retain the eager panel path.
  These nodes need shell bookkeeping that cannot simply be skipped by a cached wrapper.
- Invalidation covers changed module snapshots, theme/motion globals, control styles, bounds,
  clipping, inherited text style, fullscreen state, and native split dragging/release.
- Visible input handles are prepared before sibling event callbacks, preserving kernel-owned
  input entities, text, subscriptions, focus, and caret state across cached frames.
- Layout-motion revisions are scoped to their module. An unrelated module tree update no
  longer restarts another panel's layout-move animation.
- Shared paint clocks notify every affected view/window and deduplicate their scheduled work;
  notifying only the first cached view would leave other spinners frozen.

### Scrollbars were invalidating the transcript

Scrollbar fade and hover-width animations originally notified the containing AI panel, causing
unchanged transcript content to rebuild. Adding a cache inside that dirty parent did not solve
it: GPUI refreshes cached descendants when their dirty cached parent is rendered.

[scrollbar_layer.rs](kernel/src/ui/scrollbar_layer.rs) now renders transcript scrollbars in a
sibling native layer with window-scoped viewport geometry and clipping. Deferred prepaint
runs after the content has measured its bounds. Fades notify the scrollbar layer; actual native
scroll-offset changes also notify the content owner after event handling. Removed transcripts
clear bindings. Uncached panels retain the existing inline scrollbar path.

Transcript follow/prepend corrections request frames for their own view instead of using global
`window.refresh()`. Diagnostics distinguish `anim:transcript-follow` and `anim:transcript-anchor`.

Live `(Shell frames, AI body renders)` after isolation were `(278,20)`, `(151,1)`, `(176,5)`.
That verifies substantial content reuse, without claiming all invalidations are eliminated.

### Remaining eager work

A 5 s CPU sample included 479 main-thread `Window::draw` stacks: 194 included `Shell::render`,
with layout and paint branches represented by 110 and 111 samples. `PanelView` appeared in
one stack; no `EditorView` or `CachedTree` render stack was sampled. These are stack samples,
not exclusive CPU durations or proof that a view never renders.

Remaining eager shell/rail construction and layout are CPU targets. One native-call inefficiency
was removed: fullscreen state is queried lazily for `visibleWhen`, with one shared query per
child-filtering pass; unconditional nodes no longer call macOS for their visibility check.

## Frame sources and module fixes

- Native spinner/ambient `PaintClock` timers replace display-rate animation requests, with
  configurable FPS (spinner default 30) aligned to a shared ~33.3 ms grid. This limits common
  animation sources; it is not a global cap on every possible input/service/window redraw.
- Tree busy indicators use the shared capped clock. `TreeRow.iconBusy` lets a module replace
  a row icon with native activity without publishing new SVG/tree data for every rotation.
- `projects-panel` stopped regenerating its tree every 80 ms just to rotate busy icons
  (previously about 12 tree publications per second while an agent worked).
- `ai` background polling at 1.5 s skips `ui.invalidate()` when its relevant data signature is
  unchanged. User/data-triggered loads still invalidate normally.
- `workspace-layout` caps Ember dust at 20 FPS and exposes the persisted Appearance setting
  **Background motion** (`appearance.ambientMotion`). Off retains static glow and removes dust.
- Workflow-canvas pulse/spark animation remains a candidate for clock alignment/capping while
  visible. Caret blinking, hover, terminal output, surface frames, and real streamed data can
  also legitimately request frames and require separate interaction measurements.

With Background motion off and no active agents, three ~10 s samples measured **0.00% GPU
busy** and CPU **3.28%, 2.98%, 3.38%** (~3.2% mean). No busy-redraw log appeared. The log omits
windows at or below 5 FPS, so this does not prove literally zero frames. Idle GPU was already
addressed; active animation cost is the remaining issue.

## Live process usage: context and limits

| Stage | CPU | GPU busy | Frame/activity context |
| --- | ---: | ---: | --- |
| Earlier active baseline | roughly 30% | roughly 32% | Uncontrolled active-agent workload |
| Cached trees | 26.6%, 29.0% | 16.6%, 30.4% | ~23.7–28.2 FPS; improvement not sustained |
| Module-body caching | mean 23.4% | mean 18.1% | ~15.2–25 FPS; changing activity |
| Scrollbar isolation | mean 21.9% | mean 16.5% | ~15–28 FPS; changing activity |
| Sprite build | mean 32.03% | mean 27.25% | ~30.2–33.8 FPS; more frames rendered |
| No-motion/no-agent idle | mean ~3.2% | 0.00% | Three consecutive ~10 s samples |

These process percentages are not controlled A/B results. Higher FPS can increase total GPU
busy even when each frame becomes cheaper. Compare frame count, activity, and GPU work per
frame together. Do not describe the sprite change as an overall usage regression based solely
on the different-rate samples, or claim the earlier percentage decreases as controlled wins.

## Benchmark methodology and confidence

The reusable harness is [tools/render-bench/run.mjs](tools/render-bench/run.mjs), backed by the
development-only [snapshot renderer](kernel/src/ui/snapshot.rs). See its
[README](tools/render-bench/README.md), [results](tools/render-bench/RESULTS.md), and
[complete baseline JSON](tools/render-bench/baseline-2026-11-25.json).

- 67 deterministic cases; two untraced rounds; **134 validated CPU measurements**.
- 60 measured frames plus 16 warmup frames per mode for this baseline. The runner default is 80
  measured frames. `retained` permits cache reuse; `invalidated` forces full view invalidation.
- 1280×832 logical points, 2560×1664 physical pixels on the measured MacBook display.
- Optimized development build: Hato opt-level 1, dependencies opt-level 2, `snapshot` feature.
- Real native controls, hidden windows, fresh temporary data directories, no module/service boot.
- Fixed shuffled case order reduces order bias. PNG encoding is outside measured timings.
- 13 separate Metal System Trace cases, 120 measured frames per mode, with 253 summarized
  command buffers per case after trimming startup. Xcode/Instruments CLI is available locally.
- Offscreen buffers are grouped by command-buffer ID, not display-frame number, because the
  frames are not presented. The first 20 buffers and final buffer are excluded; this does not
  remove every warmup boundary. Vertex and fragment intervals may overlap and are not added.
- `draw_ms` measures CPU scene construction. **`raster_readback_ms` includes command encoding,
  GPU completion wait, and full CPU image copying; it is not pure GPU execution.** Its flat
  baseline is roughly 10 ms. Only the Metal exports isolate active GPU intervals.
- The live app stayed open. Device clocks, contention, and profiler overhead cause variation.
  Flat GPU p95 was 8.42 ms versus median 2.21 ms. Small deltas are not reliable wins.
- Event-loop timers are not pumped during the timed loop. Motion is off except for ambient
  fixtures, because reduced motion suppresses ambient rendering; glow fixtures have no dust.
  Sprites in ambient workspace cases may advance phase when painted. These tests do not measure
  real animation scheduling, display pacing, scrolling, hover, or streaming behavior.
- Fixture screenshots were checked. Reduced motion initially hid glows, and a non-stretched row
  hid the sidebar; both were corrected before the accepted runs. Six empty cached-panel results
  from unregistered slot IDs were replaced with validated `__` fixture modules. Early cases
  overlapping test compilation were repeated without compilation.
- Tests involving very large lists/layers deliberately exceed normal workloads. They establish
  scaling cliffs and mechanisms, not the composition of the user's actual current frame.

## Priorities from the evidence

1. **Make large panel gradients/shadows cheaper.** Compare the exact Ember fixtures before and
   after. Keep appearance policy and quality settings in TypeScript modules/shared SDK styles;
   use a small reusable native capability only if needed to preserve the look efficiently.
2. **Reduce avoidable frame requests and align remaining animation clocks.** Measure the effect
   at fixed animation/data rates; changing GPU work per frame and FPS are distinct wins.
3. **Replay streaming and scrolling deterministically.** Determine which events invalidate full
   transcript content and how CPU cost grows with history, preserving selection and anchoring.
4. **Audit unvirtualized large lists**, particularly browser network history. Most existing
   project/file trees already use fixed row heights.
5. **Measure resource-backed controls:** editor, diff, terminal, images, and surfaces require
   disposable documents/resources to reproduce realistic content. Static JSON cannot fully
   populate them. Interaction coverage also needs hover, drag, focus, and resize scenarios.
6. **Consider general native path rendering separately.** The spinner shortcut is complete;
   arbitrary canvas geometry may need renderer improvements beyond swapping an icon asset.

Shader-sample/timeline exports from the early live trace were empty, and the default GPU counter
selection was unhelpful. There is no trustworthy per-shader percentage breakdown of the complete
live window yet. Use controlled comparisons and direct GPU intervals for current conclusions.

## Validation, deployment, and related investigation

- `cargo build --features snapshot` succeeds. Latest native validation:
  `cargo test --lib --features snapshot ui::` — **47 passed**. Rendering regressions cover cache
  reuse/invalidation, shared clocks, native input/split behavior, scrollbars, follow/anchoring,
  visibility queries, and motion. Script syntax and `git diff --check` also passed.
- Native caching/scrollbar work was checkpointed in Hato commit `bc3d8fa`; baseline host/plugin
  work in `7054f5a` / `e324a8e`. Sprite/lazy-fullscreen follow-ups were built and verified after
  the user's relaunch. The separate benchmark runs need no activation in the running workspace.
  Build completion alone is not live module activation or a published release.
- Plugin artifacts foundation 0.1.60/core-acp 0.1.20 were prepared locally, not published in this
  investigation. The shared ACP prompt clarification came later and is absent from those
  prepared artifacts. Keep the nested plugin repository's commits/releases separate.
- Sidebar progress failures were stale MCP transports (`Transport closed`), not evidence of
  rendering failure. The current session's working progress endpoint acknowledged updates.
  [sdk/persistent-agents.ts](sdk/persistent-agents.ts) now specifies exact JSON, start/milestone/
  finish percentages, the accepted-percent acknowledgement, and checking `isError`/closed
  transports before assuming delivery. All consumers were rebuilt; active bundles were checked
  after module reload. TypeScript checks and all nine progress tests passed.
- Earlier plugin validation passed 118 tests and typechecking; SFTP pipeline tests passed three
  cases. A previously observed unrelated plugin-runtime test failure concerns `/private/var`
  versus `/var` canonicalization, not a rendering regression.
- Adjacent latency findings: daemon ensure was repeated unnecessarily and is now cached/shared;
  SFTP operations were serialized and are now pipelined. Remote list/read timings fell below the
  200 ms slow-op log threshold from earlier 400–2200 ms waits. Remaining non-render work includes
  redundant Git status commands across panels and repeated skill-file reads. These can affect
  responsiveness/CPU but are not evidence of GPU rasterization cost.

## Reproduce and locate the evidence

```sh
cargo build --features snapshot
node tools/render-bench/run.mjs --out /tmp/hato-ui-findings --rounds 2 --frames 60
node tools/render-bench/run.mjs --metal --rounds 1 --frames 120 \
  --case '^(flat|spinners-1|canvas-edges-1|glow-ember|ember-panels-.*)$' \
  --out /tmp/hato-ui-findings-metal
```

Use a fresh output path for each Metal run. No UI modules/services boot for these fixtures.
Never aim the benchmark at the user's real application data directory. Native changes require
rebuilding the benchmark binary; TypeScript fixture edits need only rerunning the script.

| Evidence | Local artifact |
| --- | --- |
| No-motion idle samples | `/private/tmp/hato-idle-sample.json` |
| Cached-tree CPU sample | `/private/tmp/hato-cached-tree.sample.txt` |
| Module-body-cache samples | `/private/tmp/hato-panel-cache-reloaded-sample.json` |
| Scrollbar-isolation samples | `/private/tmp/hato-scrollbar-isolation-sample.json` |
| Focused CPU profile | `/private/tmp/hato-render-next.sample.txt` |
| Live Metal before sprites | `/private/tmp/hato-render-gpu.trace`, `/private/tmp/hato-metal-gpu-intervals.xml` |
| Live Metal after sprites | `/private/tmp/hato-sprite-render-gpu.trace`, `/private/tmp/hato-sprite-metal-gpu-intervals.xml` |
| Sprite-build process usage | `/private/tmp/hato-sprite-render-sample.json` |
| Spinner/gauge visual comparison | `/private/tmp/hato-spinner-before.png`, `/private/tmp/hato-spinner-after.png` |
| Accepted primitive sweeps and replacements | `/private/tmp/hato-render-{bench,extra,repeat,panels}-20261125/` |
| Per-case Metal traces and exports | `/private/tmp/hato-render-metal{,-panels}-20261125/` |

Temporary artifacts may be removed by the operating system. The source fixtures and
repository baseline JSON preserve reproduction and summarized measurements. The baseline files
are present in the workspace; that does not imply they have already been committed/published.

Live diagnostics are implemented in [redraw_stats.rs](kernel/src/ui/redraw_stats.rs), logging
busy windows every ~10 s with causes such as `anim:paint-clock`, `panel:<module>`, `tree:<module>`,
`view:scrollbars`, transcript follow/anchor, terminal output, and surface frames. Prefer passive
sampling and Instruments. Debugger breakpoints on hot UI functions previously froze the app;
they are unsuitable for this profiling workflow.

## Appendix: complete accepted primitive sweep

The following tables are generated from
[baseline-2026-11-25.json](tools/render-bench/baseline-2026-11-25.json).
CPU and raster/readback columns show the range of the two runs' medians, in milliseconds.
Retained frames can still rebuild eager content. Raster/readback values include CPU copying.

| Fixture | Retained CPU | Invalidated CPU | Raster + wait + readback |
| --- | ---: | ---: | ---: |
| `buttons-128` | 2.627–2.628 | 2.597–2.670 | 10.049–11.746 |
| `buttons-32` | 0.634–0.713 | 0.630–0.685 | 9.881–11.216 |
| `buttons-512` | 10.792–10.903 | 10.843–10.896 | 11.294–11.311 |
| `canvas-edges-0` | 0.153–0.176 | 0.150–0.152 | 9.418–9.506 |
| `canvas-edges-1` | 0.167–0.168 | 0.154–0.161 | 9.290–9.305 |
| `canvas-edges-16` | 0.236–0.253 | 0.229–0.275 | 9.696–10.633 |
| `canvas-edges-64` | 0.471–0.502 | 0.455–0.499 | 9.958–12.260 |
| `canvas-grid` | 0.167–0.191 | 0.163–0.199 | 9.441–10.032 |
| `ember-panels-flat` | 0.300–0.307 | 2.664–2.813 | 12.934–13.678 |
| `ember-panels-glass` | 0.322–0.356 | 2.804–2.849 | 15.686–16.421 |
| `ember-panels-gradient` | 0.277–0.305 | 2.656–2.732 | 12.964–13.914 |
| `flat` | 0.058–0.067 | 0.046–0.061 | 9.593–9.765 |
| `glow-1-radius-320` | 0.055–0.072 | 0.048–0.050 | 9.888–9.975 |
| `glow-1-radius-640` | 0.056–0.101 | 0.051–0.054 | 10.053–11.209 |
| `glow-1-radius-96` | 0.049–0.052 | 0.052–0.077 | 9.325–10.334 |
| `glow-3-radius-640` | 0.065–0.074 | 0.066–0.087 | 13.841–20.652 |
| `glow-ember` | 0.055–0.079 | 0.051–0.065 | 9.768–10.361 |
| `gradient-layers-1` | 0.045–0.050 | 0.048–0.053 | 9.314–10.598 |
| `gradient-layers-32` | 0.137–0.151 | 0.121–0.164 | 13.714–19.508 |
| `gradient-layers-8` | 0.074–0.082 | 0.068–0.079 | 10.480–16.699 |
| `inputs-32` | 0.837–0.902 | 0.936–0.981 | 12.253–15.638 |
| `inputs-8` | 0.227–0.274 | 0.257–0.265 | 10.354–11.333 |
| `labels-eager-100` | 0.455–0.471 | 0.424–0.442 | 9.502–10.049 |
| `labels-eager-1500` | 4.414–4.429 | 4.394–4.455 | 10.141–10.162 |
| `labels-eager-500` | 1.576–1.643 | 1.500–1.574 | 9.970–11.094 |
| `labels-lazy-100` | 0.322–0.412 | 0.299–0.340 | 9.445–10.887 |
| `labels-lazy-1500` | 0.313–0.331 | 0.307–0.317 | 9.465–9.611 |
| `labels-lazy-500` | 0.306–0.309 | 0.307–0.318 | 9.431–9.799 |
| `markdown-1` | 0.145–0.158 | 0.142–0.161 | 9.595–10.354 |
| `markdown-10` | 0.661–0.680 | 0.664–0.760 | 9.634–9.669 |
| `markdown-50` | 2.962–3.211 | 2.948–2.975 | 10.001–10.148 |
| `opaque-layers-1` | 0.057–0.063 | 0.057–0.058 | 11.060–11.504 |
| `opaque-layers-32` | 0.152–0.162 | 0.142–0.146 | 15.280–18.307 |
| `opaque-layers-8` | 0.067–0.079 | 0.069–0.077 | 9.910–12.214 |
| `rings-1` | 0.064–0.074 | 0.067 | 9.492–9.979 |
| `rings-128` | 0.919–0.935 | 0.909–0.916 | 9.719–10.460 |
| `rings-16` | 0.154–0.229 | 0.164–0.235 | 9.682–10.827 |
| `shadow-1-blur-128` | 0.061–0.066 | 0.067–0.071 | 9.944–14.676 |
| `shadow-1-blur-32` | 0.048–0.080 | 0.046–0.069 | 9.838–10.377 |
| `shadow-32-blur-128` | 0.146–0.153 | 0.147–0.152 | 25.686–25.688 |
| `shadow-32-blur-32` | 0.152–0.162 | 0.152–0.159 | 21.132–21.556 |
| `shadow-8-blur-128` | 0.078–0.098 | 0.075–0.087 | 12.569–15.007 |
| `shadow-8-blur-32` | 0.076–0.102 | 0.070–0.078 | 11.388–11.531 |
| `spinners-1` | 0.060–0.061 | 0.060–0.075 | 9.445–9.966 |
| `spinners-128` | 0.510–0.539 | 0.522–0.534 | 9.935–10.965 |
| `spinners-16` | 0.103–0.162 | 0.099–0.178 | 9.659–10.535 |
| `switches-32` | 0.597–0.609 | 0.579–0.721 | 9.244–11.690 |
| `switches-8` | 0.179–0.195 | 0.183–0.230 | 9.472–9.900 |
| `transcript-100` | 6.492–6.514 | 6.524–7.045 | 10.278–10.785 |
| `transcript-25` | 1.562–1.771 | 1.572–1.654 | 9.837–10.140 |
| `translucent-layers-1` | 0.052–0.054 | 0.046–0.060 | 9.496–11.088 |
| `translucent-layers-32` | 0.135–0.140 | 0.140–0.149 | 17.020–17.461 |
| `translucent-layers-8` | 0.069–0.075 | 0.063–0.092 | 9.629–10.184 |
| `tree-fixed-100` | 0.096–0.098 | 0.724–0.771 | 9.875–10.439 |
| `tree-fixed-1000` | 0.092–0.115 | 0.706–0.735 | 9.538–11.002 |
| `tree-fixed-5000` | 0.093–0.099 | 0.709–0.735 | 9.522–10.180 |
| `tree-intrinsic-100` | 0.107 | 1.695–1.697 | 10.034–10.279 |
| `tree-intrinsic-1000` | 0.403–0.431 | 17.607–17.615 | 10.312–10.502 |
| `tree-intrinsic-5000` | 2.248–2.916 | 92.516–134.573 | 11.685–12.552 |
| `workspace-1-rail` | 0.098–0.100 | 0.723–0.747 | 9.566–10.329 |
| `workspace-2-toolbar` | 0.286–0.290 | 0.915–0.924 | 9.812–10.190 |
| `workspace-3-transcript` | 2.135–2.182 | 2.763–2.780 | 10.386–10.594 |
| `workspace-4-glow` | 2.178–2.344 | 2.799–2.809 | 13.201–13.231 |
| `workspace-5-shadows` | 2.274–2.396 | 2.967–3.024 | 13.927–18.037 |
| `workspace-cached-100` | 0.384–0.435 | 7.700–7.709 | 10.281–10.311 |
| `workspace-cached-25` | 0.217–0.269 | 2.439–2.583 | 9.873–11.463 |
| `workspace-cached-ember` | 0.244–0.361 | 2.474–2.712 | 10.162–13.077 |

### Complete direct GPU captures

These are separate traced runs. Times are active fragment intervals summed per command buffer,
in milliseconds; the p95 column exposes the broad timing tails. Encoder counts were consistent
within every accepted case. Vertex intervals may overlap fragment work and are excluded here.

| Fixture | Mean fragment | Median fragment | p95 fragment | Encoders/buffer | Buffers |
| --- | ---: | ---: | ---: | ---: | ---: |
| `canvas-edges-0` | 3.279 | 2.272 | 8.040 | 1 | 253 |
| `canvas-edges-1` | 6.183 | 5.744 | 11.612 | 3 | 253 |
| `canvas-grid` | 4.553 | 3.517 | 11.261 | 3 | 253 |
| `ember-panels-flat` | 3.416 | 2.717 | 8.508 | 1 | 253 |
| `ember-panels-glass` | 6.158 | 5.309 | 10.301 | 1 | 253 |
| `ember-panels-gradient` | 4.755 | 4.177 | 9.153 | 1 | 253 |
| `flat` | 3.295 | 2.209 | 8.418 | 1 | 253 |
| `glow-3-radius-640` | 10.159 | 9.605 | 14.130 | 1 | 253 |
| `glow-ember` | 3.202 | 2.339 | 7.567 | 1 | 253 |
| `shadow-32-blur-128` | 17.468 | 16.866 | 19.167 | 1 | 253 |
| `spinners-1` | 2.607 | 1.810 | 7.443 | 1 | 253 |
| `spinners-128` | 3.419 | 2.521 | 7.695 | 1 | 253 |
| `workspace-cached-25` | 2.854 | 2.148 | 6.649 | 1 | 253 |
