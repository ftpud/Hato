# Hato renderer patch

Upstream: gpui-pre-apple 0.3.10 from crates.io (LICENSE-APACHE).

## Damage-region rendering

The stock renderer rasterizes the complete window scene for every frame, so a small spinner or
caret update re-shades every panel, gradient, shadow and glyph. Opaque windows now keep the
last frame in a retained texture and redraw only what changed.

- `src/damage.rs`: fingerprints every primitive in GPU draw order (`Scene::batches`), aligns
  the new frame with the previous one (common prefix/suffix, pairwise middle), and merges the
  visual bounds of differing primitives into at most four device-pixel rectangles. Identical
  frames are skipped without acquiring a drawable. Large damage (over 60% of the window), size
  changes, the first frame and atlas tile removal redraw everything. Video surfaces are always
  treated as changed. The module comment explains why the result equals a full redraw.
- `src/metal_renderer.rs`: `draw_damaged` renders into the retained texture, one scissored pass
  per rectangle, each starting with an opaque black quad (the full-frame clear color) that
  overhangs the scissor. Path rasterization passes use the same scissor. The retained texture
  is then blitted to the drawable, which requires `framebufferOnly = false` on opaque layers.
  Transparent windows, headless rendering, screenshots and benchmarks keep the full path.
- `src/metal_atlas.rs`: tile removal bumps `damage::ATLAS_GENERATION`.

Set `HATO_FULL_REDRAW=1` to disable damage tracking. Every ~10 s the renderer logs
`damage: N frames, S skipped, F full, mean redrawn area X%`.

Tests: `cargo test -p hato -p gpui-pre-apple --features hato/snapshot --lib damage` compares
damaged redraws with full redraws pixel for pixel on the GPU.

Remove this patch if upstream GPUI gains retained/damage rendering.
