//! OS-backed change notifications. The broker resolves and checks the scope before launching
//! this stream helper locally or over SSH. Only invalidations are sent, never untrusted paths.
//!
//! Output lines: `ready`, then `changed` per (coalesced) burst; `warning <text>` when watching is
//! incomplete (e.g. the OS watch limit was reached; what could be watched still is).
//!
//! Exclusions skip directories whose changes do not matter (dependencies, build output, ignored
//! paths). A pattern containing `/` is a path relative to the watched root (`dist`, `app/build/`);
//! otherwise it matches a directory name at any depth, with `*` and `?` wildcards
//! (`node_modules`, `*.egg-info`). On Linux, inotify needs one watch per directory and the user
//! total is capped (`fs.inotify.max_user_watches`), so with exclusions each kept directory is
//! watched on its own and excluded trees cost nothing. Elsewhere one recursive watch covers the
//! tree and events under excluded directories are dropped.
use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

#[derive(Default, Debug)]
pub struct Excludes {
    names: Vec<String>,
    paths: Vec<PathBuf>,
}

impl Excludes {
    pub fn parse(patterns: &[String]) -> Excludes {
        let mut e = Excludes::default();
        for p in patterns {
            let p = p.trim();
            if p.is_empty() || p.starts_with('!') || p.split('/').any(|c| c == "..") {
                continue;
            }
            if p.contains('/') {
                let rel = p.trim_matches('/');
                if !rel.is_empty() && rel != "." {
                    e.paths.push(PathBuf::from(rel));
                }
            } else {
                e.names.push(p.to_string());
            }
        }
        e
    }

    pub fn is_empty(&self) -> bool { self.names.is_empty() && self.paths.is_empty() }

    /// Whether `rel` (relative to the watched root) is an excluded directory or lies inside one.
    pub fn excludes(&self, rel: &Path) -> bool {
        if rel.as_os_str().is_empty() {
            return false;
        }
        if self.paths.iter().any(|p| rel.starts_with(p)) {
            return true;
        }
        rel.components().any(|c| {
            let name = c.as_os_str().to_string_lossy();
            self.names.iter().any(|n| glob(n.as_bytes(), name.as_bytes()))
        })
    }
}

/// `*` (any run) and `?` (one character) within a single name.
fn glob(p: &[u8], s: &[u8]) -> bool {
    match (p.first(), s.first()) {
        (None, None) => true,
        (Some(b'*'), _) => glob(&p[1..], s) || (!s.is_empty() && glob(p, &s[1..])),
        (Some(b'?'), Some(_)) => glob(&p[1..], &s[1..]),
        (Some(a), Some(b)) if a == b => glob(&p[1..], &s[1..]),
        _ => false,
    }
}

fn say(line: &str) {
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{line}").and_then(|_| out.flush());
}

/// Directories to watch individually (Linux with exclusions): kept directories and their
/// descendants, not following symlinks.
struct Walker {
    root: PathBuf,
    excludes: Arc<Excludes>,
    full: bool,
}

impl Walker {
    fn add(&mut self, watcher: &mut RecommendedWatcher, start: &Path) {
        let mut stack = vec![start.to_path_buf()];
        while let Some(dir) = stack.pop() {
            if self.full {
                return;
            }
            let rel = dir.strip_prefix(&self.root).unwrap_or(&dir);
            if self.excludes.excludes(rel) {
                continue;
            }
            if let Err(e) = watcher.watch(&dir, RecursiveMode::NonRecursive) {
                if is_limit(&e) {
                    self.full = true;
                    say("warning watch limit reached: some folders are not watched (raise fs.inotify.max_user_watches or exclude more folders)");
                    return;
                }
                continue; // removed meanwhile, or unreadable
            }
            if let Ok(entries) = std::fs::read_dir(&dir) {
                for entry in entries.flatten() {
                    if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                        stack.push(entry.path());
                    }
                }
            }
        }
    }
}

fn is_limit(e: &notify::Error) -> bool {
    match &e.kind {
        notify::ErrorKind::MaxFilesWatch => true,
        notify::ErrorKind::Io(io) => io.raw_os_error() == Some(28), // ENOSPC: inotify watch limit
        _ => false,
    }
}

pub fn run(path: &str, recursive: bool, exclude: &[String]) -> anyhow::Result<()> {
    let excludes = Arc::new(Excludes::parse(exclude));
    let root = std::fs::canonicalize(path).unwrap_or_else(|_| PathBuf::from(path));
    // `HATO_WATCH_PER_DIRECTORY` forces the Linux strategy elsewhere (tests).
    let per_directory = (cfg!(target_os = "linux") || std::env::var_os("HATO_WATCH_PER_DIRECTORY").is_some()) && recursive && !excludes.is_empty();
    // Directories created after the walk (Linux per-directory mode), to watch in turn.
    let created: Arc<Mutex<Vec<PathBuf>>> = Arc::default();
    // A bounded queue coalesces bursts without blocking the OS notification thread.
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    let changes = tx.clone();
    let (ex, base, new_dirs) = (excludes.clone(), root.clone(), created.clone());
    let mut watcher = RecommendedWatcher::new(move |event: notify::Result<Event>| {
        let event = match event {
            Ok(e) if e.kind.is_access() => return,
            Ok(e) => e,
            Err(e) => { let _ = changes.try_send(Err(e)); return; }
        };
        // A change inside an excluded directory is dropped; creating or removing the excluded
        // directory itself is a change in its parent and still counts.
        let relevant: Vec<&PathBuf> = event.paths.iter().filter(|p| {
            let rel = p.strip_prefix(&base).unwrap_or(p);
            !rel.parent().is_some_and(|parent| ex.excludes(parent))
        }).collect();
        if !event.paths.is_empty() && relevant.is_empty() {
            return;
        }
        if per_directory && matches!(event.kind, EventKind::Create(_) | EventKind::Modify(notify::event::ModifyKind::Name(_))) {
            let dirs: Vec<PathBuf> = relevant.into_iter().filter(|p| std::fs::symlink_metadata(p).map(|m| m.is_dir()).unwrap_or(false)).cloned().collect();
            if !dirs.is_empty() {
                new_dirs.lock().unwrap_or_else(|p| p.into_inner()).extend(dirs);
            }
        }
        let _ = changes.try_send(Ok(()));
    }, Config::default().with_follow_symlinks(false))?;
    let mut walker = Walker { root: root.clone(), excludes: excludes.clone(), full: false };
    if per_directory {
        walker.add(&mut watcher, &root);
    } else {
        watcher.watch(&root, if recursive { RecursiveMode::Recursive } else { RecursiveMode::NonRecursive })?;
    }
    // EOF on the SSH channel stops the helper when its desktop viewer goes away.
    std::thread::spawn(move || {
        let mut input = std::io::stdin().lock();
        let mut buf = [0u8; 64];
        while matches!(input.read(&mut buf), Ok(n) if n > 0) {}
        drop(tx);
        std::process::exit(0);
    });
    say("ready");
    for event in rx {
        if let Err(e) = event {
            if is_limit(&e) {
                say("warning watch limit reached: some folders are not watched (raise fs.inotify.max_user_watches or exclude more folders)");
                continue;
            }
            return Err(e.into());
        }
        let dirs = std::mem::take(&mut *created.lock().unwrap_or_else(|p| p.into_inner()));
        for dir in dirs {
            walker.add(&mut watcher, &dir);
        }
        say("changed");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exclusion_patterns() {
        let e = Excludes::parse(&["node_modules".into(), "*.egg-info".into(), "dist/".into(), "/app/build".into(), "!keep".into(), "../x".into(), "".into()]);
        let ex = |p: &str| e.excludes(Path::new(p));
        assert!(ex("node_modules") && ex("web/node_modules/react/index.js"), "names match at any depth");
        assert!(ex("pkg/foo.egg-info"), "wildcards");
        assert!(ex("dist") && ex("dist/main.js"), "anchored paths");
        assert!(!ex("web/dist"), "anchored paths only from the root");
        assert!(ex("app/build/out.o") && !ex("app/builder"), "a path prefix is whole components");
        assert!(!ex("src/main.rs") && !ex(""), "the root itself is never excluded");
        assert!(!ex("keep") && !ex("x"), "negations and escaping paths are ignored");
    }

    #[test]
    fn globs() {
        assert!(glob(b"*", b"") && glob(b"a*c", b"abbc") && glob(b"?b", b"ab"));
        assert!(!glob(b"a?c", b"ac") && !glob(b"*.py", b"a.pyc"));
    }
}
