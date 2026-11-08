//! SSH primitive built on the system OpenSSH client with a per-profile ControlMaster.
//!
//! Why OpenSSH rather than libssh2: it honours the user's ~/.ssh/config, agent, keys and
//! known_hosts verification; multiplexed channels (exec, PTY, SFTP subsystem, reverse forwards)
//! run concurrently without the global-session locking issues of blocking libssh2. The spec allows
//! "ssh2/libssh2 or equivalent"; this is documented in docs/COMPATIBILITY.md.
//!
//! The kernel knows nothing about projects: it only holds endpoints, verified host identity and
//! live connections, identified by a kernel-derived machine id `ssh:<profileId>`.
//!
//! On Windows, whose OpenSSH has no ControlMaster, the client is the one in the default WSL
//! distribution. `transport: "wsl"` runs the same channels in a distribution, without SSH.
use crate::approvals::{Approvals, Decision, Secret};
use crate::host::sftp::Sftp;
use crate::host::wsl;
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
    pub socket: PathBuf,
    child: Mutex<Option<Child>>,
    /// Held while connecting, so concurrent callers share one master and one password prompt.
    connecting: Mutex<()>,
    pub sftp: Mutex<Option<Arc<Sftp>>>,
    pub connected_at: Mutex<Option<Instant>>,
    pub last_error: Mutex<Option<String>>,
    accept_new: Mutex<bool>,
    /// `hato daemon forward` processes by the port they listen on.
    relays: Mutex<std::collections::HashMap<u16, Child>>,
    /// Windows, SSH transport: remote port -> (default distribution, relay port there).
    #[cfg(windows)]
    wsl_hops: Mutex<std::collections::HashMap<u16, (Arc<SshMaster>, u16)>>,
}

#[cfg(unix)]
fn socket_dir() -> String {
    let uid = unsafe { libc::getuid() };
    let d = PathBuf::from(format!("/tmp/hato-ssh-{uid}"));
    let _ = std::fs::create_dir_all(&d);
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&d, std::fs::Permissions::from_mode(0o700));
    }
    d.to_string_lossy().into_owned()
}

/// A path inside the distribution running the client; created by `prepare_socket_dir`.
#[cfg(windows)]
fn socket_dir() -> String { "/tmp/hato-ssh-windows".to_string() }

/// The OpenSSH client, as a program with leading arguments.
fn ssh_argv() -> (String, Vec<String>) {
    if cfg!(windows) { (wsl::exe(), wsl::exec_args(None, &["ssh"])) } else { ("ssh".to_string(), vec![]) }
}

fn ssh_program() -> Command {
    let (program, args) = ssh_argv();
    let mut c = crate::util::command(program);
    c.args(args);
    c
}

/// The client, reading a password from `askpass`. ssh passes its stdin on to that program, so the
/// password stays off command lines, out of the environment and off the disk.
fn password_ssh_program(askpass: &str) -> Command {
    let askpass = format!("SSH_ASKPASS={askpass}");
    // DISPLAY makes OpenSSH before 8.4 use askpass; it has no SSH_ASKPASS_REQUIRE.
    let argv = ["env", askpass.as_str(), "SSH_ASKPASS_REQUIRE=force", "DISPLAY=:0", "ssh"];
    if cfg!(windows) {
        return wsl::command(None, &argv);
    }
    let mut c = crate::util::command(argv[0]);
    c.args(&argv[1..]);
    c
}

/// An OpenSSH companion tool (`ssh-keyscan`, `ssh-keygen`) from the same place as the client.
fn ssh_tool(tool: &str) -> Command {
    if cfg!(windows) { wsl::command(None, &[tool]) } else { crate::util::command(tool) }
}

/// Runs `sftp-server` from the home directory (`realpath(".")` is how callers find the home).
const WSL_SFTP: &str = r#"cd && for p in /usr/lib/openssh/sftp-server /usr/libexec/openssh/sftp-server /usr/lib/ssh/sftp-server /usr/libexec/sftp-server /usr/lib/sftp-server; do [ -x "$p" ] && exec "$p"; done; exit 127"#;

impl SshMaster {
    pub fn new(profile: SshProfile) -> Arc<SshMaster> {
        let socket = PathBuf::from(format!("{}/{}.sock", socket_dir(), random_hex(6)));
        Arc::new(SshMaster {
            profile,
            socket,
            child: Mutex::new(None),
            connecting: Mutex::new(()),
            sftp: Mutex::new(None),
            connected_at: Mutex::new(None),
            last_error: Mutex::new(None),
            accept_new: Mutex::new(false),
            relays: Default::default(),
            #[cfg(windows)]
            wsl_hops: Default::default(),
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

    pub fn is_wsl(&self) -> bool { self.profile.is_wsl() }

    /// A distribution channel for `argv`. Only meaningful with the WSL transport.
    fn wsl_command(&self, argv: &[&str]) -> Command { wsl::command(self.wsl_distro(), argv) }

    /// The internal default-distribution master has no host.
    fn wsl_distro(&self) -> Option<&str> { Some(self.profile.host.as_str()).filter(|h| !h.is_empty()) }

    /// A non-interactive channel running `remote` through a POSIX shell on the machine.
    pub fn remote_command(&self, remote: &str) -> Command {
        if self.is_wsl() {
            return self.wsl_command(&["/bin/sh", "-c", remote]);
        }
        let mut c = self.client_command(&["-T"]);
        c.arg("--").arg(remote);
        c
    }

    /// A client invocation multiplexed over the master: `ssh -S sock -o ControlMaster=no ... dest`.
    pub fn client_command(&self, extra: &[&str]) -> Command {
        let mut c = ssh_program();
        c.arg("-S").arg(&self.socket).arg("-o").arg("ControlMaster=no");
        self.base_opts(&mut c);
        for e in extra {
            c.arg(e);
        }
        c.arg(self.profile.destination());
        c
    }

    /// Program and arguments for a local PTY running `remote_cmd` interactively on the machine.
    pub fn pty_command(&self, remote_cmd: &str) -> (String, Vec<String>) {
        if self.is_wsl() {
            return (wsl::exe(), wsl::exec_args(self.wsl_distro(), &["/bin/sh", "-c", remote_cmd]));
        }
        let (program, mut argv) = ssh_argv();
        argv.extend(self.pty_argv(remote_cmd));
        (program, argv)
    }

    /// Argument vector for running ssh inside a local PTY (remote interactive shell).
    fn pty_argv(&self, remote_cmd: &str) -> Vec<String> {
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
        if self.is_wsl() {
            return true; // the keepalive channel is the connection
        }
        let st = ssh_program()
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
            Err(HostError::new("ENOTCONN", format!("Connection to {} is not available (reconnect required; no local fallback)", self.profile.machine_id())))
        }
    }

    /// Start (or restart) the ControlMaster. Host key trust for unknown hosts is a native approval.
    /// A password is also asked natively, so only an `interactive` caller (a user gesture) may need one.
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
        #[cfg(windows)]
        prepare_socket_dir()?;
        let _ = std::fs::remove_file(&self.socket);
        let mut trust_asked = false;
        // The first password attempt follows a probe without credentials, which verifies the host
        // key first and reports the authentication methods: a password only goes to a trusted host.
        let mut password: Option<Secret> = None;
        let mut method = "";
        let mut rejected = 0;
        loop {
            let strict = if *self.accept_new.lock() { "accept-new" } else { "yes" };
            let mut c = match &password {
                Some(_) => password_ssh_program(&install_askpass()?),
                None => ssh_program(),
            };
            c.arg("-M").arg("-N").arg("-S").arg(&self.socket)
                .arg("-o").arg("ControlPersist=no")
                .arg("-o").arg(format!("StrictHostKeyChecking={strict}"))
                .arg("-o").arg("ServerAliveInterval=15")
                .arg("-o").arg("ServerAliveCountMax=3")
                .arg("-o").arg("ExitOnForwardFailure=yes");
            if password.is_some() {
                c.arg("-o").arg("BatchMode=no")
                    .arg("-o").arg(format!("PreferredAuthentications={method}"))
                    .arg("-o").arg("PubkeyAuthentication=no")
                    .arg("-o").arg("NumberOfPasswordPrompts=1");
            } else if self.profile.uses_password() {
                c.arg("-o").arg("PreferredAuthentications=none");
            }
            self.base_opts(&mut c);
            c.arg(self.profile.destination());
            c.stdin(if password.is_some() { Stdio::piped() } else { Stdio::null() }).stdout(Stdio::null()).stderr(Stdio::piped());
            let mut child = c.spawn().map_err(|e| HostError::new("ENOEXEC", format!("cannot run ssh: {e}")))?;
            if let (Some(secret), Some(mut stdin)) = (&password, child.stdin.take()) {
                use std::io::Write;
                let _ = stdin.write_all(secret.expose().as_bytes()).and_then(|_| stdin.write_all(b"\n"));
            }
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
                // On Windows the socket is inside the distribution: only the check can tell.
                if cfg!(windows) || self.socket.exists() {
                    let ok = ssh_program().arg("-S").arg(&self.socket).arg("-O").arg("check")
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
                    if host_key_problem && !trust_asked && !err.contains("REMOTE HOST IDENTIFICATION HAS CHANGED") {
                        trust_asked = true;
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
                    if self.profile.uses_password() && err.contains("Permission denied") {
                        if password.take().is_some() {
                            rejected += 1;
                        } else if let Some(offered) = password_method(&err) {
                            method = offered;
                        } else {
                            *self.last_error.lock() = Some(err.clone());
                            return Err(HostError::new("EAUTH", format!("{} does not accept password logins. Sign in with a key or the SSH agent instead.", self.profile.destination())));
                        }
                        if rejected >= MAX_PASSWORD_ATTEMPTS {
                            *self.last_error.lock() = Some(err.clone());
                            return Err(HostError::new("EAUTH", format!("The password for {} was rejected {rejected} times.", self.profile.destination())));
                        }
                        let notice = if rejected > 0 { "That password was not accepted. Try again.\n\n" } else { "" };
                        let detail = format!("{notice}Connecting to {}:{}, whose host key matches known_hosts.\n\nThe password goes only to OpenSSH for this connection. Hato does not save it or share it with plugins, and asks again the next time it reconnects.", self.profile.host, self.profile.port);
                        password = approvals.request_secret(module, generation, "ssh.password", &format!("Password for {}", self.profile.destination()), &detail, "Password", "Connect", Duration::from_secs(300));
                        if password.is_none() {
                            return Err(HostError::new("ECANCELED", format!("Password entry for {} was cancelled.", self.profile.destination())));
                        }
                        continue;
                    }
                    *self.last_error.lock() = Some(err.clone());
                    return Err(HostError::new("ECONNREFUSED", format!("SSH connection to {} failed: {err}", self.profile.destination())));
                }
            }
        }
    }

    /// Connect the internal master for the default distribution (no approvals involved).
    #[cfg(windows)]
    pub fn connect_default_distribution(&self) -> HResult<()> { self.connect_wsl() }

    /// Verify the distribution runs, then hold a channel open so WSL does not stop it while idle.
    fn connect_wsl(&self) -> HResult<()> {
        let out = self.wsl_command(&["/bin/sh", "-c", "echo hato-wsl-ok"]).stdin(Stdio::null()).output()
            .map_err(|e| HostError::new("ENOEXEC", format!("cannot run wsl.exe: {e}")))?;
        let text = wsl::decode(&out.stdout);
        if !out.status.success() || !text.contains("hato-wsl-ok") {
            let err = format!("{} {}", text.trim(), wsl::decode(&out.stderr).trim());
            *self.last_error.lock() = Some(err.clone());
            return Err(HostError::new("ECONNREFUSED", format!("WSL distribution {} is not available: {}", self.profile.label(), err.trim())));
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
        #[cfg(windows)]
        self.wsl_hops.lock().clear();
        if self.is_wsl() {
            if let Some(mut c) = self.child.lock().take() {
                let _ = c.kill();
                let _ = c.wait();
            }
            return;
        }
        let _ = ssh_program().arg("-S").arg(&self.socket).arg("-O").arg("exit")
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
        let s = if self.is_wsl() {
            Sftp::start(self.wsl_command(&["/bin/sh", "-c", WSL_SFTP])).map_err(|e| {
                HostError::new(&e.code, format!("cannot start sftp-server in {} (install the openssh-sftp-server package there): {}", self.profile.label(), e.message))
            })?
        } else {
            let mut c = self.client_command(&["-s"]);
            c.arg("sftp");
            Sftp::start(c)?
        };
        let s = Arc::new(s);
        *g = Some(s.clone());
        Ok(s)
    }

    /// Remote loopback-only reverse forward: remote 127.0.0.1:<allocated> -> local 127.0.0.1:<local_port>.
    pub fn forward_reverse(&self, local_port: u16) -> HResult<u16> {
        self.ensure_alive()?;
        let spec = format!("127.0.0.1:0:127.0.0.1:{local_port}");
        let out = ssh_program().arg("-S").arg(&self.socket).arg("-O").arg("forward").arg("-R").arg(&spec)
            .arg("-p").arg(self.profile.port.to_string()).arg(self.profile.destination())
            .output().map_err(HostError::io)?;
        if !out.status.success() {
            return Err(HostError::new("EFORWARD", format!("reverse forward failed: {}", String::from_utf8_lossy(&out.stderr).trim())));
        }
        let s = String::from_utf8_lossy(&out.stdout);
        s.trim().lines().last().and_then(|l| l.trim().parse::<u16>().ok())
            .ok_or_else(|| HostError::new("EFORWARD", format!("could not parse allocated remote port from {s:?}")))
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

    /// Windows, SSH transport: the forward's local end is a relay in the default distribution.
    #[cfg(windows)]
    pub fn forward_through_wsl(&self, hop: Arc<SshMaster>, hop_port: u16) -> HResult<u16> {
        let remote = self.forward_reverse(hop_port)?;
        self.wsl_hops.lock().insert(remote, (hop, hop_port));
        Ok(remote)
    }

    pub fn cancel_reverse(&self, remote_port: u16, local_port: u16) {
        if self.is_wsl() {
            if let Some(mut r) = self.relays.lock().remove(&remote_port) {
                let _ = r.kill();
                let _ = r.wait();
            }
            return;
        }
        #[cfg(windows)]
        let local_port = match self.wsl_hops.lock().remove(&remote_port) {
            Some((hop, hop_port)) => {
                hop.cancel_reverse(hop_port, local_port);
                hop_port
            }
            None => local_port,
        };
        let spec = format!("127.0.0.1:{remote_port}:127.0.0.1:{local_port}");
        let _ = ssh_program().arg("-S").arg(&self.socket).arg("-O").arg("cancel").arg("-R").arg(&spec)
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

/// The socket directory lives in the distribution running the client.
#[cfg(windows)]
fn prepare_socket_dir() -> HResult<()> {
    let out = wsl::command(None, &["/bin/sh", "-c", r#"umask 077 && mkdir -p "$1" && [ -O "$1" ]"#, "sh", &socket_dir()]).stdin(Stdio::null()).output()
        .map_err(|e| HostError::new("ENOEXEC", format!("cannot run wsl.exe: {e}")))?;
    if !out.status.success() {
        let err = format!("{} {}", wsl::decode(&out.stdout).trim(), wsl::decode(&out.stderr).trim());
        return Err(HostError::new("ENOEXEC", format!("SSH on Windows uses the OpenSSH client of the default WSL distribution, which is not available: {}", err.trim())));
    }
    Ok(())
}

const MAX_PASSWORD_ATTEMPTS: u32 = 3;

/// The method to send a password with, from ssh's `Permission denied (publickey,password).` One
/// method only: a second would count against the server's limit with an empty answer.
fn password_method(error: &str) -> Option<&'static str> {
    let (_, rest) = error.split_once("Permission denied (")?;
    let methods = rest.split(')').next()?.split(',').map(str::trim);
    let mut keyboard = false;
    for method in methods {
        match method {
            "password" => return Some("password"),
            "keyboard-interactive" => keyboard = true,
            _ => {}
        }
    }
    keyboard.then_some("keyboard-interactive")
}

const ASKPASS_SCRIPT: &str = "#!/bin/sh\nexec head -n 1\n";

/// Install the askpass program where the client runs, and return its path. It holds no secret.
#[cfg(unix)]
fn install_askpass() -> HResult<String> {
    use std::os::unix::fs::PermissionsExt;
    let path = format!("{}/askpass", socket_dir());
    let temporary = format!("{path}.{}", random_hex(4));
    std::fs::write(&temporary, ASKPASS_SCRIPT)
        .and_then(|_| std::fs::set_permissions(&temporary, std::fs::Permissions::from_mode(0o700)))
        .and_then(|_| std::fs::rename(&temporary, &path))
        .map_err(|e| HostError::new("EIO", format!("cannot install the SSH password helper: {e}")))?;
    Ok(path)
}

#[cfg(windows)]
fn install_askpass() -> HResult<String> {
    let path = format!("{}/askpass", socket_dir());
    let out = wsl::command(None, &["/bin/sh", "-c", r#"printf "$1" > "$2.$$" && chmod 700 "$2.$$" && mv "$2.$$" "$2""#, "sh", ASKPASS_SCRIPT, &path]).stdin(Stdio::null()).output()
        .map_err(|e| HostError::new("ENOEXEC", format!("cannot run wsl.exe: {e}")))?;
    if !out.status.success() {
        return Err(HostError::new("EIO", format!("cannot install the SSH password helper: {}", wsl::decode(&out.stderr).trim())));
    }
    Ok(path)
}

/// Optional alternate known_hosts file (isolated test environments). Host keys are still verified.
fn known_hosts_override() -> Option<String> {
    std::env::var("HATO_SSH_KNOWN_HOSTS").ok().filter(|s| !s.is_empty() && !s.contains('\0'))
}

fn keyscan_fingerprints(host: &str, port: u16) -> String {
    let scan = ssh_tool("ssh-keyscan").arg("-p").arg(port.to_string()).arg("-T").arg("5").arg(host)
        .stderr(Stdio::null()).output();
    let Ok(scan) = scan else { return String::new() };
    let mut kg = match ssh_tool("ssh-keygen").arg("-lf").arg("-").stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn() {
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

#[cfg(test)]
mod password_tests {
    use super::*;

    #[test]
    fn password_method_prefers_password_and_refuses_key_only_servers() {
        assert_eq!(password_method("u@h: Permission denied (publickey,password,keyboard-interactive)."), Some("password"));
        assert_eq!(password_method("u@h: Permission denied (publickey,keyboard-interactive)."), Some("keyboard-interactive"));
        assert_eq!(password_method("u@h: Permission denied (publickey)."), None);
        assert_eq!(password_method("Connection refused"), None);
    }

    #[test]
    fn password_profiles_exclude_keys_and_wsl() {
        let profile = SshProfile { profile_id: "p".into(), host: "h".into(), port: 22, user: "u".into(), identity_file: None, transport: None, auth: Some("password".into()) };
        assert!(profile.validate().is_ok());
        assert!(SshProfile { identity_file: Some("/k".into()), ..profile.clone() }.validate().is_err());
        assert!(SshProfile { auth: Some("other".into()), ..profile }.validate().is_err());
    }
}
