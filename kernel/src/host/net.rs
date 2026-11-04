//! Loopback-only TCP listener primitive. Accepted connections become byte streams; the listener
//! itself is a stream of JSON lines announcing accepted connection handles. Authentication of
//! peers is the responsibility of the owning module (e.g. the TS internal MCP server).
use crate::host::streams::ByteStream;
use crate::util::{HResult, HostError};
use parking_lot::Mutex;
use std::io::{Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

pub struct NetConn {
    pub stream: Arc<ByteStream>,
    sock: Mutex<TcpStream>,
    pub peer: String,
}

impl NetConn {
    pub fn write(&self, data: &[u8]) -> HResult<()> {
        let mut s = self.sock.lock();
        s.write_all(data).and_then(|_| s.flush()).map_err(|e| HostError::new("EPIPE", e.to_string()))
    }
    pub fn close(&self) { let _ = self.sock.lock().shutdown(Shutdown::Both); }
}

pub struct NetListener {
    pub port: u16,
    pub events: Arc<ByteStream>,
    closed: Arc<AtomicBool>,
}

impl NetListener {
    /// `on_accept` registers the connection in the handle table and returns its handle string.
    pub fn bind(on_accept: Arc<dyn Fn(Arc<NetConn>) -> String + Send + Sync>) -> HResult<Arc<NetListener>> {
        Self::bind_port(0, on_accept)
    }
    /// Bind 127.0.0.1 on `port` (0 = any free port). Fixed ports serve OAuth redirect URIs that a
    /// provider registered exactly.
    pub fn bind_port(port: u16, on_accept: Arc<dyn Fn(Arc<NetConn>) -> String + Send + Sync>) -> HResult<Arc<NetListener>> {
        let l = TcpListener::bind(("127.0.0.1", port)).map_err(|e| if e.kind() == std::io::ErrorKind::AddrInUse { HostError::new("EADDRINUSE", format!("port {port} is already in use")) } else { HostError::io(e) })?;
        let port = l.local_addr().map_err(HostError::io)?.port();
        let events = ByteStream::new(format!("listener:{port}"), false);
        let closed = Arc::new(AtomicBool::new(false));
        let nl = Arc::new(NetListener { port, events: events.clone(), closed: closed.clone() });
        std::thread::spawn(move || {
            for s in l.incoming() {
                if closed.load(Ordering::SeqCst) {
                    break;
                }
                let Ok(s) = s else { continue };
                let peer = s.peer_addr().map(|a| a.to_string()).unwrap_or_default();
                if !s.peer_addr().map(|a| a.ip().is_loopback()).unwrap_or(false) {
                    let _ = s.shutdown(Shutdown::Both);
                    continue;
                }
                let Ok(mut reader) = s.try_clone() else { continue };
                let stream = ByteStream::new(format!("conn:{peer}"), false);
                let conn = Arc::new(NetConn { stream: stream.clone(), sock: Mutex::new(s), peer: peer.clone() });
                let h = on_accept(conn);
                events.push(format!("{}\n", serde_json::json!({"connection": h, "peer": peer})).as_bytes());
                std::thread::spawn(move || {
                    let mut buf = vec![0u8; 32 * 1024];
                    loop {
                        match reader.read(&mut buf) {
                            Ok(0) => break,
                            Ok(n) => stream.push(&buf[..n]),
                            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                            Err(_) => break,
                        }
                    }
                    stream.finish(None);
                });
            }
        });
        Ok(nl)
    }

    pub fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
        // Wake the accept loop.
        let _ = TcpStream::connect(("127.0.0.1", self.port));
        self.events.finish(None);
    }
}
