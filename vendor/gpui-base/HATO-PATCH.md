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

`src/input/editor/search.rs` and `src/input/base/element.rs`: highlight the logical
rows occupied by the active Find match across the editor and gutter, independently
of caret focus. Wrapped rows share the highlight; closing search clears it.

Hover pointer hit testing uses the fixed input viewport instead of the scrolled
text bounds, so tooltips continue working after scrolling far down a file.
Find supports F3/Shift+F3 navigation with either the editor or the Find panel
focused. Every matching logical row gets a stronger background, including soft
wraps and the gutter; the active match gets additional contrast. Match lookup is
limited to visible rows to avoid rescanning offscreen matches on every paint.
