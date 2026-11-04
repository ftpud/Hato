//! The daemon process: resource holders, a headless kernel for pushed plugins, and the socket.
use super::*;
use crate::bridge::UiBridge;
use crate::config::Config;
use crate::host::pty::{self, PtySession, PtySpec};
use crate::kernel::Kernel;
use crate::util::{now_ms, HostError};
use parking_lot::{Condvar, Mutex};
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::Path;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// Output kept for a detached process before the oldest bytes are dropped.
const PROC_BUFFER: usize = 16 * 1024 * 1024;

struct PtyHolder {
    sess: Arc<PtySession>,
    attach: AtomicU64,
    attached: AtomicBool,
    cwd: String,
    created_ms: u64,
}

struct ProcHolder {
    pid: u32,
    child: Mutex<Option<Child>>,
    stdin: Mutex<Option<ChildStdin>>,
    pending: Mutex<VecDeque<(u8, Vec<u8>)>>,
    pending_bytes: AtomicUsize,
    /// Delivered to the current viewer but not acknowledged yet.
    inflight: Mutex<VecDeque<(u8, Vec<u8>)>>,
    dropped: AtomicU64,
    cv: Condvar,
    exit: Mutex<Option<Value>>,
    attach: AtomicU64,
    attached: AtomicBool,
    command: String,
    cwd: String,
    created_ms: u64,
}

impl ProcHolder {
    fn push(&self, t: u8, data: &[u8]) {
        let mut q = self.pending.lock();
        q.push_back((t, data.to_vec()));
        let mut total = self.pending_bytes.fetch_add(data.len(), Ordering::SeqCst) + data.len();
        while total > PROC_BUFFER {
            match q.pop_front() {
                Some((_, d)) => {
                    self.pending_bytes.fetch_sub(d.len(), Ordering::SeqCst);
                    self.dropped.fetch_add(d.len() as u64, Ordering::SeqCst);
                    total -= d.len();
                }
                None => break,
            }
        }
        self.cv.notify_all();
    }

    fn info(&self, key: &str) -> Value {
        json!({"key": key, "pid": self.pid, "command": self.command, "cwd": self.cwd, "exit": self.exit.lock().clone(),
               "attached": self.attached.load(Ordering::SeqCst), "bufferedBytes": self.pending_bytes.load(Ordering::SeqCst),
               "droppedBytes": self.dropped.load(Ordering::SeqCst), "createdMs": self.created_ms})
    }
}

pub struct Daemon {
    home: PathBuf,
    kernel: Arc<Kernel>,
    ptys: Mutex<HashMap<String, Arc<PtyHolder>>>,
    procs: Mutex<HashMap<String, Arc<ProcHolder>>>,
    connections: AtomicUsize,
    last_activity: Mutex<Instant>,
    started: Instant,
}

fn valid_key(k: &str) -> bool {
    !k.is_empty() && k.len() <= 200 && k.bytes().all(|b| b.is_ascii_alphanumeric() || b"-_./:@".contains(&b))
}

fn write_line(w: &mut UnixStream, v: &Value) -> io::Result<()> {
    let mut s = v.to_string();
    s.push('\n');
    w.write_all(s.as_bytes())?;
    w.flush()
}

fn err_json(e: &HostError) -> Value { json!({"ok": false, "error": {"code": e.code, "message": e.message}}) }

#[cfg(any(target_os = "macos", target_os = "freebsd", target_os = "openbsd", target_os = "netbsd"))]
fn peer_uid(s: &UnixStream) -> Option<u32> {
    use std::os::fd::AsRawFd;
    let (mut uid, mut gid) = (0 as libc::uid_t, 0 as libc::gid_t);
    (unsafe { libc::getpeereid(s.as_raw_fd(), &mut uid, &mut gid) } == 0).then_some(uid)
}

#[cfg(target_os = "linux")]
fn peer_uid(s: &UnixStream) -> Option<u32> {
    use std::os::fd::AsRawFd;
    let mut cred: libc::ucred = unsafe { std::mem::zeroed() };
    let mut len = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    let r = unsafe { libc::getsockopt(s.as_raw_fd(), libc::SOL_SOCKET, libc::SO_PEERCRED, &mut cred as *mut _ as *mut libc::c_void, &mut len) };
    (r == 0).then_some(cred.uid)
}

fn set_mode(p: &Path, mode: u32) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(p, std::fs::Permissions::from_mode(mode));
}

pub fn serve(home: &Path, idle_secs: u64) -> anyhow::Result<()> {
    let run = run_dir(home);
    std::fs::create_dir_all(&run)?;
    set_mode(home, 0o700);
    set_mode(&run, 0o700);
    // Single instance: an exclusive lock held for the daemon's lifetime.
    let lock = std::fs::OpenOptions::new().create(true).truncate(false).write(true).open(run.join("hatod.lock"))?;
    {
        use std::os::fd::AsRawFd;
        if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            anyhow::bail!("another daemon is running for {}", home.display());
        }
    }
    let sock = socket_path(home);
    let _ = std::fs::remove_file(&sock);
    let listener = UnixListener::bind(&sock)?;
    set_mode(&sock, 0o600);

    // Headless kernel for pushed plugins. Its "repository" has no built-ins: everything it runs
    // arrives as a user plugin from a desktop client.
    let rt = home.join("runtime");
    for d in ["modules/services", "modules/ui", "grants"] {
        std::fs::create_dir_all(rt.join(d))?;
    }
    let data = home.join("data");
    for d in ["sqlite", "artifacts", "logs", "ssh", "shared", "plugins"] {
        std::fs::create_dir_all(data.join(d))?;
    }
    let cfg = Config {
        repo_root: rt.canonicalize()?,
        data_dir: data.canonicalize()?,
        initial_root: dirs::home_dir(),
        safe_mode: false,
        dev_watch: false,
        headless: true,
        headless_script: None,
    };
    let kernel = Kernel::new(cfg, UiBridge::disconnected())?;
    // No one can click an approval here: requests are denied (and audited) instead of hanging.
    *kernel.approvals.headless_policy.lock() = Some(Arc::new(|req| {
        log::warn!("daemon denied approval '{}' from {} (no desktop attached)", req.title, req.module);
        req.options.iter().find(|o| o.kind == "deny").map(|o| o.id.clone())
    }));
    kernel.boot();
    std::fs::write(run.join("hatod.json"), json!({"pid": std::process::id(), "version": VERSION, "abi": ABI, "socket": sock}).to_string())?;

    let d = Arc::new(Daemon {
        home: home.to_path_buf(),
        kernel,
        ptys: Mutex::new(HashMap::new()),
        procs: Mutex::new(HashMap::new()),
        connections: AtomicUsize::new(0),
        last_activity: Mutex::new(Instant::now()),
        started: Instant::now(),
    });
    let d2 = d.clone();
    std::thread::Builder::new().name("idle".into()).spawn(move || loop {
        std::thread::sleep(Duration::from_secs(15));
        if d2.idle_for() > Duration::from_secs(idle_secs) {
            log::info!("daemon idle for {idle_secs}s; exiting");
            d2.exit();
        }
    })?;
    let me = unsafe { libc::getuid() };
    for stream in listener.incoming() {
        let Ok(stream) = stream else { continue };
        if peer_uid(&stream) != Some(me) {
            continue; // never serve another user, even if the socket were reachable
        }
        let d = d.clone();
        std::thread::spawn(move || {
            d.connections.fetch_add(1, Ordering::SeqCst);
            d.touch();
            if let Err(e) = d.handle(stream) {
                log::debug!("connection ended: {e}");
            }
            d.connections.fetch_sub(1, Ordering::SeqCst);
            d.touch();
        });
    }
    Ok(())
}

impl Daemon {
    fn touch(&self) { *self.last_activity.lock() = Instant::now(); }

    /// Idle = no connections, no live resources, no enabled plugins.
    fn idle_for(&self) -> Duration {
        if self.connections.load(Ordering::SeqCst) > 0 || !self.ptys.lock().is_empty() || !self.procs.lock().is_empty() {
            return Duration::ZERO;
        }
        let plugins = self.kernel.plugins_json();
        if plugins["plugins"].as_array().map(|a| a.iter().any(|p| p["enabled"] == true)).unwrap_or(false) {
            return Duration::ZERO;
        }
        self.last_activity.lock().elapsed()
    }

    fn exit(&self) -> ! {
        for p in self.ptys.lock().values() {
            p.sess.kill();
        }
        for p in self.procs.lock().values() {
            if let Some(c) = p.child.lock().as_mut() {
                let _ = c.kill();
            }
        }
        self.kernel.shutdown();
        let _ = std::fs::remove_file(socket_path(&self.home));
        let _ = std::fs::remove_file(run_dir(&self.home).join("hatod.json"));
        std::process::exit(0)
    }

    fn handle(self: &Arc<Self>, stream: UnixStream) -> io::Result<()> {
        let mut w = stream.try_clone()?;
        let mut reader = BufReader::new(stream);
        let mut line = String::new();
        if reader.read_line(&mut line)? == 0 {
            return Ok(());
        }
        let req: Value = serde_json::from_str(line.trim()).unwrap_or(Value::Null);
        let op = req["op"].as_str().unwrap_or("").to_string();
        let args = req.get("args").cloned().unwrap_or(json!({}));
        match op.as_str() {
            "pty.attach" => self.pty_attach(&args, reader, w),
            "proc.attach" => self.proc_attach(&args, reader, w),
            "bridge" => self.bridge(&args, reader, w),
            "shutdown" => {
                write_line(&mut w, &json!({"ok": true, "value": {"stopping": true}}))?;
                let me = self.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(50));
                    me.exit()
                });
                Ok(())
            }
            _ => {
                let r = match self.request(&op, &args) {
                    Ok(v) => json!({"ok": true, "value": v}),
                    Err(e) => err_json(&e),
                };
                write_line(&mut w, &r)
            }
        }
    }

    fn resources(&self) -> Value {
        let ptys: Vec<Value> = self.ptys.lock().iter().map(|(k, p)| {
            let i = p.sess.info();
            json!({"key": k, "cwd": p.cwd, "exit": i["exit"], "attached": p.attached.load(Ordering::SeqCst), "columns": i["columns"], "rows": i["rows"], "title": i["title"], "createdMs": p.created_ms})
        }).collect();
        let procs: Vec<Value> = self.procs.lock().iter().map(|(k, p)| p.info(k)).collect();
        json!({"ptys": ptys, "procs": procs})
    }

    fn request(&self, op: &str, args: &Value) -> Result<Value, HostError> {
        let s = |k: &str| args.get(k).and_then(|v| v.as_str()).ok_or_else(|| HostError::invalid(format!("missing {k}")));
        match op {
            "hello" | "status" => Ok(json!({
                "version": VERSION, "abi": ABI, "pid": std::process::id(), "home": self.home,
                "exe": std::env::current_exe().ok().map(|p| p.to_string_lossy().into_owned()), "uptimeMs": self.started.elapsed().as_millis() as u64,
                "os": std::env::consts::OS, "arch": std::env::consts::ARCH, "resources": self.resources(), "plugins": self.kernel.plugins_json()["plugins"],
            })),
            "resources.list" => Ok(self.resources()),
            "pty.read" => {
                let p = self.ptys.lock().get(s("key")?).cloned().ok_or_else(|| HostError::not_found("no terminal"))?;
                let cursor = args.get("cursor").and_then(Value::as_u64);
                let limit = args.get("limitBytes").and_then(Value::as_u64).unwrap_or(65536).min(262144) as usize;
                Ok(p.sess.read_output(cursor, limit))
            }
            "pty.write" => {
                let p = self.ptys.lock().get(s("key")?).cloned().ok_or_else(|| HostError::not_found("no terminal"))?;
                let text = s("text")?;
                if text.len() > 65536 { return Err(HostError::invalid("terminal input too large")); }
                p.sess.write(text.as_bytes())?;
                Ok(Value::Null)
            }
            "pty.kill" => {
                let key = s("key")?;
                let p = self.ptys.lock().remove(key).ok_or_else(|| HostError::not_found(format!("no terminal {key}")))?;
                p.sess.kill();
                p.attach.fetch_add(1, Ordering::SeqCst);
                Ok(Value::Null)
            }
            "proc.kill" => {
                let key = s("key")?;
                let p = self.procs.lock().get(key).cloned().ok_or_else(|| HostError::not_found(format!("no process {key}")))?;
                let sig = match args.get("signal").and_then(|v| v.as_str()) { Some("KILL") => libc::SIGKILL, Some("INT") => libc::SIGINT, _ => libc::SIGTERM };
                unsafe { libc::kill(-(p.pid as i32), sig) };
                Ok(Value::Null)
            }
            "proc.closeStdin" => {
                let key = s("key")?;
                let p = self.procs.lock().get(key).cloned().ok_or_else(|| HostError::not_found(format!("no process {key}")))?;
                p.stdin.lock().take();
                Ok(Value::Null)
            }
            "plugins.list" => Ok(self.kernel.plugins_json()),
            "plugins.push" => self.push_plugin(args),
            "plugins.disable" => self.kernel.disable_plugin(None, s("id")?, true),
            "plugins.enable" => self.kernel.enable_plugin(None, s("id")?),
            "modules.call" => {
                let timeout = args.get("timeoutMs").and_then(|t| t.as_u64()).unwrap_or(30_000).clamp(100, 30 * 60 * 1000);
                self.kernel.router.invoke_blocking(s("target")?, json!({"kind": "call", "method": s("method")?, "args": args.get("args").cloned().unwrap_or(Value::Null), "caller": "daemon-client"}), Duration::from_millis(timeout))
            }
            _ => Err(HostError::invalid(format!("unknown daemon op '{op}'"))),
        }
    }

    /// Install or update a plugin sent by the desktop. The desktop already obtained the user's
    /// approval for `approved` (capabilities / `call:` entries); the daemon records them as is.
    fn push_plugin(&self, args: &Value) -> Result<Value, HostError> {
        let manifest: crate::grants::Manifest = serde_json::from_value(args.get("manifest").cloned().unwrap_or(Value::Null)).map_err(|e| HostError::invalid(format!("manifest: {e}")))?;
        manifest.validate()?;
        if manifest.kind == "ui" {
            return Err(HostError::invalid("UI plugins run in the desktop window, not on the daemon"));
        }
        let code = args.get("code").and_then(|c| c.as_str()).ok_or_else(|| HostError::invalid("missing code"))?;
        let id = manifest.id.clone();
        let dir = self.kernel.cfg.plugins_dir().join(&id);
        std::fs::create_dir_all(dir.join("dist"))?;
        let mut m = manifest.clone();
        m.entry = format!("dist/{id}.mjs");
        std::fs::write(dir.join("manifest.json"), serde_json::to_string_pretty(&m).unwrap_or_default())?;
        let hash = crate::util::sha256_hex(code.as_bytes());
        let changed = self.kernel.router.active(&id).map(|g| g.hash != hash).unwrap_or(true);
        std::fs::write(dir.join("dist").join(format!("{id}.mjs")), code)?;
        let approved: Vec<String> = args.get("approved").and_then(|a| a.as_array()).map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default();
        if !approved.is_empty() {
            self.kernel.grants.record_approval(&id, &approved);
        }
        if changed && self.kernel.router.active(&id).is_some() {
            self.kernel.disable_plugin(None, &id, true)?;
        }
        let r = self.kernel.enable_plugin(None, &id)?;
        Ok(json!({"id": id, "sha256": hash, "reloaded": changed, "active": r["active"], "error": r["error"]}))
    }

    fn pty_attach(&self, args: &Value, mut reader: BufReader<UnixStream>, mut w: UnixStream) -> io::Result<()> {
        let key = args["key"].as_str().unwrap_or("").to_string();
        if !valid_key(&key) {
            return write_line(&mut w, &err_json(&HostError::invalid("invalid key")));
        }
        let cols = args["columns"].as_u64().unwrap_or(100) as u16;
        let rows = args["rows"].as_u64().unwrap_or(30) as u16;
        let existing = self.ptys.lock().get(&key).cloned();
        let (holder, created) = match existing {
            Some(h) => (h, false),
            None => {
                let cwd = args["cwd"].as_str().map(str::to_owned).or_else(|| dirs::home_dir().map(|h| h.to_string_lossy().into_owned())).unwrap_or_else(|| "/".into());
                let shell = args["shell"].as_str().map(str::to_owned).or_else(|| std::env::var("SHELL").ok()).unwrap_or_else(|| "/bin/sh".into());
                let spec = PtySpec { program: shell, args: vec!["-l".into()], cwd: Some(cwd.clone()), env: vec![], cols, rows, machine_id: "daemon".into(), display_cwd: cwd.clone(), answer_queries: true };
                match pty::open(spec) {
                    Ok(sess) => {
                        let h = Arc::new(PtyHolder { sess, attach: AtomicU64::new(0), attached: AtomicBool::new(false), cwd, created_ms: now_ms() });
                        self.ptys.lock().insert(key.clone(), h.clone());
                        (h, true)
                    }
                    Err(e) => return write_line(&mut w, &err_json(&e)),
                }
            }
        };
        write_line(&mut w, &json!({"ok": true, "value": {"created": created}}))?;
        let my = holder.attach.fetch_add(1, Ordering::SeqCst) + 1;
        holder.attached.store(true, Ordering::SeqCst);
        if !created {
            // Nudge full-screen programs to redraw for the new viewer (the client's resize restores it).
            let i = holder.sess.info();
            let c = i["columns"].as_u64().unwrap_or(cols as u64) as u16;
            let r = i["rows"].as_u64().unwrap_or(rows as u64) as u16;
            let _ = holder.sess.resize(c.saturating_sub(1).max(10), r);
        }
        let closed = Arc::new(AtomicBool::new(false));
        {
            let (h, closed) = (holder.clone(), closed.clone());
            std::thread::spawn(move || {
                while let Ok(Some((t, data))) = read_frame(&mut reader) {
                    if h.attach.load(Ordering::SeqCst) != my {
                        break;
                    }
                    match t {
                        F_IN => { let _ = h.sess.write(&data); }
                        F_RESIZE if data.len() == 4 => {
                            let _ = h.sess.resize(u16::from_be_bytes([data[0], data[1]]), u16::from_be_bytes([data[2], data[3]]));
                        }
                        _ => {}
                    }
                }
                closed.store(true, Ordering::SeqCst);
            });
        }
        let mut cursor = 0u64;
        let result = loop {
            if holder.attach.load(Ordering::SeqCst) != my {
                let _ = write_frame(&mut w, F_DETACHED, b"attached elsewhere");
                break Ok(());
            }
            if closed.load(Ordering::SeqCst) {
                break Ok(());
            }
            let v = holder.sess.read_output(Some(cursor), 64 * 1024);
            let text = v["text"].as_str().unwrap_or("");
            if !text.is_empty() {
                if let Err(e) = write_frame(&mut w, F_OUT, text.as_bytes()) {
                    break Err(e);
                }
            }
            cursor = v["cursor"].as_u64().unwrap_or(cursor);
            let end = v["endCursor"].as_u64().unwrap_or(cursor);
            if !v["exit"].is_null() && cursor >= end {
                let _ = write_frame(&mut w, F_EXIT, json!({"status": v["exit"]}).to_string().as_bytes());
                self.ptys.lock().remove(&key);
                break Ok(());
            }
            if text.is_empty() {
                std::thread::sleep(Duration::from_millis(10));
            }
        };
        if holder.attach.load(Ordering::SeqCst) == my {
            holder.attached.store(false, Ordering::SeqCst);
        }
        result
    }

    fn proc_attach(&self, args: &Value, mut reader: BufReader<UnixStream>, mut w: UnixStream) -> io::Result<()> {
        let key = args["key"].as_str().unwrap_or("").to_string();
        if !valid_key(&key) {
            return write_line(&mut w, &err_json(&HostError::invalid("invalid key")));
        }
        let existing = self.procs.lock().get(&key).cloned();
        let (holder, created) = match existing {
            Some(h) => (h, false),
            None => {
                let Some(sh) = args["sh"].as_str() else {
                    return write_line(&mut w, &err_json(&HostError::not_found(format!("no process {key} (and no command to start)"))));
                };
                match spawn_held(sh, args["cwd"].as_str()) {
                    Ok(h) => {
                        self.procs.lock().insert(key.clone(), h.clone());
                        (h, true)
                    }
                    Err(e) => return write_line(&mut w, &err_json(&e)),
                }
            }
        };
        write_line(&mut w, &json!({"ok": true, "value": {"created": created, "pid": holder.pid}}))?;
        let my = holder.attach.fetch_add(1, Ordering::SeqCst) + 1;
        holder.attached.store(true, Ordering::SeqCst);
        holder.cv.notify_all();
        {
            // Output the previous viewer received but never confirmed goes out first.
            let mut infl = holder.inflight.lock();
            let mut q = holder.pending.lock();
            while let Some(f) = infl.pop_back() {
                holder.pending_bytes.fetch_add(f.1.len(), Ordering::SeqCst);
                q.push_front(f);
            }
        }
        let closed = Arc::new(AtomicBool::new(false));
        {
            let (h, closed) = (holder.clone(), closed.clone());
            std::thread::spawn(move || {
                // EOF here means the viewer went away (or closed its stdin): the process keeps
                // running either way; use `proc.closeStdin` to close its input explicitly.
                while let Ok(Some((t, data))) = read_frame(&mut reader) {
                    if h.attach.load(Ordering::SeqCst) != my {
                        break;
                    }
                    match t {
                        F_IN => {
                            if let Some(stdin) = h.stdin.lock().as_mut() {
                                let _ = stdin.write_all(&data).and_then(|_| stdin.flush());
                            }
                        }
                        F_ACK if data.len() == 4 => {
                            let n = u32::from_be_bytes([data[0], data[1], data[2], data[3]]) as usize;
                            let mut infl = h.inflight.lock();
                            for _ in 0..n.min(infl.len()) {
                                infl.pop_front();
                            }
                            h.cv.notify_all();
                        }
                        _ => {}
                    }
                }
                closed.store(true, Ordering::SeqCst);
                h.cv.notify_all();
            });
        }
        let result = loop {
            let next = {
                let mut q = holder.pending.lock();
                while q.is_empty() && (holder.exit.lock().is_none() || !holder.inflight.lock().is_empty())
                    && holder.attach.load(Ordering::SeqCst) == my && !closed.load(Ordering::SeqCst) {
                    holder.cv.wait_for(&mut q, Duration::from_millis(250));
                }
                if holder.attach.load(Ordering::SeqCst) != my || closed.load(Ordering::SeqCst) {
                    None
                } else {
                    q.pop_front().map(|f| { holder.pending_bytes.fetch_sub(f.1.len(), Ordering::SeqCst); f })
                }
            };
            if closed.load(Ordering::SeqCst) {
                break Ok(());
            }
            if holder.attach.load(Ordering::SeqCst) != my {
                let _ = write_frame(&mut w, F_DETACHED, b"attached elsewhere");
                break Ok(());
            }
            match next {
                Some((t, data)) => {
                    if let Err(e) = write_frame(&mut w, t, &data) {
                        // Viewer gone: keep the undelivered frame for the next attach.
                        holder.pending_bytes.fetch_add(data.len(), Ordering::SeqCst);
                        holder.pending.lock().push_front((t, data));
                        break Err(e);
                    }
                    let mut infl = holder.inflight.lock();
                    infl.push_back((t, data));
                    // Bound memory for viewers that never acknowledge.
                    let mut bytes: usize = infl.iter().map(|f| f.1.len()).sum();
                    while bytes > PROC_BUFFER {
                        if let Some(f) = infl.pop_front() { bytes -= f.1.len(); } else { break; }
                    }
                }
                None => {
                    let exit = holder.exit.lock().clone();
                    if let Some(exit) = exit {
                        if write_frame(&mut w, F_EXIT, exit.to_string().as_bytes()).is_ok() {
                            self.procs.lock().remove(&key);
                        }
                        break Ok(());
                    }
                }
            }
        };
        if holder.attach.load(Ordering::SeqCst) == my {
            holder.attached.store(false, Ordering::SeqCst);
        }
        result
    }

    /// Line bridge: each stdin line becomes `plugin.method({line})`; the plugin returns a line, a
    /// list of lines, or null. Lets remote tools reach plugins without the desktop.
    fn bridge(&self, args: &Value, mut reader: BufReader<UnixStream>, mut w: UnixStream) -> io::Result<()> {
        let plugin = args["plugin"].as_str().unwrap_or("").to_string();
        let method = args["method"].as_str().unwrap_or("").to_string();
        if !crate::grants::valid_module_id(&plugin) || method.is_empty() {
            return write_line(&mut w, &err_json(&HostError::invalid("bridge needs a plugin id and method")));
        }
        write_line(&mut w, &json!({"ok": true, "value": null}))?;
        let mut line = String::new();
        loop {
            line.clear();
            if reader.read_line(&mut line)? == 0 {
                return Ok(());
            }
            let text = line.trim_end_matches(['\n', '\r']);
            if text.is_empty() {
                continue;
            }
            self.touch();
            let r = self.kernel.router.invoke_blocking(&plugin, json!({"kind": "call", "method": method, "args": {"line": text}, "caller": "daemon-bridge"}), Duration::from_secs(600));
            let out = match r {
                Ok(Value::String(s)) => json!({"lines": [s]}),
                Ok(Value::Array(a)) => json!({"lines": a}),
                Ok(_) => json!({"lines": []}),
                Err(e) => json!({"error": e.to_string()}),
            };
            write_line(&mut w, &out)?;
        }
    }
}

fn spawn_held(sh: &str, cwd: Option<&str>) -> Result<Arc<ProcHolder>, HostError> {
    let mut cmd = Command::new("/bin/sh");
    cmd.arg("-c").arg(sh).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    if let Some(c) = cwd {
        cmd.current_dir(c);
    }
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    let mut child = cmd.spawn().map_err(|e| HostError::new("ENOEXEC", format!("cannot start process: {e}")))?;
    let pid = child.id();
    let (mut out, mut err, stdin) = (child.stdout.take().unwrap(), child.stderr.take().unwrap(), child.stdin.take());
    let h = Arc::new(ProcHolder {
        pid, child: Mutex::new(Some(child)), stdin: Mutex::new(stdin), pending: Mutex::new(VecDeque::new()), pending_bytes: AtomicUsize::new(0), inflight: Mutex::new(VecDeque::new()),
        dropped: AtomicU64::new(0), cv: Condvar::new(), exit: Mutex::new(None), attach: AtomicU64::new(0), attached: AtomicBool::new(false),
        command: sh.chars().take(300).collect(), cwd: cwd.unwrap_or("").to_string(), created_ms: now_ms(),
    });
    let pump = |h: Arc<ProcHolder>, t: u8, r: &mut dyn Read| {
        let mut buf = vec![0u8; 32 * 1024];
        loop {
            match r.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => h.push(t, &buf[..n]),
                Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                Err(_) => break,
            }
        }
    };
    let (h1, h2, h3) = (h.clone(), h.clone(), h.clone());
    let t_out = std::thread::spawn(move || pump(h1, F_OUT, &mut out));
    let t_err = std::thread::spawn(move || pump(h2, F_ERR, &mut err));
    std::thread::spawn(move || {
        let _ = t_out.join();
        let _ = t_err.join();
        let status = h3.child.lock().as_mut().map(|c| c.wait());
        let v = match status {
            Some(Ok(s)) => {
                use std::os::unix::process::ExitStatusExt;
                json!({"code": s.code(), "signal": s.signal()})
            }
            _ => json!({"code": null, "signal": null}),
        };
        *h3.exit.lock() = Some(v);
        h3.cv.notify_all();
    });
    Ok(h)
}
