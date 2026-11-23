//! Opt-in integration test against the HatoCloud Node relay on the same wire as the desktop.
#![cfg(unix)]

use anyhow::{anyhow, bail, ensure, Context, Result};
use base64::Engine;
use hato_kernel::host::cloud::{Config, Connection, Kind, Program};
use serde_json::{json, Value};
use std::net::TcpListener;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

const HATO: &str = env!("CARGO_BIN_EXE_hato");
const MARKER: &str = "hato-cloud-m1-known-plaintext";

struct ChildGuard(Child);

impl Drop for ChildGuard {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn checked(command: &mut Command) -> Result<Vec<u8>> {
    let output = command
        .output()
        .with_context(|| format!("start {:?}", command.get_program()))?;
    ensure!(
        output.status.success(),
        "{:?} failed: {}",
        command.get_program(),
        String::from_utf8_lossy(&output.stderr)
    );
    Ok(output.stdout)
}

fn private_config(path: &Path, fields: Value) -> Result<()> {
    use std::io::Write;
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)?;
    f.write_all(&serde_json::to_vec(&fields)?)?;
    Ok(())
}

fn keypair() -> Result<snow::Keypair> {
    Ok(snow::Builder::new("Noise_IK_25519_ChaChaPoly_BLAKE2s".parse()?).generate_keypair()?)
}

struct Fixture {
    dir: tempfile::TempDir,
    entry: PathBuf,
    port: u16,
    host_token: String,
    client_token: String,
    admin_token: String,
    ca: String,
    host_key: snow::Keypair,
    client_key: snow::Keypair,
}

impl Fixture {
    fn new() -> Result<Self> {
        let entry = std::env::var_os("HATO_CLOUD_RELAY_FIXTURE")
            .context("set HATO_CLOUD_RELAY_FIXTURE to HatoCloud/tests/relay-fixture.ts")?;
        let dir = tempfile::tempdir()?;
        checked(Command::new("openssl").current_dir(dir.path()).args([
            "req",
            "-x509",
            "-newkey",
            "rsa:2048",
            "-nodes",
            "-days",
            "1",
            "-keyout",
            "relay.key",
            "-out",
            "relay.pem",
            "-subj",
            "/CN=127.0.0.1",
            "-addext",
            "subjectAltName=IP:127.0.0.1",
            "-addext",
            "basicConstraints=critical,CA:FALSE",
            "-addext",
            "extendedKeyUsage=serverAuth",
        ]))?;
        let der = checked(Command::new("openssl").current_dir(dir.path()).args([
            "x509",
            "-in",
            "relay.pem",
            "-outform",
            "DER",
        ]))?;
        let port = TcpListener::bind("127.0.0.1:0")?.local_addr()?.port();
        let token = || hato_kernel::util::random_hex(32);
        Ok(Self {
            dir,
            entry: entry.into(),
            port,
            host_token: token(),
            client_token: token(),
            admin_token: token(),
            ca: base64::engine::general_purpose::STANDARD.encode(der),
            host_key: keypair()?,
            client_key: keypair()?,
        })
    }

    fn config(&self, token: &str, private: &[u8], public: &[u8]) -> Value {
        json!({
            "relay": format!("wss://127.0.0.1:{}", self.port),
            "hostId": "rust-fixture",
            "token": token,
            "privateKey": hex::encode(private),
            "peerKey": hex::encode(public),
            "relayCaDer": self.ca
        })
    }

    fn client(&self, name: &str, private: &[u8], public: &[u8]) -> Result<Connection> {
        let config = self.dir.path().join(name);
        private_config(&config, self.config(&self.client_token, private, public))?;
        Ok(Connection::new(Config::load(&config)?))
    }

    async fn relay(&self) -> Result<ChildGuard> {
        let ready = self.dir.path().join("relay-ready");
        if ready.exists() {
            std::fs::remove_file(&ready)?;
        }
        let mut child = ChildGuard(
            Command::new("node")
                .arg(&self.entry)
                .arg(self.port.to_string())
                .env("HATO_CLOUD_FIXTURE_DIR", self.dir.path())
                .env("HATO_CLOUD_FIXTURE_HOST_TOKEN", &self.host_token)
                .env("HATO_CLOUD_FIXTURE_CLIENT_TOKEN", &self.client_token)
                .env("HATO_CLOUD_FIXTURE_ADMIN_TOKEN", &self.admin_token)
                .spawn()?,
        );
        let deadline = Instant::now() + Duration::from_secs(10);
        while !ready.exists() {
            if let Some(status) = child.0.try_wait()? {
                bail!("relay fixture exited: {status}");
            }
            ensure!(Instant::now() < deadline, "relay fixture did not start");
            tokio::time::sleep(Duration::from_millis(40)).await;
        }
        Ok(child)
    }

    fn host(&self) -> Result<Vec<ChildGuard>> {
        let config = self.dir.path().join("host.json");
        private_config(
            &config,
            self.config(
                &self.host_token,
                &self.host_key.private,
                &self.client_key.public,
            ),
        )?;
        if let Some(driver) = std::env::var_os("HATO_CLOUD_HOST_DRIVER") {
            return Ok(vec![ChildGuard(
                Command::new(driver)
                    .arg(self.port.to_string())
                    .arg(config)
                    .spawn()?,
            )]);
        }
        let home = self.dir.path().join("hatod");
        let daemon = ChildGuard(
            Command::new(HATO)
                .args(["daemon", "serve", "--dir"])
                .arg(&home)
                .env("HATO_CLOUD_TEST_DIR", self.dir.path())
                .stdout(Stdio::null())
                .spawn()?,
        );
        let host = ChildGuard(
            Command::new(HATO)
                .args(["cloud", "connect", "--dir"])
                .arg(&home)
                .arg("--config")
                .arg(config)
                .spawn()?,
        );
        Ok(vec![daemon, host])
    }

    fn revoke(&self) -> Result<()> {
        let endpoint = format!("https://127.0.0.1:{}/dev/revoke-host", self.port);
        let authorization = format!("Authorization: Bearer {}", self.admin_token);
        checked(
            Command::new("curl")
                .args([
                    "--max-time",
                    "5",
                    "--fail",
                    "--silent",
                    "--show-error",
                    "--cacert",
                ])
                .arg(self.dir.path().join("relay.pem"))
                .args(["-X", "POST", "-H", &authorization, &endpoint]),
        )?;
        Ok(())
    }
}

async fn hello(connection: &Connection) -> Result<Value> {
    let deadline = Instant::now() + Duration::from_secs(35);
    loop {
        match connection.request(&json!({ "op": "hello" })).await {
            Ok(status) => return Ok(status),
            Err(error) if Instant::now() >= deadline => bail!("waiting for Cloud host: {error}"),
            Err(_) => tokio::time::sleep(Duration::from_millis(100)).await,
        }
    }
}

async fn program(connection: &Connection, kind: Kind, sh: &str) -> Result<Program> {
    connection
        .program(kind, json!({ "sh": sh, "rows": 20, "columns": 80 }))
        .await
        .map_err(|e| anyhow!("{e}"))
}

async fn output(program: &Program) -> Result<Vec<u8>> {
    let mut data = Vec::new();
    loop {
        let frame = program
            .read(Duration::from_secs(5))
            .await
            .map_err(|e| anyhow!("{e}"))?;
        match frame["kind"].as_str() {
            Some("stdout") => data.extend(
                base64::engine::general_purpose::STANDARD
                    .decode(frame["base64"].as_str().unwrap())?,
            ),
            Some("exit") => {
                ensure!(frame["code"] == 0, "remote command failed: {frame}");
                return Ok(data);
            }
            Some("stderr") => {}
            _ => bail!("unexpected remote program frame: {frame}"),
        }
    }
}

async fn expect_disconnect(program: &Program) -> Result<()> {
    let frame = program.read(Duration::from_secs(5)).await;
    ensure!(
        matches!(frame, Err(ref error) if error.code == "ECLOUD"),
        "expected ECLOUD, got {frame:?}"
    );
    Ok(())
}

#[test]
#[ignore = "requires Node 24 and HATO_CLOUD_RELAY_FIXTURE from the HatoCloud repo"]
fn encrypted_relay_to_hatod() -> Result<()> {
    Connection::wait(async { tokio::time::timeout(Duration::from_secs(100), exercise()).await? })
}

async fn exercise() -> Result<()> {
    let fixture = Fixture::new()?;
    let relay = fixture.relay().await?;
    let _host = fixture.host()?;
    let client = fixture.client(
        "client.json",
        &fixture.client_key.private,
        &fixture.host_key.public,
    )?;
    let status = hello(&client).await?;
    ensure!(status["abi"] == 1);
    if std::env::var_os("HATO_CLOUD_HOST_DRIVER").is_some() {
        ensure!(
            status["os"] == "linux",
            "expected the external Linux fixture"
        );
    }

    let hello_request = json!({ "op": "hello" });
    let (exec, pty, control) = tokio::join!(
        program(
            &client,
            Kind::Exec,
            "printf 'exec-first\n'; sleep .25; printf 'exec-second\n'"
        ),
        program(
            &client,
            Kind::Pty,
            "printf 'pty-first\n'; sleep .25; printf 'pty-second\n'"
        ),
        client.request(&hello_request),
    );
    ensure!(control.map_err(|e| anyhow!("{e}"))?["abi"] == 1);
    let (exec, pty) = (exec?, pty?);
    let (exec_out, pty_out) = tokio::try_join!(output(&exec), output(&pty))?;
    ensure!(exec_out == b"exec-first\nexec-second\n");
    ensure!(String::from_utf8(pty_out)?.replace('\r', "") == "pty-first\npty-second\n");
    drop((exec, pty));

    let slow = program(
        &client,
        Kind::Exec,
        "yes Z | head -c 8388608; printf done >\"$HATO_CLOUD_TEST_DIR/slow-done\"",
    )
    .await?;
    tokio::time::sleep(Duration::from_millis(300)).await;
    let fast = program(
        &client,
        Kind::Exec,
        &format!("test ! -e \"$HATO_CLOUD_TEST_DIR/slow-done\" && printf '{MARKER}'"),
    )
    .await?;
    ensure!(
        output(&fast).await? == MARKER.as_bytes(),
        "slow channel blocked an unrelated command or drained without credit"
    );
    ensure!(
        output(&slow).await?.len() == 8_388_608,
        "slow channel lost output"
    );
    drop((fast, slow));
    ensure!(
        fixture.dir.path().join("ciphertext-seen").exists(),
        "relay did not observe encrypted application records"
    );
    ensure!(
        !fixture.dir.path().join("plaintext-seen").exists(),
        "relay saw plaintext"
    );

    let wrong_key = keypair()?;
    let wrong_host = fixture.client(
        "bad-host.json",
        &fixture.client_key.private,
        &wrong_key.public,
    )?;
    ensure!(
        wrong_host.open(Kind::Control).await.is_err(),
        "accepted an incorrect host pin"
    );
    let wrong_client = fixture.client(
        "bad-client.json",
        &wrong_key.private,
        &fixture.host_key.public,
    )?;
    ensure!(
        wrong_client.open(Kind::Control).await.is_err(),
        "accepted an unknown desktop key"
    );
    let missing = fixture.dir.path().join("unpinned.json");
    private_config(
        &missing,
        fixture.config(&fixture.client_token, &fixture.client_key.private, &[0; 32]),
    )?;
    ensure!(Config::load(&missing).is_err(), "accepted a missing pin");
    drop((wrong_host, wrong_client));

    let mutation = program(
        &client,
        Kind::Exec,
        "printf 'once\n' >>\"$HATO_CLOUD_TEST_DIR/mutations\"; printf 'applied\n'; exec sleep 30",
    )
    .await?;
    ensure!(
        mutation
            .read(Duration::from_secs(5))
            .await
            .map_err(|e| anyhow!("{e}"))?["kind"]
            == "stdout"
    );
    drop(relay);
    expect_disconnect(&mutation).await?;
    let _relay = fixture.relay().await?;
    hello(&client).await?;
    let check = program(
        &client,
        Kind::Exec,
        "cat \"$HATO_CLOUD_TEST_DIR/mutations\"",
    )
    .await?;
    ensure!(output(&check).await? == b"once\n", "mutation was replayed");
    drop((mutation, check));

    let revoked = program(&client, Kind::Exec, "exec sleep 30").await?;
    fixture.revoke()?;
    expect_disconnect(&revoked).await?;
    if client.open(Kind::Control).await.is_ok() {
        return Err(anyhow!("revoked host accepted a new channel"));
    }
    Ok(())
}

#[test]
#[ignore = "started by HatoCloud's native enrolment integration test"]
fn enrolled_connector_exchange() -> Result<()> {
    let configuration = |name| -> Result<Connection> {
        let file = std::env::var_os(name).with_context(|| format!("missing {name}"))?;
        Ok(Connection::new(Config::load(Path::new(&file))?))
    };
    let client = configuration("HATO_CLOUD_M2_CLIENT")?;
    let unregistered = configuration("HATO_CLOUD_M2_UNKNOWN_KEY")?;
    Connection::wait(async {
        let status = hello(&client).await?;
        ensure!(status["abi"] == 1);
        if let Ok(os) = std::env::var("HATO_CLOUD_M2_EXPECT_OS") {
            ensure!(status["os"] == os, "unexpected enrolled connector platform");
        }
        let run = program(&client, Kind::Exec, "printf m2-enrolled").await?;
        ensure!(output(&run).await? == b"m2-enrolled");
        ensure!(
            unregistered.open(Kind::Control).await.is_err(),
            "host accepted an unregistered key"
        );
        Ok(())
    })
}
