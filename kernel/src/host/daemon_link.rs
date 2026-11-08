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
use std::process::Stdio;
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
}

impl DaemonTable {
    pub fn get(&self, machine_id: &str) -> Option<DaemonInfo> { self.by_machine.lock().get(machine_id).cloned() }
    fn put(&self, i: DaemonInfo) { self.by_machine.lock().insert(i.machine_id.clone(), i); }
    pub fn forget(&self, machine_id: &str) { self.by_machine.lock().remove(machine_id); }
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

/// One control request (`hato daemon ctl`). Returns the daemon's `value` or its error.
pub fn request(info: &DaemonInfo, master: Option<&Arc<SshMaster>>, req: &Value) -> HResult<Value> {
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
}
