---
name: build-and-test-module
version: 1
description: Build a module into a new versioned artifact and stage it.
---
# Build and stage

Call `modules_build` with `id`. The source is bundled with esbuild into a new artifact version
(never overwriting the active one) and evaluated in an isolated runtime. On failure the result contains
compiler diagnostics in `diagnostics`; fix the source and build again. Staging requires native approval.
The result's `stageId` is used by `modules_activate`.
