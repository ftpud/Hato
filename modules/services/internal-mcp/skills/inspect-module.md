---
name: inspect-module
version: 2
description: Inspect a Hato application module before changing it.
---
# Inspect a Hato module

1. Call `modules_list` to see every module, its active version (`id@NNNN`), kind (`service` or `ui`) and errors.
2. Call `modules_describe` with the module id: manifest, capabilities, source directory, recent logs.
3. Call `modules_read_source` with only `id` to list files, then again with `path` to read a file.

UI modules export `render(ctx)` returning a keyed UI tree (`row`, `column`, `label`, `button`, `tree`, …) and
`onEvent(ctx, event)` handling `event.action`. Services export `methods`. Modules never import each other at
runtime; they call `ctx.modules.call(id, method, args)`.

Read `self-configure` for packaged launches and storage. `modules_describe.runtime` identifies the
actual editable source tree, compiler and data folders; a workspace checkout can be a different copy.
Inspect saved build origins/status and `seedVersion` before choosing a recovery build.
