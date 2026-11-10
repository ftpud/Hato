//! Desktop side of the remote runtime: install/start `hato daemon` on a machine and talk to it.
//!
//! The kernel only moves bytes and starts the daemon; which terminals or processes persist, and
//! which plugins run remotely, is decided by modules (`persist` keys, `daemon.request`).
use super::ssh::SshMaster;
use crate::quoting::sh_quote;
use crate::util::{sha256_hex, HResult, HostError};
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::Write;
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

#[derive(Clone, Debug)]
pub struct DaemonInfo {
    /// Absolute path of the daemon binary on that machine.
    pub bin: String,
    /// Daemon home on that machine (`--dir`).
    pub dir: String,
    pub machine_id: String,
    pub status: Value,
}

#[derive(Default)]
pub struct DaemonTable {
    by_machine: Mutex<HashMap<String, DaemonInfo>>,
    /// Open `daemon ctl --stream` channels by machine id.
    links: Mutex<HashMap<String, Arc<CtlLink>>>,
    /// `machine\0binary` pairs whose daemon binary predates `ctl-stream`.
    no_stream: Mutex<std::collections::HashSet<String>>,
}

impl DaemonTable {
    pub fn get(&self, machine_id: &str) -> Option<DaemonInfo> { self.by_machine.lock().get(machine_id).cloned() }
    fn put(&self, i: DaemonInfo) {
        // The binary or home may have changed: the next request opens a fresh channel.
        self.links.lock().remove(&i.machine_id);
        self.by_machine.lock().insert(i.machine_id.clone(), i);
    }
    pub fn forget(&self, machine_id: &str) {
        self.links.lock().remove(machine_id);
        self.by_machine.lock().remove(machine_id);
    }
}

/// A long-lived `hato daemon ctl --stream` channel. Starting a channel per request costs a process
/// launch locally (a `wsl.exe` on Windows, often hundreds of ms) plus one on the machine.
struct CtlLink {
    child: Mutex<Child>,
    stdin: Mutex<ChildStdin>,
    pending: Arc<Mutex<HashMap<u64, crossbeam_channel::Sender<Value>>>>,
    next_id: AtomicU64,
    dead: Arc<AtomicBool>,
}

impl CtlLink {
    /// Start the channel and wait for its `ready` line. A daemon binary without `ctl-stream` exits
    /// with a usage error instead, which fails here (`EUNSUPPORTED`).
    fn start(mut cmd: Command) -> HResult<CtlLink> {
        cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
        let mut child = cmd.spawn().map_err(|e| HostError::new("ENOEXEC", format!("daemon ctl: {e}")))?;
        let (stdin, stdout) = (child.stdin.take().unwrap(), child.stdout.take().unwrap());
        let pending: Arc<Mutex<HashMap<u64, crossbeam_channel::Sender<Value>>>> = Default::default();
        let dead = Arc::new(AtomicBool::new(false));
        let (p, d) = (pending.clone(), dead.clone());
        let (ready_tx, ready_rx) = crossbeam_channel::bounded::<()>(1);
        let reader = std::thread::Builder::new().name("daemon-ctl".into()).spawn(move || {
            use std::io::BufRead;
            for line in std::io::BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                let Ok(v) = serde_json::from_str::<Value>(line.trim()) else { continue };
                if v["ready"] == true {
                    let _ = ready_tx.try_send(());
                } else if let Some(tx) = v["id"].as_u64().and_then(|id| p.lock().remove(&id)) {
                    let _ = tx.send(v);
                }
            }
            d.store(true, Ordering::SeqCst);
            p.lock().clear(); // waiting callers see the channel close
        });
        let link = CtlLink { child: Mutex::new(child), stdin: Mutex::new(stdin), pending, next_id: AtomicU64::new(1), dead };
        reader.map_err(HostError::io)?;
        // Generous: on Windows this includes starting `wsl.exe` and an SSH session.
        match ready_rx.recv_timeout(Duration::from_secs(30)) {
            Ok(()) => Ok(link),
            Err(_) => Err(HostError::new("EUNSUPPORTED", "the daemon binary has no ctl-stream (rebuild it)")), // `link` drops: killed
        }
    }

    fn is_alive(&self) -> bool { !self.dead.load(Ordering::SeqCst) && matches!(self.child.lock().try_wait(), Ok(None)) }

    /// `Ok(None)`: the request was never sent, so it is safe to retry another way.
    fn call(&self, req: &Value, timeout: Duration) -> HResult<Option<Value>> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = crossbeam_channel::bounded(1);
        self.pending.lock().insert(id, tx);
        let line = format!("{}\n", json!({"id": id, "req": req}));
        let sent = {
            let mut w = self.stdin.lock();
            w.write_all(line.as_bytes()).and_then(|_| w.flush())
        };
        if sent.is_err() {
            self.pending.lock().remove(&id);
            self.dead.store(true, Ordering::SeqCst);
            return Ok(None);
        }
        match rx.recv_timeout(timeout) {
            Ok(v) => Ok(Some(v)),
            Err(crossbeam_channel::RecvTimeoutError::Timeout) => {
                self.pending.lock().remove(&id);
                Err(HostError::new("ETIMEDOUT", "daemon request timed out"))
            }
            Err(crossbeam_channel::RecvTimeoutError::Disconnected) => Err(HostError::new("EDAEMON", "the daemon control channel closed during the request")),
        }
    }
}

impl Drop for CtlLink {
    fn drop(&mut self) {
        let mut c = self.child.lock();
        let _ = c.kill();
        let _ = c.wait();
    }
}

/// `uname -sm` → (std::env::consts::OS, ARCH) naming.
pub fn platform(uname: &str) -> Option<(&'static str, &'static str)> {
    let mut it = uname.split_whitespace();
    let os = match it.next()? { "Darwin" => "macos", "Linux" => "linux", "FreeBSD" => "freebsd", _ => return None };
    let arch = match it.next()? { "arm64" | "aarch64" => "aarch64", "x86_64" | "amd64" => "x86_64", _ => return None };
    Some((os, arch))
}

/// Local daemon binary for a target platform: this executable when the platforms match, else a
/// cross-built binary (see tools/build-hatod.sh).
pub fn binary_for(data_dir: &std::path::Path, repo_root: &std::path::Path, os: &str, arch: &str) -> HResult<PathBuf> {
    if os == std::env::consts::OS && arch == std::env::consts::ARCH {
        return std::env::current_exe().map_err(HostError::io);
    }
    let mut candidates = vec![data_dir.join("daemon").join(format!("{os}-{arch}")).join("hato")];
    if os == "linux" {
        for libc in ["musl", "gnu"] {
            candidates.push(repo_root.join("target").join(format!("{arch}-unknown-linux-{libc}")).join("release").join("hato"));
        }
    }
    candidates.iter().find(|p| p.is_file()).cloned().ok_or_else(|| HostError::new("ENOTSUP", format!(
        "no hato daemon build for {os}-{arch}; build one with `tools/build-hatod.sh {arch}-unknown-linux-musl` or place it at {}",
        candidates[0].display())))
}

fn run_ssh(master: &SshMaster, remote: &str, stdin: Option<&[u8]>, timeout: Duration) -> HResult<(i32, String, String)> {
    let mut c = master.remote_command(remote);
    c.stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() }).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = c.spawn().map_err(|e| HostError::new("ENOEXEC", format!("ssh: {e}")))?;
    if let (Some(data), Some(mut w)) = (stdin, child.stdin.take()) {
        let data = data.to_vec();
        std::thread::spawn(move || { let _ = w.write_all(&data); });
    }
    let (tx, rx) = crossbeam_channel::bounded(1);
    std::thread::spawn(move || { let _ = tx.send(child.wait_with_output()); });
    let out = rx.recv_timeout(timeout).map_err(|_| HostError::new("ETIMEDOUT", "remote command timed out"))?.map_err(HostError::io)?;
    Ok((out.status.code().unwrap_or(-1), String::from_utf8_lossy(&out.stdout).into_owned(), String::from_utf8_lossy(&out.stderr).into_owned()))
}

/// Upload the matching daemon binary if the machine lacks it. Returns (binary, daemon home).
fn install(master: &Arc<SshMaster>, data_dir: &std::path::Path, repo_root: &std::path::Path) -> HResult<(String, String)> {
    let (code, uname, err) = run_ssh(master, "uname -sm", None, Duration::from_secs(30))?;
    if code != 0 {
        return Err(HostError::new("EREMOTE", format!("uname failed: {err}")));
    }
    let (os, arch) = platform(uname.trim()).ok_or_else(|| HostError::new("ENOTSUP", format!("unsupported remote platform: {}", uname.trim())))?;
    let local = binary_for(data_dir, repo_root, os, arch)?;
    let bytes = std::fs::read(&local).map_err(HostError::io)?;
    let tag = format!("{}-{}", crate::daemon::VERSION, &sha256_hex(&bytes)[..12]);
    let sftp = master.sftp()?;
    let home = sftp.realpath(".")?;
    // `HATO_REMOTE_DAEMON_DIR` (absolute, or relative to the remote home) relocates the daemon.
    let dir = match std::env::var("HATO_REMOTE_DAEMON_DIR") {
        Ok(d) if d.starts_with('/') => d,
        Ok(d) if !d.is_empty() => format!("{home}/{d}"),
        _ => format!("{home}/.hato"),
    };
    let bin = format!("{dir}/bin/hato-{tag}");
    let present = sftp.stat(&bin).map(|a| a.size == Some(bytes.len() as u64)).unwrap_or(false);
    if !present {
        // One streamed channel (much faster than SFTP round trips for a large binary).
        let tmp = format!("{bin}.part-{}", crate::util::random_hex(4));
        let script = format!("umask 077 && mkdir -p {dir} && cat > {tmp} && chmod 700 {tmp} && mv -f {tmp} {bin}",
            dir = sh_quote(&format!("{dir}/bin")), tmp = sh_quote(&tmp), bin = sh_quote(&bin));
        let (code, _, err) = run_ssh(master, &script, Some(&bytes), Duration::from_secs(1800))?;
        if code != 0 {
            return Err(HostError::new("EREMOTE", format!("uploading the daemon failed: {}", err.trim())));
        }
    }
    Ok((bin, dir))
}

/// Install (if needed) and start the daemon on an SSH machine.
pub fn ensure_ssh(table: &DaemonTable, master: &Arc<SshMaster>, data_dir: &std::path::Path, repo_root: &std::path::Path) -> HResult<DaemonInfo> {
    master.ensure_alive()?;
    let machine_id = master.profile.machine_id();
    let (bin, dir) = install(master, data_dir, repo_root)?;
    let (code, out, err) = run_ssh(master, &format!("{} daemon ensure --dir {}", sh_quote(&bin), sh_quote(&dir)), None, Duration::from_secs(60))?;
    if code != 0 {
        return Err(HostError::new("EREMOTE", format!("starting the daemon failed: {}", err.trim())));
    }
    let status: Value = serde_json::from_str(out.trim()).map_err(|e| HostError::new("EREMOTE", format!("bad daemon status: {e}: {}", out.trim())))?;
    let info = DaemonInfo { bin, dir, machine_id, status };
    table.put(info.clone());
    Ok(info)
}

/// Reverse loopback forward: remote 127.0.0.1:<allocated> reaches local 127.0.0.1:<local_port>.
/// WSL shares no loopback with Windows, so its leg goes through a relay process in Linux.
pub fn forward_reverse(master: &Arc<SshMaster>, local_port: u16, data_dir: &std::path::Path, repo_root: &std::path::Path) -> HResult<u16> {
    if master.is_wsl() {
        let (bin, _) = install(master, data_dir, repo_root)?;
        return master.relay_from_wsl(local_port, &bin);
    }
    #[cfg(windows)]
    {
        let hop = SshMaster::new(crate::host::ssh::SshProfile { profile_id: "wsl-default".into(), host: String::new(), port: 22, user: "default".into(), identity_file: None, transport: Some("wsl".into()), auth: None });
        hop.connect_default_distribution()?;
        let (bin, _) = install(&hop, data_dir, repo_root)?;
        let hop_port = hop.relay_from_wsl(local_port, &bin)?;
        return master.forward_through_wsl(hop, hop_port);
    }
    #[cfg(not(windows))]
    {
        let _ = (data_dir, repo_root);
        master.forward_reverse(local_port)
    }
}

/// Start the daemon on this machine (terminals/processes then survive app restarts).
#[cfg(windows)]
pub fn ensure_local(_table: &DaemonTable) -> HResult<DaemonInfo> {
    Err(HostError::new("ENOTSUP", "persistent resources need a Linux machine: open the workspace in WSL or over SSH"))
}

/// Start the daemon on this machine (terminals/processes then survive app restarts).
#[cfg(not(windows))]
pub fn ensure_local(table: &DaemonTable) -> HResult<DaemonInfo> {
    let exe = std::env::current_exe().map_err(HostError::io)?;
    let dir = crate::daemon::home_dir(None).to_string_lossy().into_owned();
    let out = crate::util::command(&exe).args(["daemon", "ensure", "--dir", &dir]).stdin(Stdio::null()).output().map_err(HostError::io)?;
    if !out.status.success() {
        return Err(HostError::new("EDAEMON", String::from_utf8_lossy(&out.stderr).trim().to_string()));
    }
    let status: Value = serde_json::from_slice(&out.stdout).map_err(|e| HostError::new("EDAEMON", e.to_string()))?;
    let info = DaemonInfo { bin: exe.to_string_lossy().into_owned(), dir, machine_id: "local".into(), status };
    table.put(info.clone());
    Ok(info)
}

const REQUEST_TIMEOUT: Duration = Duration::from_secs(600);

fn ctl_link(table: &DaemonTable, info: &DaemonInfo, master: Option<&Arc<SshMaster>>) -> HResult<Arc<CtlLink>> {
    let mut links = table.links.lock();
    if let Some(l) = links.get(&info.machine_id).filter(|l| l.is_alive()) {
        return Ok(l.clone());
    }
    let binary = format!("{}\0{}", info.machine_id, info.bin);
    if table.no_stream.lock().contains(&binary) {
        return Err(HostError::new("EUNSUPPORTED", "the daemon binary has no ctl-stream"));
    }
    let cmd = match master {
        Some(m) => m.remote_command(&format!("{} daemon ctl-stream --dir {}", sh_quote(&info.bin), sh_quote(&info.dir))),
        None => {
            let mut c = crate::util::command(&info.bin);
            c.args(["daemon", "ctl-stream", "--dir", &info.dir]);
            c
        }
    };
    let l = Arc::new(CtlLink::start(cmd).inspect_err(|e| {
        if e.code == "EUNSUPPORTED" {
            table.no_stream.lock().insert(binary);
        }
    })?);
    links.insert(info.machine_id.clone(), l.clone());
    Ok(l)
}

/// One control request to the daemon. Returns the daemon's `value` or its error.
pub fn request(table: &DaemonTable, info: &DaemonInfo, master: Option<&Arc<SshMaster>>, req: &Value) -> HResult<Value> {
    match ctl_link(table, info, master).and_then(|l| l.call(req, REQUEST_TIMEOUT)) {
        Ok(Some(v)) => reply_value(&v),
        // Sent, but failed or timed out: it may have run, so it is not repeated.
        Err(e) if e.code == "ETIMEDOUT" || e.code == "EDAEMON" => Err(e),
        // No channel (older daemon binary, or it could not start), or it was gone before sending:
        // one standalone round trip.
        _ => {
            table.links.lock().remove(&info.machine_id);
            request_once(info, master, req)
        }
    }
}

fn reply_value(v: &Value) -> HResult<Value> {
    if v["ok"] == true {
        Ok(v["value"].clone())
    } else {
        Err(HostError::new("EDAEMON", v["error"]["message"].as_str().unwrap_or("daemon request failed").to_string()))
    }
}

/// One control request over its own `hato daemon ctl` channel.
fn request_once(info: &DaemonInfo, master: Option<&Arc<SshMaster>>, req: &Value) -> HResult<Value> {
    let input = req.to_string().into_bytes();
    let (code, out, err) = match master {
        Some(m) => run_ssh(m, &format!("{} daemon ctl --dir {}", sh_quote(&info.bin), sh_quote(&info.dir)), Some(&input), Duration::from_secs(600))?,
        None => {
            let mut child = crate::util::command(&info.bin).args(["daemon", "ctl", "--dir", &info.dir]).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped())
                .spawn().map_err(HostError::io)?;
            if let Some(mut w) = child.stdin.take() {
                let _ = w.write_all(&input);
            }
            let o = child.wait_with_output().map_err(HostError::io)?;
            (o.status.code().unwrap_or(-1), String::from_utf8_lossy(&o.stdout).into_owned(), String::from_utf8_lossy(&o.stderr).into_owned())
        }
    };
    if code != 0 {
        return Err(HostError::new("EDAEMON", format!("daemon ctl failed: {}", err.trim())));
    }
    let v: Value = serde_json::from_str(out.trim()).map_err(|e| HostError::new("EDAEMON", format!("bad reply: {e}")))?;
    if v["ok"] == true {
        Ok(v["value"].clone())
    } else {
        Err(HostError::new("EDAEMON", v["error"]["message"].as_str().unwrap_or("daemon request failed").to_string()))
    }
}

/// Daemon resource keys are namespaced by the owning module so plugins cannot reattach to each
/// other's terminals or processes.
pub fn scoped_key(owner: &str, key: &str) -> HResult<String> {
    if key.is_empty() || key.len() > 150 || !key.bytes().all(|b| b.is_ascii_alphanumeric() || b"-_./:@".contains(&b)) {
        return Err(HostError::invalid("persist.key may contain letters, digits and -_./:@ (max 150)"));
    }
    Ok(format!("{owner}/{key}"))
}

/// Allowed `daemon.request` operations (module-facing; attach/bridge go through PTY/process).
pub fn allowed_op(op: &str) -> bool {
    matches!(op, "hello" | "status" | "resources.list" | "pty.read" | "pty.write" | "pty.kill" | "proc.kill" | "proc.closeStdin" | "plugins.list" | "plugins.push" | "plugins.enable" | "plugins.disable" | "modules.call")
}

pub fn status_json(i: &DaemonInfo) -> Value { json!({"machineId": i.machine_id, "bin": i.bin, "dir": i.dir, "status": i.status}) }

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn platforms_and_keys() {
        assert_eq!(platform("Linux x86_64"), Some(("linux", "x86_64")));
        assert_eq!(platform("Darwin arm64\n"), Some(("macos", "aarch64")));
        assert_eq!(platform("Plan9 mips"), None);
        assert_eq!(scoped_key("terminals", "ws:1/main").unwrap(), "terminals/ws:1/main");
        assert!(scoped_key("terminals", "a b").is_err());
        assert!(allowed_op("plugins.push") && !allowed_op("shutdown") && !allowed_op("pty.attach"));
    }

    /// A stand-in daemon binary: `ctl-stream` answers "stream" (unless `old`), `ctl` answers "once".
    #[cfg(unix)]
    fn fake_daemon(dir: &std::path::Path, old: bool) -> String {
        use std::os::unix::fs::PermissionsExt;
        let stream = r#"echo '{"ready":true}'; while read l; do id=$(echo "$l" | sed 's/.*"id":\([0-9]*\).*/\1/'); echo "{\"id\":$id,\"ok\":true,\"value\":\"stream\"}"; done"#;
        let script = format!("#!/bin/sh\ncase \"$2\" in\n  ctl) cat >/dev/null; echo '{{\"ok\":true,\"value\":\"once\"}}' ;;\n  ctl-stream) {} ;;\n  *) echo usage >&2; exit 2 ;;\nesac\n",
            if old { "echo usage >&2; exit 2" } else { stream });
        let p = dir.join(if old { "old" } else { "new" });
        std::fs::write(&p, script).unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        p.to_string_lossy().into_owned()
    }

    #[cfg(unix)]
    #[test]
    fn requests_share_one_ctl_channel_and_fall_back_for_old_binaries() {
        let dir = std::env::temp_dir().join(format!("hato-ctl-{}", crate::util::random_hex(4)));
        std::fs::create_dir_all(&dir).unwrap();
        let table = DaemonTable::default();
        let info = |bin: String, m: &str| DaemonInfo { bin, dir: "/nonexistent".into(), machine_id: m.into(), status: Value::Null };

        let new = info(fake_daemon(&dir, false), "local");
        assert_eq!(request(&table, &new, None, &json!({"op": "hello"})).unwrap(), "stream");
        let pid = table.links.lock()["local"].child.lock().id();
        assert_eq!(request(&table, &new, None, &json!({"op": "hello"})).unwrap(), "stream");
        assert_eq!(table.links.lock()["local"].child.lock().id(), pid, "the channel is reused");

        let old = info(fake_daemon(&dir, true), "other");
        assert_eq!(request(&table, &old, None, &json!({"op": "hello"})).unwrap(), "once");
        assert_eq!(request(&table, &old, None, &json!({"op": "hello"})).unwrap(), "once");
        assert_eq!(table.no_stream.lock().len(), 1, "an old binary is only probed once");

        table.forget("local");
        assert!(table.links.lock().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
