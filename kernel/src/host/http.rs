//! Outbound HTTP primitive behind the `net.fetch` capability. HTTPS anywhere; plain HTTP only to
//! loopback (local development servers). Redirects are not followed: the module sees the 3xx and
//! must issue a new request, so every hop is validated here. Bodies are UTF-8 text with a size cap.
use crate::util::{HResult, HostError};
use serde_json::{json, Map, Value};
use std::time::Duration;

const MAX_BODY: u64 = 8 << 20;

/// Validate the URL and return "host/path" (no query or fragment) for audit records.
pub fn check_url(url: &str) -> HResult<String> {
    let uri: ureq::http::Uri = url.parse().map_err(|_| HostError::invalid("invalid URL"))?;
    let host = uri.host().ok_or_else(|| HostError::invalid("URL needs a host"))?.to_ascii_lowercase();
    match uri.scheme_str() {
        Some("https") => {}
        Some("http") if host == "127.0.0.1" || host == "localhost" || host == "[::1]" || host == "::1" => {}
        Some("http") => return Err(HostError::denied("plain http is only allowed to loopback; use https")),
        _ => return Err(HostError::invalid("URL scheme must be https")),
    }
    if uri.authority().map(|a| a.as_str().contains('@')).unwrap_or(false) {
        return Err(HostError::invalid("credentials in URLs are not allowed"));
    }
    Ok(format!("{host}{}", uri.path()))
}

pub fn fetch(args: &Value) -> HResult<Value> {
    let url = args.get("url").and_then(|u| u.as_str()).ok_or_else(|| HostError::invalid("missing url"))?;
    check_url(url)?;
    let method = args.get("method").and_then(|m| m.as_str()).unwrap_or("GET").to_ascii_uppercase();
    if !["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].contains(&method.as_str()) {
        return Err(HostError::invalid("unsupported HTTP method"));
    }
    let timeout = args.get("timeoutMs").and_then(|t| t.as_u64()).unwrap_or(30_000).clamp(1_000, 120_000);
    let limit = args.get("maxBytes").and_then(|t| t.as_u64()).unwrap_or(1 << 20).clamp(1, MAX_BODY);
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_millis(timeout)))
        .http_status_as_error(false)
        .max_redirects(0)
        .build()
        .into();
    let mut builder = ureq::http::Request::builder().method(method.as_str()).uri(url);
    if let Some(h) = args.get("headers").and_then(|h| h.as_object()) {
        for (name, value) in h {
            let v = value.as_str().ok_or_else(|| HostError::invalid("header values must be strings"))?;
            if name.eq_ignore_ascii_case("host") || name.eq_ignore_ascii_case("content-length") {
                continue;
            }
            builder = builder.header(name.as_str(), v);
        }
    }
    let body = args.get("body").and_then(|b| b.as_str()).map(|b| b.as_bytes().to_vec());
    let result = match body {
        Some(b) => agent.run(builder.body(b).map_err(|e| HostError::invalid(e.to_string()))?),
        None => agent.run(builder.body(()).map_err(|e| HostError::invalid(e.to_string()))?),
    };
    let mut resp = result.map_err(|e| match e {
        ureq::Error::Timeout(_) => HostError::new("ETIMEDOUT", "request timed out"),
        other => HostError::new("ENET", other.to_string()),
    })?;
    let mut headers = Map::new();
    for (name, value) in resp.headers() {
        let v = String::from_utf8_lossy(value.as_bytes()).into_owned();
        let key = name.as_str().to_ascii_lowercase();
        match headers.get_mut(&key) {
            Some(Value::String(prev)) => { prev.push_str(", "); prev.push_str(&v); }
            _ => { headers.insert(key, Value::String(v)); }
        }
    }
    let status = resp.status().as_u16();
    let text = if method == "HEAD" { String::new() } else {
        resp.body_mut().with_config().limit(limit).read_to_string().map_err(|e| HostError::new("ENET", format!("reading response: {e}")))?
    };
    Ok(json!({ "status": status, "headers": headers, "body": text }))
}

#[cfg(test)]
mod tests {
    use super::check_url;
    #[test]
    fn only_https_or_loopback_http() {
        assert!(check_url("https://mcp.example.com/mcp?x=1").is_ok());
        assert_eq!(check_url("https://Mcp.Example.com/a?token=secret").unwrap(), "mcp.example.com/a");
        assert!(check_url("http://127.0.0.1:8080/mcp").is_ok());
        assert!(check_url("http://localhost/mcp").is_ok());
        assert!(check_url("http://example.com/").is_err());
        assert!(check_url("file:///etc/passwd").is_err());
        assert!(check_url("https://user:pw@example.com/").is_err());
    }
}
