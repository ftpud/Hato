//! SSH primitive built on the system OpenSSH client with a per-profile ControlMaster.
//!
//! Why OpenSSH rather than libssh2: it honours the user's ~/.ssh/config, agent, keys and
//! known_hosts verification; multiplexed channels (exec, PTY, SFTP subsystem, reverse forwards)
//! run concurrently without the global-session locking issues of blocking libssh2. The spec allows
//! "ssh2/libssh2 or equivalent"; this is documented in docs/COMPATIBILITY.md.
//!
//! The kernel knows nothing about projects: it only holds endpoints, verified host identity and
//! live connections, identified by a kernel-derived machine id `ssh:<profileId>`.
use crate::approvals::{Approvals, Decision};
use crate::host::sftp::Sftp;
use crate::util::{random_hex, HResult, HostError};
use parking_lot::Mutex;
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct SshProfile {
    #[serde(rename = "profileId")]
    pub profile_id: String,
    pub host: String,
    #[serde(default = "default_port")]
    pub port: u16,
    pub user: String,
    /// Optional private key *path* reference (never key material).
    #[serde(rename = "identityFile", default)]
    pub identity_file: Option<String>,
}

fn default_port() -> u16 { 22 }

impl SshProfile {
    pub fn validate(&self) -> HResult<()> {
        let ok_host = !self.host.is_empty() && self.host.len() < 256 && self.host.bytes().all(|b| b.is_ascii_alphanumeric() || b".-_:[]".contains(&b)) && !self.host.starts_with('-');
        let ok_user = !self.user.is_empty() && self.user.len() < 64 && self.user.bytes().all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b)) && !self.user.starts_with('-');
        let ok_id = !self.profile_id.is_empty() && self.profile_id.len() <= 64 && self.profile_id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-');
        if !ok_host || !ok_user || !ok_id || self.port == 0 {
            return Err(HostError::invalid("invalid SSH profile (host/user/profileId/port)"));
        }
        if let Some(f) = &self.identity_file {
            if f.starts_with('-') || f.contains('\0') {
                return Err(HostError::invalid("invalid identity file path"));
            }
        }
        Ok(())
    }
    pub fn destination(&self) -> String { format!("{}@{}", self.user, self.host) }
    pub fn machine_id(&self) -> String { format!("ssh:{}", self.profile_id) }
}

pub struct SshMaster {
    pub profile: SshProfile,
    pub socket: PathBuf,
    child: Mutex<Option<Child>>,
    pub sftp: Mutex<Option<Arc<Sftp>>>,
    pub connected_at: Mutex<Option<Instant>>,
    pub last_error: Mutex<Option<String>>,
    accept_new: Mutex<bool>,
}

fn socket_dir() -> PathBuf {
    let uid = unsafe { libc::getuid() };
    let d = PathBuf::from(format!("/tmp/hato-ssh-{uid}"));
    let _ = std::fs::create_dir_all(&d);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&d, std::fs::Permissions::from_mode(0o700));
    }
    d
}

impl SshMaster {
    pub fn new(profile: SshProfile) -> Arc<SshMaster> {
        let socket = socket_dir().join(format!("{}.sock", random_hex(6)));
        Arc::new(SshMaster {
            profile,
            socket,
            child: Mutex::new(None),
            sftp: Mutex::new(None),
            connected_at: Mutex::new(None),
            last_error: Mutex::new(None),
            accept_new: Mutex::new(false),
        })
    }

    fn base_opts(&self, c: &mut Command) {
        c.arg("-o").arg("BatchMode=yes")
            .arg("-o").arg("ConnectTimeout=10")
            .arg("-p").arg(self.profile.port.to_string());
        if let Some(id) = &self.profile.identity_file {
            c.arg("-i").arg(id).arg("-o").arg("IdentitiesOnly=yes");
        }
        if let Some(kh) = known_hosts_override() {
            c.arg("-o").arg(format!("UserKnownHostsFile={kh}"));
        }
    }

    /// A client invocation multiplexed over the master: `ssh -S sock -o ControlMaster=no ... dest`.
    pub fn client_command(&self, extra: &[&str]) -> Command {
        let mut c = Command::new("ssh");
        c.arg("-S").arg(&self.socket).arg("-o").arg("ControlMaster=no");
        self.base_opts(&mut c);
        for e in extra {
            c.arg(e);
        }
        c.arg(self.profile.destination());
        c
    }

    /// Argument vector for running ssh inside a local PTY (remote interactive shell).
    pub fn pty_argv(&self, remote_cmd: &str) -> Vec<String> {
        let mut v = vec!["-tt".to_string(), "-S".into(), self.socket.display().to_string(), "-o".into(), "ControlMaster=no".into(),
            "-o".into(), "BatchMode=yes".into(), "-p".into(), self.profile.port.to_string()];
        if let Some(id) = &self.profile.identity_file {
            v.extend(["-i".into(), id.clone()]);
        }
        if let Some(kh) = known_hosts_override() {
            v.extend(["-o".into(), format!("UserKnownHostsFile={kh}")]);
        }
        v.push(self.profile.destination());
        v.push("--".into());
        v.push(remote_cmd.to_string());
        v
    }

    pub fn is_alive(&self) -> bool {
        {
            let mut ch = self.child.lock();
            match ch.as_mut() {
                None => return false,
                Some(c) => {
                    if let Ok(Some(_)) = c.try_wait() {
                        *ch = None;
                        return false;
                    }
                }
            }
        }
        let st = Command::new("ssh")
            .arg("-S").arg(&self.socket).arg("-O").arg("check")
            .arg("-p").arg(self.profile.port.to_string())
            .arg(self.profile.destination())
            .stdout(Stdio::null()).stderr(Stdio::null()).status();
        matches!(st, Ok(s) if s.success())
    }

    pub fn ensure_alive(&self) -> HResult<()> {
        if self.is_alive() {
            Ok(())
        } else {
            Err(HostError::new("ENOTCONN", format!("SSH connection to {} is not available (reconnect required; no local fallback)", self.profile.machine_id())))
        }
    }

    /// Start (or restart) the ControlMaster. Host key trust for unknown hosts is a native approval.
    pub fn connect(&self, approvals: &Approvals, module: &str, generation: u64) -> HResult<()> {
        if self.is_alive() {
            return Ok(());
        }
        let _ = std::fs::remove_file(&self.socket);
        *self.sftp.lock() = None;
        for attempt in 0..2 {
            let strict = if *self.accept_new.lock() { "accept-new" } else { "yes" };
            let mut c = Command::new("ssh");
            c.arg("-M").arg("-N").arg("-S").arg(&self.socket)
                .arg("-o").arg("ControlPersist=no")
                .arg("-o").arg(format!("StrictHostKeyChecking={strict}"))
                .arg("-o").arg("ServerAliveInterval=15")
                .arg("-o").arg("ServerAliveCountMax=3")
                .arg("-o").arg("ExitOnForwardFailure=yes");
            self.base_opts(&mut c);
            c.arg(self.profile.destination());
            c.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped());
            let mut child = c.spawn().map_err(|e| HostError::new("ENOEXEC", format!("cannot run ssh: {e}")))?;
            let t0 = Instant::now();
            let mut failure = None;
            loop {
                if let Ok(Some(_st)) = child.try_wait() {
                    let mut err = String::new();
                    if let Some(mut e) = child.stderr.take() {
                        use std::io::Read;
                        let _ = e.read_to_string(&mut err);
                    }
                    failure = Some(err.trim().to_string());
                    break;
                }
                if self.socket.exists() {
                    let ok = Command::new("ssh").arg("-S").arg(&self.socket).arg("-O").arg("check")
                        .arg("-p").arg(self.profile.port.to_string()).arg(self.profile.destination())
                        .stdout(Stdio::null()).stderr(Stdio::null()).status().map(|s| s.success()).unwrap_or(false);
                    if ok {
                        break;
                    }
                }
                if t0.elapsed() > Duration::from_secs(20) {
                    let _ = child.kill();
                    failure = Some("timed out establishing SSH connection".into());
                    break;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            match failure {
                None => {
                    // Drain stderr in the background so the master never blocks.
                    if let Some(mut e) = child.stderr.take() {
                        std::thread::spawn(move || {
                            let mut sink = Vec::new();
                            use std::io::Read;
                            let _ = e.read_to_end(&mut sink);
                        });
                    }
                    *self.child.lock() = Some(child);
                    *self.connected_at.lock() = Some(Instant::now());
                    *self.last_error.lock() = None;
                    return Ok(());
                }
                Some(err) => {
                    let host_key_problem = err.contains("Host key verification failed") || err.contains("No ED25519 host key is known") || err.contains("host key for") && err.contains("is not known");
                    if host_key_problem && attempt == 0 && !err.contains("REMOTE HOST IDENTIFICATION HAS CHANGED") {
                        let fp = keyscan_fingerprints(&self.profile.host, self.profile.port);
                        let detail = format!(
                            "The SSH host {}:{} is not in your known_hosts file.\n\nServer key fingerprints (from ssh-keyscan):\n{}\n\nApproving adds the key to ~/.ssh/known_hosts (StrictHostKeyChecking=accept-new). Changed keys are always rejected.",
                            self.profile.host, self.profile.port, if fp.is_empty() { "(unavailable)".to_string() } else { fp });
                        match approvals.request(module, generation, "ssh.trustHostKey", &format!("Trust new SSH host {}?", self.profile.host), &detail, false, Approvals::allow_deny(), Duration::from_secs(300)) {
                            Decision::Option(o) if o == "allow" => {
                                *self.accept_new.lock() = true;
                                continue;
                            }
                            _ => {
                                *self.last_error.lock() = Some(err.clone());
                                return Err(HostError::new("EHOSTKEY", format!("host key not trusted: {err}")));
                            }
                        }
                    }
                    *self.last_error.lock() = Some(err.clone());
                    return Err(HostError::new("ECONNREFUSED", format!("SSH connection to {} failed: {err}", self.profile.destination())));
                }
            }
        }
        Err(HostError::new("ECONNREFUSED", "SSH connection failed"))
    }

    pub fn disconnect(&self) {
        *self.sftp.lock() = None;
        let _ = Command::new("ssh").arg("-S").arg(&self.socket).arg("-O").arg("exit")
            .arg("-p").arg(self.profile.port.to_string()).arg(self.profile.destination())
            .stdout(Stdio::null()).stderr(Stdio::null()).status();
        if let Some(mut c) = self.child.lock().take() {
            let _ = c.kill();
            let _ = c.wait();
        }
        let _ = std::fs::remove_file(&self.socket);
    }

    pub fn sftp(&self) -> HResult<Arc<Sftp>> {
        self.ensure_alive()?;
        let mut g = self.sftp.lock();
        if let Some(s) = g.as_ref() {
            if s.is_alive() {
                return Ok(s.clone());
            }
        }
        let mut c = self.client_command(&["-s"]);
        c.arg("sftp");
        let s = Arc::new(Sftp::start(c)?);
        *g = Some(s.clone());
        Ok(s)
    }

    /// Remote loopback-only reverse forward: remote 127.0.0.1:<allocated> -> local 127.0.0.1:<local_port>.
    pub fn forward_reverse(&self, local_port: u16) -> HResult<u16> {
        self.ensure_alive()?;
        let spec = format!("127.0.0.1:0:127.0.0.1:{local_port}");
        let out = Command::new("ssh").arg("-S").arg(&self.socket).arg("-O").arg("forward").arg("-R").arg(&spec)
            .arg("-p").arg(self.profile.port.to_string()).arg(self.profile.destination())
            .output().map_err(HostError::io)?;
        if !out.status.success() {
            return Err(HostError::new("EFORWARD", format!("reverse forward failed: {}", String::from_utf8_lossy(&out.stderr).trim())));
        }
        let s = String::from_utf8_lossy(&out.stdout);
        s.trim().lines().last().and_then(|l| l.trim().parse::<u16>().ok())
            .ok_or_else(|| HostError::new("EFORWARD", format!("could not parse allocated remote port from {s:?}")))
    }

    pub fn cancel_reverse(&self, remote_port: u16, local_port: u16) {
        let spec = format!("127.0.0.1:{remote_port}:127.0.0.1:{local_port}");
        let _ = Command::new("ssh").arg("-S").arg(&self.socket).arg("-O").arg("cancel").arg("-R").arg(&spec)
            .arg("-p").arg(self.profile.port.to_string()).arg(self.profile.destination())
            .stdout(Stdio::null()).stderr(Stdio::null()).status();
    }

    pub fn status_json(&self) -> Value {
        json!({
            "machineId": self.profile.machine_id(), "host": self.profile.host, "port": self.profile.port, "user": self.profile.user,
            "alive": self.is_alive(), "lastError": self.last_error.lock().clone(),
        })
    }
}

impl Drop for SshMaster {
    fn drop(&mut self) { self.disconnect(); }
}

/// Optional alternate known_hosts file (isolated test environments). Host keys are still verified.
fn known_hosts_override() -> Option<String> {
    std::env::var("HATO_SSH_KNOWN_HOSTS").ok().filter(|s| !s.is_empty() && !s.contains('\0'))
}

fn keyscan_fingerprints(host: &str, port: u16) -> String {
    let scan = Command::new("ssh-keyscan").arg("-p").arg(port.to_string()).arg("-T").arg("5").arg(host)
        .stderr(Stdio::null()).output();
    let Ok(scan) = scan else { return String::new() };
    let mut kg = match Command::new("ssh-keygen").arg("-lf").arg("-").stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn() {
        Ok(c) => c,
        Err(_) => return String::new(),
    };
    {
        use std::io::Write;
        if let Some(mut i) = kg.stdin.take() {
            let _ = i.write_all(&scan.stdout);
        }
    }
    kg.wait_with_output().map(|o| String::from_utf8_lossy(&o.stdout).to_string()).unwrap_or_default()
}

/// Kernel table of SSH masters keyed by machine id. The first profile registered for a machine id
/// pins its endpoint; a different endpoint under the same id is refused (no machine-id spoofing).
#[derive(Default)]
pub struct SshTable {
    masters: Mutex<std::collections::HashMap<String, Arc<SshMaster>>>,
}

impl SshTable {
    pub fn get_or_create(&self, p: &SshProfile) -> HResult<Arc<SshMaster>> {
        let mut m = self.masters.lock();
        let id = p.machine_id();
        if let Some(existing) = m.get(&id) {
            if existing.profile != *p {
                // Endpoint changed (user edited the profile): replace only when the old one is dead.
                if existing.is_alive() {
                    return Err(HostError::new("EBUSY", format!("{id} is connected with a different endpoint; disconnect first")));
                }
                let nm = SshMaster::new(p.clone());
                m.insert(id, nm.clone());
                return Ok(nm);
            }
            return Ok(existing.clone());
        }
        let nm = SshMaster::new(p.clone());
        m.insert(id, nm.clone());
        Ok(nm)
    }
    pub fn by_machine(&self, machine_id: &str) -> Option<Arc<SshMaster>> { self.masters.lock().get(machine_id).cloned() }
    pub fn shutdown(&self) {
        for (_, m) in self.masters.lock().drain() {
            m.disconnect();
        }
    }
}
