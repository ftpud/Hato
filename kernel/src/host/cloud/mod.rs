//! Kernel-owned, multiplexed transport to a same-user daemon socket.
mod channel;
mod noise;
mod program;
mod wire;

use anyhow::{anyhow, bail, Context, Result};
use base64::Engine;
pub use channel::Channel;
use channel::Tunnel;
use futures::{SinkExt, StreamExt};
use noise::Keys;
use parking_lot::Mutex;
pub use program::Program;
use serde::Deserialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::Duration;
use tokio::net::TcpStream;
use tokio::sync::{mpsc, oneshot, Semaphore};
use tokio::task::JoinHandle;
use tokio::time::timeout;
use tokio_tungstenite::tungstenite::{
    client::IntoClientRequest, http, protocol::WebSocketConfig, Bytes, Message,
};
use tokio_tungstenite::{
    connect_async_tls_with_config, Connector, MaybeTlsStream, WebSocketStream,
};
use wire::{Frame, CLOSE, CREDIT, DATA, MAX_CHANNELS, MAX_DATA, MAX_MESSAGE, OPEN, WINDOW};

const DEADLINE: Duration = Duration::from_secs(10);
const HEARTBEAT_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Clone, Copy)]
#[repr(u8)]
pub enum Kind {
    Control = 1,
    Exec = 2,
    Pty = 3,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ConfigFile {
    relay: String,
    host_id: String,
    token: String,
    private_key: String,
    peer_key: String,
    relay_ca_der: Option<String>,
}

pub struct Config {
    relay: String,
    host_id: String,
    token: String,
    keys: Keys,
    tls: Option<Arc<rustls::ClientConfig>>,
}

fn runtime() -> &'static tokio::runtime::Runtime {
    static RUNTIME: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
    RUNTIME.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .thread_name("hato-cloud")
            .build()
            .expect("Cloud runtime")
    })
}

impl Config {
    pub fn load(path: &Path) -> Result<Self> {
        use std::io::Read;
        let mut options = std::fs::OpenOptions::new();
        options.read(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
        }
        let mut file = options.open(path).context("open Cloud config")?;
        let metadata = file.metadata()?;
        if !metadata.is_file() || metadata.len() > 4096 {
            bail!("Cloud config must be a regular file of at most 4096 bytes");
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            if metadata.uid() != unsafe { libc::geteuid() } || metadata.mode() & 0o7177 != 0 {
                bail!("Cloud config must be owned by the current user with mode 0600");
            }
        }
        let mut bytes = Vec::new();
        file.by_ref().take(4097).read_to_end(&mut bytes)?;
        if bytes.len() > 4096 {
            bail!("Cloud config is too large");
        }
        let file: ConfigFile =
            serde_json::from_slice(&bytes).map_err(|_| anyhow!("invalid Cloud config JSON"))?;
        let valid_id = |s: &str| {
            s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        };
        if !(1..=64).contains(&file.host_id.len())
            || !valid_id(&file.host_id)
            || !(32..=128).contains(&file.token.len())
            || !valid_id(&file.token)
        {
            bail!("invalid Cloud host ID or token");
        }
        let uri: http::Uri = file.relay.parse().context("invalid Cloud relay URL")?;
        let scheme = uri.scheme_str();
        let authority = uri
            .authority()
            .ok_or_else(|| anyhow!("invalid Cloud relay authority"))?;
        let is_loopback = matches!(authority.host(), "127.0.0.1" | "[::1]");
        if uri.path() != "/"
            || uri.query().is_some()
            || authority.as_str().contains('@')
            || !(scheme == Some("wss") || scheme == Some("ws") && is_loopback)
        {
            bail!("Cloud relay requires a WSS origin, or WS on literal loopback for local development");
        }
        let tls = file
            .relay_ca_der
            .map(|encoded| {
                if scheme != Some("wss") {
                    bail!("a relay CA requires WSS");
                }
                let der = base64::engine::general_purpose::STANDARD
                    .decode(encoded)
                    .context("invalid relay CA encoding")?;
                let mut roots = rustls::RootCertStore::empty();
                roots.add(rustls::pki_types::CertificateDer::from(der))?;
                Ok(Arc::new(
                    rustls::ClientConfig::builder()
                        .with_root_certificates(roots)
                        .with_no_client_auth(),
                ))
            })
            .transpose()?;
        Ok(Self {
            relay: file.relay.trim_end_matches('/').to_string(),
            host_id: file.host_id,
            token: file.token,
            keys: Keys::new(&file.private_key, &file.peer_key)?,
            tls,
        })
    }

    pub fn label(&self) -> String {
        format!("{} on {}", self.host_id, self.relay)
    }

    pub fn machine_id(&self) -> String {
        // Distinguish independent relay origins with the same host ID.
        format!("cloud:{}", crate::util::sha256_hex(self.label().as_bytes()))
    }

    pub fn fingerprint(&self) -> String {
        crate::util::sha256_hex(self.keys.peer())
    }
}

type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;
type OpenReply = oneshot::Sender<Result<Channel>>;
type Link = mpsc::Sender<Command>;

enum Command {
    Open(Kind, OpenReply),
    Frame(Frame),
    Done(u32, u8),
}

struct Active {
    tx: Option<mpsc::Sender<Bytes>>,
    credit: Arc<Semaphore>,
    task: JoinHandle<()>,
    failure: Arc<Mutex<Option<&'static str>>>,
    done: bool,
}

impl Drop for Active {
    fn drop(&mut self) {
        if !self.done && !self.task.is_finished() {
            self.failure
                .lock()
                .get_or_insert("Cloud channel disconnected");
            self.task.abort();
        }
    }
}

struct Session {
    config: Arc<Config>,
    path: Option<PathBuf>,
    channels: HashMap<u32, Active>,
    sender: mpsc::WeakSender<Command>,
    next_id: u32,
}

impl Session {
    fn start(&mut self, id: u32, reply: Option<OpenReply>) -> Result<()> {
        let (tx, inbox) = channel::inbox();
        let credit = Arc::new(Semaphore::new(WINDOW));
        let commands = self
            .sender
            .upgrade()
            .ok_or_else(|| anyhow!("Cloud link closed"))?;
        let mut tunnel = Tunnel {
            id,
            inbox,
            credit: credit.clone(),
            commands: commands.clone(),
        };
        let config = self.config.clone();
        let path = self.path.clone();
        let failure = Arc::new(Mutex::new(None));
        let report = failure.clone();
        let task = tokio::spawn(async move {
            let result = async {
                let noise =
                    timeout(DEADLINE, tunnel.authenticate(&config.keys, reply.is_some())).await??;
                if let Some(reply) = reply {
                    let (pipe, mut bridge) = tokio::io::duplex(wire::CHUNK);
                    let (lifetime, dropped) = oneshot::channel();
                    reply
                        .send(Ok(Channel {
                            pipe,
                            failure: report.clone(),
                            _lifetime: lifetime,
                        }))
                        .map_err(|_| anyhow!("Cloud channel caller cancelled"))?;
                    let result = tokio::select! {
                        result = tunnel.bridge(&mut bridge, noise) => result,
                        _ = dropped => Err(anyhow!("Cloud channel released")),
                    };
                    if result.is_err() {
                        *report.lock() = Some("Cloud channel interrupted");
                    }
                    result
                } else {
                    #[cfg(unix)]
                    {
                        let path = path.ok_or_else(|| anyhow!("missing daemon socket path"))?;
                        let parent = path
                            .parent()
                            .ok_or_else(|| anyhow!("missing daemon socket directory"))?;
                        crate::daemon::secure_socket_dir(parent, false)?;
                        let mut socket = tokio::net::UnixStream::connect(path).await?;
                        if socket.peer_cred()?.uid() != unsafe { libc::geteuid() } {
                            bail!("daemon socket belongs to another user");
                        }
                        tunnel.bridge(&mut socket, noise).await
                    }
                    #[cfg(not(unix))]
                    {
                        let _ = path;
                        bail!("the daemon connector requires Unix");
                    }
                }
            }
            .await;
            let reason = if result.is_ok() { 0 } else { 3 };
            let _ = commands.send(Command::Done(id, reason)).await;
        });
        self.channels.insert(
            id,
            Active {
                tx: Some(tx),
                credit,
                task,
                failure,
                done: false,
            },
        );
        Ok(())
    }

    async fn command(&mut self, socket: &mut Socket, command: Command) -> Result<()> {
        match command {
            Command::Open(kind, reply) => {
                if self.channels.len() >= MAX_CHANNELS || self.next_id == u32::MAX {
                    let _ = reply.send(Err(anyhow!("Cloud channel limit reached")));
                    return Ok(());
                }
                self.next_id += 1;
                let id = self.next_id;
                self.start(id, Some(reply))?;
                send(socket, Frame::control(OPEN, id, kind as u8).message()).await
            }
            Command::Frame(frame) => {
                if self.channels.contains_key(&frame.id) {
                    send(socket, frame.message()).await?;
                }
                Ok(())
            }
            Command::Done(id, reason) => {
                if let Some(mut active) = self.channels.remove(&id) {
                    active.done = true;
                    send(socket, Frame::control(CLOSE, id, reason).message()).await?;
                }
                Ok(())
            }
        }
    }

    async fn receive(&mut self, socket: &mut Socket, frame: Frame) -> Result<()> {
        let id = frame.id;
        if frame.op == OPEN {
            if self.path.is_none()
                || id <= self.next_id
                || frame.payload.len() != 1
                || !(1..=3).contains(&frame.payload[0])
            {
                bail!("invalid relay open frame");
            }
            self.next_id = id;
            return if self.channels.len() >= MAX_CHANNELS {
                send(socket, Frame::control(CLOSE, id, 2).message()).await
            } else {
                self.start(id, None)
            };
        }
        let Some(active) = self.channels.get_mut(&id) else {
            return Ok(());
        };
        let valid = match frame.op {
            DATA if !frame.payload.is_empty() && frame.payload.len() <= MAX_DATA => active
                .tx
                .as_ref()
                .is_some_and(|tx| tx.try_send(frame.payload).is_ok()),
            CREDIT if frame.payload.len() == 1 && frame.payload[0] != 0 => {
                let n = frame.payload[0] as usize;
                if active.credit.available_permits() + n <= WINDOW {
                    active.credit.add_permits(n);
                    true
                } else {
                    false
                }
            }
            CLOSE if frame.payload.as_ref() == [0] => {
                // Drain already queued ciphertext and require encrypted EOF for a clean finish.
                active.tx.take();
                true
            }
            CLOSE => {
                self.channels.remove(&id);
                return Ok(());
            }
            _ => false,
        };
        if !valid {
            self.channels.remove(&id);
            send(socket, Frame::control(CLOSE, id, 2).message()).await?;
        }
        Ok(())
    }
}

async fn send(socket: &mut Socket, message: Message) -> Result<()> {
    timeout(DEADLINE, socket.send(message)).await??;
    Ok(())
}

async fn dial(config: &Config, role: &str) -> Result<Socket> {
    let mut request = format!("{}/relay/v1/{role}", config.relay).into_client_request()?;
    let token = http::HeaderValue::from_str(&format!("Bearer {}", config.token))?;
    request
        .headers_mut()
        .insert(http::header::AUTHORIZATION, token);
    request
        .headers_mut()
        .insert("x-hato-host", http::HeaderValue::from_str(&config.host_id)?);
    let limits = WebSocketConfig::default()
        .read_buffer_size(MAX_MESSAGE)
        .write_buffer_size(0)
        .max_write_buffer_size(2 * MAX_MESSAGE)
        .max_message_size(Some(MAX_MESSAGE))
        .max_frame_size(Some(MAX_MESSAGE));
    let tls = config
        .tls
        .as_ref()
        .map(|tls| Connector::Rustls(tls.clone()));
    let (socket, _) = timeout(
        DEADLINE,
        connect_async_tls_with_config(request, Some(limits), true, tls),
    )
    .await?
    .map_err(|error| match error {
        tokio_tungstenite::tungstenite::Error::Http(ref reply) => {
            anyhow!("Cloud relay rejected the connection ({})", reply.status())
        }
        _ => anyhow!("could not connect to the Cloud relay: {error}"),
    })?;
    Ok(socket)
}

async fn drive(
    mut socket: Socket,
    mut session: Session,
    mut commands: mpsc::Receiver<Command>,
) -> Result<()> {
    let idle = tokio::time::sleep(HEARTBEAT_TIMEOUT);
    tokio::pin!(idle);
    loop {
        tokio::select! {
            command = commands.recv() => match command {
                Some(command) => session.command(&mut socket, command).await?,
                None => return Ok(()),
            },
            message = socket.next() => {
                let message = message.ok_or_else(|| anyhow!("Cloud relay disconnected"))??;
                idle.as_mut().reset(tokio::time::Instant::now() + HEARTBEAT_TIMEOUT);
                match message {
                    Message::Binary(bytes) => session.receive(&mut socket, Frame::decode(bytes)?).await?,
                    Message::Ping(_) => timeout(DEADLINE, socket.flush()).await??,
                    Message::Pong(_) => {},
                    Message::Close(_) => bail!("Cloud relay closed the link"),
                    _ => bail!("invalid Cloud relay message"),
                }
            },
            _ = &mut idle => bail!("Cloud relay heartbeat timed out"),
        }
    }
}

pub struct Connection {
    config: Arc<Config>,
    link: tokio::sync::Mutex<Option<(Link, JoinHandle<()>)>>,
}

impl Connection {
    pub fn new(config: Config) -> Self {
        Self {
            config: Arc::new(config),
            link: tokio::sync::Mutex::new(None),
        }
    }

    pub fn machine_id(&self) -> String {
        self.config.machine_id()
    }

    pub async fn open(&self, kind: Kind) -> Result<Channel> {
        let sender = {
            let mut link = self.link.lock().await;
            if !link
                .as_ref()
                .is_some_and(|(sender, task)| !sender.is_closed() && !task.is_finished())
            {
                let socket = dial(&self.config, "client").await?;
                let (sender, receiver) = mpsc::channel(2 * MAX_CHANNELS);
                let session = Session {
                    config: self.config.clone(),
                    path: None,
                    channels: HashMap::new(),
                    sender: sender.downgrade(),
                    next_id: 0,
                };
                let task = tokio::spawn(async move {
                    let _ = drive(socket, session, receiver).await;
                });
                *link = Some((sender, task));
            }
            link.as_ref().expect("Cloud link initialized").0.clone()
        };
        let (reply, result) = oneshot::channel();
        sender
            .send(Command::Open(kind, reply))
            .await
            .map_err(|_| anyhow!("Cloud relay disconnected"))?;
        timeout(DEADLINE, result)
            .await?
            .map_err(|_| anyhow!("Cloud channel closed during peer authentication"))?
    }

    pub fn wait<F: std::future::Future>(future: F) -> F::Output {
        runtime().block_on(future)
    }
}

impl Drop for Connection {
    fn drop(&mut self) {
        if let Some((_, task)) = self.link.get_mut().take() {
            task.abort();
        }
    }
}

#[cfg(unix)]
pub async fn connect_host(config: Config, path: PathBuf) -> Result<()> {
    let config = Arc::new(config);
    let mut delay = Duration::from_millis(250);
    loop {
        let started = tokio::time::Instant::now();
        if let Ok(socket) = dial(&config, "host").await {
            let (sender, receiver) = mpsc::channel(2 * MAX_CHANNELS);
            let session = Session {
                config: config.clone(),
                path: Some(path.clone()),
                channels: HashMap::new(),
                sender: sender.downgrade(),
                next_id: 0,
            };
            let _ = drive(socket, session, receiver).await;
        }
        if started.elapsed() > Duration::from_secs(30) {
            delay = Duration::from_millis(250);
        }
        tokio::time::sleep(delay).await;
        delay = (delay * 2).min(Duration::from_secs(10));
    }
}

pub fn cli(args: &[String]) -> i32 {
    let result = match args.first().map(String::as_str) {
        Some("keygen") if args.len() == 2 => keygen(Path::new(&args[1])),
        #[cfg(unix)]
        Some("connect") => {
            let flags = crate::daemon::Args::parse(&args[1..]);
            let home = crate::daemon::home_dir(flags.get("dir"));
            let path = flags
                .get("config")
                .map(PathBuf::from)
                .unwrap_or_else(|| home.join("cloud/host.json"));
            Config::load(&path).and_then(|config| {
                Connection::wait(connect_host(config, crate::daemon::socket_path(&home)))
            })
        }
        _ => Err(anyhow!(
            "usage: hato cloud keygen <private-key-file> | connect [--dir DIR] [--config FILE]"
        )),
    };
    match result {
        Ok(()) => 0,
        Err(error) => {
            eprintln!("hato cloud: {error:#}");
            1
        }
    }
}

fn keygen(path: &Path) -> Result<()> {
    use std::io::Write;
    let keys = noise::generate()?;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut out = options.open(path).context("create private key file")?;
    writeln!(out, "{}", hex::encode(&keys.private))?;
    out.sync_all()?;
    println!("public key: {}", hex::encode(&keys.public));
    println!(
        "SHA-256 fingerprint: {}",
        crate::util::sha256_hex(&keys.public)
    );
    Ok(())
}
