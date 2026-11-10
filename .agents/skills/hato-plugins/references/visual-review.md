# Inspecting Hato's actual UI

For panel, spacing, popup or typography changes, capture and inspect the running native UI when
possible. TypeScript tests verify behavior; they do not establish that a design looks right.
Preserve the current workspace, layout, and running sessions.

## macOS helper

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
separate before/after filenames. Never substitute a generated mockup for a real screenshot.

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
