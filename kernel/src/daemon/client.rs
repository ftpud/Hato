//! Client commands run on the remote machine (over SSH) to talk to the daemon.
use super::*;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader};
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

/// Exit with a specific status (e.g. the attached process's exit code).
#[derive(Debug)]
pub struct ExitCode(pub i32);
impl std::fmt::Display for ExitCode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { write!(f, "exit status {}", self.0) }
}
impl std::error::Error for ExitCode {}

fn connect(home: &Path) -> anyhow::Result<UnixStream> {
    UnixStream::connect(socket_path(home)).map_err(|e| anyhow::anyhow!("daemon not reachable at {}: {e}", socket_path(home).display()))
}

fn send_line(s: &mut UnixStream, v: &Value) -> io::Result<()> {
    let mut t = v.to_string();
    t.push('\n');
    s.write_all(t.as_bytes())
}

fn reply(r: &mut BufReader<UnixStream>) -> anyhow::Result<Value> {
    let mut line = String::new();
    if r.read_line(&mut line)? == 0 {
        anyhow::bail!("daemon closed the connection");
    }
    let v: Value = serde_json::from_str(line.trim())?;
    if v["ok"] == true {
        Ok(v["value"].clone())
    } else {
        anyhow::bail!("{}: {}", v["error"]["code"].as_str().unwrap_or("EDAEMON"), v["error"]["message"].as_str().unwrap_or("request failed"))
    }
}

/// One request/response round trip.
pub fn request(home: &Path, req: &Value) -> anyhow::Result<Value> {
    let mut s = connect(home)?;
    send_line(&mut s, req)?;
    let mut r = BufReader::new(s);
    reply(&mut r)
}

/// `ctl`: one JSON request on stdin, the JSON reply (`{"ok":…}`) on stdout.
pub fn ctl(home: &Path) -> anyhow::Result<()> {
    let mut input = String::new();
    io::stdin().read_to_string(&mut input)?;
    let req: Value = serde_json::from_str(input.trim())?;
    match request(home, &req) {
        Ok(v) => println!("{}", json!({"ok": true, "value": v})),
        Err(e) => println!("{}", json!({"ok": false, "error": {"code": "EDAEMON", "message": format!("{e:#}")}})),
    }
    Ok(())
}

/// Start the daemon if needed (detached from this session) and print its status.
pub fn ensure(home: &Path, force: bool) -> anyhow::Result<()> {
    if let Ok(info) = request(home, &json!({"op": "hello"})) {
        // Same build = same version, ABI and binary (uploaded binaries are named by content hash).
        let exe = std::env::current_exe().ok().map(|p| p.to_string_lossy().into_owned());
        let same = info["version"] == VERSION && info["abi"] == ABI && info["exe"].as_str() == exe.as_deref();
        let live = info["resources"]["ptys"].as_array().map(|a| !a.is_empty()).unwrap_or(false)
            || info["resources"]["procs"].as_array().map(|a| !a.is_empty()).unwrap_or(false);
        if same || (live && !force) {
            let mut out = info;
            out["stale"] = json!(!same);
            println!("{out}");
            return Ok(());
        }
        // Different build and nothing to lose (or forced): replace it.
        let _ = request(home, &json!({"op": "shutdown"}));
        let t = Instant::now();
        while socket_path(home).exists() && t.elapsed() < Duration::from_secs(5) {
            std::thread::sleep(Duration::from_millis(50));
        }
    }
    std::fs::create_dir_all(run_dir(home))?;
    let log = std::fs::OpenOptions::new().create(true).append(true).open(run_dir(home).join("hatod.log"))?;
    let exe = std::env::current_exe()?;
    let mut cmd = std::process::Command::new(exe);
    cmd.args(["daemon", "serve", "--dir"]).arg(home)
        .stdin(std::process::Stdio::null()).stdout(log.try_clone()?).stderr(log);
    {
        use std::os::unix::process::CommandExt;
        // A new session: the daemon must not die with the SSH session that started it.
        unsafe {
            cmd.pre_exec(|| {
                if libc::setsid() < 0 {
                    return Err(io::Error::last_os_error());
                }
                Ok(())
            });
        }
    }
    cmd.spawn()?;
    let t = Instant::now();
    loop {
        match request(home, &json!({"op": "hello"})) {
            Ok(mut info) => {
                info["stale"] = json!(false);
                info["started"] = json!(true);
                println!("{info}");
                return Ok(());
            }
            Err(e) if t.elapsed() > Duration::from_secs(15) => anyhow::bail!("daemon did not start: {e:#} (see {})", run_dir(home).join("hatod.log").display()),
            Err(_) => std::thread::sleep(Duration::from_millis(50)),
        }
    }
}

fn winsize() -> Option<(u16, u16)> {
    let mut ws: libc::winsize = unsafe { std::mem::zeroed() };
    (unsafe { libc::ioctl(0, libc::TIOCGWINSZ, &mut ws) } == 0 && ws.ws_col > 0).then_some((ws.ws_col, ws.ws_row))
}

/// Raw mode for the duration of an interactive attach; restored on drop.
struct RawMode(Option<libc::termios>);
impl RawMode {
    fn enable() -> RawMode {
        unsafe {
            if libc::isatty(0) != 1 {
                return RawMode(None);
            }
            let mut t: libc::termios = std::mem::zeroed();
            if libc::tcgetattr(0, &mut t) != 0 {
                return RawMode(None);
            }
            let orig = t;
            libc::cfmakeraw(&mut t);
            libc::tcsetattr(0, libc::TCSANOW, &t);
            RawMode(Some(orig))
        }
    }
}
impl Drop for RawMode {
    fn drop(&mut self) {
        if let Some(t) = self.0 {
            unsafe { libc::tcsetattr(0, libc::TCSANOW, &t) };
        }
    }
}

fn spawn_stdin_pump(w: Arc<parking_lot::Mutex<UnixStream>>) {
    std::thread::spawn(move || {
        let mut buf = vec![0u8; 16 * 1024];
        let mut stdin = io::stdin().lock();
        loop {
            match stdin.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if write_frame(&mut *w.lock(), F_IN, &buf[..n]).is_err() {
                        break;
                    }
                }
            }
        }
    });
}

/// Interactive terminal held by the daemon (create on first attach). Run inside `ssh -tt`.
pub fn pty_attach(home: &Path, a: &Args) -> anyhow::Result<()> {
    let key = a.get("key").ok_or_else(|| anyhow::anyhow!("--key is required"))?;
    let (cols, rows) = winsize().unwrap_or((100, 30));
    let mut s = connect(home)?;
    send_line(&mut s, &json!({"op": "pty.attach", "args": {"key": key, "cwd": a.get("cwd"), "shell": a.get("shell"), "columns": cols, "rows": rows}}))?;
    let mut r = BufReader::new(s.try_clone()?);
    reply(&mut r)?;
    let _raw = RawMode::enable();
    let w = Arc::new(parking_lot::Mutex::new(s));
    spawn_stdin_pump(w.clone());
    {
        let w = w.clone();
        std::thread::spawn(move || {
            let mut last = None;
            loop {
                let now = winsize();
                if now.is_some() && now != last {
                    let (c, r) = now.unwrap();
                    let mut b = Vec::with_capacity(4);
                    b.extend_from_slice(&c.to_be_bytes());
                    b.extend_from_slice(&r.to_be_bytes());
                    if write_frame(&mut *w.lock(), F_RESIZE, &b).is_err() {
                        break;
                    }
                    last = now;
                }
                std::thread::sleep(Duration::from_millis(250));
            }
        });
    }
    let mut out = io::stdout().lock();
    while let Some((t, data)) = read_frame(&mut r)? {
        match t {
            F_OUT => {
                out.write_all(&data)?;
                out.flush()?;
            }
            F_EXIT => return Ok(()),
            F_DETACHED => {
                let _ = out.write_all(b"\r\n[hato: this terminal was opened elsewhere]\r\n");
                return Ok(());
            }
            _ => {}
        }
    }
    Ok(())
}

/// Non-interactive process held by the daemon (`--sh` command started on first attach).
/// Output produced while detached is buffered and delivered on the next attach.
pub fn proc_attach(home: &Path, a: &Args) -> anyhow::Result<()> {
    let key = a.get("key").ok_or_else(|| anyhow::anyhow!("--key is required"))?;
    let sh = a.get("sh").map(str::to_owned).or_else(|| (!a.rest.is_empty()).then(|| a.rest.iter().map(|x| crate::quoting::sh_quote(x)).collect::<Vec<_>>().join(" ")));
    let mut s = connect(home)?;
    send_line(&mut s, &json!({"op": "proc.attach", "args": {"key": key, "cwd": a.get("cwd"), "sh": sh}}))?;
    let mut r = BufReader::new(s.try_clone()?);
    reply(&mut r)?;
    let w = Arc::new(parking_lot::Mutex::new(s));
    spawn_stdin_pump(w.clone());
    let (mut out, mut err) = (io::stdout().lock(), io::stderr());
    // Acknowledge only after the bytes reached our stdout/stderr (resent otherwise).
    let ack = |w: &Arc<parking_lot::Mutex<UnixStream>>| write_frame(&mut *w.lock(), F_ACK, &1u32.to_be_bytes());
    while let Some((t, data)) = read_frame(&mut r)? {
        match t {
            F_OUT => {
                out.write_all(&data)?;
                out.flush()?;
                ack(&w)?;
            }
            F_ERR => {
                err.write_all(&data)?;
                err.flush()?;
                ack(&w)?;
            }
            F_EXIT => {
                let v: Value = serde_json::from_slice(&data).unwrap_or(Value::Null);
                let code = v["code"].as_i64().map(|c| c as i32).unwrap_or(128 + v["signal"].as_i64().unwrap_or(1) as i32);
                if code == 0 {
                    return Ok(());
                }
                return Err(ExitCode(code).into());
            }
            F_DETACHED => return Err(ExitCode(75).into()),
            _ => {}
        }
    }
    Ok(())
}

/// Line bridge to a plugin method (stdin lines in, returned lines out).
pub fn bridge(home: &Path, a: &Args) -> anyhow::Result<()> {
    let plugin = a.get("plugin").ok_or_else(|| anyhow::anyhow!("--plugin is required"))?;
    let method = a.get("method").unwrap_or("line");
    let mut s = connect(home)?;
    send_line(&mut s, &json!({"op": "bridge", "args": {"plugin": plugin, "method": method}}))?;
    let mut r = BufReader::new(s.try_clone()?);
    reply(&mut r)?;
    let mut w = s;
    std::thread::spawn(move || {
        let stdin = io::stdin();
        for line in stdin.lock().lines() {
            let Ok(line) = line else { break };
            if w.write_all(line.as_bytes()).and_then(|_| w.write_all(b"\n")).is_err() {
                break;
            }
        }
        let _ = w.shutdown(std::net::Shutdown::Write);
    });
    let mut out = io::stdout().lock();
    let mut line = String::new();
    loop {
        line.clear();
        if r.read_line(&mut line)? == 0 {
            return Ok(());
        }
        let v: Value = serde_json::from_str(line.trim()).unwrap_or(Value::Null);
        if let Some(e) = v["error"].as_str() {
            eprintln!("hato bridge: {e}");
            continue;
        }
        for l in v["lines"].as_array().into_iter().flatten() {
            if let Some(s) = l.as_str() {
                writeln!(out, "{s}")?;
            }
        }
        out.flush()?;
    }
}
