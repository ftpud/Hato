//! Small helpers shared by the kernel.
use rand::RngCore;
use serde_json::Value;

pub fn random_hex(bytes: usize) -> String {
    let mut b = vec![0u8; bytes];
    rand::thread_rng().fill_bytes(&mut b);
    hex::encode(b)
}

pub fn uuid_v4() -> String {
    let mut b = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut b);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h = hex::encode(b);
    format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32])
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

pub fn now_iso() -> String {
    // RFC3339-ish UTC timestamp without external deps.
    let ms = now_ms();
    let secs = (ms / 1000) as i64;
    let (y, mo, d, h, mi, s) = civil_from_unix(secs);
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{mi:02}:{s:02}.{:03}Z", ms % 1000)
}

fn civil_from_unix(t: i64) -> (i64, u32, u32, u32, u32, u32) {
    let days = t.div_euclid(86400);
    let rem = t.rem_euclid(86400);
    let (h, mi, s) = ((rem / 3600) as u32, ((rem % 3600) / 60) as u32, (rem % 60) as u32);
    let z = days + 719468;
    let era = z.div_euclid(146097);
    let doe = z.rem_euclid(146097);
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d, h, mi, s)
}

pub fn sha256_hex(data: &[u8]) -> String {
    use sha2::Digest;
    hex::encode(sha2::Sha256::digest(data))
}

/// Structured error passed back to JS. `code` is stable and machine readable.
#[derive(Debug, Clone)]
pub struct HostError {
    pub code: String,
    pub message: String,
}

impl HostError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        HostError { code: code.to_string(), message: message.into() }
    }
    pub fn denied(message: impl Into<String>) -> Self { Self::new("EPERM", message) }
    pub fn invalid(message: impl Into<String>) -> Self { Self::new("EINVAL", message) }
    pub fn not_found(message: impl Into<String>) -> Self { Self::new("ENOENT", message) }
    pub fn io(e: impl std::fmt::Display) -> Self { Self::new("EIO", e.to_string()) }
    pub fn to_json(&self) -> Value { serde_json::json!({"code": self.code, "message": self.message}) }
}

impl std::fmt::Display for HostError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { write!(f, "{}: {}", self.code, self.message) }
}

impl From<anyhow::Error> for HostError {
    fn from(e: anyhow::Error) -> Self { HostError::new("EIO", format!("{e:#}")) }
}
impl From<std::io::Error> for HostError {
    fn from(e: std::io::Error) -> Self {
        let code = match e.kind() {
            std::io::ErrorKind::NotFound => "ENOENT",
            std::io::ErrorKind::PermissionDenied => "EACCES",
            _ => "EIO",
        };
        HostError::new(code, e.to_string())
    }
}

pub type HResult<T> = Result<T, HostError>;

pub fn arg_str<'a>(v: &'a Value, k: &str) -> HResult<&'a str> {
    v.get(k).and_then(|x| x.as_str()).ok_or_else(|| HostError::invalid(format!("missing string argument '{k}'")))
}
pub fn arg_opt_str<'a>(v: &'a Value, k: &str) -> Option<&'a str> { v.get(k).and_then(|x| x.as_str()) }
pub fn arg_u64(v: &Value, k: &str) -> HResult<u64> {
    v.get(k).and_then(|x| x.as_u64()).ok_or_else(|| HostError::invalid(format!("missing integer argument '{k}'")))
}

/// Redact obvious secrets from log lines.
pub fn redact(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let lower = s.to_lowercase();
    let keys = ["token", "secret", "password", "api_key", "apikey", "authorization"];
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < s.len() {
        let mut matched = None;
        for k in keys {
            if lower[i..].starts_with(k) {
                matched = Some(k.len());
                break;
            }
        }
        if let Some(klen) = matched {
            out.push_str(&s[i..i + klen]);
            i += klen;
            // copy separator chars
            while i < s.len() && matches!(bytes[i], b'"' | b'\'' | b':' | b'=' | b' ') {
                out.push(bytes[i] as char);
                i += 1;
            }
            let start = i;
            while i < s.len() && !matches!(bytes[i], b'"' | b'\'' | b' ' | b',' | b'}' | b'\n' | b'&') {
                i += 1;
            }
            if i > start {
                out.push_str("[REDACTED]");
            }
        } else {
            let ch = s[i..].chars().next().unwrap();
            out.push(ch);
            i += ch.len_utf8();
        }
    }
    out
}

/// Split a byte buffer at the last complete UTF-8 boundary. Returns (decoded text, leftover bytes).
pub fn utf8_split(buf: &[u8]) -> (String, Vec<u8>) {
    match std::str::from_utf8(buf) {
        Ok(s) => (s.to_string(), Vec::new()),
        Err(e) => {
            if e.error_len().is_none() {
                let valid = e.valid_up_to();
                (String::from_utf8_lossy(&buf[..valid]).into_owned(), buf[valid..].to_vec())
            } else {
                // Invalid sequence in the middle: decode lossily but keep a possibly incomplete tail.
                let tail_start = buf.len().saturating_sub(3);
                let tail = &buf[tail_start..];
                let keep = match std::str::from_utf8(tail) {
                    Err(t) if t.error_len().is_none() => tail.len() - t.valid_up_to(),
                    _ => 0,
                };
                let cut = buf.len() - keep;
                (String::from_utf8_lossy(&buf[..cut]).into_owned(), buf[cut..].to_vec())
            }
        }
    }
}

/// A child process command. A Windows GUI app would otherwise flash a console for each child.
pub fn command(program: impl AsRef<std::ffi::OsStr>) -> std::process::Command {
    #[allow(unused_mut)]
    let mut c = std::process::Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        c.creation_flags(CREATE_NO_WINDOW);
    }
    c
}

/// Absolute path of a Windows system tool.
#[cfg(windows)]
pub fn system32(tool: &str) -> String {
    let root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
    format!(r"{root}\System32\{tool}")
}

/// Canonical path as the kernel's scope checks compare it: symlinks resolved and, on Windows,
/// `/`-separated without the `\\?\` prefix (`C:/x`, `//server/share/x`).
pub fn canonical_string(p: &std::path::Path) -> std::io::Result<String> {
    let real = std::fs::canonicalize(p)?.to_string_lossy().into_owned();
    Ok(if cfg!(windows) { plain_windows_path(&real) } else { real })
}

#[cfg_attr(not(windows), allow(dead_code))]
fn plain_windows_path(p: &str) -> String {
    let plain = match (p.strip_prefix(r"\\?\UNC\"), p.strip_prefix(r"\\?\")) {
        (Some(unc), _) => format!(r"\\{unc}"),
        (None, Some(local)) => local.to_string(),
        (None, None) => p.to_string(),
    };
    plain.replace('\\', "/")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn plain_windows_paths() {
        assert_eq!(plain_windows_path(r"\\?\C:\Users\me\My Project"), "C:/Users/me/My Project");
        assert_eq!(plain_windows_path(r"\\?\UNC\wsl.localhost\Ubuntu\home"), "//wsl.localhost/Ubuntu/home");
        assert_eq!(plain_windows_path(r"C:\x"), "C:/x");
    }
    #[test]
    fn redacts() {
        assert_eq!(redact("token=abc123 ok"), "token=[REDACTED] ok");
        assert_eq!(redact(r#"{"HATO_MCP_TOKEN":"xyz"}"#), r#"{"HATO_MCP_TOKEN":"[REDACTED]"}"#);
    }
    #[test]
    fn utf8_boundaries() {
        let s = "héllo".as_bytes();
        let (a, rest) = utf8_split(&s[..2]);
        assert_eq!(a, "h");
        assert_eq!(rest, vec![0xc3]);
    }
    #[test]
    fn iso() { assert!(now_iso().ends_with('Z')); }
}
