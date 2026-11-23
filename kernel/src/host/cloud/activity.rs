//! Activity exporter for `hato cloud connect`.
//!
//! Polls the daemon's `cloud-activity` module over the local socket and forwards changed
//! snapshots to Hato Cloud with the host credential. The module decides what is exported
//! (allowlisted metadata only); this loop only transports it, bounded in size and rate.
use serde_json::{json, Value};
use std::path::PathBuf;
use std::time::{Duration, Instant};

const POLL: Duration = Duration::from_secs(5);
/// Re-send an unchanged snapshot this often so the server can recover after its restarts.
const RESYNC: Duration = Duration::from_secs(120);
const MAX_ITEMS: usize = 300;
const MAX_BYTES: usize = 200 * 1024;

pub(super) fn spawn(home: PathBuf, server: String, token: String) {
    let _ = std::thread::Builder::new()
        .name("hato-cloud-activity".into())
        .spawn(move || run(home, server, token));
}

fn run(home: PathBuf, server: String, token: String) {
    let mut last_hash = String::new();
    let mut last_sent = Instant::now() - RESYNC;
    loop {
        if let Some(items) = snapshot(&home) {
            let body = json!({ "items": items }).to_string();
            let hash = crate::util::sha256_hex(body.as_bytes());
            let due = hash != last_hash || last_sent.elapsed() >= RESYNC;
            if body.len() <= MAX_BYTES && due && post(&server, &token, body) {
                last_hash = hash;
                last_sent = Instant::now();
            }
        }
        std::thread::sleep(POLL);
    }
}

/// `None` when the daemon or module is unavailable; the next poll retries.
fn snapshot(home: &std::path::Path) -> Option<Value> {
    let reply = crate::daemon::client::request(
        home,
        &json!({ "op": "modules.call", "args": {
            "target": "cloud-activity", "method": "snapshot", "args": {}, "timeoutMs": 10_000
        }}),
    )
    .ok()?;
    let items = reply.get("items")?.as_array()?;
    Some(Value::Array(items.iter().take(MAX_ITEMS).cloned().collect()))
}

fn post(server: &str, token: &str, body: String) -> bool {
    let reply = crate::host::http::fetch(&json!({
        "url": format!("{server}/enrol/host/activity"),
        "method": "POST",
        "headers": { "Authorization": format!("Bearer {token}"), "Content-Type": "application/json" },
        "timeoutMs": 5000,
        "maxBytes": 4096,
        "body": body,
    }));
    matches!(reply, Ok(r) if r["status"].as_u64().map(|s| (200..300).contains(&s)).unwrap_or(false))
}
