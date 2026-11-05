---
name: build-and-test-module
version: 2
description: Build a module into a new versioned artifact and stage it.
---
# Build and stage

Call `modules_build` with `id`. The source is bundled with esbuild into a new artifact version
(never overwriting the active one) and evaluated in an isolated runtime. On failure the result contains
compiler diagnostics in `diagnostics`; fix the source and build again. Staging requires native approval.
The result's `stageId` is used by `modules_activate`.

Use the compiler and source tree from `modules_describe.runtime`; packaged builds do not require a
system Node installation for esbuild. A checkout `npm run modules:build` writes seeds only; it does
not activate a packaged runtime. Shared SDK edits require rebuilding every affected consumer.
Run relevant checks before cutover. Keep the active version on build failure and show the full error.
A repeated large-output timeout on an older native runner needs a rebuilt app; see `self-configure`.
