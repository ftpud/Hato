# UI and remote performance: handover

Status as of 2026-11-25, ~17:55 local. Continue from **Next steps**. All measurements are from the
user's MacBook (Built-in Liquid Retina, 2560×1664, ProMotion), running `target/debug/hato --root .`.

## Takeover checkpoint (2026-11-25)

- **Isolated native benchmark built and run:** `tools/render-bench/README.md` documents a
  development-only extension to snapshot rendering. 67 deterministic UiNode fixtures, two
  untraced rounds (134 validated measurements), plus 13 per-case Metal traces. Fixed 1280×832
  points / 2560×1664 pixels, throwaway data, no live modules/services. Retained vs fully
  invalidated views separate native caching from rebuild cost. `raster_readback_ms` includes
  CPU pixel copying; only the Metal summaries report direct GPU intervals. Results and limits:
  **`tools/render-bench/RESULTS.md`**, full summaries **`baseline-2026-11-25.json`** beside it.
  No live activation or user restart is needed to run this harness.
- **Proven CPU cliffs:** intrinsic trees rebuild 1,000 rows in ~17.6 ms and 5,000 in 92–135 ms;
  fixed-height virtualization stays ~0.7 ms at both counts. Most current panels already use
  `rowHeight`; the browser network tree is a caller worth auditing. 100-message cached workspace
  draws cost ~0.4 ms retained vs 7.7 ms fully invalidated, validating panel isolation. Streamed
  transcript updates/scroll interactions still need deterministic replay measurements.
- **GPU target narrowed:** a single canvas path changes 1→3 encoders (~2.27→5.74 ms median
  active fragment time in these captures). Spinners remain sprites with one encoder. Real
  Ember glows are close to flat baseline; three huge glows/32 large shadows are stress cases,
  not evidence against normal glow defaults. Actual Ember panel styling, identical content and
  rounded borders: **2.72 ms flat, 4.18 ms gradient, 5.31 ms gradient + card shadows**, all one
  encoder. Untraced wall measurements also show added cost for the combined card effects.
  Broad GPU tails limit small-delta claims; don't claim this is a live-app improvement yet.
  Next useful optimization is large card effects, keeping appearance policy in modules/SDK;
  follow with controlled streaming/scrolling and resource-backed editor/diff/terminal cases.
- Baseline changes committed at the user's request: **Hato `7054f5a`** and
  **Hato-plugins `e324a8e`**. Release artifacts are committed locally, not published. The host
  lock remains pinned to the previous published revision; do not pin it to an unpublished SHA.
- **Built and reloaded:** `cargo build` succeeds. The baseline was idle-verified; both native
  caching follow-ups were relaunched. Latest live measurements are recorded below.
- **New native fix:** layout-motion revisions are now scoped to the module that publishes a
  tree (`Motion::tree_changed` / `revision(module)`). An unrelated panel update no longer
  starts or restarts another panel's layout-move animation during a parent resize. A regression
  test covers unrelated updates, owner-triggered movement, and preserving an active animation.
- **Validated:** all 27 native UI unit tests pass (`cargo test --lib ui::`); all three SFTP
  pipeline tests pass (`cargo test --lib --no-default-features sftp::`). Plugin `npm test`
  passes all 118 tests and typechecking. Its loopback fixture initially hit sandbox `EPERM`;
  the approved rerun passed.
- **Prepared:** `npm run release:prepare` produced **foundation 0.1.60** and **core-acp 0.1.20**.
  Correction to the original notes: `ai` belongs to `core-acp`; `projects-panel` and
  `workspace-layout` belong to `foundation`. All catalogue artifact paths and SHA-256 hashes
  were checked against the generated files. Old release artifacts remain unchanged.
- **Idle verification complete:** user disabled Background motion; read-only persistence
  lookup confirmed `appearance.ambientMotion = false`. A passive sample started at 18:04:38
  local, after the agent's reply finished (25 s grace period). Three consecutive 10.07 s
  windows measured **0.00% GPU busy** each and **3.28%, 2.98%, 3.38% CPU** (~3.2% mean).
  No `redraws:` entries appeared during the sample. The logger suppresses windows at or below
  5 fps, so this does not prove literally zero frames. Results were saved to
  `/private/tmp/hato-idle-sample.json`. The zero-motion idle GPU target is met; residual CPU
  and active-animation per-frame cost remain separate optimization work.
- **After user relaunch:** startup log at 17:59:54 local and shifted diagnostic source lines
  confirm the new native build is running. Quiet post-startup windows were 15.0–15.2 fps,
  solely `anim:paint-clock`; during this agent's work they rose to 32.7–34.2 fps with paint
  clocks dominating (ambient plus busy spinners). A 10.04 s sample of desktop PID 83114
  measured 31.2% GPU busy and 29.7% CPU. This is an active-agent sample, **not** the requested
  Background-motion-off idle check or a measured improvement from the revision-scoping fix.
- **Per-module view caching is not implemented yet.** A direct wrapper around `render_slot`
  would be incorrect: rendering currently registers floats, detached windows, drop zones,
  modals, popover anchors, presence lifetimes and editor hover bindings before Shell assembles
  and prunes the frame. Cached views would skip those side effects, and lazy view rendering
  would run after Shell consumes the registrations. Separate frame registration/lifetimes from
  subtree rendering first, then introduce stable views per window/slot with explicit tree,
  theme/control-style and interaction invalidation. Test overlays, hidden/reopened panels,
  drag/drop and detached windows as well as animation isolation before enabling caching.

The baseline commits are local; publish only with authorization. Do not repin
`plugins.lock.json` to an unpublished plugin revision.

### First caching boundary (after the baseline commits)

- Native trees with independent layout allocations (`grow`, `height`, or `style.height`) now
  render through window/element-owned `CachedTree` entities. GPUI reuses their layout and scene
  data on unrelated frames. Content-sized trees keep their existing renderer path.
- This deliberately caches **tree controls**, not whole module panels. Trees do not register
  shell floats, slots, modals or detached windows; the shell's frame bookkeeping remains eager.
  Other inline content still rebuilds, and scene reuse is not a raster cache: static effects
  still incur GPU compositing/fill work. No live CPU/GPU improvement has been measured yet.
- Snapshot changes, control-style changes, theme and motion-style globals invalidate the cache;
  GPUI also handles changed bounds, clipping and inherited text styles. Native keyboard actions
  explicitly invalidate the cached tree as well as the shell. The separately laid-out root fills
  its allocated bounds, including flex allocation and animated dimension changes.
- Shared paint clocks now schedule one invalidation **per view and window**. Previously a shared
  spinner clock notified just the first view that painted; with independent caches, other lists
  could otherwise freeze. All timers still align to the common grid.
- Actual GPUI rendering regressions verify cache reuse, painted-row retention, snapshot/theme
  invalidation, keyboard focus/actions, and shared-clock invalidation without duplicate timers.
  The final `cargo test --features snapshot --lib ui::` passes all **44 tests**, and
  `cargo build` succeeds. This follow-up remains uncommitted for review. The user relaunched
  it (startup 18:21:46 local, binary mtime 18:21:45); the new renderer is now running.

### Live cached-tree measurement

- Background motion remains off (read-only persistence check). Two consecutive active-agent
  samples of PID 14273, 10.05 s each: **16.6% / 30.4% GPU busy**, **26.6% / 29.0% CPU**.
  Redraw windows around the samples were 23.7–28.2 fps, overwhelmingly paint clocks.
  Compared with the earlier ~32% GPU / ~30% CPU active sample, this does **not** establish a
  meaningful overall improvement; the lower first GPU sample was not sustained.
- Non-intrusive 3 s CPU profile: `/private/tmp/hato-cached-tree.sample.txt`. Main-thread frame
  work still includes Shell rendering/node construction, layout, and paint. No `CachedTree`
  render stack was observed in this short sample (consistent with reuse, not proof of it).
  The existing inline content remains the next CPU target; static scene fill/compositing
  remains a separate GPU cost that view caching alone does not remove.

Next: continue expanding cache boundaries after separating shell frame registrations from
module rendering; the first live sample shows native-list caching alone is insufficient.
Publish the already committed plugin releases only when asked, then update the host lock.

### Broader module-body caching (new follow-up, running)

- `panel_view.rs` adds stable cached module-body views per window and slot mount. Eligibility
  is planned once per immutable module snapshot, using an allowlist of audited native nodes.
  Ordinary panels, chat transcripts/markdown, inputs, images, and native splits are supported.
- Panels with frame-collected nodes (modals, popovers, detached windows, slots, drop zones),
  theme/chrome, trusted controls, native editors, presence state or lazy item-height lists stay
  eager. Unknown node kinds also stay eager. This avoids skipping registration/lifetime work;
  full separation of those registrations remains future work.
- Cache invalidation covers module snapshots, theme/motion globals, inherited control styles,
  bounds, clipping, text style, fullscreen state and native divider drags including release.
  `panel:<module>` diagnostic causes identify module-body renders in the redraw log.
- Input-slot creation is factored into a shared helper. Cached bodies prepare visible input
  handles before building sibling event callbacks, while keeping the existing kernel-owned
  input entities, subscriptions, text and caret state.
- `cargo check` and all **46 native UI tests** pass. New rendering regressions cover sibling
  isolation/paint retention, input handles, eager fallback, and actual native split dragging.
  Rebuilt native code was relaunched by the user; `panel:<module>` logs confirm it is running.

### ACP progress instruction clarification

- Updated shared `sdk/persistent-agents.ts` prompt/tool descriptions: exact JSON example,
  0–100 milestones, 80-character optional note, accepted-percent acknowledgement, and explicit
  handling of `isError` / `Transport closed` (a resolved tool call is not proof of success).
  Agents should try another available endpoint for their session instead of retrying a stale
  connection. Clarified the hidden HTML-comment format for agents without MCP tools as well.
- All module consumers were rebuilt; changed bundles are `agent-runner`, `ai-sessions`,
  `internal-mcp` and `internal-remote-mcp`. Both repositories' TypeScript checks and all nine
  progress tests pass. After the user's module reload, read-only registry/artifact checks
  confirmed active versions **0033 / 0024 / 0025 / 0037**, respectively; all four match the
  rebuilt bundle hashes and contain the clarified prompts. The already committed marketplace
  artifacts do not contain this prompt update yet.
- After app restarts the old `internal-local-mcp` and `internal-remote-mcp-local` connections
  returned `Transport closed`. `internal-remote-mcp/report_progress` returned accepted percent
  and the user confirmed the sidebar updates work. Always inspect progress tool results.

### Measurement after native and module reloads

- Discarded the sample interrupted by the user's module reload. Fresh sample started at
  **18:38:29 local**, desktop PID 32393, Background motion confirmed off. Three ~10 s windows:
  CPU **21.7%, 23.2%, 25.2%** (mean **23.4%**); GPU busy **14.8%, 17.7%, 21.9%**
  (mean **18.1%**). Raw data: `/private/tmp/hato-panel-cache-reloaded-sample.json`.
- Previous active readings were roughly 30% CPU / 32% GPU. Overall sampled load is lower, but
  frame rate and module activity also varied, so this is **not** a controlled A/B or proof of
  reduced GPU cost per frame. Fresh redraw windows were 15.2–25.0 fps, mainly paint clocks.
- The 15.2 fps window recorded **153 Shell frames, one `panel:ai` render and one `tree:ai`**:
  the AI body is being reused across unrelated animation frames. Another window had 144 AI
  body renders in 251 frames, so there is still intermittent cache invalidation/refresh work.

Next: investigate intermittent AI-body invalidations and remaining eager panel/scene costs.
Keep marketplace publication separate; prepare a newer release before publishing the prompts.

### Scrollbar animation and transcript refresh isolation (latest, running)

- Source tracing found that gpui-base scrollbar fade/hover-width animations notify their
  containing view. When that view is the AI panel, even an unchanged transcript is rebuilt.
  Nesting another cache below it does not solve this: GPUI refreshes cached descendants when
  it renders a dirty cached parent.
- Cached module panels now host transcript scrollbars in a **sibling native layer**, with
  retained, window-scoped viewport bounds and clipping. Its deferred prepaint runs after panel
  prepaint so it can use current geometry even on the first frame. Fades/hover animations
  notify the scrollbar layer; pointer/scroll/touch offset changes also notify the content view
  after native event handling. Panels without registered scrollbars skip the layer's view work.
- This layer lives inside the panel, so floating/detached placement and higher trusted window
  overlays keep their existing stacking. Uncached/eager transcripts retain their original
  inline scrollbar path. Removing a transcript clears its live layer binding.
- Transcript prepend/follow corrections now request another frame for their containing view
  (`anim:transcript-anchor`, `anim:transcript-follow`) instead of `window.refresh()`, which was
  bypassing every panel cache. Existing scrolling/follow/history policy is unchanged.
- All **47 native UI tests** pass. A real GPUI regression triggers scrollbar animation frames
  and verifies the transcript render count stays fixed, then checks native track-click
  scrolling does repaint content, history prepending retains its anchor, and removed bars
  leave no live bindings. `cargo build` succeeds; the user relaunched it (binary mtime 18:55:14
  local, startup 18:55:15). New scrollbar-layer and transcript-animation diagnostics are live.

### Live scrollbar-isolation sample

- Fresh sample at **18:56:00 local**, PID 55298, Background motion confirmed off. Three
  consecutive 10.06 s windows measured CPU **23.4%, 21.5%, 20.9%** (mean **21.9%**) and GPU
  busy **18.4%, 14.9%, 16.2%** (mean **16.5%**). Raw data:
  `/private/tmp/hato-scrollbar-isolation-sample.json`.
- The preceding module-body-cache sample averaged 23.4% CPU / 18.1% GPU. This is a small
  decrease in sampled overall load, not a controlled A/B improvement: frame rate, data updates,
  and native animations varied between samples.
- Recorded `(Shell frames, AI-body renders)` were **(278, 20), (151, 1), (176, 5)**.
  `view:scrollbars` matched frame counts; paint clocks remained the dominant frame source.
  The last interval had two `anim:transcript-follow` requests and no global transcript-refresh
  entries. No high-frequency AI-body rebuild burst appeared in this 30 s sample.

Next: profile remaining eager rendering and GPU fill/compositing while busy spinners keep the
window active. Remaining panel invalidations may include caret blinking, hover transitions,
streaming messages and other legitimate control/data changes.

### Checkpoint and focused CPU/Metal profiling

- Current panel/tree caching, scrollbar isolation and ACP prompt clarification were checkpointed
  in **Hato `bc3d8fa`**. Nothing pushed. The plugin repository had no new source changes.
- New 5 s non-intrusive CPU sample: `/private/tmp/hato-render-next.sample.txt`. Of 479 sampled
  main-thread `Window::draw` stacks, 194 included `Shell::render`; layout and paint branches
  accounted for another 110 and 111 respectively. These are stack-sample counts, not measured
  exclusive CPU durations. `PanelView` appeared in one stack, with no sampled EditorView or
  CachedTree rendering. Remaining eager shell/rail construction is still a CPU target.
- Removed an identified native-call inefficiency: `visibleWhen` now evaluates fullscreen state
  lazily, and child filtering shares one native fullscreen query per list. Nodes with absent or
  unknown visibility conditions do not query macOS at all. Existing visibility tests now also
  enforce that lazy-query behavior.
- Captured a real 5 s **Metal System Trace**, `/private/tmp/hato-render-gpu.trace`, using
  Instruments CLI. It is available on this machine; the earlier handover assumption that the
  user must record it manually no longer applies. Table exports are
  `/private/tmp/hato-metal-gpu-intervals.xml` and `/private/tmp/hato-render-gpu-toc.xml`.
- Hato's 171 recorded frame numbers had mean **12.634 ms** / median **11.843 ms** total fragment
  interval time per frame (range 7.234–18.659 ms); vertex intervals totaled 45.14 ms across
  the capture (~0.264 ms/frame). There were normally five GPU render commands per frame. This
  is interval accounting, not a complete shader-level attribution: shader sample/timeline
  tables were empty, and the default counter capture only exposed an unhelpful ray-tracing
  activity counter. Do not claim that the trace proves shadows or ambient glows dominate.

### Small arc sprites instead of full-window path passes (new, needs relaunch)

- Reviewing the pinned GPUI Metal renderer explained a concrete cost: every native path batch
  ends the current render encoder, clears/rasterizes through a **window-sized 4× MSAA texture**,
  resolves it, then resumes drawing into the window. Even tiny spinner/ring paths take this
  route. The trace's multiple render commands are consistent with these path-batch passes;
  the next live trace must confirm how much their removal changes total GPU time.
- Spinners and ring gauges now use cached SVG alpha-mask sprites. Spinners rotate the same
  cached sprite via GPUI's existing transform; rings use cached full/partial arc masks. Sizes,
  thickness, colors/alpha, labels, rounded gauge caps, reduced-motion behavior and clock/FPS
  scheduling retain the existing module contract. The local glyph cache is bounded at 128
  variants; sprite rasterization/atlas caching is provided by GPUI. These primitives no longer
  call `paint_path`; general workflow/canvas paths are unchanged.
- All **47 native UI tests** pass. Real isolated offscreen renders were inspected before and
  after at six spinner sizes (8–64 px) and gauge values 0%, 1%, 25%, 74%, 99%, 100%:
  `/private/tmp/hato-spinner-before.png` and `/private/tmp/hato-spinner-after.png`. The 840×400
  comparison had mean absolute RGB error 0.1136/255; 1.193% of pixels changed, with 0.165%
  differing by more than 32/255. Small edge/antialiasing differences are expected between
  polygonal native paths and rasterized SVG arcs.
- Native source changes are uncommitted after `bc3d8fa`; the desktop needs a relaunch to use
  them until the user's restart. That restart is now verified below; sprites are running.

Next: relaunch and repeat the Metal trace plus active CPU/GPU sample. Compare fragment time
per frame and render-command count, not just process GPU percentage (which varies with FPS).
Only then decide whether more work on shadows/glow overdraw or eager rail rendering is needed.

### Sprite renderer live verification

- User restarted; binary mtime **19:13:59 local**, startup **19:14:00**, desktop PID **73220**.
  Background motion remains off. Fresh process samples at 19:14:40 local:
  CPU **29.63%, 34.09%, 32.38%** (mean **32.03%**), GPU busy **24.67%, 27.38%, 29.69%**
  (mean **27.25%**), over three ~10 s windows. Redraw intervals were **30.2–33.8 fps**;
  the previous lower-percentage sample ran around 15–28 fps. Overall process usage did not
  decrease in these differently paced samples. Raw data:
  `/private/tmp/hato-sprite-render-sample.json`.
- Captured a separate 5 s Metal trace after process sampling (to avoid profiler contamination
  of those samples): `/private/tmp/hato-sprite-render-gpu.trace`. Exported GPU intervals:
  `/private/tmp/hato-sprite-metal-gpu-intervals.xml`. Analysis helper:
  `/private/tmp/hato-gpu-summary.py` (XML path and PID arguments).
- **Every one of 200 recorded frame numbers had one fragment render-command/encoder ID.**
  Before the sprite conversion, every one of 171 frames had five. This confirms removal of
  the spinner/gauge path-batch passes in the captured scene.
- Fragment interval time per frame: **mean 7.970 ms, median 7.576 ms**, range 5.782–11.689 ms;
  before: mean 12.634 ms, median 11.843 ms. Mean frame fragment cost decreased **~37%** in
  these captures. Vertex interval time was ~0.200 ms/frame, versus ~0.264 ms previously.
  Content, GPU clocks and activity were not locked for a laboratory benchmark; the command
  count change is the clearest structural result, supported by the lower per-frame timings.

Next: optimize remaining eager CPU/layout work and animation frame frequency. A single render
pass still spends ~8 ms in fragment work; controlled shadow/glow ablation or shader counters
would be needed to attribute that remaining cost. Do not judge this change solely by total
GPU percentage when the redraw rate differs.

## 1. Already committed and pushed (done)

| Repo | Commit | What |
|---|---|---|
| Hato-plugins | `1f1a2c2` | `remote-runtime`: ensure the daemon once per **machine** (was per project selection, ~1.2 s each). `workflows`: stop re-running `daemon.ensure` on every 1.2 s panel poll. |
| Hato-plugins | `fac01fd` | Release: remote 0.1.8, automation 0.1.12, foundation 0.1.59 (foundation only because `settings` embeds catalogue versions). |
| Hato | `d1bffe6` | `daemon_link::ensure_ssh` cached per live SSH connection (`hello` liveness check over the ctl link), per-machine ensure lock, ctl link kept on unchanged re-ensure, binary digest cached by size+mtime. Slow-op logging (`HATO_SLOW_OP_MS`, default 200). |
| Hato | `a20a85b` | `plugins.lock.json` re-pinned to Hato-plugins `fac01fd`. |

## 2. Baseline optimizations (committed locally; plugin publication pending)

### Hato repo (kernel + SDK)
- **Pipelined SFTP** (`kernel/src/host/sftp.rs`, `fs.rs`): many requests in flight per session.
  A reader thread routes responses by request id; writes go out 16×32 KB at a time; `close`
  and `setstat` don't block (sftp-server is in-order); `stat_many` for symlink targets in
  listings; a dead session fails pending requests at once (5 min backstop). Tests in
  `sftp.rs` run against the local `/usr/libexec/sftp-server`.
  Result: remote `fs.list`/`fs.read` went from 400–2200 ms (queued) to under the 200 ms log
  threshold. Project switching is fast now; first SSH connect is ~0.5 s, similar to OpenSSH.
- **Slow-op log improvements** (`ops.rs`): adds machine id, command (`git status`), daemon
  method, and `queued Nms` (SFTP write-lock wait, via `sftp::take_queue_wait`).
- **Redraw diagnostics** (`kernel/src/ui/redraw_stats.rs`, new): counts frames (in
  `Shell::render`) and causes. Causes are `tree:<module>`, `terminal-output`, `surface-frame`,
  `modules-changed`, `toasts`, `refresh:<file:line>`, `anim:<file:line>`, `anim:paint-clock`
  and `view:<terminal|editor|surface|detached>`. It logs one `redraws:` line to `kernel.log`
  per 10 s only when the window redraws at more than 5 fps. All `window.request_animation_frame()`
  and `window.refresh()` calls in `kernel/src/ui/*.rs` were wrapped mechanically with a
  `redraw_stats::cause(...)` call. Intended to stay (cheap), but could be compiled out later.
- **Frame-rate capping** (`kernel/src/ui/node_paint.rs`): `PaintClock` (spinner/ambient)
  redraws via a timer at the node's `fps` (default 30) instead of every display frame. All
  timers align to one shared 33.3 ms grid (`quantize`, `until_next_tick`), so several animated
  elements share frames. Adds `shared_spinner()`, a windowless spinner with one shared clock.
- **Tree rows** (`kernel/src/ui/tree.rs`): the `busy` indicator uses `shared_spinner` instead
  of gpui-component `Spinner` (uncapped `with_animation().repeat()`). New row field
  **`iconBusy`** replaces the row icon with the native spinner. The unused `Spinner` import
  was removed from `mod.rs`.
- **SDK** (`sdk/types.ts`): `UiAmbient.fps?`, spinner node `fps?`, `TreeRow.iconBusy?`.

### Hato-plugins repo (modules)
- `ui/projects-panel`: busy rows use `iconBusy` instead of re-rendering the whole tree every
  80 ms to rotate an SVG (that was about 12 tree updates per second while any agent worked).
- `ui/ai`: background-agent poll (`setInterval` 1.5 s, `load(ctx, true)`) skips
  `ui.invalidate()` when a JSON signature of page/auth/sessions/catalog is unchanged. Only timer
  polls skip; other `load()` callers always redraw.
- `ui/workspace-layout`: Ember dust `fps: 20`; new Appearance toggle **Background motion**
  (`appearance.ambientMotion`, default true, reset → true). Off uses `emberAmbientStill`
  (glow only).

### How these modules are currently deployed (important)
The Hato module tools (`internal-local-mcp`) were disconnected for this session, so nothing
was hot-activated through them. Deployment so far:
- `workspace-layout` 0068 was picked up automatically from `Hato-plugins/build/modules` at
  17:36 (module-dev scans builds).
- `projects-panel` and `ai`: built bundles were **copied over the installed plugin bundles** in
  `~/Library/Application Support/Hato/plugins/<id>/dist/<id>.mjs`; the kernel imports a changed
  installed bundle on startup. Originals are backed up in
  `~/Library/Application Support/Hato/plugin-backups-20261125-1748/`. Active now: `ai@0060`,
  `projects-panel@0053`. A proper plugin release (below) supersedes these copies.

## 3. Current measurements (idle, after all of the above)

| | Before | Now |
|---|---|---|
| Hato GPU busy (10 s sample) | 51% | 35% |
| Hato CPU | ~38% | ~28% |
| Redraws | 15–50/s, uncapped | ≤30/s (grid) |
| `tree:projects-panel` per 10 s | ~118 | 1 |

Remaining idle frames are only `anim:paint-clock` (Ember dust plus any spinner while an agent
works). **Per-frame cost is high: ~11 ms GPU and ~9 ms main-thread CPU**, because gpui re-lays
out and repaints the whole window for any frame.

## 4. Next steps (in order)

1. **Verify idle — done:** Background motion off, no active agents: 0.00% GPU busy across
   three 10 s samples, ~3.2% CPU, no busy-redraw log entries. See takeover checkpoint above.
2. **Commit** both repos (separate commits; Hato-plugins has its own history). Then **release
   plugins**: in `Hato-plugins`, run `npm test`, then `npm run release:prepare`, check that only
   the expected packages bumped (projects-panel/ai/workspace-layout are in `foundation`; check
   `catalogue.json`), commit and push. In Hato, run `npm run plugins:lock`, commit and push.
   See Hato-plugins `AGENTS.md`: don't publish without the user asking (the user did ask to
   publish earlier for the first round).
3. **Cut per-frame CPU (biggest remaining win):** render each module's tree as its own gpui
   view/entity and use gpui view caching (`AnyView::cached` / `.cached(style)`), so an animation
   frame re-lays out only the dirty panel. Today `Shell::render` (`kernel/src/ui/mod.rs` ~1850)
   builds every module tree inline. Keep tree data in Shell; make thin per-module views that
   read it. Watch `motion.revision`, which every `UiMsg::Tree` bumps globally (`mod.rs` ~230)
   and may trigger layout-move animations (`node_motion.rs:204`) for all panels. Scope it per
   module.
4. **Find the GPU cost per frame:** run an Instruments Metal System Trace (the user has to
   run it), or bisect by temporarily disabling the ambient glow (`node_paint::ambient`,
   16 concentric quads × glows), large `shadow` styles (`style.rs:100`, blur up to 128), and
   translucent panel layers. 11 ms per frame on a 2560×1664 surface suggests fill-rate/overdraw.
5. Remaining uncapped animation: `canvas.rs:335` workflow-canvas pulse
   (`with_animation().repeat()`), only while a workflow canvas is visible. Move it to a paint
   clock if it matters.
6. Smaller leftovers:
   - Git panels: each `git.changed` makes about 5 panels refresh, each running several git
     commands (342 git runs in the first 2 minutes after startup). Share one status run in the
     `git` service.
   - `files` and `persistent-agents` read the same `.agents/skills/*/SKILL.md` multiple times.
   - `remote-runtime` can ensure twice per machine when a status check races the first ensure
     (cheap now, ~30 ms).
   - The user's SSH profiles all use the public IP `83.99.157.68` (4.4 ms RTT through the
     router, vs ~1 ms on LAN). Profile `cf665ab8` uses password auth, so every connect waits
     for the password prompt.

## 5. How to measure

GPU per process (Apple Silicon; in `ioreg` the `AppUsage` line comes **before**
`IOUserClientCreator` within each `AGXDeviceUserClient` block):
```sh
PID=$(pgrep -f "target/debug/hato --root" | head -1)
snap() { ioreg -l -w0 -r -c AGXDeviceUserClient | perl -ne 'if(/\+-o AGXDeviceUserClient/){ $t{$p}+=$g if defined $p; $p=undef; $g=0 } if(/IOUserClientCreator" = "pid (\d+), ([^"]+)"/){$p="$1 $2"} if(/AppUsage/){ while(/accumulatedGPUTime"=(\d+)/g){$g+=$1} } END{ $t{$p}+=$g if defined $p; print "$_\t$t{$_}\n" for keys %t}'; }
snap > /tmp/g0; c0=$(ps -o time= -p $PID); sleep 10; snap > /tmp/g1; c1=$(ps -o time= -p $PID)
perl -e 'open A,"/tmp/g0";while(<A>){chomp;($k,$v)=split/\t/;$a{$k}=$v} open B,"/tmp/g1";while(<B>){chomp;($k,$v)=split/\t/;$d=$v-($a{$k}//$v); printf "GPU %6.1f%%  %s\n", $d/10e9*100, $k if $d>0}' | sort -k2 -rn | head -3
echo "cpu $c0 -> $c1 over 10s"
```
Redraw causes: `grep "redraws:" ~/Library/Application\ Support/Hato/logs/kernel.log | tail`.
Slow ops: `grep "slow op" …/kernel.log | tail`. CPU profile: `sample $PID 5 -file /tmp/h.sample`
(safe, non-intrusive).

## 6. Gotchas

- **Never set lldb breakpoints on hot gpui functions** (`App::notify`, `Window::refresh`) in
  the user's live app. It froze Hato and needed a restart. `request_animation_frame` produced 0
  hits even when the paint clock was active (likely inlined), so prefer `redraw_stats`.
- After editing Rust, `cargo build`. The user restarts the app (the dev script uses
  `cargo run`). Check that the process start time (`ps -o lstart=`) is later than the binary's
  mtime.
- Installed plugins (`~/Library/Application Support/Hato/plugins/<id>`) are loaded from their
  `dist/`, not from the checkout. Use the module tools (`modules_build`/`modules_activate`) when
  they're connected; otherwise see section 2.
- Pre-existing failing test, unrelated: `plugin_runtime::single_module_metadata_matches_discovery_and_stays_fresh`
  (`/private/var` vs `/var` on macOS).
- AGENTS.md: app behaviour belongs in modules, primitives in Rust; keep Hato and Hato-plugins
  commits separate; report built / staged / activated / needs restart honestly.
