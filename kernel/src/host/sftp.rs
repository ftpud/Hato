//! Minimal SFTP v3 client speaking the real protocol over the `sftp` subsystem of an SSH channel.
//!
//! Requests are pipelined: any number of callers may have requests in flight on the one session,
//! and a reader thread hands each response to its caller by request id. A request therefore waits
//! for its own round trip only, not for every request queued before it (with one request in
//! flight, a burst of directory listings on project switch queued for seconds).
use crate::util::{HResult, HostError};
use parking_lot::Mutex;
use crate::host::stdio::{ProcHandle, Spawned};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;
use std::time::Duration;

/// How long a request waits for its response before the caller gets `ETIMEDOUT`.
const RESPONSE_TIMEOUT: Duration = Duration::from_secs(300);
/// Write requests in flight per upload; OpenSSH's sftp-server reads them in order.
const WRITE_WINDOW: usize = 16;
const CHUNK: usize = 32 * 1024;

const FXP_INIT: u8 = 1;
const FXP_VERSION: u8 = 2;
const FXP_OPEN: u8 = 3;
const FXP_CLOSE: u8 = 4;
const FXP_READ: u8 = 5;
const FXP_WRITE: u8 = 6;
const FXP_LSTAT: u8 = 7;
const FXP_SETSTAT: u8 = 9;
const FXP_OPENDIR: u8 = 11;
const FXP_READDIR: u8 = 12;
const FXP_REMOVE: u8 = 13;
const FXP_MKDIR: u8 = 14;
const FXP_REALPATH: u8 = 16;
const FXP_STAT: u8 = 17;
const FXP_RENAME: u8 = 18;
const FXP_STATUS: u8 = 101;
const FXP_HANDLE: u8 = 102;
const FXP_DATA: u8 = 103;
const FXP_NAME: u8 = 104;
const FXP_ATTRS: u8 = 105;
const FXP_EXTENDED: u8 = 200;

const ATTR_SIZE: u32 = 0x1;
const ATTR_UIDGID: u32 = 0x2;
const ATTR_PERMISSIONS: u32 = 0x4;
const ATTR_ACMODTIME: u32 = 0x8;
const ATTR_EXTENDED: u32 = 0x8000_0000;

#[derive(Debug, Clone, Default)]
pub struct Attrs {
    pub size: Option<u64>,
    pub perms: Option<u32>,
    pub mtime: Option<u32>,
}

impl Attrs {
    pub fn is_dir(&self) -> bool { self.perms.map(|p| p & 0o170000 == 0o040000).unwrap_or(false) }
    pub fn is_symlink(&self) -> bool { self.perms.map(|p| p & 0o170000 == 0o120000).unwrap_or(false) }
    pub fn is_file(&self) -> bool { self.perms.map(|p| p & 0o170000 == 0o100000).unwrap_or(false) }
}

type Response = (u8, Vec<u8>);
type Pending = Arc<Mutex<HashMap<u32, crossbeam_channel::Sender<Response>>>>;

pub struct Sftp {
    child: Mutex<ProcHandle>,
    /// Held only while one framed request is written, never across a round trip.
    w: Mutex<Box<dyn Write + Send>>,
    /// Callers waiting for a response, by request id. Cleared (waking them) when the session dies.
    pending: Pending,
    next_id: AtomicU32,
    dead: Arc<AtomicBool>,
    pub extensions: Vec<String>,
}

struct Buf(Vec<u8>);
impl Buf {
    fn new(t: u8) -> Self { Buf(vec![t]) }
    fn u32(&mut self, v: u32) -> &mut Self { self.0.extend_from_slice(&v.to_be_bytes()); self }
    fn u64(&mut self, v: u64) -> &mut Self { self.0.extend_from_slice(&v.to_be_bytes()); self }
    fn bytes(&mut self, b: &[u8]) -> &mut Self { self.u32(b.len() as u32); self.0.extend_from_slice(b); self }
    fn str(&mut self, s: &str) -> &mut Self { self.bytes(s.as_bytes()) }
}

struct Rd<'a> {
    b: &'a [u8],
    i: usize,
}
impl<'a> Rd<'a> {
    fn u8(&mut self) -> HResult<u8> { let v = *self.b.get(self.i).ok_or_else(short)?; self.i += 1; Ok(v) }
    fn u32(&mut self) -> HResult<u32> {
        let s = self.b.get(self.i..self.i + 4).ok_or_else(short)?;
        self.i += 4;
        Ok(u32::from_be_bytes([s[0], s[1], s[2], s[3]]))
    }
    fn u64(&mut self) -> HResult<u64> { Ok(((self.u32()? as u64) << 32) | self.u32()? as u64) }
    fn bytes(&mut self) -> HResult<&'a [u8]> {
        let n = self.u32()? as usize;
        let s = self.b.get(self.i..self.i + n).ok_or_else(short)?;
        self.i += n;
        Ok(s)
    }
    fn string(&mut self) -> HResult<String> { Ok(String::from_utf8_lossy(self.bytes()?).into_owned()) }
    fn attrs(&mut self) -> HResult<Attrs> {
        let flags = self.u32()?;
        let mut a = Attrs::default();
        if flags & ATTR_SIZE != 0 { a.size = Some(self.u64()?); }
        if flags & ATTR_UIDGID != 0 { self.u32()?; self.u32()?; }
        if flags & ATTR_PERMISSIONS != 0 { a.perms = Some(self.u32()?); }
        if flags & ATTR_ACMODTIME != 0 { self.u32()?; a.mtime = Some(self.u32()?); }
        if flags & ATTR_EXTENDED != 0 {
            let n = self.u32()?;
            for _ in 0..n { self.bytes()?; self.bytes()?; }
        }
        Ok(a)
    }
}
thread_local! {
    /// Time this thread spent waiting to write requests to an SFTP session.
    static QUEUE_WAIT: std::cell::Cell<std::time::Duration> = const { std::cell::Cell::new(std::time::Duration::ZERO) };
}

/// Queue wait accumulated by SFTP requests on this thread since the last call (ops run on their
/// own thread, so this is the wait of the current op).
pub fn take_queue_wait() -> std::time::Duration { QUEUE_WAIT.with(|w| w.replace(std::time::Duration::ZERO)) }

fn short() -> HostError { HostError::new("EPROTO", "short SFTP packet") }

fn status_err(code: u32, msg: String) -> HostError {
    let c = match code {
        2 => "ENOENT",
        3 => "EACCES",
        _ => "EIO",
    };
    HostError::new(c, format!("sftp: {msg} (status {code})"))
}

impl Sftp {
    /// Speak SFTP over a started `sftp-server` (an SSH subsystem channel or a local program).
    pub fn start(mut p: Spawned) -> HResult<Sftp> {
        let mut w = p.stdin.take().ok_or_else(|| HostError::new("EPROTO", "sftp: no input pipe"))?;
        let mut r = p.stdout.take().ok_or_else(|| HostError::new("EPROTO", "sftp: no output pipe"))?;
        // Nobody reads stderr: drain it so a chatty server cannot block on a full pipe.
        if let Some(mut e) = p.stderr.take() {
            std::thread::spawn(move || { let _ = std::io::copy(&mut e, &mut std::io::sink()); });
        }
        let mut init = Buf::new(FXP_INIT);
        init.u32(3);
        write_packet(&mut w, &init.0)?;
        let pkt = read_packet(&mut r)?;
        let mut rd = Rd { b: &pkt, i: 0 };
        if rd.u8()? != FXP_VERSION {
            return Err(HostError::new("EPROTO", "sftp: expected VERSION"));
        }
        let _ver = rd.u32()?;
        let mut extensions = Vec::new();
        while rd.i < pkt.len() {
            let name = rd.string()?;
            let _data = rd.bytes()?;
            extensions.push(name);
        }
        let pending: Pending = Default::default();
        let dead = Arc::new(AtomicBool::new(false));
        let (pending2, dead2) = (pending.clone(), dead.clone());
        std::thread::Builder::new().name("sftp-reader".into()).spawn(move || {
            // Every response starts with its type and the request id it answers.
            while let Ok(pkt) = read_packet(&mut r) {
                if pkt.len() < 5 {
                    break;
                }
                let id = u32::from_be_bytes([pkt[1], pkt[2], pkt[3], pkt[4]]);
                if let Some(tx) = pending2.lock().remove(&id) {
                    let _ = tx.send((pkt[0], pkt[5..].to_vec()));
                }
            }
            // Order matters: a caller registering after the clear sees `dead` and gives up.
            dead2.store(true, Ordering::SeqCst);
            pending2.lock().clear();
        }).map_err(|e| HostError::new("EAGAIN", format!("sftp: cannot start reader: {e}")))?;
        Ok(Sftp { child: Mutex::new(p.handle), w: Mutex::new(w), pending, next_id: AtomicU32::new(1), dead, extensions })
    }

    pub fn is_alive(&self) -> bool {
        !self.dead.load(Ordering::SeqCst) && matches!(self.child.lock().try_wait(), Ok(None))
    }

    fn closed() -> HostError { HostError::new("ENOTCONN", "sftp session closed") }

    /// Write a request; its response arrives on the returned channel.
    fn submit(&self, t: u8, build: impl FnOnce(&mut Buf)) -> HResult<crossbeam_channel::Receiver<Response>> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = crossbeam_channel::bounded(1);
        self.pending.lock().insert(id, tx);
        if self.dead.load(Ordering::SeqCst) {
            self.pending.lock().remove(&id);
            return Err(Self::closed());
        }
        let mut b = Buf::new(t);
        b.u32(id);
        build(&mut b);
        let queued = std::time::Instant::now();
        let mut w = self.w.lock();
        QUEUE_WAIT.with(|q| q.set(q.get() + queued.elapsed()));
        if let Err(e) = write_packet(&mut w, &b.0) {
            drop(w);
            self.pending.lock().remove(&id);
            self.dead.store(true, Ordering::SeqCst);
            return Err(e);
        }
        Ok(rx)
    }

    fn response(rx: crossbeam_channel::Receiver<Response>) -> HResult<Response> {
        match rx.recv_timeout(RESPONSE_TIMEOUT) {
            Ok(r) => Ok(r),
            Err(crossbeam_channel::RecvTimeoutError::Timeout) => Err(HostError::new("ETIMEDOUT", "sftp: no response from the server")),
            Err(crossbeam_channel::RecvTimeoutError::Disconnected) => Err(Self::closed()),
        }
    }

    /// Send a request and return (response type, body after request id).
    fn request(&self, t: u8, build: impl FnOnce(&mut Buf)) -> HResult<Response> {
        Self::response(self.submit(t, build)?)
    }

    fn expect_status(rt: u8, body: &[u8]) -> HResult<()> {
        if rt != FXP_STATUS {
            return Err(HostError::new("EPROTO", format!("sftp: unexpected response {rt}")));
        }
        let mut rd = Rd { b: body, i: 0 };
        let code = rd.u32()?;
        let msg = rd.string().unwrap_or_default();
        if code == 0 { Ok(()) } else { Err(status_err(code, msg)) }
    }

    fn status_or<T>(rt: u8, body: &[u8], want: u8, f: impl FnOnce(&mut Rd) -> HResult<T>) -> HResult<T> {
        if rt == want {
            let mut rd = Rd { b: body, i: 0 };
            return f(&mut rd);
        }
        if rt == FXP_STATUS {
            let mut rd = Rd { b: body, i: 0 };
            let code = rd.u32()?;
            let msg = rd.string().unwrap_or_default();
            return Err(status_err(code, msg));
        }
        Err(HostError::new("EPROTO", format!("sftp: unexpected response {rt}")))
    }

    pub fn realpath(&self, path: &str) -> HResult<String> {
        let (rt, body) = self.request(FXP_REALPATH, |b| { b.str(path); })?;
        Self::status_or(rt, &body, FXP_NAME, |rd| {
            let n = rd.u32()?;
            if n < 1 { return Err(HostError::new("EPROTO", "realpath: empty")); }
            rd.string()
        })
    }

    pub fn stat(&self, path: &str) -> HResult<Attrs> {
        let (rt, body) = self.request(FXP_STAT, |b| { b.str(path); })?;
        Self::status_or(rt, &body, FXP_ATTRS, |rd| rd.attrs())
    }

    pub fn lstat(&self, path: &str) -> HResult<Attrs> {
        let (rt, body) = self.request(FXP_LSTAT, |b| { b.str(path); })?;
        Self::status_or(rt, &body, FXP_ATTRS, |rd| rd.attrs())
    }

    /// Close without waiting: the server handles requests in order, so whatever follows on this
    /// session (a rename of the written file, say) still sees the handle closed.
    fn close(&self, handle: &[u8]) {
        let _ = self.submit(FXP_CLOSE, |b| { b.bytes(handle); });
    }

    pub fn list(&self, path: &str) -> HResult<Vec<(String, Attrs)>> {
        let (rt, body) = self.request(FXP_OPENDIR, |b| { b.str(path); })?;
        let handle = Self::status_or(rt, &body, FXP_HANDLE, |rd| Ok(rd.bytes()?.to_vec()))?;
        let mut out = Vec::new();
        loop {
            let (rt, body) = self.request(FXP_READDIR, |b| { b.bytes(&handle); })?;
            if rt == FXP_STATUS {
                let mut rd = Rd { b: &body, i: 0 };
                let code = rd.u32()?;
                if code == 1 { break; }
                self.close(&handle);
                return Err(status_err(code, rd.string().unwrap_or_default()));
            }
            let entries = Self::status_or(rt, &body, FXP_NAME, |rd| {
                let n = rd.u32()?;
                let mut v = Vec::new();
                for _ in 0..n {
                    let name = rd.string()?;
                    let _long = rd.string()?;
                    let a = rd.attrs()?;
                    v.push((name, a));
                }
                Ok(v)
            })?;
            for (n, a) in entries {
                if n != "." && n != ".." {
                    out.push((n, a));
                }
            }
            if out.len() > 20000 { break; }
        }
        self.close(&handle);
        Ok(out)
    }

    pub fn read(&self, path: &str, limit: usize) -> HResult<(Vec<u8>, bool)> {
        let (rt, body) = self.request(FXP_OPEN, |b| { b.str(path).u32(0x1).u32(0); })?;
        let handle = Self::status_or(rt, &body, FXP_HANDLE, |rd| Ok(rd.bytes()?.to_vec()))?;
        let mut out = Vec::new();
        let mut truncated = false;
        loop {
            let want = (limit + 1).saturating_sub(out.len()).min(32 * 1024) as u32;
            if want == 0 { truncated = true; break; }
            let off = out.len() as u64;
            let (rt, body) = self.request(FXP_READ, |b| { b.bytes(&handle).u64(off).u32(want); })?;
            if rt == FXP_STATUS {
                let mut rd = Rd { b: &body, i: 0 };
                let code = rd.u32()?;
                if code == 1 { break; }
                self.close(&handle);
                return Err(status_err(code, rd.string().unwrap_or_default()));
            }
            let data = Self::status_or(rt, &body, FXP_DATA, |rd| Ok(rd.bytes()?.to_vec()))?;
            if data.is_empty() { break; }
            out.extend_from_slice(&data);
            if out.len() > limit { truncated = true; out.truncate(limit); break; }
        }
        self.close(&handle);
        Ok((out, truncated))
    }

    /// Write via temp file + rename (posix-rename extension when available).
    pub fn write_atomic(&self, path: &str, data: &[u8], mode: u32) -> HResult<()> {
        self.write_atomic_with_replace(path, data, mode, true)
    }

    pub fn write_atomic_with_replace(&self, path: &str, data: &[u8], mode: u32, replace: bool) -> HResult<()> {
        let (parent, _) = path.rsplit_once('/').ok_or_else(|| HostError::invalid("missing parent directory"))?;
        let tmp = format!("{parent}/.hato-tmp-{}", crate::util::random_hex(8));
        let (rt, body) = self.request(FXP_OPEN, |b| { b.str(&tmp).u32(0x2 | 0x8 | 0x10 | 0x20).u32(ATTR_PERMISSIONS).u32(mode); })?;
        let handle = Self::status_or(rt, &body, FXP_HANDLE, |rd| Ok(rd.bytes()?.to_vec()))?;
        if let Err(e) = self.write_chunks(&handle, data) {
            self.close(&handle);
            let _ = self.request(FXP_REMOVE, |b| { b.str(&tmp); });
            return Err(e);
        }
        self.close(&handle);
        let _ = self.submit(FXP_SETSTAT, |b| { b.str(&tmp).u32(ATTR_PERMISSIONS).u32(mode); });
        let r = if replace && self.extensions.iter().any(|e| e == "posix-rename@openssh.com") {
            self.request(FXP_EXTENDED, |b| { b.str("posix-rename@openssh.com").str(&tmp).str(path); })
                .and_then(|(rt, body)| Self::expect_status(rt, &body))
        } else {
            if replace {
                let _ = self.request(FXP_REMOVE, |b| { b.str(path); });
            }
            self.request(FXP_RENAME, |b| { b.str(&tmp).str(path); })
                .and_then(|(rt, body)| Self::expect_status(rt, &body))
        };
        if r.is_err() {
            let _ = self.request(FXP_REMOVE, |b| { b.str(&tmp); });
        }
        r
    }

    /// Write `data` from offset 0 with up to `WRITE_WINDOW` requests in flight. Every response is
    /// collected before returning, so none is left for a later request to trip over.
    fn write_chunks(&self, handle: &[u8], data: &[u8]) -> HResult<()> {
        let mut inflight = std::collections::VecDeque::new();
        let mut first_err = None;
        let mut off = 0usize;
        loop {
            while first_err.is_none() && off < data.len() && inflight.len() < WRITE_WINDOW {
                let n = (data.len() - off).min(CHUNK);
                let chunk = &data[off..off + n];
                match self.submit(FXP_WRITE, |b| { b.bytes(handle).u64(off as u64).bytes(chunk); }) {
                    Ok(rx) => inflight.push_back(rx),
                    Err(e) => first_err = Some(e),
                }
                off += n;
            }
            let Some(rx) = inflight.pop_front() else { break };
            if let Err(e) = Self::response(rx).and_then(|(rt, body)| Self::expect_status(rt, &body)) {
                first_err.get_or_insert(e);
            }
        }
        first_err.map_or(Ok(()), Err)
    }

    /// `stat` of several paths with all requests in flight at once.
    pub fn stat_many(&self, paths: &[String]) -> Vec<HResult<Attrs>> {
        let sent: Vec<_> = paths.iter().map(|p| self.submit(FXP_STAT, |b| { b.str(p); })).collect();
        sent.into_iter().map(|rx| {
            let (rt, body) = Self::response(rx?)?;
            Self::status_or(rt, &body, FXP_ATTRS, |rd| rd.attrs())
        }).collect()
    }

    pub fn mkdir(&self, path: &str) -> HResult<()> {
        let (rt, body) = self.request(FXP_MKDIR, |b| { b.str(path).u32(ATTR_PERMISSIONS).u32(0o700); })?;
        Self::expect_status(rt, &body)
    }
}

impl Drop for Sftp {
    fn drop(&mut self) {
        // Ends the channel, so the reader thread sees end of input and exits.
        self.child.lock().kill();
    }
}

fn write_packet(w: &mut Box<dyn Write + Send>, payload: &[u8]) -> HResult<()> {
    let mut out = Vec::with_capacity(payload.len() + 4);
    out.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    out.extend_from_slice(payload);
    w.write_all(&out).and_then(|_| w.flush()).map_err(|e| HostError::new("ENOTCONN", format!("sftp write: {e}")))
}

fn read_packet(r: &mut Box<dyn Read + Send>) -> HResult<Vec<u8>> {
    let mut len = [0u8; 4];
    r.read_exact(&mut len).map_err(|e| HostError::new("ENOTCONN", format!("sftp read: {e}")))?;
    let n = u32::from_be_bytes(len) as usize;
    if n > 8 * 1024 * 1024 {
        return Err(HostError::new("EPROTO", "sftp packet too large"));
    }
    let mut b = vec![0u8; n];
    r.read_exact(&mut b).map_err(|e| HostError::new("ENOTCONN", format!("sftp read: {e}")))?;
    Ok(b)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    /// A session with the system's sftp-server over pipes, or `None` where there is none.
    fn session() -> Option<(Arc<Sftp>, std::path::PathBuf)> {
        let server = ["/usr/libexec/sftp-server", "/usr/lib/openssh/sftp-server", "/usr/libexec/openssh/sftp-server", "/usr/lib/ssh/sftp-server"]
            .into_iter().find(|p| std::path::Path::new(p).exists())?;
        let dir = std::env::temp_dir().join(format!("hato-sftp-{}", crate::util::random_hex(6)));
        std::fs::create_dir_all(&dir).unwrap();
        let dir = dir.canonicalize().unwrap();
        let p = Spawned::spawn(std::process::Command::new(server), "sftp-server").unwrap();
        Some((Arc::new(Sftp::start(p).unwrap()), dir))
    }

    #[test]
    fn pipelined_writes_round_trip() {
        let Some((s, dir)) = session() else { return };
        let path = format!("{}/big.bin", dir.display());
        // Several write windows' worth, with a ragged tail.
        let data: Vec<u8> = (0..(CHUNK * WRITE_WINDOW * 2 + 1234)).map(|i| (i * 31 % 251) as u8).collect();
        s.write_atomic(&path, &data, 0o640).unwrap();
        let (back, truncated) = s.read(&path, data.len() + 10).unwrap();
        assert!(!truncated);
        assert!(back == data);
        assert_eq!(s.stat(&path).unwrap().size, Some(data.len() as u64));
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1, "no temp file left behind");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn concurrent_callers_get_their_own_responses() {
        let Some((s, dir)) = session() else { return };
        for i in 0..20 {
            std::fs::write(dir.join(format!("f{i}")), format!("file {i}")).unwrap();
        }
        let threads: Vec<_> = (0..8).map(|t| {
            let (s, dir) = (s.clone(), dir.clone());
            std::thread::spawn(move || {
                for round in 0..25 {
                    let i = (t * 7 + round) % 20;
                    let path = format!("{}/f{i}", dir.display());
                    assert_eq!(s.read(&path, 1024).unwrap().0, format!("file {i}").into_bytes());
                    assert_eq!(s.list(dir.to_str().unwrap()).unwrap().len(), 20);
                    assert!(s.stat(&format!("{path}-missing")).is_err());
                }
            })
        }).collect();
        for t in threads {
            t.join().unwrap();
        }
        let paths = vec![format!("{}/f1", dir.display()), format!("{}/nope", dir.display()), format!("{}/f2", dir.display())];
        let r = s.stat_many(&paths);
        assert!(r[0].is_ok() && r[1].as_ref().is_err_and(|e| e.code == "ENOENT") && r[2].is_ok());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_closed_session_fails_requests_instead_of_hanging() {
        let Some((s, dir)) = session() else { return };
        s.child.lock().kill();
        let started = std::time::Instant::now();
        assert!(s.stat(dir.to_str().unwrap()).is_err());
        assert!(started.elapsed() < Duration::from_secs(10));
        assert!(!s.is_alive());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
