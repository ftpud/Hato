---
name: activate-and-verify
version: 1
description: Hot-swap a staged module generation and verify it.
---
# Activate and verify

Call `modules_activate` with `id` (and optionally `stageId`; defaults to the last build). The kernel fences
the module, snapshots its state, activates the new generation, runs a health check (UI modules must render)
and switches routing atomically. Failure keeps the previous version active. Afterwards call `modules_list`
and `modules_logs` to verify. Terminals, agent processes and data are preserved. Native approval required.
