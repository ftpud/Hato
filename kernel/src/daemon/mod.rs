//! `hato daemon …`: the remote runtime (Tier 2). The same binary, without a window.
//!
//! * `serve` keeps PTYs and processes alive across SSH disconnects and hosts pushed plugins in a
//!   headless kernel. It listens on a user-only Unix socket in `<dir>/run/`.
//! * `ensure` starts it (once, under a lock) and prints `{pid, version, socket, …}`.
//! * `pty-attach` / `proc-attach` bridge a daemon-held PTY/process to this process's stdio. They
//!   run through ordinary SSH PTY/exec channels, so a dropped connection only ends the attach.
//! * `ctl` sends one JSON request (stdin) and prints the reply; `bridge` forwards stdin lines to a
//!   plugin method (so remote tools can reach plugins while the desktop is offline).
//!
//! SSH is the authentication boundary: the socket directory is 0700 and the daemon checks that
//! the peer has its own uid. The daemon knows nothing about what plugins or processes mean.
pub mod client;
pub mod server;

use std::io::{self, Read, Write};
use std::path::PathBuf;

pub const ABI: u32 = 1;
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

// Attach stream frames: [type u8][len u32 BE][payload].
pub const F_OUT: u8 = 0;
pub const F_IN: u8 = 1;
pub const F_RESIZE: u8 = 2;
pub const F_ERR: u8 = 3;
pub const F_EXIT: u8 = 4;
pub const F_DETACHED: u8 = 5;
/// Viewer → daemon: `u32` count of output frames written to its stdout/stderr. Unacknowledged
/// frames are resent to the next viewer, so output is never lost when a viewer dies mid-write.
pub const F_ACK: u8 = 6;
const MAX_FRAME: usize = 16 * 1024 * 1024;

pub fn write_frame(w: &mut impl Write, t: u8, data: &[u8]) -> io::Result<()> {
    let mut h = [0u8; 5];
    h[0] = t;
    h[1..5].copy_from_slice(&(data.len() as u32).to_be_bytes());
    w.write_all(&h)?;
    w.write_all(data)?;
    w.flush()
}

/// `Ok(None)` on a clean EOF between frames.
pub fn read_frame(r: &mut impl Read) -> io::Result<Option<(u8, Vec<u8>)>> {
    let mut h = [0u8; 5];
    let mut got = 0;
    while got < 5 {
        match r.read(&mut h[got..]) {
            Ok(0) if got == 0 => return Ok(None),
            Ok(0) => return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "truncated frame")),
            Ok(n) => got += n,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e),
        }
    }
    let len = u32::from_be_bytes([h[1], h[2], h[3], h[4]]) as usize;
    if len > MAX_FRAME {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "frame too large"));
    }
    let mut buf = vec![0u8; len];
    r.read_exact(&mut buf)?;
    Ok(Some((h[0], buf)))
}

/// Daemon home: `--dir`, `$HATO_DAEMON_DIR`, or `~/.hato`.
pub fn home_dir(arg: Option<&str>) -> PathBuf {
    if let Some(d) = arg {
        return PathBuf::from(d);
    }
    if let Ok(d) = std::env::var("HATO_DAEMON_DIR") {
        if !d.is_empty() {
            return PathBuf::from(d);
        }
    }
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("/tmp")).join(".hato")
}

pub fn run_dir(home: &std::path::Path) -> PathBuf { home.join("run") }
pub fn socket_path(home: &std::path::Path) -> PathBuf { run_dir(home).join("hatod.sock") }

/// Parse `--flag value` pairs and a trailing `-- argv…`.
pub struct Args {
    pub flags: Vec<(String, String)>,
    pub bools: Vec<String>,
    pub rest: Vec<String>,
}

impl Args {
    pub fn parse(args: &[String]) -> Args {
        let mut out = Args { flags: vec![], bools: vec![], rest: vec![] };
        let mut i = 0;
        while i < args.len() {
            let a = &args[i];
            if a == "--" {
                out.rest = args[i + 1..].to_vec();
                break;
            }
            if let Some(name) = a.strip_prefix("--") {
                match args.get(i + 1) {
                    Some(v) if !v.starts_with("--") => {
                        out.flags.push((name.to_string(), v.clone()));
                        i += 2;
                        continue;
                    }
                    _ => out.bools.push(name.to_string()),
                }
            }
            i += 1;
        }
        out
    }
    pub fn get(&self, k: &str) -> Option<&str> { self.flags.iter().rev().find(|(n, _)| n == k).map(|(_, v)| v.as_str()) }
    pub fn has(&self, k: &str) -> bool { self.bools.iter().any(|b| b == k) }
}

/// Entry point for `hato daemon <command> …`. Returns the process exit code.
pub fn main(args: &[String]) -> i32 {
    let cmd = args.first().map(|s| s.as_str()).unwrap_or("help");
    let a = Args::parse(args.get(1..).unwrap_or(&[]));
    let home = home_dir(a.get("dir"));
    let r = match cmd {
        "serve" => server::serve(&home, a.get("idle-exit-secs").and_then(|s| s.parse().ok()).unwrap_or(6 * 3600)),
        "ensure" => client::ensure(&home, a.has("force")),
        "ctl" => client::ctl(&home),
        "stop" => client::request(&home, &serde_json::json!({"op": "shutdown"})).map(|v| println!("{v}")),
        "status" => client::request(&home, &serde_json::json!({"op": "hello"})).map(|v| println!("{v}")),
        "pty-attach" => client::pty_attach(&home, &a),
        "proc-attach" => client::proc_attach(&home, &a),
        "watch" => match a.get("path") { Some(path) => crate::host::watch::run(path, !a.has("non-recursive")), None => Err(anyhow::anyhow!("missing --path")) },
        "bridge" => client::bridge(&home, &a),
        _ => {
            eprintln!("usage: hato daemon <serve|ensure|ctl|stop|status|pty-attach|proc-attach|bridge|watch> [--dir DIR] …");
            return 2;
        }
    };
    match r {
        Ok(()) => 0,
        // An attached process's own exit status is passed through silently.
        Err(e) => match e.downcast_ref::<client::ExitCode>() {
            Some(c) => c.0,
            None => {
                eprintln!("hato daemon {cmd}: {e:#}");
                1
            }
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn frames_round_trip_and_reject_oversize() {
        let mut buf = Vec::new();
        write_frame(&mut buf, F_OUT, b"hello").unwrap();
        write_frame(&mut buf, F_RESIZE, &[0, 80, 0, 24]).unwrap();
        let mut r = &buf[..];
        assert_eq!(read_frame(&mut r).unwrap(), Some((F_OUT, b"hello".to_vec())));
        assert_eq!(read_frame(&mut r).unwrap(), Some((F_RESIZE, vec![0, 80, 0, 24])));
        assert_eq!(read_frame(&mut r).unwrap(), None);
        let big = [F_OUT, 0xff, 0xff, 0xff, 0xff];
        assert!(read_frame(&mut &big[..]).is_err());
    }
    #[test]
    fn args() {
        let a = Args::parse(&["--key".into(), "k1".into(), "--force".into(), "--".into(), "sh".into(), "-c".into()]);
        assert_eq!(a.get("key"), Some("k1"));
        assert!(a.has("force"));
        assert_eq!(a.rest, vec!["sh", "-c"]);
    }
}
