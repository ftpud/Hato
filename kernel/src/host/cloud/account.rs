use super::{enrol, noise, Config, Connection};
use crate::host::{http, streams::ByteStream};
use crate::util::{sha256_hex, HResult, HostError};
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

#[derive(Serialize, Deserialize)]
struct Identity {
    private: String,
    public: String,
}

#[derive(Serialize, Deserialize)]
struct Session {
    token: String,
    device: Value,
}

pub struct Account {
    dir: PathBuf,
    origin: String,
}

impl Account {
    pub fn new(data_dir: &Path, owner: &str, origin: &str) -> HResult<Self> {
        let origin = enrol::origin(origin, false).map_err(|e| HostError::invalid(e.to_string()))?;
        let dir = data_dir.join(format!("cloud-{}", &sha256_hex(owner.as_bytes())[..24]));
        #[cfg(unix)]
        crate::daemon::secure_socket_dir(&dir, true).map_err(HostError::io)?;
        #[cfg(not(unix))]
        std::fs::create_dir_all(&dir).map_err(HostError::io)?;
        Ok(Self { dir, origin })
    }

    fn write(&self, path: &Path, data: &[u8], replace: bool) -> HResult<()> {
        let mut file = tempfile::NamedTempFile::new_in(&self.dir).map_err(HostError::io)?;
        file.write_all(data).map_err(HostError::io)?;
        file.as_file().sync_all().map_err(HostError::io)?;
        if replace {
            file.persist(path)
        } else {
            file.persist_noclobber(path)
        }
        .map(|_| ())
        .map_err(|e| HostError::io(e.error))
    }

    fn identity(&self) -> HResult<Identity> {
        let path = self.dir.join("identity.json");
        let read = || -> HResult<Identity> {
            let bytes = std::fs::read(&path).map_err(HostError::io)?;
            serde_json::from_slice(&bytes).map_err(|_| HostError::invalid("Invalid Cloud identity"))
        };
        match std::fs::metadata(&path) {
            Ok(_) => return read(),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(HostError::io(error)),
        }
        let pair = noise::generate()
            .map_err(|_| HostError::new("ECLOUD", "Could not generate a Cloud device key"))?;
        let identity = Identity {
            private: hex::encode(pair.private),
            public: hex::encode(pair.public),
        };
        let bytes = serde_json::to_vec(&identity).expect("identity serializes");
        self.write(&path, &bytes, false).or_else(|error| {
            if path.exists() {
                Ok(())
            } else {
                Err(error)
            }
        })?;
        read()
    }

    pub fn begin(&self) -> HResult<Value> {
        let identity = self.identity()?;
        let verifier = crate::util::random_hex(32);
        let challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(Sha256::digest(verifier.as_bytes()));
        Ok(json!({
            "publicKey": identity.public, "fingerprint": sha256_hex(&hex::decode(identity.public).map_err(|_| HostError::invalid("Invalid Cloud identity"))?),
            "state": crate::util::random_hex(32), "verifier": verifier, "challenge": challenge,
        }))
    }

    fn token_path(&self) -> PathBuf {
        self.dir
            .join(format!("session-{}", sha256_hex(self.origin.as_bytes())))
    }

    fn session(&self) -> HResult<Session> {
        let bytes = std::fs::read(self.token_path())
            .map_err(|_| HostError::new("ECLOUD_AUTH", "Sign in to Hato Cloud"))?;
        serde_json::from_slice(&bytes)
            .map_err(|_| HostError::new("ECLOUD_AUTH", "Cloud session is invalid"))
    }

    fn token(&self) -> HResult<String> {
        Ok(self.session()?.token)
    }

    pub fn clear(&self) -> HResult<()> {
        match std::fs::remove_file(self.token_path()) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(HostError::io(error)),
        }
    }

    fn fetch(&self, path: &str, method: &str, body: &Value, token: Option<&str>) -> HResult<Value> {
        if !path.starts_with('/')
            || path.starts_with("//")
            || path.contains(['\\', '#'])
            || path
                .bytes()
                .any(|byte| byte.is_ascii_control() || byte == b' ')
            || !matches!(path, "/auth/logout") && !path.starts_with("/api/")
        {
            return Err(HostError::invalid("Invalid Cloud API path"));
        }
        let mut headers = json!({"Content-Type": "application/json"});
        if let Some(token) = token {
            headers["Authorization"] = json!(format!("Bearer {token}"));
        }
        let response = http::fetch(&json!({
            "url": format!("{}{path}", self.origin), "method": method,
            "headers": headers, "body": if body.is_null() { None } else { Some(body.to_string()) },
            "timeoutMs": 12000, "maxBytes": 1048576,
        }))?;
        Ok(response)
    }

    pub fn request(&self, path: &str, method: &str, body: &Value) -> HResult<Value> {
        let token = self.token()?;
        self.fetch(path, method, body, Some(&token))
    }

    pub fn exchange(&self, body: &Value) -> HResult<Value> {
        let mut response = self.fetch("/api/desktop/exchange", "POST", body, None)?;
        if response["status"] != 200 {
            return Ok(response);
        }
        let mut result: Value = serde_json::from_str(response["body"].as_str().unwrap_or(""))
            .map_err(|_| HostError::invalid("Invalid Cloud sign-in response"))?;
        let token = result
            .as_object_mut()
            .and_then(|v| v.remove("token"))
            .and_then(|v| v.as_str().map(str::to_owned))
            .filter(|s| {
                s.len() == 43
                    && s.bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
            })
            .ok_or_else(|| HostError::invalid("Invalid Cloud session token"))?;
        let identity = self.identity()?;
        if result["device"]["publicKey"] != identity.public {
            return Err(HostError::denied(
                "Cloud sign-in returned another device key",
            ));
        }
        let session = Session {
            token,
            device: result["device"].clone(),
        };
        self.write(
            &self.token_path(),
            &serde_json::to_vec(&session).expect("session serializes"),
            true,
        )?;
        response["body"] = json!(result.to_string());
        Ok(response)
    }

    pub fn device(&self) -> Value {
        self.session()
            .map(|session| session.device)
            .unwrap_or(Value::Null)
    }

    pub fn connection(
        &self,
        host: &str,
        public_key: &str,
        fingerprint: &str,
    ) -> HResult<Connection> {
        if host.is_empty()
            || host.len() > 64
            || !host.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
        {
            return Err(HostError::invalid("Invalid Cloud host ID"));
        }
        let keys = noise::Keys::new(&self.identity()?.private, Some(public_key))
            .map_err(|_| HostError::invalid("Invalid Cloud host key"))?;
        if keys.peer().map(sha256_hex).as_deref() != Some(fingerprint) {
            return Err(HostError::denied(
                "Cloud host key does not match the expected fingerprint",
            ));
        }
        Ok(Connection::new(Config {
            keys,
            host_id: host.into(),
            relay: enrol::relay_for(&self.origin),
            token: self.token()?,
            server: None,
            tls: None,
            trusted: Default::default(),
        }))
    }

    pub fn events(&self) -> HResult<Arc<Events>> {
        let token = self.token()?;
        let origin = self.origin.clone();
        let stream = ByteStream::new("Cloud presence", false);
        let events = Arc::new(Events(stream.clone()));
        std::thread::spawn(move || {
            let result = watch(&origin, &token, &stream);
            stream.finish(result.err().map(str::to_owned));
        });
        Ok(events)
    }
}

pub struct Events(pub Arc<ByteStream>);
impl Drop for Events {
    fn drop(&mut self) {
        self.0.finish(None);
    }
}

fn watch(origin: &str, token: &str, stream: &ByteStream) -> Result<(), &'static str> {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_connect(Some(Duration::from_secs(8)))
        .timeout_recv_body(Some(Duration::from_secs(90)))
        .max_redirects(0)
        .http_status_as_error(false)
        .build()
        .into();
    let mut response = agent
        .get(format!("{origin}/api/stream"))
        .header("Authorization", format!("Bearer {token}"))
        .header("Accept", "text/event-stream")
        .call()
        .map_err(|_| "Cloud event stream unavailable")?;
    if response.status() == 401 {
        return Err("Cloud session expired");
    }
    if response.status() != 200 {
        return Err("Cloud event stream rejected");
    }
    let mut reader = response.body_mut().as_reader();
    let mut chunk = [0u8; 8192];
    while !stream.is_eof() {
        let n = reader
            .read(&mut chunk)
            .map_err(|_| "Cloud event stream disconnected")?;
        if n == 0 {
            break;
        }
        stream.push(&chunk[..n]);
    }
    Ok(())
}
