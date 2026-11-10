// No console window for the desktop app on Windows; output still reaches pipes and the log file.
#![cfg_attr(all(windows, feature = "gui"), windows_subsystem = "windows")]
use hato_kernel::bridge::UiBridge;
use hato_kernel::config::Config;
use hato_kernel::kernel::Kernel;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(|a| a == "daemon").unwrap_or(false) {
        std::process::exit(daemon_main(&args[2..]));
    }
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
        if let Some(error) = k.setup_status.lock().clone() {
            eprintln!("{error}");
            k.shutdown();
            std::process::exit(1);
        }
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
    #[cfg(feature = "gui")]
    hato_kernel::ui::run(cfg);
    #[cfg(not(feature = "gui"))]
    {
        eprintln!("hato: built without the desktop window (feature `gui`); use `hato daemon …` or --headless");
        std::process::exit(2);
    }
}

fn daemon_main(args: &[String]) -> i32 {
    let home = hato_kernel::daemon::home_dir(None);
    let log_dir = home.join("run");
    let _ = std::fs::create_dir_all(&log_dir);
    // Only the long-running server logs to a file; client commands keep stdio clean.
    if args.first().map(|a| a == "serve").unwrap_or(false) {
        let level = if std::env::var("HATO_DEBUG").is_ok() { log::LevelFilter::Debug } else { log::LevelFilter::Info };
        struct Stderr;
        impl log::Log for Stderr {
            fn enabled(&self, _: &log::Metadata) -> bool { true }
            fn log(&self, r: &log::Record) { eprintln!("{} {:5} {}: {}", hato_kernel::util::now_iso(), r.level(), r.target(), r.args()); }
            fn flush(&self) {}
        }
        let _ = log::set_boxed_logger(Box::new(Stderr));
        log::set_max_level(level);
    }
    hato_kernel::daemon::main(args)
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
