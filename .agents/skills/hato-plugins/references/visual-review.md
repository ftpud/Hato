# Inspecting Hato's actual UI

For panel, spacing, popup or typography changes, capture and inspect the running native UI when
possible. TypeScript tests verify behavior; they do not establish that a design looks right.
Preserve the current workspace, layout, and running sessions.

## Offscreen snapshots (preferred while designing)

`--snapshot` renders a panel with the real native renderer into a PNG: no visible window, no focus
change, no Screen Recording permission, and it does not touch the user's running app. Use it
first for design iteration; use the window helper below when you need the user's live state.
It is a development build feature (`snapshot`), so it is absent from default and release builds.

```sh
cargo build --features snapshot          # once, and after any Rust change
# A module's panel, at a chosen size (points; PNG is 2x on Retina):
target/debug/hato --root . --data-dir /tmp/hato-snap/data \
  --snapshot /tmp/hato-files.png --snapshot-module explorer --snapshot-size 360x600
# Workspace panels (git-panel, explorer…) need a selected project; select the --root one first:
target/debug/hato --root . --data-dir /tmp/hato-snap/data --snapshot-setup tools/snapshot/select-root-project.js \
  --snapshot /tmp/git.png --snapshot-module git-panel --snapshot-size 380x700 --snapshot-delay 2000
# A hand-written node tree, no module needed (same shape modules return from render):
target/debug/hato --snapshot /tmp/mock.png --snapshot-tree /tmp/mock.json --snapshot-size 400x200
```

Open the PNG with the image reader, then compare. Options: `--snapshot-setup SCRIPT.js` (driver script run after boot, before capture; same `test.*` ops as headless tests; write your own to open files, patch view state or seed data), `--snapshot-module ID` (omit for the full
root layout), `--snapshot-tree FILE.json`, `--snapshot-size WxH`, `--snapshot-delay MS` (settle
time, default 800; raise for images or highlighting), `--snapshot-timeout MS` (wait for the first
tree, default 20000). Exit code 1 means the tree never arrived or was only partly ready: check the
module is built (`npm run modules:build`), enabled, and read the `module:` log lines it prints.

Workflow for a panel change: edit the TypeScript module, `npm run modules:build`, re-run the
snapshot, view it, repeat. No app restart or activation is needed because each run boots fresh
from `build/modules`. This does not show the user's running app; report it as built and rendered
offscreen, not activated.

Limits to keep in mind:

- It boots real modules and services, so content comes from `--data-dir` and `--root`. A fresh
  data dir shows empty states ("Select a project or task") unless a setup script selects a
  project. Slow panels (Git status) may show a half-loaded state; raise `--snapshot-delay`. Use a
  setup script, a seeded copy of a data dir, or `--snapshot-tree`, to see populated or edge-case states (long names, narrow widths, errors).
- Always pass a throwaway `--data-dir`; never point it at the user's real Hato data.
- It captures one still frame: no clicks, hover, focus rings, open menus or popups, and no
  animation. Mock those states as static nodes where the tree allows, or use the window helper.
- Trees from `--snapshot-tree` render with the real renderer but have no backing module, so
  actions do nothing; verify behavior elsewhere. State clearly when an image is a mock tree.
- macOS only (Metal offscreen). Mock trees need valid node field names; a blank control usually
  means a wrong key, so check `sdk/types.ts`.

## macOS window helper (live app)

Run from Hato's repository root:

```sh
python3 tools/hato-screenshot.py --list
python3 tools/hato-screenshot.py --window-id 12345 --label workspace -o /tmp/hato-workspace.png
python3 tools/hato-screenshot.py --window-id 12345 --crop 20,80,360,600 --label files -o /tmp/hato-files.png
```

Select the actual window ID from `--list`; Hato may have a separate thin titlebar window.
Detached panels have their own IDs. Capture the whole window, open it with `view_image`, then
crop panels, popups or elements for closer inspection. Crop coordinates are **window-relative
points**, not image pixels; the helper accounts for Retina scaling and rejects out-of-bounds
regions. Each PNG has a JSON sidecar with window dimensions, crop, label and timestamp. Use
separate before/after filenames. Never present an invented mockup image as a screenshot; offscreen snapshots above are real renderer output.

The helper captures only the selected Hato window and does not focus/click it or upload images.
Open the desired state using authorized application controls. Inspecting a Markdown Run button
does not require executing its command. Exercise branch mutations in disposable repositories.

If sandboxed enumeration returns no windows, retry through normal sandbox escalation; the
helper needs WindowServer access. macOS Screen Recording permission is separate: if capture
fails with “could not create image from window,” report that the user needs to enable Screen
Recording for the terminal/agent application in System Settings → Privacy & Security. Stop
retrying until access changes. OS permission cannot be enabled in Hato settings. This helper
currently supports macOS only.

## Review the changed state

Useful checks include a long branch name, expanded branch actions, a narrow panel, open tab
menu, pasted image, and Markdown with multiple shell fences. Compare padding, clipping,
alignment and menu placement with the user's reference. Check that a context menu is compact
and anchored near the pointer, split diffs divide at the panel midpoint, and attachments leave
a usable composer. Report which states were actually inspected. If capture was blocked, do
not claim visual verification. Distinguish built, hot-activated and restart-dependent changes.
