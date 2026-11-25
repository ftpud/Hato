//! Redraw diagnostics. gpui repaints the whole window for any frame, so anything that keeps a view
//! dirty (a module re-sending its tree, terminal output, an animation) costs a full layout and
//! paint each time. This counts frames and what asked for them, and logs one line to kernel.log
//! per 10-second window in which the window redrew continuously (more than 5 frames per second).
//! Counting is a few hash-map increments per frame; quiet windows log nothing.
use parking_lot::Mutex;
use std::collections::HashMap;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

const WINDOW: Duration = Duration::from_secs(10);
const BUSY_FPS: f64 = 5.;

struct Stats {
    since: Instant,
    frames: u64,
    causes: HashMap<String, u64>,
}

fn stats() -> &'static Mutex<Stats> {
    static STATS: OnceLock<Mutex<Stats>> = OnceLock::new();
    STATS.get_or_init(|| Mutex::new(Stats { since: Instant::now(), frames: 0, causes: HashMap::new() }))
}

/// Something asked for a redraw (or re-rendered): counted under `name`.
pub fn cause(name: impl AsRef<str>) {
    let mut s = stats().lock();
    match s.causes.get_mut(name.as_ref()) {
        Some(n) => *n += 1,
        None => { s.causes.insert(name.as_ref().to_string(), 1); }
    }
}

/// One window frame (the root view rendered). Logs and resets once per window.
pub fn frame() {
    let mut s = stats().lock();
    s.frames += 1;
    let elapsed = s.since.elapsed();
    if elapsed < WINDOW {
        return;
    }
    let fps = s.frames as f64 / elapsed.as_secs_f64();
    if fps > BUSY_FPS {
        let mut causes: Vec<_> = s.causes.iter().collect();
        causes.sort_by(|a, b| b.1.cmp(a.1).then_with(|| a.0.cmp(b.0)));
        let top: Vec<String> = causes.iter().take(12).map(|(k, v)| format!("{k}={v}")).collect();
        log::info!("redraws: {} frames in {:.0}s ({fps:.1}/s); causes: {}", s.frames, elapsed.as_secs_f64(), top.join(" "));
    }
    s.since = Instant::now();
    s.frames = 0;
    s.causes.clear();
}
