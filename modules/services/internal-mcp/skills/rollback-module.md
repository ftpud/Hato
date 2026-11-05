---
name: rollback-module
version: 2
description: Roll a module back to its previous healthy version.
---
# Roll back

Call `modules_rollback` with `id` (optionally `toVersion`). The previous artifact is integrity-checked
(SHA-256) and swapped in with the same protocol as activation. Native approval required.

For Bundled/Updated selection, inspect `seedVersion` and saved build origins/status using describe.
Bundled is the runtime's imported seed; Updated is the latest successfully activated custom build.
Staged/untested or failed artifacts are not known-good recovery targets. Switching artifacts preserves
local source files, so a reverted module can still show local differences in the Modules panel.
Selecting an older build does not remove newer saved artifacts: use an explicit toVersion to return.
Avoid rolling back the Modules panel itself when the user needs its Bundled/Updated controls.
