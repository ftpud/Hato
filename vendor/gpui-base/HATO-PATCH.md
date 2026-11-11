# Hato editor patch

Upstream: gpui-base 0.8.1 from crates.io (LICENSE-APACHE).

`src/input/editor/lsp/definitions.rs`: modifier + left click calls the same
definition request as the context menu at the clicked offset, rather than
requiring a completed hover lookup. Accept Control as well as the platform
secondary modifier. Keep Alt-click and ordinary selection unchanged.

`src/input/editor/lsp/hover.rs`: pointer moves within the word whose hover request is
in flight do not cancel and restart that request (slow servers never answered while the
pointer jittered). `src/input/editor/lsp/completions.rs`: completion menu min width and
max height options.

Remove this local Cargo patch when upstream supports click-time requests.
