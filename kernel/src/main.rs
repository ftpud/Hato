use hato_kernel::bridge::UiBridge;
use hato_kernel::config::Config;
use hato_kernel::kernel::Kernel;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let cfg = match Config::from_args(&args) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("hato: {e:#}");
            std::process::exit(2);
        }
    };
    init_logging(&cfg);
    log::info!("hato kernel starting: repo={} data={}", cfg.repo_root.display(), cfg.data_dir.display());
    if cfg.headless {
        let t0 = std::time::Instant::now();
        let k = Kernel::new(cfg.clone(), UiBridge::disconnected()).expect("kernel");
        k.boot();
        eprintln!("[headless] boot completed in {} ms: {}", t0.elapsed().as_millis(), serde_json::to_string(&*k.boot_report.lock()).unwrap_or_default());
        let ok = match &cfg.headless_script {
            Some(s) => hato_kernel::headless::run(&k, s).unwrap_or_else(|e| {
                eprintln!("{e:#}");
                false
            }),
            None => true,
        };
        k.shutdown();
        std::process::exit(if ok { 0 } else { 1 });
    }
    hato_kernel::ui::run(cfg);
}

fn init_logging(cfg: &Config) {
    struct L(parking_lot::Mutex<Option<std::fs::File>>, log::Level);
    impl log::Log for L {
        fn enabled(&self, m: &log::Metadata) -> bool { m.level() <= self.1 }
        fn log(&self, r: &log::Record) {
            if !self.enabled(r.metadata()) || r.target().starts_with("gpui") && r.level() > log::Level::Warn {
                return;
            }
            let line = format!("{} {:5} {}: {}\n", hato_kernel::util::now_iso(), r.level(), r.target(), r.args());
            if r.level() <= log::Level::Warn || std::env::var("HATO_LOG_STDERR").is_ok() {
                eprint!("{line}");
            }
            if let Some(f) = self.0.lock().as_mut() {
                use std::io::Write;
                let _ = f.write_all(line.as_bytes());
            }
        }
        fn flush(&self) {}
    }
    let f = std::fs::OpenOptions::new().create(true).append(true).open(cfg.logs_dir().join("kernel.log")).ok();
    let level = if std::env::var("HATO_DEBUG").is_ok() { log::Level::Debug } else { log::Level::Info };
    let _ = log::set_boxed_logger(Box::new(L(parking_lot::Mutex::new(f), level)));
    log::set_max_level(level.to_level_filter());
}
