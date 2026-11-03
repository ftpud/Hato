//! OS-backed change notifications. The broker resolves and checks the scope before launching
//! this stream helper locally or over SSH. Only invalidations are sent, never untrusted paths.
use notify::{Config, Event, RecommendedWatcher, RecursiveMode, Watcher};
use std::io::{Read, Write};
use std::path::Path;

pub fn run(path: &str, recursive: bool) -> anyhow::Result<()> {
    // A bounded queue coalesces bursts without blocking the OS notification thread.
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    let changes = tx.clone();
    let mut watcher = RecommendedWatcher::new(move |event: notify::Result<Event>| {
        if !matches!(&event, Ok(e) if e.kind.is_access()) {
            let _ = changes.try_send(event.map(|_| ()));
        }
    }, Config::default().with_follow_symlinks(false))?;
    watcher.watch(Path::new(path), if recursive { RecursiveMode::Recursive } else { RecursiveMode::NonRecursive })?;
    // EOF on the SSH channel stops the helper when its desktop viewer goes away.
    std::thread::spawn(move || {
        let mut input = std::io::stdin().lock();
        let mut buf = [0u8; 64];
        while matches!(input.read(&mut buf), Ok(n) if n > 0) {}
        drop(tx);
        std::process::exit(0);
    });
    let mut out = std::io::stdout().lock();
    writeln!(out, "ready")?;
    out.flush()?;
    for event in rx {
        event?;
        writeln!(out, "changed")?;
        out.flush()?;
    }
    Ok(())
}
