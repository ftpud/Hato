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
use super::ipc::{Group, Listener as UnixListener, Stream as UnixStream};
use std::io::{BufRead, BufReader};
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
    /// The process and everything it starts (`None` if Windows could not create its job).
    group: Option<Group>,
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
    /// Process groups of running `exec`/`pty.exec` programs by pid (killed when the daemon exits).
    ephemeral: Mutex<HashMap<u32, Group>>,
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

/// Unix permissions; on Windows the home and its `run` directory keep the ACL of the user profile.
fn set_mode(_p: &Path, _mode: u32) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(_p, std::fs::Permissions::from_mode(_mode));
    }
}

#[cfg(windows)]
fn raise_fd_limit() {}

/// Each routed command holds a few descriptors (socket, pipes or a PTY) for its lifetime; the
/// usual soft limit of 1024 would cap concurrency near 200, so use the hard limit.
#[cfg(unix)]
fn raise_fd_limit() {
    let mut l = libc::rlimit { rlim_cur: 0, rlim_max: 0 };
    if unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut l) } != 0 || l.rlim_cur >= l.rlim_max {
        return;
    }
    // macOS rejects RLIM_INFINITY for open files; OPEN_MAX bounds it there.
    #[cfg(target_os = "macos")]
    let target = l.rlim_max.min(10240); // OPEN_MAX (sys/syslimits.h)
    #[cfg(not(target_os = "macos"))]
    let target = l.rlim_max;
    let raised = libc::rlimit { rlim_cur: target, rlim_max: l.rlim_max };
    unsafe { libc::setrlimit(libc::RLIMIT_NOFILE, &raised) };
}

pub fn serve(home: &Path, idle_secs: u64) -> anyhow::Result<()> {
    // Resolve the login shell before any request threads exist.
    #[cfg(unix)]
    let _ = login_shell();
    raise_fd_limit();
    let run = run_dir(home);
    std::fs::create_dir_all(&run)?;
    set_mode(home, 0o700);
    set_mode(&run, 0o700);
    // Single instance: an exclusive lock held for the daemon's lifetime (`flock` on Unix,
    // `LockFileEx` on Windows).
    let lock = std::fs::OpenOptions::new().create(true).truncate(false).write(true).open(run.join("hatod.lock"))?;
    if lock.try_lock().is_err() {
        anyhow::bail!("another daemon is running for {}", home.display());
    }
    let sock = socket_path(home);
    if let Some(dir) = sock.parent().filter(|d| *d != run.as_path()) {
        secure_socket_dir(dir, true)?;
    }
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
        // Plain paths: Windows' `canonicalize` adds `\\?\`, which rejects the `/` in plugin entries
        // (`dist/<id>.mjs`) with "filename, directory name, or volume label syntax is incorrect".
        repo_root: PathBuf::from(crate::util::canonical_string(&rt)?),
        data_dir: PathBuf::from(crate::util::canonical_string(&data)?),
        initial_root: dirs::home_dir(),
        initial_root_explicit: false,
        safe_mode: false,
        dev_watch: false,
        headless: true,
        headless_script: None,
        snapshot: None,
    };
    let kernel = Kernel::new(cfg, UiBridge::disconnected())?;
    // No one can click an approval here: requests are denied (and audited) instead of hanging.
    *kernel.approvals.headless_policy.lock() = Some(Arc::new(|req| {
        log::warn!("daemon denied approval '{}' from {} (no desktop attached)", req.title, req.module);
        req.options.iter().find(|o| o.kind == "deny").map(|o| o.id.clone())
    }));
    // Operator limits for pushed plugins, set by a desktop through `policy.set`. Loaded before boot
    // so plugins never run without them.
    kernel.host_policy.load(home.join("policy.json"));
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
        ephemeral: Mutex::new(Default::default()),
    });
    #[cfg(unix)]
    {
        let connector_home = home.to_path_buf();
        std::thread::spawn(move || crate::host::cloud::supervise_daemon(connector_home));
    }
    let d2 = d.clone();
    #[cfg_attr(windows, allow(unused_variables))]
    let touched = sock.clone();
    std::thread::Builder::new().name("idle".into()).spawn(move || loop {
        std::thread::sleep(Duration::from_secs(15));
        // Fresh times keep age-based temp cleaners (systemd-tmpfiles) off a socket in /tmp.
        #[cfg(unix)]
        if let Ok(c) = std::ffi::CString::new(touched.as_os_str().as_encoded_bytes()) {
            unsafe { libc::utimensat(libc::AT_FDCWD, c.as_ptr(), std::ptr::null(), libc::AT_SYMLINK_NOFOLLOW) };
        }
        if d2.idle_for() > Duration::from_secs(idle_secs) {
            log::info!("daemon idle for {idle_secs}s; exiting");
            d2.exit();
        }
    })?;
    for stream in listener.incoming() {
        let stream = match stream {
            Ok(s) => s,
            // Out of descriptors (or similar): back off instead of spinning; the connection
            // waits in the backlog and is accepted once a running command ends.
            Err(e) => {
                log::warn!("accept failed: {e}");
                std::thread::sleep(Duration::from_millis(50));
                continue;
            }
        };
        if !super::ipc::peer_is_self(&stream) {
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
        #[cfg(unix)]
        let managed = crate::host::cloud::daemon_managed(&self.home);
        #[cfg(windows)]
        let managed = false;
        if managed || self.connections.load(Ordering::SeqCst) > 0 || !self.ptys.lock().is_empty() || !self.procs.lock().is_empty() {
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
            if let Some(g) = &p.group {
                g.signal("KILL");
            }
        }
        for group in self.ephemeral.lock().values() {
            group.signal("KILL");
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
        if reader.by_ref().take(MAX_FRAME as u64).read_line(&mut line)? == 0 {
            return Ok(());
        }
        if !line.ends_with('\n') {
            return write_line(&mut w, &err_json(&HostError::invalid("daemon request exceeds the message limit or has no newline")));
        }
        let req: Value = serde_json::from_str(line.trim()).unwrap_or(Value::Null);
        let op = req["op"].as_str().unwrap_or("").to_string();
        let args = req.get("args").cloned().unwrap_or(json!({}));
        match op.as_str() {
            "pty.attach" => self.pty_attach(&args, reader, w),
            "proc.attach" => self.proc_attach(&args, reader, w),
            "bridge" => self.bridge(&args, reader, w),
            #[cfg(unix)]
            "exec" => self.exec(&args, reader, w),
            #[cfg(unix)]
            "pty.exec" => self.pty_exec(&args, reader, w),
            // The SSH command route: Windows SSH hosts have no daemon (`daemon_link::install`).
            #[cfg(windows)]
            "exec" | "pty.exec" => write_line(&mut w, &err_json(&HostError::new("ENOTSUP", "exec routes are unavailable on Windows daemons"))),
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
                "features": FEATURES, "socket": absolute(&socket_path(&self.home)),
            })),
            "resources.list" => Ok(self.resources()),
            "fs.root" | "fs.resolve" | "fs.stat" | "fs.list" | "fs.read" | "fs.mkdir" | "fs.write" => {
                files::request(&self.kernel.cfg, &self.home, op, args)
            }
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
                let sig = match args.get("signal").and_then(|v| v.as_str()) { Some("KILL") => "KILL", Some("INT") => "INT", _ => "TERM" };
                match &p.group {
                    Some(g) => g.signal(sig),
                    None => { if let Some(c) = p.child.lock().as_mut() { let _ = c.kill(); } }
                }
                Ok(Value::Null)
            }
            "proc.closeStdin" => {
                let key = s("key")?;
                let p = self.procs.lock().get(key).cloned().ok_or_else(|| HostError::not_found(format!("no process {key}")))?;
                p.stdin.lock().take();
                Ok(Value::Null)
            }
            "plugins.list" => Ok(self.kernel.plugins_json()),
            "policy.get" => Ok(self.kernel.host_policy.status_json()),
            "policy.set" => {
                let policy = self.kernel.host_policy.set(args.get("policy").unwrap_or(&Value::Null))?;
                self.kernel.audit.record("daemon-client", 0, "policy.set", &serde_json::to_string(&policy).unwrap_or_default(), "ok", None);
                Ok(self.kernel.host_policy.status_json())
            }
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
                #[cfg(unix)]
                let (shell, login) = (args["shell"].as_str().map(str::to_owned).or_else(|| std::env::var("SHELL").ok()).unwrap_or_else(|| "/bin/sh".into()), vec!["-l".to_string()]);
                #[cfg(windows)]
                let (shell, login) = (args["shell"].as_str().map(str::to_owned).unwrap_or_else(|| "powershell.exe".into()), vec![]);
                let spec = PtySpec { remote: None, program: shell, args: login, cwd: Some(cwd.clone()), env: vec![], env_remove: vec![], cols, rows, machine_id: "daemon".into(), display_cwd: cwd.clone(), answer_queries: true };
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
                let command = match held_command(args) {
                    Ok(c) => c,
                    Err(e) => return write_line(&mut w, &err_json(&e)),
                };
                match spawn_held(command, args["cwd"].as_str()) {
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

fn absolute(p: &Path) -> String {
    let p = if p.is_absolute() { p.to_path_buf() } else { std::env::current_dir().map(|d| d.join(p)).unwrap_or_else(|_| p.to_path_buf()) };
    p.to_string_lossy().into_owned()
}

/// The user's login shell (what sshd runs commands with), then `$SHELL`, then `/bin/sh`.
///
/// Resolved once with the reentrant `getpwuid_r` and cached. `getpwuid` returns a pointer into a
/// shared static buffer: called from concurrent request threads it returned other accounts' shells
/// (e.g. `/usr/sbin/nologin`) and corrupted memory, crashing the daemon under request bursts.
#[cfg(unix)]
fn login_shell() -> String {
    static SHELL: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    SHELL.get_or_init(|| passwd_shell().unwrap_or_else(|| {
        std::env::var("SHELL").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "/bin/sh".into())
    })).clone()
}

#[cfg(unix)]
fn passwd_shell() -> Option<String> {
    let mut buffer = vec![0 as libc::c_char; 16 * 1024];
    let mut entry: libc::passwd = unsafe { std::mem::zeroed() };
    let mut found: *mut libc::passwd = std::ptr::null_mut();
    let code = unsafe {
        libc::getpwuid_r(libc::getuid(), &mut entry, buffer.as_mut_ptr(), buffer.len(), &mut found)
    };
    if code != 0 || found.is_null() || entry.pw_shell.is_null() {
        return None;
    }
    let shell = unsafe { std::ffi::CStr::from_ptr(entry.pw_shell) }.to_str().ok()?.to_string();
    (!shell.is_empty()).then_some(shell)
}

#[cfg(unix)]
type SharedSocket = Arc<Mutex<UnixStream>>;
#[cfg(unix)]
fn send_frame(w: &SharedSocket, t: u8, data: &[u8]) -> io::Result<()> { write_frame(&mut *w.lock(), t, data) }

/// Ends a connection's program when the desktop goes away: HUP (as sshd does when a channel
/// closes), then KILL if the group is still there two seconds later.
#[cfg(unix)]
fn hang_up(group: &Group, finished: &Arc<AtomicBool>) {
    if finished.load(Ordering::SeqCst) {
        return;
    }
    group.signal("HUP");
    let (group, finished) = (group.clone(), finished.clone());
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(2));
        if !finished.load(Ordering::SeqCst) {
            group.signal("KILL");
        }
    });
}

#[cfg(unix)]
impl Daemon {
    /// `exec`: run `sh` with the login shell in the home directory, like an SSH exec channel, for as
    /// long as this connection lasts. Frames: out/err/exit to the desktop; in/eof/signal from it.
    fn exec(&self, args: &Value, mut reader: BufReader<UnixStream>, mut w: UnixStream) -> io::Result<()> {
        let Some(sh) = args["sh"].as_str() else { return write_line(&mut w, &err_json(&HostError::invalid("missing sh"))) };
        let mut cmd = Command::new(login_shell());
        cmd.arg("-c").arg(sh).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        if let Some(h) = dirs::home_dir() { cmd.current_dir(h); }
        {
            use std::os::unix::process::CommandExt;
            cmd.process_group(0);
        }
        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => return write_line(&mut w, &err_json(&HostError::new("ENOEXEC", format!("cannot start process: {e}")))),
        };
        let pid = child.id();
        let group = Group::of_leader(pid)?;
        self.ephemeral.lock().insert(pid, group.clone());
        let finished = Arc::new(AtomicBool::new(false));
        let result = (|| {
            write_line(&mut w, &json!({"ok": true, "value": {"pid": pid}}))?;
            let w: SharedSocket = Arc::new(Mutex::new(w));
            let (out, err) = (child.stdout.take().unwrap(), child.stderr.take().unwrap());
            let pump = |mut r: Box<dyn Read + Send>, t: u8, w: SharedSocket| std::thread::spawn(move || {
                let mut buf = vec![0u8; 32 * 1024];
                loop {
                    match r.read(&mut buf) {
                        Ok(0) => break,
                        Ok(n) => if send_frame(&w, t, &buf[..n]).is_err() { break },
                        Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                        Err(_) => break,
                    }
                }
            });
            let (t_out, t_err) = (pump(Box::new(out), F_OUT, w.clone()), pump(Box::new(err), F_ERR, w.clone()));
            let mut stdin = child.stdin.take();
            let (fin, group) = (finished.clone(), group.clone());
            std::thread::spawn(move || {
                loop {
                    match read_frame(&mut reader) {
                        Ok(Some((F_IN, data))) => { if let Some(i) = stdin.as_mut() { if i.write_all(&data).and_then(|_| i.flush()).is_err() { stdin = None; } } }
                        Ok(Some((F_EOF, _))) => stdin = None,
                        Ok(Some((F_SIGNAL, name))) => group.signal(&String::from_utf8_lossy(&name)),
                        Ok(Some(_)) => {}
                        Ok(None) | Err(_) => break,
                    }
                }
                hang_up(&group, &fin);
            });
            let status = child.wait();
            finished.store(true, Ordering::SeqCst);
            let _ = (t_out.join(), t_err.join());
            let r = send_frame(&w, F_EXIT, exit_json(status.ok()).to_string().as_bytes());
            let _ = w.lock().shutdown(std::net::Shutdown::Both);
            r
        })();
        finished.store(true, Ordering::SeqCst);
        self.ephemeral.lock().remove(&pid);
        result
    }

    /// `pty.exec`: like `exec`, on a fresh pseudo-terminal (`columns`/`rows`, resized by frames).
    fn pty_exec(&self, args: &Value, mut reader: BufReader<UnixStream>, mut w: UnixStream) -> io::Result<()> {
        use portable_pty::{native_pty_system, CommandBuilder, PtySize};
        let Some(sh) = args["sh"].as_str() else { return write_line(&mut w, &err_json(&HostError::invalid("missing sh"))) };
        let cols = args["columns"].as_u64().unwrap_or(100).clamp(10, 1000) as u16;
        let rows = args["rows"].as_u64().unwrap_or(30).clamp(3, 500) as u16;
        let pair = match native_pty_system().openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 }) {
            Ok(p) => p,
            Err(e) => return write_line(&mut w, &err_json(&HostError::new("EPTY", format!("openpty: {e}")))),
        };
        let mut cb = CommandBuilder::new(login_shell());
        cb.args(["-c", sh]);
        if let Some(h) = dirs::home_dir() { cb.cwd(h); }
        cb.env("TERM", "xterm-256color");
        cb.env("COLORTERM", "truecolor");
        let mut child = match pair.slave.spawn_command(cb) {
            Ok(c) => c,
            Err(e) => return write_line(&mut w, &err_json(&HostError::new("ENOEXEC", format!("cannot start terminal program: {e}")))),
        };
        drop(pair.slave);
        // The PTY child leads its own session, so its pid is the process group to signal.
        let pid = child.process_id().unwrap_or(0);
        let group = (pid > 0).then(|| Group::of_leader(pid).ok()).flatten();
        if let Some(g) = &group { self.ephemeral.lock().insert(pid, g.clone()); }
        let finished = Arc::new(AtomicBool::new(false));
        let result = (|| {
            let (mut out, input) = match (pair.master.try_clone_reader(), pair.master.take_writer()) {
                (Ok(r), Ok(wr)) => (r, wr),
                _ => { let _ = child.kill(); return write_line(&mut w, &err_json(&HostError::new("EPTY", "cannot open terminal streams"))); }
            };
            write_line(&mut w, &json!({"ok": true, "value": {"pid": pid}}))?;
            let w: SharedSocket = Arc::new(Mutex::new(w));
            let (done_tx, done_rx) = crossbeam_channel::bounded::<()>(1);
            {
                let w = w.clone();
                std::thread::spawn(move || {
                    let mut buf = vec![0u8; 32 * 1024];
                    loop {
                        match out.read(&mut buf) {
                            Ok(0) => break,
                            Ok(n) => if send_frame(&w, F_OUT, &buf[..n]).is_err() { break },
                            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                            Err(_) => break,
                        }
                    }
                    let _ = done_tx.send(());
                });
            }
            let master = Arc::new(Mutex::new(pair.master));
            let (fin, group) = (finished.clone(), group.clone());
            std::thread::spawn(move || {
                let mut input = input;
                loop {
                    match read_frame(&mut reader) {
                        Ok(Some((F_IN, data))) => { let _ = input.write_all(&data).and_then(|_| input.flush()); }
                        Ok(Some((F_RESIZE, d))) if d.len() == 4 => {
                            let _ = master.lock().resize(PtySize { cols: u16::from_be_bytes([d[0], d[1]]).clamp(10, 1000), rows: u16::from_be_bytes([d[2], d[3]]).clamp(3, 500), pixel_width: 0, pixel_height: 0 });
                        }
                        Ok(Some((F_SIGNAL, name))) => { if let Some(g) = &group { g.signal(&String::from_utf8_lossy(&name)); } }
                        Ok(Some(_)) => {}
                        Ok(None) | Err(_) => break,
                    }
                }
                if let Some(g) = &group { hang_up(g, &fin); }
            });
            let status = child.wait();
            finished.store(true, Ordering::SeqCst);
            // Output still buffered in the PTY drains first; a background job holding the
            // terminal open must not keep the exit from being reported.
            let _ = done_rx.recv_timeout(Duration::from_millis(500));
            let code = status.map(|s| s.exit_code() as i64).ok();
            let r = send_frame(&w, F_EXIT, json!({"code": code, "signal": null}).to_string().as_bytes());
            let _ = w.lock().shutdown(std::net::Shutdown::Both);
            r
        })();
        finished.store(true, Ordering::SeqCst);
        if group.is_some() { self.ephemeral.lock().remove(&pid); }
        result
    }
}

fn exit_json(status: Option<std::process::ExitStatus>) -> Value {
    match status {
        Some(s) => {
            let e = crate::host::stdio::exit_info(&s);
            json!({"code": e.code, "signal": e.signal})
        }
        None => json!({"code": null, "signal": null}),
    }
}

/// What `proc.attach` starts: `spec` ({program, args, env, envRemove, verbatim}, run directly) or
/// `sh` (a shell command line: `/bin/sh -c` on Unix, `cmd.exe /d /s /c` on Windows).
/// Returns the command and how it is described in `resources.list`.
fn held_command(args: &Value) -> Result<(Command, String), HostError> {
    if let Some(spec) = args.get("spec").filter(|s| s.is_object()) {
        let program = spec["program"].as_str().filter(|p| !p.is_empty()).ok_or_else(|| HostError::invalid("spec.program is required"))?;
        let list: Vec<&str> = spec["args"].as_array().map(|a| a.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
        let mut cmd = crate::util::command(program);
        if spec["verbatim"] == true {
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                cmd.raw_arg(list.join(" "));
            }
            #[cfg(not(windows))]
            return Err(HostError::invalid("verbatim arguments are Windows-only"));
        } else {
            cmd.args(&list);
        }
        for k in spec["envRemove"].as_array().into_iter().flatten().filter_map(Value::as_str) {
            cmd.env_remove(k);
        }
        for (k, v) in spec["env"].as_object().into_iter().flatten() {
            if let Some(v) = v.as_str() { cmd.env(k, v); }
        }
        let description = std::iter::once(program).chain(list.iter().copied()).collect::<Vec<_>>().join(" ");
        return Ok((cmd, description));
    }
    let sh = args["sh"].as_str().ok_or_else(|| HostError::not_found(format!("no process {} (and no command to start)", args["key"].as_str().unwrap_or(""))))?;
    #[cfg(unix)]
    let cmd = {
        let mut c = Command::new("/bin/sh");
        c.arg("-c").arg(sh);
        c
    };
    #[cfg(windows)]
    let cmd = {
        use std::os::windows::process::CommandExt;
        let mut c = crate::util::command(crate::util::system32("cmd.exe"));
        c.raw_arg(format!("/d /s /c \"{sh}\""));
        c
    };
    Ok((cmd, sh.to_string()))
}

fn spawn_held((mut cmd, description): (Command, String), cwd: Option<&str>) -> Result<Arc<ProcHolder>, HostError> {
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    if let Some(c) = cwd {
        cmd.current_dir(c);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    let mut child = cmd.spawn().map_err(|e| HostError::new("ENOEXEC", format!("cannot start process: {e}")))?;
    let pid = child.id();
    // Windows: a job created right after the start; anything the program launched in between
    // escapes it (process groups have no such gap).
    let group = Group::of_leader(pid).inspect_err(|e| log::warn!("process {pid} has no process group: {e}")).ok();
    let (mut out, mut err, stdin) = (child.stdout.take().unwrap(), child.stderr.take().unwrap(), child.stdin.take());
    let h = Arc::new(ProcHolder {
        pid, group, child: Mutex::new(Some(child)), stdin: Mutex::new(stdin), pending: Mutex::new(VecDeque::new()), pending_bytes: AtomicUsize::new(0), inflight: Mutex::new(VecDeque::new()),
        dropped: AtomicU64::new(0), cv: Condvar::new(), exit: Mutex::new(None), attach: AtomicU64::new(0), attached: AtomicBool::new(false),
        command: description.chars().take(300).collect(), cwd: cwd.unwrap_or("").to_string(), created_ms: now_ms(),
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
        let status = h3.child.lock().as_mut().and_then(|c| c.wait().ok());
        *h3.exit.lock() = Some(exit_json(status));
        h3.cv.notify_all();
    });
    Ok(h)
}
