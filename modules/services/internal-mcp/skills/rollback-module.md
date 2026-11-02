---
name: rollback-module
version: 1
description: Roll a module back to its previous healthy version.
---
# Roll back

Call `modules_rollback` with `id` (optionally `toVersion`). The previous artifact is integrity-checked
(SHA-256) and swapped in with the same protocol as activation. Native approval required.
