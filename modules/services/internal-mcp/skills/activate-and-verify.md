---
name: activate-and-verify
version: 2
description: Hot-swap a staged module generation and verify it.
---
# Activate and verify

Call `modules_activate` with `id` (and optionally `stageId`; defaults to the last build). The kernel fences
the module, snapshots its state, activates the new generation, runs a health check (UI modules must render)
and switches routing atomically. Failure keeps the previous version active. Afterwards call `modules_list`
and `modules_logs` to verify. Terminals, agent processes and data are preserved. Native approval required.

Verify the returned active build against the stage you built, then check the actual UI/service behavior.
Do not call a change live merely because it compiled. Report desktop activation separately from
workspace-daemon activation: long-lived agents/workflows may still use their existing daemon runtime.
Preserve active work and defer daemon replacement when busy. Updating this MCP service or its bundled
skill Markdown requires rebuilding and activating internal-mcp; clients may need to reconnect to
refresh advertised tools/instructions. When using internal-mcp to update internal-mcp itself,
its own activation call counts as an in-flight MCP call and canSwap defers the swap. Build/stage
through MCP, then activate from the Modules panel after the tool call ends; verify after reconnecting.
Do not remove the in-flight guard to force a self-swap. Rust/native changes require a rebuilt app and relaunch.
