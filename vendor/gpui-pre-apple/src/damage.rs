//! Hato patch: damage-region rendering.
//!
//! GPUI rebuilds a complete scene for every frame and the stock renderer rasterizes all of it.
//! A 12 px spinner tick therefore re-shades every panel, gradient, shadow and glyph in the window.
//! The renderer now keeps the last frame in a retained texture and asks this tracker which
//! device-pixel rectangles differ from the previous scene. Only those rectangles are cleared and
//! redrawn (with a scissor), and the retained texture is copied to the drawable.
//!
//! Correctness argument: primitives are compared in GPU draw order (`Scene::batches`). Common
//! prefixes and suffixes are identical draws at identical stack positions. In the differing
//! middle, an equal-length run is compared pairwise; any differing pair damages the visual bounds
//! of both versions. Unequal runs damage the bounds of every primitive in both runs. Redrawing a
//! damaged rectangle replays *every* primitive that touches it, in order, so pixels outside the
//! damage cannot differ from a full redraw. Anything the fingerprint cannot see falls back to a
//! full frame: a size change, atlas tile removal (a tile slot may be reused with new pixels),
//! the first frame, and video surfaces, which are always treated as changed.
use gpui::{Bounds, DevicePixels, PrimitiveBatch, ScaledPixels, Scene, Size, TransformationMatrix};
use std::sync::atomic::{AtomicU64, Ordering};

/// Bumped whenever an atlas tile is freed. Freed slots can be reused by different pixels while
/// keeping identical tile coordinates, which would make sprite fingerprints stale.
pub(crate) static ATLAS_GENERATION: AtomicU64 = AtomicU64::new(0);

/// Pixels of slack around every damaged primitive (antialiasing, subpixel snapping).
const SLACK: f32 = 2.0;
/// Damage covering more of the window than this redraws everything (one pass is cheaper).
const FULL_FRACTION: f64 = 0.6;
/// Separate scissor passes per frame. Every pass replays the vertex work of the scene.
const MAX_RECTS: usize = 4;

pub(crate) enum Plan {
    /// Nothing changed: keep presenting the previous frame.
    Skip,
    Full,
    Rects(Vec<Bounds<DevicePixels>>),
}

#[derive(Clone, Copy, PartialEq)]
struct Entry {
    hash: u64,
    /// x0, y0, x1, y1 in device pixels, clipped to the viewport. Empty when invisible.
    rect: [i32; 4],
}

pub(crate) struct DamageTracker {
    enabled: bool,
    prev: Vec<Entry>,
    size: Size<DevicePixels>,
    atlas_generation: u64,
    valid: bool,
    surface_frame: u64,
    stats: Stats,
}

#[derive(Default)]
struct Stats {
    since: Option<std::time::Instant>,
    frames: u32,
    skipped: u32,
    full: u32,
    damaged_fraction: f64,
}

impl Default for DamageTracker {
    fn default() -> Self {
        Self {
            enabled: std::env::var_os("HATO_FULL_REDRAW").is_none(),
            prev: Vec::new(),
            size: Size::default(),
            atlas_generation: 0,
            valid: false,
            surface_frame: 0,
            stats: Stats::default(),
        }
    }
}

impl DamageTracker {
    pub(crate) fn enabled(&self) -> bool {
        self.enabled
    }

    /// The retained texture no longer holds the last frame (recreated, or a render failed).
    pub(crate) fn invalidate(&mut self) {
        self.valid = false;
    }

    pub(crate) fn plan(&mut self, scene: &Scene, viewport: Size<DevicePixels>) -> Plan {
        self.surface_frame = self.surface_frame.wrapping_add(1);
        let cur = self.entries(scene, viewport);
        let generation = ATLAS_GENERATION.load(Ordering::Acquire);
        let full = !self.valid || viewport != self.size || generation != self.atlas_generation;
        let prev = std::mem::replace(&mut self.prev, cur);
        self.size = viewport;
        self.atlas_generation = generation;
        self.valid = true;
        let plan = if full { Plan::Full } else { diff(&prev, &self.prev, viewport) };
        self.record(&plan, viewport);
        plan
    }

    fn entries(&self, scene: &Scene, viewport: Size<DevicePixels>) -> Vec<Entry> {
        let (vw, vh) = (viewport.width.0, viewport.height.0);
        let mut out = Vec::with_capacity(
            scene.quads.len() + scene.monochrome_sprites.len() + scene.polychrome_sprites.len()
                + scene.shadows.len() + scene.paths.len() + scene.underlines.len() + scene.surfaces.len(),
        );
        let entry = |hash: u64, b: [f32; 4], mask: &Bounds<ScaledPixels>| Entry { hash, rect: clip(b, mask, vw, vh) };
        for batch in scene.batches() {
            match batch {
                PrimitiveBatch::Quads(range) => {
                    for q in &scene.quads[range] {
                        let mut c = q.clone();
                        c.order = 0;
                        out.push(entry(hash_pod(&c, 1), rect(&q.bounds), &q.content_mask.bounds));
                    }
                }
                PrimitiveBatch::Shadows(range) => {
                    for s in &scene.shadows[range] {
                        let mut c = s.clone();
                        c.order = 0;
                        // Drop shadows reach 3 blur radii past their bounds (see shadow_vertex);
                        // inset shadows stay within the element.
                        let m = 3.0 * s.blur_radius.0;
                        let b = union(grow(rect(&s.bounds), m), rect(&s.element_bounds));
                        out.push(entry(hash_pod(&c, 2), b, &s.content_mask.bounds));
                    }
                }
                PrimitiveBatch::Underlines(range) => {
                    for u in &scene.underlines[range] {
                        let mut c = u.clone();
                        c.order = 0;
                        out.push(entry(hash_pod(&c, 3), grow(rect(&u.bounds), u.thickness.0), &u.content_mask.bounds));
                    }
                }
                PrimitiveBatch::MonochromeSprites { range, .. } => {
                    for s in &scene.monochrome_sprites[range] {
                        let mut c = s.clone();
                        c.order = 0;
                        out.push(entry(hash_pod(&c, 4), transformed(&s.bounds, &s.transformation), &s.content_mask.bounds));
                    }
                }
                PrimitiveBatch::PolychromeSprites { range, .. } => {
                    for s in &scene.polychrome_sprites[range] {
                        let mut c = s.clone();
                        c.order = 0;
                        out.push(entry(hash_pod(&c, 5), rect(&s.bounds), &s.content_mask.bounds));
                    }
                }
                PrimitiveBatch::Paths(range) => {
                    for p in &scene.paths[range] {
                        let mut h = mix(6, hash_pod(&p.bounds, 0));
                        h = mix(h, hash_pod(&p.content_mask, 0));
                        h = mix(h, hash_pod(&p.color, 0));
                        h = mix(h, hash_slice(&p.vertices));
                        out.push(entry(h, rect(&p.bounds), &p.content_mask.bounds));
                    }
                }
                PrimitiveBatch::Surfaces(range) => {
                    // Video frames change without any scene change: always damaged.
                    for s in &scene.surfaces[range] {
                        let h = mix(mix(7, hash_pod(&s.bounds, 0)), self.surface_frame);
                        out.push(entry(h, rect(&s.bounds), &s.content_mask.bounds));
                    }
                }
                PrimitiveBatch::SubpixelSprites { .. } => {}
            }
        }
        out
    }

    fn record(&mut self, plan: &Plan, viewport: Size<DevicePixels>) {
        let s = &mut self.stats;
        let now = std::time::Instant::now();
        let since = *s.since.get_or_insert(now);
        s.frames += 1;
        match plan {
            Plan::Skip => s.skipped += 1,
            Plan::Full => { s.full += 1; s.damaged_fraction += 1.0 }
            Plan::Rects(rects) => s.damaged_fraction += area(rects) / viewport_area(viewport),
        }
        if now.duration_since(since).as_secs() >= 10 && s.frames > 50 {
            let drawn = (s.frames - s.skipped).max(1);
            log::info!(
                "damage: {} frames, {} skipped, {} full, mean redrawn area {:.1}% of drawn frames",
                s.frames, s.skipped, s.full, 100.0 * s.damaged_fraction / f64::from(drawn)
            );
            *s = Stats { since: Some(now), ..Stats::default() };
        } else if now.duration_since(since).as_secs() >= 10 {
            *s = Stats { since: Some(now), ..Stats::default() };
        }
    }
}

fn diff(prev: &[Entry], cur: &[Entry], viewport: Size<DevicePixels>) -> Plan {
    let prefix = prev.iter().zip(cur).take_while(|(a, b)| a.hash == b.hash).count();
    let max_suffix = prev.len().min(cur.len()) - prefix;
    let suffix = prev.iter().rev().zip(cur.iter().rev()).take(max_suffix).take_while(|(a, b)| a.hash == b.hash).count();
    let (old, new) = (&prev[prefix..prev.len() - suffix], &cur[prefix..cur.len() - suffix]);
    if old.is_empty() && new.is_empty() {
        return Plan::Skip;
    }
    let mut damage: Vec<[i32; 4]> = Vec::new();
    if old.len() == new.len() {
        for (a, b) in old.iter().zip(new) {
            if a.hash != b.hash {
                damage.push(a.rect);
                damage.push(b.rect);
            }
        }
    } else {
        damage.extend(old.iter().chain(new).map(|e| e.rect));
    }
    damage.retain(|r| r[2] > r[0] && r[3] > r[1]);
    if damage.is_empty() {
        // Only invisible primitives changed.
        return Plan::Skip;
    }
    let rects = cluster(damage);
    let bounds: Vec<Bounds<DevicePixels>> = rects
        .iter()
        .map(|r| Bounds::new(gpui::point(DevicePixels(r[0]), DevicePixels(r[1])), gpui::size(DevicePixels(r[2] - r[0]), DevicePixels(r[3] - r[1]))))
        .collect();
    if area(&bounds) > FULL_FRACTION * viewport_area(viewport) {
        Plan::Full
    } else {
        Plan::Rects(bounds)
    }
}

/// Merge damage into at most `MAX_RECTS` rectangles, joining the pair whose union wastes the
/// fewest pixels first. Overlapping or nearly touching rectangles always merge.
fn cluster(mut rects: Vec<[i32; 4]>) -> Vec<[i32; 4]> {
    // Collapse the common case (many glyphs/rows in one area) cheaply before the pairwise pass.
    let mut merged: Vec<[i32; 4]> = Vec::new();
    for r in rects.drain(..) {
        if let Some(m) = merged.iter_mut().find(|m| near(m, &r, 16)) {
            *m = join(m, &r);
        } else {
            merged.push(r);
        }
        if merged.len() > 64 {
            merged = vec![merged.iter().fold(merged[0], |a, b| join(&a, b))];
        }
    }
    loop {
        // Overlapping rectangles always merge: drawing them separately would redraw the overlap.
        let overlap = (0..merged.len()).flat_map(|i| (i + 1..merged.len()).map(move |j| (i, j)))
            .find(|&(i, j)| near(&merged[i], &merged[j], 0));
        let pick = overlap.or_else(|| {
            (merged.len() > MAX_RECTS).then(|| {
                (0..merged.len()).flat_map(|i| (i + 1..merged.len()).map(move |j| (i, j)))
                    .min_by_key(|&(i, j)| rect_area(&join(&merged[i], &merged[j])) - rect_area(&merged[i]) - rect_area(&merged[j]))
                    .unwrap()
            })
        });
        let Some((i, j)) = pick else { return merged };
        let u = join(&merged[i], &merged[j]);
        merged.swap_remove(j);
        merged[i] = u;
    }
}

fn near(a: &[i32; 4], b: &[i32; 4], gap: i32) -> bool {
    a[0] <= b[2] + gap && b[0] <= a[2] + gap && a[1] <= b[3] + gap && b[1] <= a[3] + gap
}
fn join(a: &[i32; 4], b: &[i32; 4]) -> [i32; 4] {
    [a[0].min(b[0]), a[1].min(b[1]), a[2].max(b[2]), a[3].max(b[3])]
}
fn rect_area(r: &[i32; 4]) -> i64 {
    i64::from(r[2] - r[0]) * i64::from(r[3] - r[1])
}
fn area(rects: &[Bounds<DevicePixels>]) -> f64 {
    rects.iter().map(|b| f64::from(b.size.width.0) * f64::from(b.size.height.0)).sum()
}
fn viewport_area(v: Size<DevicePixels>) -> f64 {
    (f64::from(v.width.0) * f64::from(v.height.0)).max(1.0)
}

fn rect(b: &Bounds<ScaledPixels>) -> [f32; 4] {
    [b.origin.x.0, b.origin.y.0, b.origin.x.0 + b.size.width.0, b.origin.y.0 + b.size.height.0]
}
fn grow(r: [f32; 4], m: f32) -> [f32; 4] {
    [r[0] - m, r[1] - m, r[2] + m, r[3] + m]
}
fn union(a: [f32; 4], b: [f32; 4]) -> [f32; 4] {
    [a[0].min(b[0]), a[1].min(b[1]), a[2].max(b[2]), a[3].max(b[3])]
}

/// Bounding box of a sprite after the shader's transform (rotation_scale · p + translation).
fn transformed(b: &Bounds<ScaledPixels>, t: &TransformationMatrix) -> [f32; 4] {
    let r = rect(b);
    let m = t.rotation_scale;
    let apply = |x: f32, y: f32| (x * m[0][0] + y * m[0][1] + t.translation[0], x * m[1][0] + y * m[1][1] + t.translation[1]);
    let pts = [apply(r[0], r[1]), apply(r[2], r[1]), apply(r[0], r[3]), apply(r[2], r[3])];
    pts.iter().fold([f32::MAX, f32::MAX, f32::MIN, f32::MIN], |a, p| [a[0].min(p.0), a[1].min(p.1), a[2].max(p.0), a[3].max(p.1)])
}

fn clip(r: [f32; 4], mask: &Bounds<ScaledPixels>, vw: i32, vh: i32) -> [i32; 4] {
    let m = rect(mask);
    let r = grow(r, SLACK);
    let x0 = r[0].max(m[0] - SLACK).max(0.0).floor();
    let y0 = r[1].max(m[1] - SLACK).max(0.0).floor();
    let x1 = r[2].min(m[2] + SLACK).min(vw as f32).ceil();
    let y1 = r[3].min(m[3] + SLACK).min(vh as f32).ceil();
    if !(x1 > x0 && y1 > y0) {
        return [0, 0, 0, 0];
    }
    [x0 as i32, y0 as i32, x1 as i32, y1 as i32]
}

fn mix(h: u64, w: u64) -> u64 {
    (h.rotate_left(5) ^ w).wrapping_mul(0x517c_c1b7_2722_0a95)
}

fn hash_bytes(bytes: &[u8], seed: u64) -> u64 {
    let mut h = mix(seed, bytes.len() as u64);
    let mut chunks = bytes.chunks_exact(8);
    for c in &mut chunks {
        h = mix(h, u64::from_le_bytes(c.try_into().unwrap()));
    }
    let mut tail = [0u8; 8];
    tail[..chunks.remainder().len()].copy_from_slice(chunks.remainder());
    mix(h, u64::from_le_bytes(tail))
}

/// Fingerprint of a `#[repr(C)]` GPU instance struct. These are the exact bytes the renderer
/// uploads, so equal bytes mean an identical draw.
fn hash_pod<T>(value: &T, seed: u64) -> u64 {
    // SAFETY: read-only view of a live value's bytes. Scene primitives are `#[repr(C)]` with
    // explicit padding fields, as the renderer already copies them byte-for-byte to the GPU.
    let bytes = unsafe { std::slice::from_raw_parts((value as *const T).cast::<u8>(), std::mem::size_of::<T>()) };
    hash_bytes(bytes, seed)
}

fn hash_slice<T>(values: &[T]) -> u64 {
    // SAFETY: as in `hash_pod`; path vertices are `#[repr(C)]` and uploaded byte-for-byte.
    let bytes = unsafe { std::slice::from_raw_parts(values.as_ptr().cast::<u8>(), std::mem::size_of_val(values)) };
    hash_bytes(bytes, 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn e(hash: u64, x: i32) -> Entry {
        Entry { hash, rect: [x, 0, x + 10, 10] }
    }
    fn v() -> Size<DevicePixels> {
        gpui::size(DevicePixels(1000), DevicePixels(1000))
    }

    #[test]
    fn identical_scenes_skip() {
        assert!(matches!(diff(&[e(1, 0), e(2, 20)], &[e(1, 0), e(2, 20)], v()), Plan::Skip));
    }

    #[test]
    fn a_changed_primitive_damages_both_versions() {
        let Plan::Rects(r) = diff(&[e(1, 0), e(2, 100), e(3, 500)], &[e(1, 0), e(9, 120), e(3, 500)], v()) else { panic!() };
        assert_eq!(r.len(), 1);
        assert_eq!((r[0].origin.x.0, r[0].size.width.0), (100, 30));
    }

    #[test]
    fn distant_changes_stay_separate() {
        let Plan::Rects(r) = diff(&[e(1, 0), e(2, 900)], &[e(5, 0), e(6, 900)], v()) else { panic!() };
        assert_eq!(r.len(), 2);
    }

    #[test]
    fn inserted_primitives_damage_the_whole_middle() {
        let Plan::Rects(r) = diff(&[e(1, 0), e(3, 400)], &[e(1, 0), e(2, 200), e(3, 400)], v()) else { panic!() };
        // Prefix and suffix match; only the inserted primitive differs.
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].origin.x.0, 200);
    }

    #[test]
    fn huge_damage_redraws_everything() {
        let big = Entry { hash: 1, rect: [0, 0, 1000, 900] };
        assert!(matches!(diff(&[big], &[Entry { hash: 2, ..big }], v()), Plan::Full));
    }

    #[test]
    fn rotated_sprites_cover_their_rotated_corners() {
        let b = Bounds::new(gpui::point(ScaledPixels(0.), ScaledPixels(0.)), gpui::size(ScaledPixels(10.), ScaledPixels(10.)));
        let (s, c) = (std::f32::consts::FRAC_1_SQRT_2, std::f32::consts::FRAC_1_SQRT_2);
        // Rotation by 45 degrees about the sprite center (5, 5).
        let t = TransformationMatrix { rotation_scale: [[c, -s], [s, c]], translation: [5. - (5. * c - 5. * s), 5. - (5. * s + 5. * c)] };
        let r = transformed(&b, &t);
        assert!(r[0] < -1.5 && r[2] > 11.5, "{r:?}");
    }

    #[test]
    fn many_nearby_rects_cluster_into_few() {
        let rects: Vec<[i32; 4]> = (0..200).map(|i| [i * 12, 0, i * 12 + 10, 10]).collect();
        assert!(cluster(rects).len() <= MAX_RECTS);
    }
}
