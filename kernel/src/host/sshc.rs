//! Built-in SSH client (russh). One authenticated connection per machine; every command, terminal,
//! SFTP session and reverse forward is a channel on it, opened in-process. Compared with spawning
//! the OpenSSH client per channel this costs no process launch (on Windows that was a `wsl.exe`,
//! hundreds of milliseconds each) and needs no ControlMaster socket.
//!
//! The kernel's threads are synchronous; a small dedicated tokio runtime drives the connections.
//! Each channel is bridged to blocking `Read`/`Write` handles (see `host::stdio`).
//!
//! Flow control: russh grants the server more window as data arrives and hands it to the channel
//! through a bounded queue, so a channel that is not drained would stall the whole connection.
//! Every channel therefore has a task that drains it at once into an unbounded queue.
use crate::host::process::ExitInfo;
use crate::host::stdio::{ProcHandle, Spawned};
use crate::util::{HResult, HostError};
use parking_lot::{Condvar, Mutex};
use russh::client::{self, Handle};
use russh::keys::{HashAlg, PrivateKeyWithHashAlg, PublicKey};
use russh::{ChannelMsg, Sig};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::{Arc, OnceLock};
use std::time::Duration;
use tokio::sync::mpsc;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const CHANNEL_TIMEOUT: Duration = Duration::from_secs(20);

fn rt() -> &'static tokio::runtime::Runtime {
    static RT: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
    RT.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread().worker_threads(2).thread_name("ssh").enable_all().build()
            .expect("SSH runtime")
    })
}

fn block_on<F: std::future::Future>(f: F) -> F::Output { rt().block_on(f) }

/// `f` with a deadline. The timer must be created inside the runtime, hence the async block.
fn block_on_timeout<F: std::future::Future>(d: Duration, f: F) -> Result<F::Output, tokio::time::error::Elapsed> {
    rt().block_on(async move { tokio::time::timeout(d, f).await })
}

fn err(code: &str, e: impl std::fmt::Display) -> HostError { HostError::new(code, e.to_string()) }

// ------------------------------------------------------------------------------- host keys

/// What the server's host key looked like against known_hosts.
#[derive(Clone, Debug)]
pub enum HostKeyVerdict {
    Known,
    /// Not recorded. `fingerprint` is SHA256, as `ssh-keygen -l` prints it.
    Unknown { fingerprint: String, algorithm: String },
    /// Recorded with a different key of the same type: never accepted.
    Changed { line: usize, path: String },
}

pub fn known_hosts_path() -> PathBuf {
    match std::env::var("HATO_SSH_KNOWN_HOSTS").ok().filter(|s| !s.is_empty() && !s.contains('\0')) {
        Some(p) => PathBuf::from(p),
        None => dirs::home_dir().unwrap_or_default().join(".ssh").join("known_hosts"),
    }
}

/// The files consulted for host keys: the user's file (written to) and, unless overridden, the
/// system-wide one.
fn known_hosts_files() -> Vec<PathBuf> {
    let mut v = vec![known_hosts_path()];
    if std::env::var_os("HATO_SSH_KNOWN_HOSTS").is_none() {
        v.push(dirs::home_dir().unwrap_or_default().join(".ssh").join("known_hosts2"));
        v.push(if cfg!(windows) { PathBuf::from(r"C:\ProgramData\ssh\ssh_known_hosts") } else { PathBuf::from("/etc/ssh/ssh_known_hosts") });
    }
    v
}

/// The name known_hosts uses: `host`, or `[host]:port` off port 22.
fn host_pattern_name(host: &str, port: u16) -> String {
    let h = host.trim_start_matches('[').trim_end_matches(']').to_ascii_lowercase();
    if port == 22 { h } else { format!("[{h}]:{port}") }
}

/// OpenSSH pattern matching for one host-list entry: hashed (`|1|salt|hash`), `*`/`?` wildcards.
fn host_entry_matches(entry: &str, name: &str) -> bool {
    if let Some(rest) = entry.strip_prefix("|1|") {
        use base64::Engine;
        use hmac::{KeyInit, Mac};
        let mut parts = rest.split('|');
        let (Some(salt), Some(hash)) = (parts.next(), parts.next()) else { return false };
        let b64 = base64::engine::general_purpose::STANDARD;
        let (Ok(salt), Ok(hash)) = (b64.decode(salt), b64.decode(hash)) else { return false };
        let Ok(mac) = <hmac::Hmac<sha1::Sha1> as KeyInit>::new_from_slice(&salt) else { return false };
        return mac.chain_update(name.as_bytes()).verify_slice(&hash).is_ok();
    }
    wildcard(entry.to_ascii_lowercase().as_bytes(), name.as_bytes())
}

fn wildcard(p: &[u8], s: &[u8]) -> bool {
    match (p.first(), s.first()) {
        (None, None) => true,
        (Some(b'*'), _) => wildcard(&p[1..], s) || (!s.is_empty() && wildcard(p, &s[1..])),
        (Some(b'?'), Some(_)) => wildcard(&p[1..], &s[1..]),
        (Some(a), Some(b)) if a == b => wildcard(&p[1..], &s[1..]),
        _ => false,
    }
}

/// Keys recorded for `name` in `text`, with their line numbers. Lines it cannot use (markers,
/// unknown key types, garbage) are skipped rather than failing the whole check.
fn recorded_keys(text: &str, name: &str) -> Vec<(usize, PublicKey)> {
    let mut out = Vec::new();
    for (i, line) in text.lines().enumerate() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') || line.starts_with('@') {
            continue; // @cert-authority / @revoked: not host keys of their own
        }
        let mut f = line.split_whitespace();
        let (Some(hosts), Some(_ty), Some(b64)) = (f.next(), f.next(), f.next()) else { continue };
        let mut matched = false;
        let mut negated = false;
        for e in hosts.split(',') {
            match e.strip_prefix('!') {
                Some(neg) if host_entry_matches(neg, name) => negated = true,
                Some(_) => {}
                None => matched |= host_entry_matches(e, name),
            }
        }
        if matched && !negated {
            if let Ok(k) = russh::keys::parse_public_key_base64(b64) {
                out.push((i + 1, k));
            }
        }
    }
    out
}

pub fn check_host_key(host: &str, port: u16, key: &PublicKey) -> HostKeyVerdict {
    let name = host_pattern_name(host, port);
    for path in known_hosts_files() {
        let Ok(text) = std::fs::read_to_string(&path) else { continue };
        let recorded = recorded_keys(&text, &name);
        if recorded.iter().any(|(_, k)| k.key_data() == key.key_data()) {
            return HostKeyVerdict::Known;
        }
        if let Some((line, _)) = recorded.iter().find(|(_, k)| k.algorithm() == key.algorithm()) {
            return HostKeyVerdict::Changed { line: *line, path: path.display().to_string() };
        }
    }
    HostKeyVerdict::Unknown { fingerprint: key.fingerprint(HashAlg::Sha256).to_string(), algorithm: key.algorithm().to_string() }
}

/// Append the key to the user's known_hosts (after the user approved its fingerprint).
pub fn learn_host_key(host: &str, port: u16, key: &PublicKey) -> HResult<()> {
    let path = known_hosts_path();
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(HostError::io)?;
    }
    let existing = std::fs::read(&path).unwrap_or_default();
    let sep = if existing.is_empty() || existing.ends_with(b"\n") { "" } else { "\n" };
    let line = format!("{sep}{} {}\n", host_pattern_name(host, port), key.to_openssh().map_err(|e| err("EIO", e))?);
    let mut f = std::fs::OpenOptions::new().create(true).append(true).open(&path).map_err(HostError::io)?;
    f.write_all(line.as_bytes()).map_err(HostError::io)
}

// ------------------------------------------------------------------------------- connection

struct Client {
    host: String,
    port: u16,
    /// SHA256 fingerprint the user approved for an unknown host (learned on success).
    trusted: Option<String>,
    seen: Arc<Mutex<Option<(PublicKey, HostKeyVerdict)>>>,
    /// Reverse forwards: remote port -> local loopback port.
    forwards: Arc<Mutex<HashMap<u32, u16>>>,
}

impl client::Handler for Client {
    type Error = russh::Error;

    async fn check_server_key(&mut self, key: &russh::keys::PublicKeyOrCertificate) -> Result<bool, Self::Error> {
        let russh::keys::PublicKeyOrCertificate::PublicKey { key, .. } = key else {
            return Ok(false); // host certificates: not supported (no CA configuration)
        };
        let verdict = check_host_key(&self.host, self.port, key);
        let ok = match &verdict {
            HostKeyVerdict::Known => true,
            HostKeyVerdict::Unknown { fingerprint, .. } => {
                let approved = self.trusted.as_deref() == Some(fingerprint.as_str());
                if approved {
                    let _ = learn_host_key(&self.host, self.port, key);
                }
                approved
            }
            HostKeyVerdict::Changed { .. } => false,
        };
        *self.seen.lock() = Some((key.clone(), verdict));
        Ok(ok)
    }

    async fn server_channel_open_forwarded_tcpip(
        &mut self, channel: russh::Channel<client::Msg>, _connected_address: &str, connected_port: u32,
        _originator_address: &str, _originator_port: u32, reply: client::ChannelOpenHandle, _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        // Only ports this connection asked for; anything else is refused (reply dropped).
        let Some(local) = self.forwards.lock().get(&connected_port).copied() else { return Ok(()) };
        reply.accept().await;
        tokio::spawn(bridge_tcp(channel, local));
        Ok(())
    }
}

/// One forwarded connection: remote client <-> local 127.0.0.1:`port`.
async fn bridge_tcp(channel: russh::Channel<client::Msg>, port: u16) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let Ok(tcp) = tokio::net::TcpStream::connect(("127.0.0.1", port)).await else {
        let _ = channel.close().await;
        return;
    };
    let _ = tcp.set_nodelay(true);
    let (mut tr, mut tw) = tcp.into_split();
    let (mut rd, wr) = channel.split();
    // Drain the channel immediately (see the module note); a separate task writes to TCP.
    let (tx, mut rx) = mpsc::unbounded_channel::<Option<Vec<u8>>>();
    tokio::spawn(async move {
        while let Some(m) = rd.wait().await {
            match m {
                ChannelMsg::Data { data } => { let _ = tx.send(Some(data.to_vec())); }
                ChannelMsg::Eof | ChannelMsg::Close => break,
                _ => {}
            }
        }
        let _ = tx.send(None);
    });
    let to_tcp = tokio::spawn(async move {
        while let Some(Some(d)) = rx.recv().await {
            if tw.write_all(&d).await.is_err() {
                break;
            }
        }
        let _ = tw.shutdown().await;
    });
    let mut buf = vec![0u8; 32 * 1024];
    loop {
        match tr.read(&mut buf).await {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                if wr.data_bytes(buf[..n].to_vec()).await.is_err() {
                    break;
                }
            }
        }
    }
    let _ = wr.eof().await;
    let _ = to_tcp.await;
    let _ = wr.close().await;
}

pub struct Conn {
    handle: Handle<Client>,
    forwards: Arc<Mutex<HashMap<u32, u16>>>,
}

pub enum Opened {
    Ok(Conn),
    /// The host key was not accepted. `verdict` says why; `Unknown` can be approved and retried.
    HostKey(HostKeyVerdict),
}

/// TCP connect, key exchange and host key verification (not yet authenticated).
pub fn open(host: &str, port: u16, trusted_fingerprint: Option<String>) -> HResult<Opened> {
    let seen = Arc::new(Mutex::new(None));
    let forwards = Arc::new(Mutex::new(HashMap::new()));
    let handler = Client { host: host.to_string(), port, trusted: trusted_fingerprint, seen: seen.clone(), forwards: forwards.clone() };
    let config = Arc::new(client::Config {
        keepalive_interval: Some(Duration::from_secs(15)),
        keepalive_max: 3,
        inactivity_timeout: None,
        nodelay: true,
        ..Default::default()
    });
    let addr = host.trim_start_matches('[').trim_end_matches(']').to_string();
    let r = block_on(async move {
        let tcp = tokio::time::timeout(CONNECT_TIMEOUT, tokio::net::TcpStream::connect((addr.as_str(), port))).await
            .map_err(|_| err("ETIMEDOUT", format!("connecting to {addr}:{port} timed out")))?
            .map_err(|e| err("ECONNREFUSED", format!("cannot reach {addr}:{port}: {e}")))?;
        tokio::time::timeout(CONNECT_TIMEOUT, client::connect_stream(config, tcp, handler)).await
            .map_err(|_| err("ETIMEDOUT", format!("SSH handshake with {addr}:{port} timed out")))
            .map(|r| r.map_err(|e| e))
    });
    match r? {
        Ok(handle) => Ok(Opened::Ok(Conn { handle, forwards })),
        Err(e) => match seen.lock().take() {
            Some((_, v)) if !matches!(v, HostKeyVerdict::Known) => Ok(Opened::HostKey(v)),
            _ => Err(err("ECONNREFUSED", format!("SSH handshake failed: {e}"))),
        },
    }
}

/// What the server accepts next, as OpenSSH names it (`publickey`, `password`, …).
pub type Methods = Vec<String>;

fn method_names(m: &russh::MethodSet) -> Methods {
    m.iter().map(|k| <&str>::from(k).to_string()).collect()
}

pub enum AuthOutcome {
    Success,
    Failed(Methods),
}

impl Conn {
    pub fn is_closed(&self) -> bool { self.handle.is_closed() }

    /// Ask for no authentication: reports the methods the server offers.
    pub fn auth_none(&mut self, user: &str) -> HResult<AuthOutcome> {
        let r = block_on(self.handle.authenticate_none(user)).map_err(|e| err("EAUTH", e))?;
        Ok(match r {
            russh::client::AuthResult::Success => AuthOutcome::Success,
            russh::client::AuthResult::Failure { remaining_methods, .. } => AuthOutcome::Failed(method_names(&remaining_methods)),
        })
    }

    /// The password, as `password` or as the answer to `keyboard-interactive` prompts.
    pub fn auth_password(&mut self, user: &str, password: &str, keyboard_interactive: bool) -> HResult<bool> {
        block_on(async {
            if !keyboard_interactive {
                return self.handle.authenticate_password(user, password).await.map(|r| r.success()).map_err(|e| err("EAUTH", e));
            }
            use russh::client::KeyboardInteractiveAuthResponse as K;
            let mut r = self.handle.authenticate_keyboard_interactive_start(user, None).await.map_err(|e| err("EAUTH", e))?;
            for _ in 0..5 {
                match r {
                    K::Success => return Ok(true),
                    K::Failure { .. } => return Ok(false),
                    K::InfoRequest { prompts, .. } => {
                        // Answer secret prompts with the password; there is nobody to ask the rest.
                        let answers = prompts.iter().map(|p| if p.echo { String::new() } else { password.to_string() }).collect();
                        r = self.handle.authenticate_keyboard_interactive_respond(answers).await.map_err(|e| err("EAUTH", e))?;
                    }
                }
            }
            Ok(false)
        })
    }

    /// Public key authentication: the agent's keys, then `identity` (or the default key files).
    /// Returns a note per key that could not be used (encrypted, unreadable), for error messages.
    pub fn auth_keys(&mut self, user: &str, identity: Option<&str>) -> HResult<(bool, Vec<String>)> {
        let mut notes = Vec::new();
        let rsa_hash = block_on(self.handle.best_supported_rsa_hash()).ok().flatten().flatten();
        // With an explicit identity, only that key is offered (IdentitiesOnly), as before.
        if identity.is_none() && block_on(self.auth_agent(user, rsa_hash, &mut notes)) {
            return Ok((true, notes));
        }
        let files: Vec<PathBuf> = match identity {
            Some(p) => vec![expand_home(p)],
            None => ["id_ed25519", "id_ecdsa", "id_rsa"].iter().map(|n| dirs::home_dir().unwrap_or_default().join(".ssh").join(n)).filter(|p| p.is_file()).collect(),
        };
        for path in files {
            let key = match russh::keys::load_secret_key(&path, None) {
                Ok(k) => k,
                Err(russh::keys::Error::KeyIsEncrypted) => {
                    notes.push(format!("{} is passphrase-protected: add it to your SSH agent", path.display()));
                    continue;
                }
                Err(e) => {
                    notes.push(format!("{}: {e}", path.display()));
                    continue;
                }
            };
            let key = PrivateKeyWithHashAlg::new(Arc::new(key), rsa_hash);
            match block_on(self.handle.authenticate_publickey(user, key)) {
                Ok(r) if r.success() => return Ok((true, notes)),
                Ok(_) => {}
                Err(e) => return Err(err("EAUTH", e)),
            }
        }
        Ok((false, notes))
    }

    async fn auth_agent(&mut self, user: &str, rsa_hash: Option<HashAlg>, notes: &mut Vec<String>) -> bool {
        #[cfg(unix)]
        if let Ok(agent) = russh::keys::agent::client::AgentClient::connect_env().await {
            return self.auth_with_agent(user, rsa_hash, agent, notes).await;
        }
        #[cfg(windows)]
        {
            if let Ok(agent) = russh::keys::agent::client::AgentClient::connect_named_pipe(r"\\.\pipe\openssh-ssh-agent").await {
                if self.auth_with_agent(user, rsa_hash, agent, notes).await {
                    return true;
                }
            }
            if let Ok(agent) = russh::keys::agent::client::AgentClient::connect_pageant().await {
                return self.auth_with_agent(user, rsa_hash, agent, notes).await;
            }
        }
        let _ = (user, rsa_hash, notes);
        false
    }

    async fn auth_with_agent<S>(&mut self, user: &str, rsa_hash: Option<HashAlg>, mut agent: russh::keys::agent::client::AgentClient<S>, notes: &mut Vec<String>) -> bool
    where S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static {
        let Ok(ids) = agent.request_identities().await else { return false };
        for id in ids {
            let russh::keys::agent::AgentIdentity::PublicKey { key, .. } = id else { continue };
            let hash = if key.algorithm().is_rsa() { rsa_hash } else { None };
            match self.handle.authenticate_publickey_with(user, key, hash, &mut agent).await {
                Ok(r) if r.success() => return true,
                Ok(_) => {}
                Err(e) => notes.push(format!("SSH agent: {e}")),
            }
        }
        false
    }

    /// Remote 127.0.0.1:<allocated> -> local 127.0.0.1:`local_port`.
    pub fn forward(&self, local_port: u16) -> HResult<u16> {
        let port = block_on_timeout(CHANNEL_TIMEOUT, self.handle.tcpip_forward("127.0.0.1", 0))
            .map_err(|_| err("ETIMEDOUT", "reverse forward request timed out"))?
            .map_err(|e| err("EFORWARD", format!("reverse forward refused: {e}")))?;
        let port = u16::try_from(port).map_err(|_| err("EFORWARD", "bad forwarded port"))?;
        self.forwards.lock().insert(port as u32, local_port);
        Ok(port)
    }

    pub fn cancel_forward(&self, remote_port: u16) {
        self.forwards.lock().remove(&(remote_port as u32));
        let _ = block_on_timeout(CHANNEL_TIMEOUT, self.handle.cancel_tcpip_forward("127.0.0.1", remote_port as u32));
    }

    pub fn disconnect(self) {
        let h = self.handle;
        rt().spawn(async move { let _ = h.disconnect(russh::Disconnect::ByApplication, "", "en").await; });
    }

    /// A new channel running `req`, bridged to blocking pipes.
    pub fn open_channel(&self, req: ChannelRequest) -> HResult<Spawned> {
        let ch = block_on_timeout(CHANNEL_TIMEOUT, self.handle.channel_open_session())
            .map_err(|_| err("ETIMEDOUT", "opening an SSH channel timed out"))?
            .map_err(|e| match e {
                // Typically the server's per-connection session limit (OpenSSH MaxSessions, 10).
                russh::Error::ChannelOpenFailure(_) => err("EBUSY", format!("the server refused another session: {e}")),
                e => err("ENOTCONN", format!("cannot open an SSH channel: {e}")),
            })?;
        let (rd, wr) = ch.split();
        let pty = matches!(req, ChannelRequest::Pty { .. });
        block_on(async {
            match &req {
                ChannelRequest::Exec(cmd) => wr.exec(false, cmd.as_bytes()).await,
                ChannelRequest::Subsystem(name) => wr.request_subsystem(false, name.as_str()).await,
                ChannelRequest::Pty { command, cols, rows } => {
                    wr.request_pty(false, "xterm-256color", *cols as u32, *rows as u32, 0, 0, &[]).await?;
                    wr.exec(false, command.as_bytes()).await
                }
            }
        }).map_err(|e| err("ENOTCONN", format!("SSH channel request failed: {e}")))?;

        let (out_tx, out_rx) = crossbeam_channel::unbounded::<Vec<u8>>();
        let (err_tx, err_rx) = crossbeam_channel::unbounded::<Vec<u8>>();
        let (ctl_tx, mut ctl_rx) = mpsc::unbounded_channel::<Ctl>();
        let ctl = Arc::new(ChannelCtl { tx: ctl_tx.clone(), exit: Mutex::new(None), cv: Condvar::new() });

        // Reader: drains the channel at once (see the module note).
        let c2 = ctl.clone();
        let shutdown = ctl_tx.clone();
        let reader = rt().spawn(async move {
            let mut rd = rd;
            let (mut out_tx, mut err_tx) = (Some(out_tx), Some(err_tx));
            while let Some(m) = rd.wait().await {
                match m {
                    ChannelMsg::Data { data } => { if let Some(t) = &out_tx { let _ = t.send(data.to_vec()); } }
                    // With a PTY the server merges streams; keep stray stderr in the terminal.
                    ChannelMsg::ExtendedData { data, .. } => {
                        let t = if pty { &out_tx } else { &err_tx };
                        if let Some(t) = t { let _ = t.send(data.to_vec()); }
                    }
                    ChannelMsg::ExitStatus { exit_status } => c2.finish(ExitInfo { code: Some(exit_status as i32), signal: None }),
                    ChannelMsg::ExitSignal { signal_name, .. } => c2.finish(ExitInfo { code: None, signal: Some(signal_number(&signal_name)) }),
                    ChannelMsg::Eof => { out_tx = None; err_tx = None; }
                    ChannelMsg::Close => break,
                    _ => {}
                }
            }
            drop((out_tx, err_tx));
            c2.finish(ExitInfo { code: None, signal: None });
            let _ = shutdown.send(Ctl::Shutdown);
        });
        // Writer: stdin, signals, resizes and close, in order.
        let c3 = ctl.clone();
        let reader = reader.abort_handle();
        rt().spawn(async move {
            while let Some(m) = ctl_rx.recv().await {
                let r = match m {
                    Ctl::Data(d) => wr.data_bytes(d).await,
                    Ctl::Eof => wr.eof().await,
                    Ctl::Signal(s) => wr.signal(s).await,
                    Ctl::Resize(c, r) => wr.window_change(c, r, 0, 0).await,
                    Ctl::Terminate(s) => {
                        // Give the program time to report how it ended: once this side closes the
                        // channel, a late exit status is no longer delivered.
                        let _ = wr.signal(s).await;
                        for _ in 0..40 {
                            if c3.try_wait().is_some() {
                                break;
                            }
                            tokio::time::sleep(Duration::from_millis(50)).await;
                        }
                        close(&wr, &c3, &reader).await;
                        break;
                    }
                    Ctl::Close => {
                        close(&wr, &c3, &reader).await;
                        break;
                    }
                    Ctl::Shutdown => break,
                };
                if r.is_err() {
                    break;
                }
            }
        });
        Ok(Spawned {
            stdin: Some(Box::new(ChanWriter { tx: ctl_tx })),
            stdout: Some(Box::new(ChanReader { rx: out_rx, buf: Vec::new(), pos: 0 })),
            stderr: Some(Box::new(ChanReader { rx: err_rx, buf: Vec::new(), pos: 0 })),
            handle: ProcHandle::Channel(ctl),
        })
    }
}

/// Close from this side. A server that never answers must not leave the channel's pipes open:
/// after a grace period it counts as ended and its output streams end.
async fn close(wr: &russh::ChannelWriteHalf<client::Msg>, c: &ChannelCtl, reader: &tokio::task::AbortHandle) {
    let _ = wr.close().await;
    for _ in 0..40 {
        if reader.is_finished() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    reader.abort();
    c.finish(ExitInfo { code: None, signal: None });
}

#[derive(Clone)]
pub enum ChannelRequest {
    /// A command line, run by the remote user's shell.
    Exec(String),
    Subsystem(String),
    /// A command on a remote PTY.
    Pty { command: String, cols: u16, rows: u16 },
}

fn sig(name: &str) -> Sig {
    match name.trim_start_matches("SIG") {
        "KILL" => Sig::KILL,
        "INT" => Sig::INT,
        "HUP" => Sig::HUP,
        _ => Sig::TERM,
    }
}

fn signal_number(s: &Sig) -> i32 {
    match s {
        Sig::HUP => 1, Sig::INT => 2, Sig::QUIT => 3, Sig::ILL => 4, Sig::ABRT => 6, Sig::FPE => 8, Sig::KILL => 9,
        Sig::USR1 => 10, Sig::SEGV => 11, Sig::PIPE => 13, Sig::ALRM => 14, Sig::TERM => 15, Sig::Custom(_) => 0,
    }
}

fn expand_home(p: &str) -> PathBuf {
    match p.strip_prefix("~/").or_else(|| p.strip_prefix("~\\")) {
        Some(rest) => dirs::home_dir().unwrap_or_default().join(rest),
        None => PathBuf::from(p),
    }
}

enum Ctl {
    Data(Vec<u8>),
    Eof,
    Signal(Sig),
    /// Signal, wait briefly for the exit, then close.
    Terminate(Sig),
    Resize(u32, u32),
    Close,
    Shutdown,
}

/// Control and exit state of one channel.
pub struct ChannelCtl {
    tx: mpsc::UnboundedSender<Ctl>,
    exit: Mutex<Option<ExitInfo>>,
    cv: Condvar,
}

impl ChannelCtl {
    fn finish(&self, e: ExitInfo) {
        let mut g = self.exit.lock();
        if g.is_none() {
            *g = Some(e);
        }
        self.cv.notify_all();
    }
    pub fn try_wait(&self) -> Option<ExitInfo> { self.exit.lock().clone() }
    pub fn wait(&self, timeout: Option<Duration>) -> Option<ExitInfo> {
        let mut g = self.exit.lock();
        let deadline = timeout.map(|t| std::time::Instant::now() + t);
        while g.is_none() {
            match deadline {
                Some(d) => {
                    if self.cv.wait_until(&mut g, d).timed_out() {
                        break;
                    }
                }
                None => self.cv.wait(&mut g),
            }
        }
        g.clone()
    }
    /// Deliver a signal (`TERM`, `KILL`, `INT`, `HUP`) to the remote program.
    pub fn signal(&self, name: &str) { let _ = self.tx.send(Ctl::Signal(sig(name))); }
    /// Signal the program, then close the channel once it ended (or after 2 s).
    pub fn terminate(&self, name: &str) { let _ = self.tx.send(Ctl::Terminate(sig(name))); }
    pub fn resize(&self, cols: u16, rows: u16) { let _ = self.tx.send(Ctl::Resize(cols as u32, rows as u32)); }
    pub fn close(&self) { let _ = self.tx.send(Ctl::Close); }
}

struct ChanWriter {
    tx: mpsc::UnboundedSender<Ctl>,
}

impl Write for ChanWriter {
    fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
        self.tx.send(Ctl::Data(b.to_vec())).map_err(|_| std::io::Error::new(std::io::ErrorKind::BrokenPipe, "SSH channel closed"))?;
        Ok(b.len())
    }
    fn flush(&mut self) -> std::io::Result<()> { Ok(()) }
}

impl Drop for ChanWriter {
    fn drop(&mut self) { let _ = self.tx.send(Ctl::Eof); }
}

struct ChanReader {
    rx: crossbeam_channel::Receiver<Vec<u8>>,
    buf: Vec<u8>,
    pos: usize,
}

impl Read for ChanReader {
    fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
        while self.pos >= self.buf.len() {
            match self.rx.recv() {
                Ok(b) => {
                    self.buf = b;
                    self.pos = 0;
                }
                Err(_) => return Ok(0),
            }
        }
        let n = out.len().min(self.buf.len() - self.pos);
        out[..n].copy_from_slice(&self.buf[self.pos..self.pos + n]);
        self.pos += n;
        Ok(n)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_hosts_lines() {
        let key = "AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl";
        let text = format!("# comment\n@cert-authority *.example ssh-ed25519 {key}\nbad line\nother,example.org ssh-ed25519 {key}\n[h]:2222\tssh-ed25519\t{key}\n*.wild.test ssh-ed25519 {key}\n!no.wild.test,*.wild.test ssh-ed25519 {key}\n");
        assert_eq!(recorded_keys(&text, "example.org").len(), 1);
        assert_eq!(recorded_keys(&text, &host_pattern_name("h", 2222)).len(), 1);
        assert_eq!(recorded_keys(&text, "a.wild.test").len(), 2);
        assert_eq!(recorded_keys(&text, "no.wild.test").len(), 1, "negated entry is skipped");
        assert!(recorded_keys(&text, "h").is_empty(), "port 2222 entry does not match port 22");
    }

    #[test]
    fn hashed_host_names() {
        // `ssh-keygen -H` form of "example.com".
        use base64::Engine;
        use hmac::{KeyInit, Mac};
        let salt = [7u8; 20];
        let mac = <hmac::Hmac<sha1::Sha1> as KeyInit>::new_from_slice(&salt).unwrap().chain_update(b"example.com").finalize().into_bytes();
        let b64 = base64::engine::general_purpose::STANDARD;
        let entry = format!("|1|{}|{}", b64.encode(salt), b64.encode(mac));
        assert!(host_entry_matches(&entry, "example.com"));
        assert!(!host_entry_matches(&entry, "example.org"));
    }
}
