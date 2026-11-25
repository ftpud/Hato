//! Development-only offscreen rendering (`cargo build --features snapshot`).
//!
//! `hato --snapshot out.png --snapshot-module ID` boots the kernel, opens a hidden window,
//! waits for the module's first UI tree, draws it with the real native renderer and writes the
//! frame to a PNG. `--snapshot-tree file.json` renders a hand-written node tree instead, so
//! elements can be designed without any module. Nothing is shown on screen or focused.
use super::*;

pub fn run(cfg: Config) -> i32 {
    let Some(spec) = cfg.snapshot.clone() else { return 2 };
    let tree: Option<Value> = match &spec.tree {
        Some(p) => match std::fs::read_to_string(p).map_err(|e| e.to_string()).and_then(|t| serde_json::from_str(&t).map_err(|e| e.to_string())) {
            Ok(v) => Some(v),
            Err(e) => {
                eprintln!("hato: cannot read tree {}: {e}", p.display());
                return 2;
            }
        },
        None => None,
    };
    if let Some(fixture) = tree.as_ref().filter(|tree| !tree["type"].is_string()) {
        let valid = fixture["tree"]["type"].is_string() && fixture["modules"].as_object().is_some_and(|modules| {
            modules.iter().all(|(id, tree)| id.starts_with("__") && id != "__snapshot" && tree["type"].is_string())
        });
        if !valid {
            eprintln!("hato: expected a UiNode or {{tree: UiNode, modules: {{__id: UiNode}}}} fixture; module ids must start with __ and cannot be __snapshot");
            return 2;
        }
    }
    let (bridge, rx) = UiBridge::new();
    let kernel = match Kernel::new(cfg, bridge) {
        Ok(k) => k,
        Err(e) => {
            eprintln!("hato: kernel init failed: {e:#}");
            return 1;
        }
    };
    let code = Arc::new(std::sync::atomic::AtomicI32::new(1));
    let code2 = code.clone();
    let app = gpui_kit::application().with_assets(gpui_kit::assets::Assets);
    let k2 = kernel.clone();
    app.run(move |cx| {
        gpui_kit::init(cx);
        terminal_view::init(cx);
        theme::init(cx, &k2.cfg.data_dir);
        let bounds = Bounds::centered(None, size(px(spec.width), px(spec.height)), cx);
        let rx = std::cell::RefCell::new(Some(rx));
        let k3 = k2.clone();
        let only = if tree.is_some() { Some("__snapshot".to_string()) } else { spec.module.clone() };
        let opened = gpui_kit::open_window(
            WindowOptions { window_bounds: Some(WindowBounds::Windowed(bounds)), show: false, focus: false, ..TitleBar::window_options() },
            cx,
            move |window, cx| {
                let rx = rx.borrow_mut().take().unwrap();
                cx.new(|cx| {
                    let mut shell = Shell::new(k3.clone(), rx, window, cx);
                    shell.only_module = only.clone();
                    shell
                })
            },
        );
        let setup_done = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let (handle, shell) = match opened {
            Ok(v) => v,
            Err(e) => {
                eprintln!("hato: cannot open window: {e:#}");
                cx.quit();
                return;
            }
        };
        if let Some(t) = tree {
            shell.update(cx, |s, _| {
                // Optional fixture bundle exercises real slot/cache boundaries without modules.
                if t["type"].is_string() {
                    s.trees.insert("__snapshot".into(), Arc::new(t));
                } else {
                    s.trees.insert("__snapshot".into(), Arc::new(t["tree"].clone()));
                    if let Some(modules) = t["modules"].as_object() {
                        for (module, tree) in modules {
                            s.trees.insert(module.clone(), Arc::new(tree.clone()));
                        }
                    }
                }
            });
        } else {
            let k4 = k2.clone();
            let setup = spec.setup.clone();
            let done = setup_done.clone();
            std::thread::spawn(move || {
                k4.boot();
                if let Some(script) = setup {
                    // Same driver as `--headless-script`; runs to completion before capture.
                    match crate::headless::run(&k4, &script) {
                        Ok(true) => {}
                        Ok(false) | Err(_) => eprintln!("hato: snapshot setup script {} failed", script.display()),
                    }
                }
                done.store(true, std::sync::atomic::Ordering::SeqCst);
            });
        }
        let module = spec.module.clone();
        let setup_done = setup_done.clone();
        let has_tree = spec.tree.is_some();
        let code = code2.clone();
        let k5 = k2.clone();
        cx.spawn(async move |cx| {
            let start = Instant::now();
            let mut ready = has_tree;
            // Wait for the module (or, without --snapshot-module, the root layout) to publish.
            while !ready && start.elapsed() < Duration::from_millis(spec.timeout_ms) {
                cx.background_executor().timer(Duration::from_millis(50)).await;
                ready = shell
                    .update(&mut cx.clone(), |s, _| match &module {
                        _ if !setup_done.load(std::sync::atomic::Ordering::SeqCst) => false,
                        Some(m) => s.trees.contains_key(m),
                        None => k5.root_module().map(|r| s.trees.contains_key(&r)).unwrap_or(false),
                    });
            }
            if !ready {
                eprintln!("hato: timed out after {} ms waiting for the UI tree (is the module built and enabled?)", spec.timeout_ms);
            }
            // Let async content (images, highlighting, follow-up renders) settle, redrawing as we go.
            let settle = Instant::now();
            while settle.elapsed() < Duration::from_millis(spec.delay_ms) {
                cx.background_executor().timer(Duration::from_millis(50)).await;
                let _ = handle.update(&mut cx.clone(), |_, window, cx| {
                    window.draw(cx).clear(cx);
                });
            }
            if let Some(report) = &spec.bench {
                let measured = handle.update(&mut cx.clone(), |_, window, cx| benchmark(window, cx, spec.bench_frames));
                match measured.and_then(|v| v).and_then(|v| {
                    std::fs::write(report, serde_json::to_vec_pretty(&v)?)?;
                    Ok(())
                }) {
                    Ok(()) => println!("benchmark: {}", report.display()),
                    Err(e) => {
                        eprintln!("hato: benchmark failed: {e:#}");
                        let _ = cx.update(|cx| cx.quit());
                        return;
                    }
                }
            }
            let img = handle.update(&mut cx.clone(), |_, window, cx| {
                window.draw(cx).clear(cx);
                window.render_to_image()
            });
            match img {
                Ok(Ok(img)) => match img.save(&spec.out) {
                    Ok(()) => {
                        println!("{} ({}x{} px)", spec.out.display(), img.width(), img.height());
                        code.store(if ready { 0 } else { 1 }, std::sync::atomic::Ordering::SeqCst);
                    }
                    Err(e) => eprintln!("hato: cannot write {}: {e}", spec.out.display()),
                },
                Ok(Err(e)) | Err(e) => eprintln!("hato: render failed: {e:#}"),
            }
            let _ = cx.update(|cx| cx.quit());
        })
        .detach();
    });
    kernel.shutdown();
    code.load(std::sync::atomic::Ordering::SeqCst)
}

/// Keep measurement mechanics here; fixture composition and sweeps belong in tools/render-bench.
/// No event pumping in the timed loop: asynchronous services/animation timers cannot change the
/// fixture. `retained` measures reuse; `invalidated` forces a complete native view rebuild.
/// Raster timing INCLUDES synchronous GPU completion and CPU pixel readback, not pure GPU time.
/// Use a Metal trace to attribute GPU work; never subtract these wall timings and call that GPU.
fn benchmark(window: &mut Window, cx: &mut App, frames: usize) -> anyhow::Result<Value> {
    fn stats(mut samples: Vec<f64>) -> Value {
        let mean = samples.iter().sum::<f64>() / samples.len() as f64;
        samples.sort_by(f64::total_cmp);
        let percentile = |p: f64| samples[((samples.len() - 1) as f64 * p).round() as usize];
        json!({ "mean": mean, "p50": percentile(0.5), "p95": percentile(0.95), "min": samples[0], "max": samples[samples.len() - 1] })
    }
    let mut modes = serde_json::Map::new();
    let mut pixels = (0, 0);
    for (mode, invalidate) in [("retained", false), ("invalidated", true)] {
        let mut draws = Vec::with_capacity(frames);
        let mut rasters = Vec::with_capacity(frames);
        let mut totals = Vec::with_capacity(frames);
        for i in 0..frames + 16 {
            if invalidate { window.refresh(); }
            let start = Instant::now();
            window.draw(cx).clear(cx);
            let drawn = Instant::now();
            let image = window.render_to_image()?;
            let end = Instant::now();
            pixels = (image.width(), image.height());
            if i >= 16 {
                draws.push((drawn - start).as_secs_f64() * 1000.);
                rasters.push((end - drawn).as_secs_f64() * 1000.);
                totals.push((end - start).as_secs_f64() * 1000.);
            }
        }
        modes.insert(mode.into(), json!({ "draw_ms": stats(draws), "raster_readback_ms": stats(rasters), "total_ms": stats(totals) }));
    }
    Ok(json!({
        "schema": 1, "pid": std::process::id(), "frames_per_mode": frames, "warmup_per_mode": 16,
        "width_px": pixels.0, "height_px": pixels.1, "scale_factor": window.scale_factor(),
        "quads": window.painted_quads().len(), "modes": modes,
        "timing_note": "draw is CPU scene construction; raster_readback includes GPU wait and CPU pixel copy; no event-loop timer pumping; not display FPS or pure GPU duration"
    }))
}
