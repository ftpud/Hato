//! Connections to workspace machines, identified by a kernel-derived machine id `ssh:<profileId>`.
//!
//! SSH hosts use the built-in client (`host::sshc`): one authenticated connection per machine,
//! with commands, terminals, SFTP and reverse forwards as channels on it. It reads the user's
//! known_hosts, SSH agent and key files, but not `~/.ssh/config` (see docs/COMPATIBILITY.md).
//! `transport: "wsl"` runs the same channels in a WSL distribution through `wsl.exe`, without SSH.
//!
//! The kernel knows nothing about projects: it only holds endpoints, verified host identity and
//! live connections.
use crate::approvals::{Approvals, Decision};
use crate::host::sftp::Sftp;
use crate::host::sshc::{self, AuthOutcome, ChannelRequest, Conn, HostKeyVerdict, Opened};
use crate::host::stdio::Spawned;
use crate::host::wsl;
use crate::util::{HResult, HostError};
use parking_lot::Mutex;
use serde::Deserialize;
use serde_json::{json, Value};
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
    /// "ssh" (default) or "wsl": `host` is then a WSL distribution, reached without SSH.
    #[serde(default)]
    pub transport: Option<String>,
    /// "password": the kernel asks for it natively when connecting. Otherwise the agent or the key.
    #[serde(default)]
    pub auth: Option<String>,
}

fn default_port() -> u16 { 22 }

impl SshProfile {
    pub fn is_wsl(&self) -> bool { self.transport.as_deref() == Some("wsl") }
    pub fn uses_password(&self) -> bool { self.auth.as_deref() == Some("password") }

    pub fn validate(&self) -> HResult<()> {
        if !matches!(self.transport.as_deref(), None | Some("ssh") | Some("wsl")) {
            return Err(HostError::invalid("invalid SSH profile transport"));
        }
        if !matches!(self.auth.as_deref(), None | Some("password")) || self.uses_password() && (self.is_wsl() || self.identity_file.is_some()) {
            return Err(HostError::invalid("invalid SSH profile authentication"));
        }
        if self.is_wsl() && !cfg!(windows) {
            return Err(HostError::new("ENOTSUP", "WSL workspaces are only available on Windows"));
        }
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
    /// Who this connection reaches, for messages and the audit log.
    pub fn label(&self) -> String { if self.is_wsl() { format!("wsl:{}", self.host) } else { self.destination() } }
    pub fn machine_id(&self) -> String { format!("ssh:{}", self.profile_id) }
}

pub struct SshMaster {
    pub profile: SshProfile,
    /// SSH transport: the authenticated connection.
    conn: Mutex<Option<Arc<Conn>>>,
    /// More connections to the same host, opened when the server refuses further sessions on
    /// the existing ones (OpenSSH allows 10 per connection).
    extra: Mutex<Vec<Arc<Conn>>>,
    adding: Mutex<()>,
    /// WSL transport: the keepalive channel holding the distribution running.
    child: Mutex<Option<Child>>,
    /// Held while connecting, so concurrent callers share one connection and one password prompt.
    connecting: Mutex<()>,
    pub sftp: Mutex<Option<Arc<Sftp>>>,
    pub connected_at: Mutex<Option<Instant>>,
    pub last_error: Mutex<Option<String>>,
    /// SHA256 fingerprint of an unknown host key the user approved.
    trusted_key: Mutex<Option<String>>,
    /// WSL transport: `hato daemon forward` processes by the port they listen on.
    relays: Mutex<std::collections::HashMap<u16, Child>>,
}

/// Runs `sftp-server` from the home directory (`realpath(".")` is how callers find the home).
const WSL_SFTP: &str = r#"cd && for p in /usr/lib/openssh/sftp-server /usr/libexec/openssh/sftp-server /usr/lib/ssh/sftp-server /usr/libexec/sftp-server /usr/lib/sftp-server; do [ -x "$p" ] && exec "$p"; done; exit 127"#;

const MAX_PASSWORD_ATTEMPTS: u32 = 3;
/// Connections per machine, counting the first.
const MAX_CONNECTIONS: usize = 16;
/// How long a channel request waits for a session slot to free up.
const SESSION_WAIT: Duration = Duration::from_secs(10);

impl SshMaster {
    pub fn new(profile: SshProfile) -> Arc<SshMaster> {
        Arc::new(SshMaster {
            profile,
            conn: Mutex::new(None),
            extra: Mutex::new(Vec::new()),
            adding: Mutex::new(()),
            child: Mutex::new(None),
            connecting: Mutex::new(()),
            sftp: Mutex::new(None),
            connected_at: Mutex::new(None),
            last_error: Mutex::new(None),
            trusted_key: Mutex::new(None),
            relays: Default::default(),
        })
    }

    pub fn is_wsl(&self) -> bool { self.profile.is_wsl() }

    /// A distribution channel for `argv`. Only meaningful with the WSL transport.
    fn wsl_command(&self, argv: &[&str]) -> Command { wsl::command(self.wsl_distro(), argv) }

    fn wsl_distro(&self) -> Option<&str> { Some(self.profile.host.as_str()).filter(|h| !h.is_empty()) }

    fn conn(&self) -> HResult<Arc<Conn>> {
        match self.conn.lock().as_ref() {
            Some(c) if !c.is_closed() => Ok(c.clone()),
            _ => Err(self.not_connected()),
        }
    }

    fn not_connected(&self) -> HostError {
        HostError::new("ENOTCONN", format!("Connection to {} is not available (reconnect required; no local fallback)", self.profile.machine_id()))
    }

    /// Run `remote` through the user's shell on the machine, with piped stdio.
    pub fn exec(&self, remote: &str) -> HResult<Spawned> {
        if self.is_wsl() {
            self.ensure_alive()?;
            return Spawned::spawn(self.wsl_command(&["/bin/sh", "-c", remote]), "wsl.exe");
        }
        self.open_channel(ChannelRequest::Exec(remote.to_string()))
    }

    /// Run `remote` on a terminal of the machine (SSH transport; WSL uses a local ConPTY, see
    /// `wsl_pty_command`).
    pub fn exec_pty(&self, remote: &str, cols: u16, rows: u16) -> HResult<Spawned> {
        self.open_channel(ChannelRequest::Pty { command: remote.to_string(), cols, rows })
    }

    /// A channel on the first connection with a free session; another connection when all are
    /// full (key logins: nothing to ask), else wait for a session to end.
    fn open_channel(&self, req: ChannelRequest) -> HResult<Spawned> {
        let deadline = Instant::now() + SESSION_WAIT;
        loop {
            let primary = self.conn()?;
            let mut conns = vec![primary];
            {
                let mut extra = self.extra.lock();
                extra.retain(|c| !c.is_closed());
                conns.extend(extra.iter().cloned());
            }
            for c in &conns {
                match c.open_channel(req.clone()) {
                    Err(e) if e.code == "EBUSY" => continue,
                    r => return r,
                }
            }
            if !self.profile.uses_password() && conns.len() < MAX_CONNECTIONS {
                let _adding = self.adding.lock();
                if self.extra.lock().len() + 1 == conns.len() {
                    // Nobody added one meanwhile.
                    if let Ok(c) = self.extra_connection() {
                        self.extra.lock().push(Arc::new(c));
                    }
                }
                continue;
            }
            if Instant::now() >= deadline {
                return Err(HostError::new("EBUSY", format!("{} refuses more sessions on all {} connections (see MaxSessions in its sshd_config)", self.profile.destination(), conns.len())));
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    }

    /// Another key-authenticated connection; its host key is known by now.
    fn extra_connection(&self) -> HResult<Conn> {
        let trusted = self.trusted_key.lock().clone();
        let Opened::Ok(mut c) = sshc::open(&self.profile.host, self.profile.port, trusted)? else {
            return Err(HostError::new("EHOSTKEY", "host key changed while connected"));
        };
        match c.auth_keys(&self.profile.user, self.profile.identity_file.as_deref())? {
            (true, _) => Ok(c),
            _ => Err(HostError::new("EAUTH", "additional connection was not authenticated")),
        }
    }

    /// Program and arguments for a local PTY running `remote_cmd` in the WSL distribution.
    pub fn wsl_pty_command(&self, remote_cmd: &str) -> (String, Vec<String>) {
        (wsl::exe(), wsl::exec_args(self.wsl_distro(), &["/bin/sh", "-c", remote_cmd]))
    }

    pub fn is_alive(&self) -> bool {
        if self.is_wsl() {
            let mut ch = self.child.lock();
            // The keepalive channel is the connection.
            let alive = ch.as_mut().is_some_and(|c| matches!(c.try_wait(), Ok(None)));
            if !alive {
                *ch = None;
            }
            return alive;
        }
        self.conn().is_ok()
    }

    pub fn ensure_alive(&self) -> HResult<()> {
        if self.is_alive() { Ok(()) } else { Err(self.not_connected()) }
    }

    fn fail<T>(&self, code: &str, message: String) -> HResult<T> {
        *self.last_error.lock() = Some(message.clone());
        Err(HostError::new(code, message))
    }

    /// Connect and authenticate. Unknown host keys need a native approval of their fingerprint;
    /// a password is asked natively, so only an `interactive` caller (a user gesture) may need one.
    pub fn connect(&self, approvals: &Approvals, module: &str, generation: u64, interactive: bool) -> HResult<()> {
        if self.profile.uses_password() && !interactive {
            if self.is_alive() {
                return Ok(());
            }
            return Err(HostError::new("ENEEDAUTH", format!("Login needed for {}. Select the project to connect.", self.profile.destination())));
        }
        let _connecting = self.connecting.lock();
        if self.is_alive() {
            return Ok(());
        }
        *self.sftp.lock() = None;
        if self.is_wsl() {
            return self.connect_wsl();
        }
        let (host, port) = (self.profile.host.as_str(), self.profile.port);
        let mut trust_asked = false;
        let mut conn = loop {
            let trusted = self.trusted_key.lock().clone();
            match sshc::open(host, port, trusted).inspect_err(|e| *self.last_error.lock() = Some(e.message.clone()))? {
                Opened::Ok(c) => break c,
                Opened::HostKey(HostKeyVerdict::Changed { line, path }) => {
                    return self.fail("EHOSTKEY", format!("REMOTE HOST IDENTIFICATION HAS CHANGED for {host}:{port}: the server's key differs from the one recorded in {path} (line {line}). Changed keys are always rejected; remove that line if the change is expected."));
                }
                Opened::HostKey(HostKeyVerdict::Unknown { fingerprint, algorithm }) if !trust_asked => {
                    trust_asked = true;
                    let detail = format!(
                        "The SSH host {host}:{port} is not in your known_hosts file ({}).\n\nServer key fingerprint:\n{algorithm} {fingerprint}\n\nApproving adds this key to known_hosts. Changed keys are always rejected.",
                        sshc::known_hosts_path().display());
                    match approvals.request(module, generation, "ssh.trustHostKey", &format!("Trust new SSH host {host}?"), &detail, false, Approvals::allow_deny(), Duration::from_secs(300)) {
                        Decision::Option(o) if o == "allow" => *self.trusted_key.lock() = Some(fingerprint),
                        _ => return self.fail("EHOSTKEY", format!("host key of {host}:{port} not trusted ({algorithm} {fingerprint})")),
                    }
                }
                Opened::HostKey(v) => return self.fail("EHOSTKEY", format!("host key of {host}:{port} not accepted: {v:?}")),
            }
        };
        let user = self.profile.user.as_str();
        if self.profile.uses_password() {
            self.password_login(&mut conn, approvals, module, generation)?;
        } else {
            let (ok, notes) = conn.auth_keys(user, self.profile.identity_file.as_deref())
                .inspect_err(|e| *self.last_error.lock() = Some(e.message.clone()))?;
            if !ok {
                let hint = if notes.is_empty() { String::new() } else { format!(" ({})", notes.join("; ")) };
                return self.fail("EAUTH", format!("{}: Permission denied (publickey). No key from the SSH agent or {} was accepted{hint}.",
                    self.profile.destination(), self.profile.identity_file.as_deref().unwrap_or("~/.ssh/id_*")));
            }
        }
        *self.conn.lock() = Some(Arc::new(conn));
        *self.connected_at.lock() = Some(Instant::now());
        *self.last_error.lock() = None;
        Ok(())
    }

    /// The host key is verified by now, so a password only goes to a trusted host.
    fn password_login(&self, conn: &mut Conn, approvals: &Approvals, module: &str, generation: u64) -> HResult<()> {
        let dest = self.profile.destination();
        let methods = match conn.auth_none(&self.profile.user)? {
            AuthOutcome::Success => return Ok(()),
            AuthOutcome::Failed(m) => m,
        };
        // One method only: a second would count against the server's limit with an empty answer.
        let keyboard = if methods.iter().any(|m| m == "password") {
            false
        } else if methods.iter().any(|m| m == "keyboard-interactive") {
            true
        } else {
            return self.fail("EAUTH", format!("{dest} does not accept password logins. Sign in with a key or the SSH agent instead."));
        };
        let mut rejected = 0;
        while rejected < MAX_PASSWORD_ATTEMPTS {
            let notice = if rejected > 0 { "That password was not accepted. Try again.\n\n" } else { "" };
            let detail = format!("{notice}Connecting to {}:{}, whose host key matches known_hosts.\n\nThe password goes only to this SSH connection. Hato does not save it or share it with plugins, and asks again the next time it reconnects.", self.profile.host, self.profile.port);
            let Some(secret) = approvals.request_secret(module, generation, "ssh.password", &format!("Password for {dest}"), &detail, "Password", "Connect", Duration::from_secs(300)) else {
                return Err(HostError::new("ECANCELED", format!("Password entry for {dest} was cancelled.")));
            };
            if conn.auth_password(&self.profile.user, secret.expose(), keyboard)? {
                return Ok(());
            }
            rejected += 1;
            if conn.is_closed() {
                break;
            }
        }
        self.fail("EAUTH", format!("The password for {dest} was rejected {rejected} times."))
    }

    /// Verify the distribution runs, then hold a channel open so WSL does not stop it while idle.
    fn connect_wsl(&self) -> HResult<()> {
        let out = self.wsl_command(&["/bin/sh", "-c", "echo hato-wsl-ok"]).stdin(Stdio::null()).output()
            .map_err(|e| HostError::new("ENOEXEC", format!("cannot run wsl.exe: {e}")))?;
        let text = wsl::decode(&out.stdout);
        if !out.status.success() || !text.contains("hato-wsl-ok") {
            let err = format!("{} {}", text.trim(), wsl::decode(&out.stderr).trim());
            return self.fail("ECONNREFUSED", format!("WSL distribution {} is not available: {}", self.profile.label(), err.trim()));
        }
        // `cat` ends when this end of its stdin closes, so the channel never outlives the app.
        let child = self.wsl_command(&["/bin/cat"]).stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::null()).spawn()
            .map_err(|e| HostError::new("ENOEXEC", format!("cannot run wsl.exe: {e}")))?;
        *self.child.lock() = Some(child);
        *self.connected_at.lock() = Some(Instant::now());
        *self.last_error.lock() = None;
        Ok(())
    }

    pub fn disconnect(&self) {
        *self.sftp.lock() = None;
        for (_, mut r) in self.relays.lock().drain() {
            let _ = r.kill();
            let _ = r.wait();
        }
        if let Some(mut c) = self.child.lock().take() {
            let _ = c.kill();
            let _ = c.wait();
        }
        let mut all: Vec<Arc<Conn>> = self.extra.lock().drain(..).collect();
        all.extend(self.conn.lock().take());
        for c in all {
            if let Ok(c) = Arc::try_unwrap(c) {
                c.disconnect();
            }
            // Otherwise a caller still holds it; it closes when dropped.
        }
    }

    pub fn sftp(&self) -> HResult<Arc<Sftp>> {
        self.ensure_alive()?;
        let mut g = self.sftp.lock();
        if let Some(s) = g.as_ref() {
            if s.is_alive() {
                return Ok(s.clone());
            }
        }
        let s = if self.is_wsl() {
            Sftp::start(Spawned::spawn(self.wsl_command(&["/bin/sh", "-c", WSL_SFTP]), "wsl.exe")?).map_err(|e| {
                HostError::new(&e.code, format!("cannot start sftp-server in {} (install the openssh-sftp-server package there): {}", self.profile.label(), e.message))
            })?
        } else {
            Sftp::start(self.conn()?.open_channel(ChannelRequest::Subsystem("sftp".into()))?)?
        };
        let s = Arc::new(s);
        *g = Some(s.clone());
        Ok(s)
    }

    pub fn local_forward(&self, port: u16, host: String, target_port: u16) -> HResult<(tokio::task::JoinHandle<()>, u16)> {
        self.conn()?.local_forward(port, host, target_port)
    }

    /// Remote loopback-only reverse forward: remote 127.0.0.1:<allocated> -> local 127.0.0.1:<local_port>.
    pub fn forward_reverse(&self, local_port: u16) -> HResult<u16> {
        self.conn()?.forward(local_port)
    }

    /// Listen on the distribution's 127.0.0.1 and relay to this machine's `local_port`, through
    /// the `hato daemon forward` at `bin` (a Linux build, see `daemon_link::install`).
    pub fn relay_from_wsl(&self, local_port: u16, bin: &str) -> HResult<u16> {
        self.ensure_alive()?;
        let mut child = self.wsl_command(&[bin, "daemon", "forward"]).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn()
            .map_err(|e| HostError::new("ENOEXEC", format!("cannot run wsl.exe: {e}")))?;
        let (input, output) = (child.stdout.take().unwrap(), child.stdin.take().unwrap());
        match crate::host::relay::connect(Box::new(input), Box::new(output), local_port) {
            Ok(port) => {
                self.relays.lock().insert(port, child);
                Ok(port)
            }
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                Err(HostError::new("EFORWARD", format!("relay in {} failed: {e}", self.profile.label())))
            }
        }
    }

    pub fn cancel_reverse(&self, remote_port: u16, _local_port: u16) {
        if self.is_wsl() {
            if let Some(mut r) = self.relays.lock().remove(&remote_port) {
                let _ = r.kill();
                let _ = r.wait();
            }
            return;
        }
        if let Ok(c) = self.conn() {
            c.cancel_forward(remote_port);
        }
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

#[cfg(test)]
mod password_tests {
    use super::*;

    #[test]
    fn password_profiles_exclude_keys_and_wsl() {
        let profile = SshProfile { profile_id: "p".into(), host: "h".into(), port: 22, user: "u".into(), identity_file: None, transport: None, auth: Some("password".into()) };
        assert!(profile.validate().is_ok());
        assert!(SshProfile { identity_file: Some("/k".into()), ..profile.clone() }.validate().is_err());
        assert!(SshProfile { auth: Some("other".into()), ..profile }.validate().is_err());
    }
}
