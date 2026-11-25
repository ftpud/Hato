# UI and remote performance: handover

Status as of 2026-11-25, ~17:55 local. Continue from **Next steps**. All measurements are from the
user's MacBook (Built-in Liquid Retina, 2560×1664, ProMotion), running `target/debug/hato --root .`.

## Takeover checkpoint (2026-11-25)

- Preserved the pending changes in both repositories. Nothing committed or pushed in this
  continuation; release artifacts are prepared locally, not published.
- **Built:** `cargo build` succeeds. The running app has not been restarted by this agent, so
  the additional native change below is **not verified live** and needs the user's relaunch.
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

Next: review/commit the two repositories separately and publish only with authorization;
then continue the caching refactor described above. Do not repin `plugins.lock.json` to an
unpublished/uncommitted plugin revision.

## 1. Already committed and pushed (done)

| Repo | Commit | What |
|---|---|---|
| Hato-plugins | `1f1a2c2` | `remote-runtime`: ensure the daemon once per **machine** (was per project selection, ~1.2 s each). `workflows`: stop re-running `daemon.ensure` on every 1.2 s panel poll. |
| Hato-plugins | `fac01fd` | Release: remote 0.1.8, automation 0.1.12, foundation 0.1.59 (foundation only because `settings` embeds catalogue versions). |
| Hato | `d1bffe6` | `daemon_link::ensure_ssh` cached per live SSH connection (`hello` liveness check over the ctl link), per-machine ensure lock, ctl link kept on unchanged re-ensure, binary digest cached by size+mtime. Slow-op logging (`HATO_SLOW_OP_MS`, default 200). |
| Hato | `a20a85b` | `plugins.lock.json` re-pinned to Hato-plugins `fac01fd`. |

## 2. Uncommitted, built, running (needs commit + plugin release)

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
