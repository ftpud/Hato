//! Outbound WebSocket client primitive behind the `net.websocket` capability. `wss://` anywhere,
//! plain `ws://` only to loopback (local devtools ports, SSH local forwards). Incoming messages are
//! framed as one JSON object per line on a byte stream: `{"t": text}` or `{"b": base64}`; the
//! stream ends when the peer closes. Message meaning (any protocol) belongs to the owning module.
use crate::host::streams::ByteStream;
use crate::util::{HResult, HostError};
use base64::Engine;
use futures::{SinkExt, StreamExt};
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::sync::OnceLock;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::{client::IntoClientRequest, http, protocol::WebSocketConfig, Message};

/// Largest single message in either direction (full-page screenshots arrive as one message).
const MAX_MESSAGE: usize = 64 << 20;

fn runtime() -> &'static tokio::runtime::Runtime {
    static RUNTIME: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
    RUNTIME.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().thread_name("hato-ws").build().expect("websocket runtime")
    })
}

pub struct WebSocketConn {
    pub stream: Arc<ByteStream>,
    pub url: String,
    tx: Mutex<Option<mpsc::UnboundedSender<Message>>>,
}

impl WebSocketConn {
    pub fn send_text(&self, text: String) -> HResult<()> {
        if text.len() > MAX_MESSAGE { return Err(HostError::new("E2BIG", "message too large")); }
        let tx = self.tx.lock();
        let tx = tx.as_ref().ok_or_else(|| HostError::new("EPIPE", "websocket is closed"))?;
        tx.send(Message::text(text)).map_err(|_| HostError::new("EPIPE", "websocket is closed"))
    }
    pub fn close(&self) {
        if let Some(tx) = self.tx.lock().take() { let _ = tx.send(Message::Close(None)); }
    }
}

impl Drop for WebSocketConn {
    fn drop(&mut self) { self.close(); }
}

/// Validate the URL and return "host:port/path" (no query) for audit records.
pub fn check_url(url: &str) -> HResult<String> {
    let uri: http::Uri = url.parse().map_err(|_| HostError::invalid("invalid URL"))?;
    let host = uri.host().ok_or_else(|| HostError::invalid("URL needs a host"))?.to_ascii_lowercase();
    match uri.scheme_str() {
        Some("wss") => {}
        Some("ws") if host == "127.0.0.1" || host == "localhost" || host == "[::1]" || host == "::1" => {}
        Some("ws") => return Err(HostError::denied("plain ws is only allowed to loopback; use wss")),
        _ => return Err(HostError::invalid("URL scheme must be ws or wss")),
    }
    if uri.authority().map(|a| a.as_str().contains('@')).unwrap_or(false) {
        return Err(HostError::invalid("credentials in URLs are not allowed"));
    }
    Ok(format!("{host}{}{}", uri.port_u16().map(|p| format!(":{p}")).unwrap_or_default(), uri.path()))
}

fn frame(message: Message) -> Option<Vec<u8>> {
    let value = match message {
        Message::Text(text) => json!({"t": text.as_str()}),
        Message::Binary(bytes) => json!({"b": base64::engine::general_purpose::STANDARD.encode(&bytes)}),
        _ => return None,
    };
    let mut line = serde_json::to_vec(&value).ok()?;
    line.push(b'\n');
    Some(line)
}

pub fn connect(args: &Value) -> HResult<Arc<WebSocketConn>> {
    let url = args.get("url").and_then(|u| u.as_str()).ok_or_else(|| HostError::invalid("missing url"))?;
    check_url(url)?;
    let timeout = Duration::from_millis(args.get("timeoutMs").and_then(|t| t.as_u64()).unwrap_or(15_000).clamp(1_000, 60_000));
    let mut request = url.into_client_request().map_err(|e| HostError::invalid(e.to_string()))?;
    if let Some(headers) = args.get("headers").and_then(|h| h.as_object()) {
        for (name, value) in headers {
            let value = value.as_str().ok_or_else(|| HostError::invalid("header values must be strings"))?;
            let lower = name.to_ascii_lowercase();
            if ["host", "connection", "upgrade", "content-length"].contains(&lower.as_str()) || lower.starts_with("sec-websocket-") { continue; }
            let name = http::HeaderName::from_bytes(name.as_bytes()).map_err(|_| HostError::invalid("invalid header name"))?;
            let value = http::HeaderValue::from_str(value).map_err(|_| HostError::invalid("invalid header value"))?;
            request.headers_mut().insert(name, value);
        }
    }
    let limits = WebSocketConfig::default().max_message_size(Some(MAX_MESSAGE)).max_frame_size(Some(MAX_MESSAGE));
    let socket = runtime().block_on(async move {
        tokio::time::timeout(timeout, tokio_tungstenite::connect_async_with_config(request, Some(limits), true)).await
    })
    .map_err(|_| HostError::new("ETIMEDOUT", "websocket connect timed out"))?
    .map_err(|e| match e {
        tokio_tungstenite::tungstenite::Error::Http(reply) => HostError::new("ENET", format!("websocket rejected ({})", reply.status())),
        other => HostError::new("ENET", other.to_string()),
    })?
    .0;
    let stream = ByteStream::new(format!("websocket:{}", check_url(url).unwrap_or_default()), false);
    let (tx, mut rx) = mpsc::unbounded_channel::<Message>();
    let conn = Arc::new(WebSocketConn { stream: stream.clone(), url: url.to_string(), tx: Mutex::new(Some(tx)) });
    let (mut sink, mut source) = socket.split();
    runtime().spawn(async move {
        while let Some(message) = rx.recv().await {
            let closing = matches!(message, Message::Close(_));
            if sink.send(message).await.is_err() || closing { break; }
        }
        let _ = sink.close().await;
    });
    runtime().spawn(async move {
        let mut error = None;
        while let Some(message) = source.next().await {
            match message {
                Ok(Message::Close(_)) => break,
                Ok(message) => {
                    if let Some(line) = frame(message) {
                        // ByteStream::push blocks for backpressure; keep it off the async workers.
                        let s = stream.clone();
                        if tokio::task::spawn_blocking(move || s.push(&line)).await.is_err() { break; }
                    }
                }
                Err(e) => { error = Some(e.to_string()); break; }
            }
        }
        stream.finish(error);
    });
    Ok(conn)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_wss_or_loopback_ws() {
        assert!(check_url("wss://example.com/devtools").is_ok());
        assert_eq!(check_url("ws://127.0.0.1:9222/devtools/browser/x").unwrap(), "127.0.0.1:9222/devtools/browser/x");
        assert!(check_url("ws://localhost:1/x").is_ok());
        assert!(check_url("ws://example.com/x").is_err());
        assert!(check_url("https://example.com").is_err());
        assert!(check_url("wss://user:pw@example.com/").is_err());
    }
    #[test]
    fn frames_are_single_json_lines() {
        let line = frame(Message::text("a\nb")).unwrap();
        assert_eq!(line.iter().filter(|b| **b == b'\n').count(), 1);
        let v: Value = serde_json::from_slice(&line).unwrap();
        assert_eq!(v["t"], "a\nb");
        let v: Value = serde_json::from_slice(&frame(Message::binary(vec![1u8, 2])).unwrap()).unwrap();
        assert_eq!(v["b"], "AQI=");
        assert!(frame(Message::Ping(Default::default())).is_none());
    }
}
