use anyhow::{anyhow, bail, Context, Result};
use serde::Deserialize;
use serde_json::{json, Value};
use std::time::Duration;
use tokio_tungstenite::tungstenite::http::Uri;

pub(super) fn origin(value: &str, websocket: bool) -> Result<String> {
    let uri: Uri = value.parse().context("invalid Cloud origin")?;
    let authority = uri
        .authority()
        .ok_or_else(|| anyhow!("Cloud origin needs a host"))?;
    let (secure, plain) = if websocket {
        ("wss", "ws")
    } else {
        ("https", "http")
    };
    let scheme = uri.scheme_str().unwrap_or_default();
    let host = authority.host().to_ascii_lowercase();
    if uri.path() != "/"
        || uri.query().is_some()
        || authority.as_str().contains('@')
        || !(scheme == secure || scheme == plain && matches!(host.as_str(), "127.0.0.1" | "[::1]"))
    {
        bail!("Cloud requires a secure origin, or plain HTTP/WebSocket on literal loopback");
    }
    let port = authority
        .port_u16()
        .filter(|port| *port != if scheme == secure { 443 } else { 80 });
    Ok(match port {
        Some(port) => format!("{scheme}://{host}:{port}"),
        None => format!("{scheme}://{host}"),
    })
}

fn request(
    server: &str,
    path: &str,
    credential: Option<&str>,
    body: Option<Value>,
) -> Result<(u16, Value)> {
    let headers = match credential {
        Some(token) => json!({ "Authorization": format!("Bearer {token}") }),
        None => json!({ "Content-Type": "application/json" }),
    };
    let reply = crate::host::http::fetch(&json!({
        "url": format!("{server}{path}"),
        "method": if body.is_some() { "POST" } else { "GET" },
        "headers": headers,
        "timeoutMs": 5000,
        "maxBytes": 262144,
        "body": body.map(|value| value.to_string()),
    }))
    .map_err(|error| anyhow!("Cloud HTTP request failed ({})", error.code))?;
    let status = reply["status"].as_u64().unwrap_or(0) as u16;
    let body = serde_json::from_str(reply["body"].as_str().unwrap_or_default())
        .map_err(|_| anyhow!("invalid response from Cloud (HTTP {status})"))?;
    Ok((status, body))
}

#[derive(Deserialize)]
struct DeviceKey {
    #[serde(rename = "publicKey")]
    public_key: String,
}

#[derive(Deserialize)]
struct Devices {
    devices: Vec<DeviceKey>,
}

pub(super) fn trusted_device(server: &str, token: &str, peer: &[u8]) -> Result<bool> {
    let (status, body) = request(server, "/enrol/host/devices", Some(token), None)?;
    if status != 200 {
        bail!("Cloud could not authorize the desktop device (HTTP {status})");
    }
    let list: Devices = serde_json::from_value(body).context("invalid Cloud device response")?;
    let key = hex::encode(peer);
    Ok(list.devices.iter().any(|device| device.public_key == key))
}

pub(super) fn relay_for(server: &str) -> String {
    if let Some(host) = server.strip_prefix("https://") {
        format!("wss://{host}")
    } else {
        format!("ws://{}", server.trim_start_matches("http://"))
    }
}

#[cfg(unix)]
mod unix {
    use super::*;
    use crate::daemon::{self, Args};
    use std::io::{Read, Write};
    use std::os::unix::fs::DirBuilderExt;
    use std::time::Instant;

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Credential {
        host: Host,
        host_token: String,
        relay: String,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Host {
        id: String,
        public_key: String,
        fingerprint: String,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct DeviceStart {
        device_code: String,
        user_code: String,
        verification_uri: String,
        interval: u64,
    }

    fn hostname() -> String {
        let mut name = [0u8; 256];
        if unsafe { libc::gethostname(name.as_mut_ptr().cast(), name.len()) } == 0 {
            if let Some(end) = name.iter().position(|byte| *byte == 0) {
                if let Ok(name) = std::str::from_utf8(&name[..end]) {
                    if !name.trim().is_empty() {
                        return name.trim().chars().take(120).collect();
                    }
                }
            }
        }
        "Hato host".into()
    }

    fn secret(value: &str) -> bool {
        value.len() == 43
            && value
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    }

    fn enroll_device(server: &str, registration: Value, fingerprint: &str) -> Result<Value> {
        let (status, response) = request(server, "/enrol/device", None, Some(registration))?;
        if status != 201 {
            bail!("Cloud could not start enrolment (HTTP {status})");
        }
        let start: DeviceStart =
            serde_json::from_value(response).context("invalid device enrolment response")?;
        let valid_code = start.user_code.len() == 9
            && start.user_code.bytes().enumerate().all(|(i, b)| {
                if i == 4 {
                    b == b'-'
                } else {
                    b.is_ascii_uppercase() || b.is_ascii_digit()
                }
            });
        if !secret(&start.device_code)
            || !valid_code
            || !(1..=30).contains(&start.interval)
            || start.verification_uri != format!("{server}/enrol?code={}", start.user_code)
        {
            bail!("invalid Cloud verification code or URL");
        }
        println!(
            "Device code: {}\nOpen: {}\nHost key SHA-256: {fingerprint}",
            start.user_code, start.verification_uri
        );
        std::io::stdout().flush()?;
        let expires = Instant::now() + Duration::from_secs(600);
        while Instant::now() < expires {
            std::thread::sleep(Duration::from_secs(start.interval));
            let (status, response) = request(
                server,
                "/enrol/device/poll",
                None,
                Some(json!({ "deviceCode": start.device_code })),
            )?;
            if status == 429 {
                continue;
            }
            if status != 200 {
                bail!("Cloud enrolment polling failed (HTTP {status})");
            }
            match response["status"].as_str() {
                Some("pending") => {}
                Some("approved") => return Ok(response),
                Some("denied") => bail!("Cloud enrolment was denied"),
                Some("expired") => bail!("Cloud enrolment expired"),
                _ => bail!("invalid Cloud enrolment status"),
            }
        }
        bail!("Cloud enrolment expired")
    }

    pub fn run(args: &[String]) -> Result<()> {
        let flags = Args::parse(args);
        if flags
            .flags
            .iter()
            .any(|(name, _)| !matches!(name.as_str(), "server" | "claim" | "dir" | "name"))
            || flags.bools.iter().any(|flag| flag != "replace")
            || !flags.rest.is_empty()
        {
            bail!("usage: hato cloud enroll [--server HTTPS-ORIGIN] [--claim -] [--name NAME] [--dir DIR] [--replace]");
        }
        let server = origin(
            flags
                .get("server")
                .unwrap_or("https://cloud-dev.hatopad.dev"),
            false,
        )?;
        let home = daemon::home_dir(flags.get("dir"));
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&home)?;
        let directory = home.join("cloud");
        daemon::secure_socket_dir(&directory, true)?;
        let path = directory.join("host.json");
        if path.symlink_metadata().is_ok() && !flags.has("replace") {
            bail!("a host credential already exists; use --replace to enrol a new key after revoking the old host");
        }
        let key = super::super::noise::generate()?;
        let public_key = hex::encode(&key.public);
        let fingerprint = crate::util::sha256_hex(&key.public);
        let os = match std::env::consts::OS {
            value @ ("linux" | "macos" | "windows" | "freebsd" | "openbsd" | "netbsd"
            | "dragonfly") => value,
            _ => "other",
        };
        let mut registration = json!({
            "name": flags.get("name").map(str::to_owned).unwrap_or_else(hostname),
            "os": os, "version": daemon::VERSION, "publicKey": public_key,
        });
        let response = match flags.get("claim") {
            Some("-") => {
                let mut claim = String::new();
                std::io::stdin().take(129).read_to_string(&mut claim)?;
                if !secret(claim.trim()) {
                    bail!("expected a valid single-use claim on stdin");
                }
                registration["claim"] = json!(claim.trim());
                let (status, response) =
                    request(&server, "/enrol/claim", None, Some(registration))?;
                if status != 201 {
                    bail!("Cloud claim could not be redeemed (HTTP {status})");
                }
                response
            }
            Some(_) => bail!("use --claim - and pass the claim on stdin"),
            None => enroll_device(&server, registration, &fingerprint)?,
        };
        let credential: Credential = serde_json::from_value(response)
            .map_err(|_| anyhow!("invalid Cloud host credential"))?;
        if origin(&credential.relay, true)? != relay_for(&server)
            || !secret(&credential.host_token)
            || credential.host.public_key != public_key
            || credential.host.fingerprint != fingerprint
        {
            bail!("Cloud credential does not match the enrolment origin or key");
        }
        let mut temporary = tempfile::Builder::new()
            .prefix(".host-")
            .tempfile_in(&directory)?;
        serde_json::to_writer(
            temporary.as_file_mut(),
            &json!({
                "server": server,
                "relay": credential.relay,
                "hostId": credential.host.id,
                "token": credential.host_token,
                "privateKey": hex::encode(key.private),
                "publicKey": public_key,
            }),
        )?;
        temporary.as_file().sync_all()?;
        super::super::Config::load(temporary.path())?;
        if flags.has("replace") {
            temporary.persist(&path)?;
        } else {
            temporary.persist_noclobber(&path)?;
        }
        std::fs::File::open(&directory)?.sync_all()?;
        println!(
            "Enrolled host {}\nHost key SHA-256: {fingerprint}",
            credential.host.id
        );
        Ok(())
    }
}

#[cfg(unix)]
pub(super) use unix::run;
