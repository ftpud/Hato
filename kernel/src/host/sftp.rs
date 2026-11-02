//! Minimal SFTP v3 client speaking the real protocol over the `sftp` subsystem of an SSH channel.
//! Requests are serialized (one in flight); this is sufficient for browsing/reading files and
//! deploying small helper files.
use crate::util::{HResult, HostError};
use parking_lot::Mutex;
use std::io::{Read, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

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

struct Conn {
    child: Child,
    w: ChildStdin,
    r: ChildStdout,
    next_id: u32,
    dead: bool,
}

pub struct Sftp {
    conn: Mutex<Conn>,
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
    pub fn start(mut cmd: Command) -> HResult<Sftp> {
        cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
        let mut child = cmd.spawn().map_err(|e| HostError::new("ENOEXEC", format!("sftp subsystem: {e}")))?;
        let w = child.stdin.take().unwrap();
        let r = child.stdout.take().unwrap();
        let mut c = Conn { child, w, r, next_id: 1, dead: false };
        let mut init = Buf::new(FXP_INIT);
        init.u32(3);
        Self::send(&mut c, &init.0)?;
        let pkt = Self::recv(&mut c)?;
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
        Ok(Sftp { conn: Mutex::new(c), extensions })
    }

    fn send(c: &mut Conn, payload: &[u8]) -> HResult<()> {
        let mut out = Vec::with_capacity(payload.len() + 4);
        out.extend_from_slice(&(payload.len() as u32).to_be_bytes());
        out.extend_from_slice(payload);
        c.w.write_all(&out).and_then(|_| c.w.flush()).map_err(|e| {
            c.dead = true;
            HostError::new("ENOTCONN", format!("sftp write: {e}"))
        })
    }

    fn recv(c: &mut Conn) -> HResult<Vec<u8>> {
        let mut len = [0u8; 4];
        c.r.read_exact(&mut len).map_err(|e| {
            c.dead = true;
            HostError::new("ENOTCONN", format!("sftp read: {e}"))
        })?;
        let n = u32::from_be_bytes(len) as usize;
        if n > 8 * 1024 * 1024 {
            c.dead = true;
            return Err(HostError::new("EPROTO", "sftp packet too large"));
        }
        let mut b = vec![0u8; n];
        c.r.read_exact(&mut b).map_err(|e| {
            c.dead = true;
            HostError::new("ENOTCONN", format!("sftp read: {e}"))
        })?;
        Ok(b)
    }

    pub fn is_alive(&self) -> bool {
        let mut c = self.conn.lock();
        !c.dead && matches!(c.child.try_wait(), Ok(None))
    }

    /// Send a request and return (response type, body after request id).
    fn request(&self, t: u8, build: impl FnOnce(&mut Buf)) -> HResult<(u8, Vec<u8>)> {
        let mut c = self.conn.lock();
        if c.dead {
            return Err(HostError::new("ENOTCONN", "sftp session closed"));
        }
        let id = c.next_id;
        c.next_id = c.next_id.wrapping_add(1);
        let mut b = Buf::new(t);
        b.u32(id);
        build(&mut b);
        Self::send(&mut c, &b.0)?;
        let pkt = Self::recv(&mut c)?;
        let mut rd = Rd { b: &pkt, i: 0 };
        let rt = rd.u8()?;
        let rid = rd.u32()?;
        if rid != id {
            c.dead = true;
            return Err(HostError::new("EPROTO", "sftp response id mismatch"));
        }
        Ok((rt, pkt[5..].to_vec()))
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

    fn close(&self, handle: &[u8]) {
        let _ = self.request(FXP_CLOSE, |b| { b.bytes(handle); });
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
        let tmp = format!("{path}.hato-tmp-{}", crate::util::random_hex(4));
        let (rt, body) = self.request(FXP_OPEN, |b| { b.str(&tmp).u32(0x2 | 0x8 | 0x10).u32(ATTR_PERMISSIONS).u32(mode); })?;
        let handle = Self::status_or(rt, &body, FXP_HANDLE, |rd| Ok(rd.bytes()?.to_vec()))?;
        let mut off = 0usize;
        while off < data.len() {
            let n = (data.len() - off).min(32 * 1024);
            let chunk = &data[off..off + n];
            let (rt, body) = self.request(FXP_WRITE, |b| { b.bytes(&handle).u64(off as u64).bytes(chunk); })?;
            if let Err(e) = Self::expect_status(rt, &body) {
                self.close(&handle);
                let _ = self.request(FXP_REMOVE, |b| { b.str(&tmp); });
                return Err(e);
            }
            off += n;
        }
        self.close(&handle);
        let _ = self.request(FXP_SETSTAT, |b| { b.str(&tmp).u32(ATTR_PERMISSIONS).u32(mode); });
        let r = if self.extensions.iter().any(|e| e == "posix-rename@openssh.com") {
            let (rt, body) = self.request(FXP_EXTENDED, |b| { b.str("posix-rename@openssh.com").str(&tmp).str(path); })?;
            Self::expect_status(rt, &body)
        } else {
            let _ = self.request(FXP_REMOVE, |b| { b.str(path); });
            let (rt, body) = self.request(FXP_RENAME, |b| { b.str(&tmp).str(path); })?;
            Self::expect_status(rt, &body)
        };
        if r.is_err() {
            let _ = self.request(FXP_REMOVE, |b| { b.str(&tmp); });
        }
        r
    }

    pub fn mkdir(&self, path: &str) -> HResult<()> {
        let (rt, body) = self.request(FXP_MKDIR, |b| { b.str(path).u32(ATTR_PERMISSIONS).u32(0o700); })?;
        Self::expect_status(rt, &body)
    }
}

impl Drop for Sftp {
    fn drop(&mut self) {
        let mut c = self.conn.lock();
        let _ = c.child.kill();
        let _ = c.child.wait();
    }
}
