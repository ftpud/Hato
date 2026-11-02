---
name: patch-module
version: 1
description: Propose and apply a change to a module's TypeScript source.
---
# Patch a module

- Use `modules_apply_patch` with `id` and either a unified diff in `patch` (paths relative to the module,
  e.g. `src/index.ts`), or `edits: [{path, oldText, newText}]` where `oldText` occurs exactly once.
- Only files inside `modules/<kind>/<id>/` can be changed. Everything else is denied by the kernel.
- The user sees a kernel-computed diff in a native approval dialog and must approve every write,
  even with Autopilot enabled. A denial returns an error: do not retry silently; explain.
- Keep keys stable in UI trees so native controls keep their state.
