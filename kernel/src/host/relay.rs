//! Loopback relay over a byte stream, for hosts that share no loopback with the desktop.
//!
//! WSL2 cannot reach Windows' 127.0.0.1 under NAT networking, so `ssh -R` semantics are provided
//! by `hato daemon forward` running in Linux: it listens on Linux 127.0.0.1 and multiplexes the
//! connections over its stdio to the desktop, which dials the module's loopback listener. Ending
//! the process (closing its stdin) ends the forward.
use crate::daemon::{read_frame, write_frame};
use parking_lot::Mutex;
use std::collections::HashMap;
use std::io::{self, Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::sync::Arc;

const R_PORT: u8 = 16;
const R_OPEN: u8 = 17;
const R_DATA: u8 = 18;
const R_CLOSE: u8 = 19;

type Conns = Arc<Mutex<HashMap<u32, TcpStream>>>;
type Out = Arc<Mutex<Box<dyn Write + Send>>>;

fn id_frame(id: u32, data: &[u8]) -> Vec<u8> {
    let mut v = Vec::with_capacity(4 + data.len());
    v.extend_from_slice(&id.to_be_bytes());
    v.extend_from_slice(data);
    v
}

fn split_id(data: &[u8]) -> Option<(u32, &[u8])> {
    let (id, rest) = data.split_first_chunk::<4>()?;
    Some((u32::from_be_bytes(*id), rest))
}

/// Socket → frames, until either side closes.
fn pump_socket(id: u32, mut sock: TcpStream, conns: Conns, out: Out) {
    std::thread::spawn(move || {
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            match sock.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if write_frame(&mut *out.lock(), R_DATA, &id_frame(id, &buf[..n])).is_err() {
                        break;
                    }
                }
            }
        }
        if conns.lock().remove(&id).is_some() {
            let _ = write_frame(&mut *out.lock(), R_CLOSE, &id_frame(id, &[]));
        }
    });
}

/// Handle DATA/CLOSE, and OPEN through `on_open`. Returns at EOF.
fn run_frames(mut input: &mut dyn Read, conns: &Conns, out: &Out, on_open: &dyn Fn(u32) -> io::Result<TcpStream>) -> io::Result<()> {
    while let Some((t, data)) = read_frame(&mut input)? {
        let Some((id, rest)) = split_id(&data) else { continue };
        match t {
            R_OPEN => match on_open(id) {
                Ok(sock) => {
                    conns.lock().insert(id, sock.try_clone()?);
                    pump_socket(id, sock, conns.clone(), out.clone());
                }
                Err(_) => { let _ = write_frame(&mut *out.lock(), R_CLOSE, &id_frame(id, &[])); }
            },
            R_DATA => {
                let sock = conns.lock().get(&id).and_then(|s| s.try_clone().ok());
                if let Some(mut s) = sock {
                    if s.write_all(rest).is_err() {
                        let _ = s.shutdown(Shutdown::Both);
                    }
                }
            }
            R_CLOSE => {
                if let Some(s) = conns.lock().remove(&id) {
                    let _ = s.shutdown(Shutdown::Both);
                }
            }
            _ => {}
        }
    }
    for s in conns.lock().values() {
        let _ = s.shutdown(Shutdown::Both);
    }
    Ok(())
}

/// Linux side: listen, announce the port, multiplex accepted connections until `input` ends.
pub fn serve(mut input: Box<dyn Read + Send>, output: Box<dyn Write + Send>) -> io::Result<()> {
    let listener = TcpListener::bind(("127.0.0.1", 0))?;
    let port = listener.local_addr()?.port();
    let out: Out = Arc::new(Mutex::new(output));
    write_frame(&mut *out.lock(), R_PORT, &port.to_be_bytes())?;
    let conns: Conns = Default::default();
    {
        let (conns, out) = (conns.clone(), out.clone());
        std::thread::spawn(move || {
            let mut next = 0u32;
            for sock in listener.incoming().flatten() {
                next = next.wrapping_add(1);
                let Ok(clone) = sock.try_clone() else { continue };
                conns.lock().insert(next, clone);
                if write_frame(&mut *out.lock(), R_OPEN, &id_frame(next, &[])).is_err() {
                    return;
                }
                pump_socket(next, sock, conns.clone(), out.clone());
            }
        });
    }
    run_frames(&mut input, &conns, &out, &|_| Err(io::ErrorKind::Unsupported.into()))
}

/// `hato daemon forward`: the relay on this process's stdio. Exits when the desktop goes away.
pub fn serve_stdio() -> anyhow::Result<()> {
    serve(Box::new(io::stdin()), Box::new(io::stdout()))?;
    Ok(())
}

/// Desktop side: wait for the far port, then dial `local_port` per connection in the background.
pub fn connect(mut input: Box<dyn Read + Send>, output: Box<dyn Write + Send>, local_port: u16) -> io::Result<u16> {
    let port = match read_frame(&mut input)? {
        Some((R_PORT, d)) if d.len() == 2 => u16::from_be_bytes([d[0], d[1]]),
        _ => return Err(io::Error::new(io::ErrorKind::InvalidData, "relay did not announce a port")),
    };
    let out: Out = Arc::new(Mutex::new(output));
    std::thread::spawn(move || {
        let conns: Conns = Default::default();
        let _ = run_frames(&mut input, &conns, &out, &|_| TcpStream::connect(("127.0.0.1", local_port)));
    });
    Ok(port)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// In-process stdio stand-in: a connected socket pair.
    fn pipe() -> (TcpStream, TcpStream) {
        let l = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let a = TcpStream::connect(l.local_addr().unwrap()).unwrap();
        (a, l.accept().unwrap().0)
    }

    #[test]
    fn relays_concurrent_connections_both_ways() {
        // The module's loopback service: uppercases what it reads.
        let service = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let local_port = service.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for mut s in service.incoming().flatten() {
                std::thread::spawn(move || {
                    let mut b = [0u8; 256];
                    while let Ok(n) = s.read(&mut b) {
                        if n == 0 { break; }
                        s.write_all(&b[..n].to_ascii_uppercase()).unwrap();
                    }
                });
            }
        });
        let (near, far) = pipe();
        let far_out = far.try_clone().unwrap();
        std::thread::spawn(move || { let _ = serve(Box::new(far), Box::new(far_out)); });
        let near_out = near.try_clone().unwrap();
        let port = connect(Box::new(near), Box::new(near_out), local_port).unwrap();

        let mut clients: Vec<TcpStream> = (0..3).map(|_| TcpStream::connect(("127.0.0.1", port)).unwrap()).collect();
        for (i, c) in clients.iter_mut().enumerate() {
            c.write_all(format!("hello {i}").as_bytes()).unwrap();
        }
        for (i, c) in clients.iter_mut().enumerate() {
            let mut b = vec![0u8; 7];
            c.read_exact(&mut b).unwrap();
            assert_eq!(String::from_utf8(b).unwrap(), format!("HELLO {i}"));
        }
    }

    #[test]
    fn listener_ends_when_the_desktop_goes_away() {
        let (near, far) = pipe();
        let far_out = far.try_clone().unwrap();
        let t = std::thread::spawn(move || serve(Box::new(far), Box::new(far_out)));
        let mut r = near.try_clone().unwrap();
        assert_eq!(read_frame(&mut r).unwrap().unwrap().0, R_PORT);
        near.shutdown(Shutdown::Both).unwrap();
        t.join().unwrap().unwrap();
    }
}
