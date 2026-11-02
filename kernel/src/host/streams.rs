//! Bounded byte streams with credit-based backpressure.
//!
//! Producers (process stdout readers, sockets) push bytes; a single subscriber (keyed by logical
//! module, so a new generation can take over) receives coalesced chunks and acknowledges them.
//! While unacknowledged bytes exceed the high-water mark, delivery pauses; while the internal
//! buffer is full, the producer blocks (which in turn applies backpressure to the child process).
//! Lossy streams (stderr) keep only the most recent bytes instead of blocking.
use crate::js::worker::WorkerMsg;
use crate::util::utf8_split;
use base64::Engine;
use crossbeam_channel::Sender;
use parking_lot::{Condvar, Mutex};
use std::collections::VecDeque;
use std::sync::Arc;

const CHUNK: usize = 64 * 1024;
const BUFFER_CAP: usize = 4 * 1024 * 1024;
const LOSSY_CAP: usize = 256 * 1024;

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Encoding {
    Utf8,
    Base64,
}

pub struct Subscriber {
    pub sub_id: String,
    pub module_id: String,
    pub gen_id: u64,
    pub encoding: Encoding,
    pub hwm: usize,
    pub tx: Sender<WorkerMsg>,
    pub paused: bool,
}

struct Inner {
    buf: VecDeque<u8>,
    eof: bool,
    error: Option<String>,
    eof_delivered: bool,
    sub: Option<Subscriber>,
    unacked: usize,
    total_in: u64,
    dropped: u64,
}

pub struct ByteStream {
    inner: Mutex<Inner>,
    space: Condvar,
    pub lossy: bool,
    pub label: String,
    /// Optional observer invoked on every push (used for native consumers such as terminals).
    pub tap: Mutex<Option<Arc<dyn Fn(&[u8]) + Send + Sync>>>,
}

impl ByteStream {
    pub fn new(label: impl Into<String>, lossy: bool) -> Arc<Self> {
        Arc::new(ByteStream {
            inner: Mutex::new(Inner {
                buf: VecDeque::new(),
                eof: false,
                error: None,
                eof_delivered: false,
                sub: None,
                unacked: 0,
                total_in: 0,
                dropped: 0,
            }),
            space: Condvar::new(),
            lossy,
            label: label.into(),
            tap: Mutex::new(None),
        })
    }

    /// Producer side. Blocks while the buffer is full (non-lossy streams).
    pub fn push(&self, data: &[u8]) {
        if let Some(t) = self.tap.lock().clone() {
            t(data);
        }
        let mut g = self.inner.lock();
        g.total_in += data.len() as u64;
        if self.lossy {
            g.buf.extend(data.iter().copied());
            while g.buf.len() > LOSSY_CAP {
                g.buf.pop_front();
                g.dropped += 1;
            }
        } else {
            let mut off = 0;
            while off < data.len() {
                while g.buf.len() >= BUFFER_CAP && !g.eof {
                    self.space.wait(&mut g);
                }
                let n = (BUFFER_CAP - g.buf.len().min(BUFFER_CAP)).min(data.len() - off).max(1);
                g.buf.extend(data[off..off + n].iter().copied());
                off += n;
                Self::pump_locked(&mut g);
            }
        }
        Self::pump_locked(&mut g);
    }

    pub fn finish(&self, error: Option<String>) {
        let mut g = self.inner.lock();
        g.eof = true;
        if g.error.is_none() {
            g.error = error;
        }
        Self::pump_locked(&mut g);
        self.space.notify_all();
    }

    pub fn is_eof(&self) -> bool { self.inner.lock().eof }

    pub fn stats(&self) -> (u64, usize, u64) {
        let g = self.inner.lock();
        (g.total_in, g.buf.len(), g.dropped)
    }

    /// Install or replace the subscriber. A subscription from the same logical module replaces the
    /// previous generation's subscription (hand-over during hot swap). Another module is refused.
    pub fn subscribe(&self, sub: Subscriber) -> Result<(), String> {
        let mut g = self.inner.lock();
        if let Some(cur) = &g.sub {
            if cur.module_id != sub.module_id {
                return Err(format!("stream already subscribed by module '{}'", cur.module_id));
            }
        }
        g.unacked = 0;
        g.sub = Some(sub);
        Self::pump_locked(&mut g);
        Ok(())
    }

    pub fn unsubscribe(&self, sub_id: &str) -> bool {
        let mut g = self.inner.lock();
        if g.sub.as_ref().map(|s| s.sub_id == sub_id).unwrap_or(false) {
            g.sub = None;
            g.unacked = 0;
            return true;
        }
        false
    }

    pub fn unsubscribe_gen(&self, gen_id: u64) {
        let mut g = self.inner.lock();
        if g.sub.as_ref().map(|s| s.gen_id == gen_id).unwrap_or(false) {
            g.sub = None;
            g.unacked = 0;
        }
    }

    pub fn set_paused_for_module(&self, module_id: &str, paused: bool) {
        let mut g = self.inner.lock();
        if let Some(s) = g.sub.as_mut() {
            if s.module_id == module_id {
                s.paused = paused;
            }
        }
        Self::pump_locked(&mut g);
    }

    pub fn ack(&self, sub_id: &str, n: usize) {
        let mut g = self.inner.lock();
        if g.sub.as_ref().map(|s| s.sub_id == sub_id).unwrap_or(false) {
            g.unacked = g.unacked.saturating_sub(n);
            Self::pump_locked(&mut g);
        }
    }

    pub fn subscriber_id(&self) -> Option<String> { self.inner.lock().sub.as_ref().map(|s| s.sub_id.clone()) }

    /// Drain buffered bytes synchronously (used by `process.run` collectors).
    pub fn take_all(&self) -> Vec<u8> {
        let mut g = self.inner.lock();
        let v: Vec<u8> = g.buf.drain(..).collect();
        self.space.notify_all();
        v
    }

    fn pump_locked(g: &mut Inner) {
        loop {
            let Some(sub) = g.sub.as_ref() else { return };
            if sub.paused {
                return;
            }
            if !g.buf.is_empty() && g.unacked < sub.hwm {
                let n = g.buf.len().min(CHUNK);
                let bytes: Vec<u8> = g.buf.drain(..n).collect();
                let (data, consumed) = match sub.encoding {
                    Encoding::Utf8 => {
                        let (text, rest) = utf8_split(&bytes);
                        // Put back an incomplete trailing sequence unless the stream ended.
                        if !rest.is_empty() && !(g.eof && g.buf.is_empty()) {
                            for b in rest.iter().rev() {
                                g.buf.push_front(*b);
                            }
                            if text.is_empty() {
                                return;
                            }
                            (text, n - rest.len())
                        } else if !rest.is_empty() {
                            (format!("{text}{}", String::from_utf8_lossy(&rest)), n)
                        } else {
                            (text, n)
                        }
                    }
                    Encoding::Base64 => (base64::engine::general_purpose::STANDARD.encode(&bytes), n),
                };
                g.unacked += consumed;
                let msg = WorkerMsg::Stream { sub_id: sub.sub_id.clone(), data: Some(data), eof: false, nbytes: consumed, error: None };
                if sub.tx.send(msg).is_err() {
                    g.sub = None;
                    return;
                }
                continue;
            }
            if g.buf.is_empty() && g.eof && !g.eof_delivered {
                g.eof_delivered = true;
                let msg = WorkerMsg::Stream { sub_id: sub.sub_id.clone(), data: None, eof: true, nbytes: 0, error: g.error.clone() };
                let _ = sub.tx.send(msg);
            }
            return;
        }
    }
}

impl Drop for ByteStream {
    fn drop(&mut self) {
        self.space.notify_all();
    }
}

/// Wake producers blocked on a full buffer (called after the consumer drained or the stream closed).
pub fn notify_space(s: &ByteStream) { s.space.notify_all(); }

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn delivers_with_backpressure_and_handover() {
        let s = ByteStream::new("t", false);
        let (tx, rx) = crossbeam_channel::unbounded();
        s.push(b"hello ");
        s.subscribe(Subscriber { sub_id: "a".into(), module_id: "acp".into(), gen_id: 1, encoding: Encoding::Utf8, hwm: 4, tx: tx.clone(), paused: false }).unwrap();
        match rx.try_recv().unwrap() {
            WorkerMsg::Stream { data, nbytes, .. } => {
                assert_eq!(data.unwrap(), "hello ");
                assert_eq!(nbytes, 6);
            }
            _ => panic!(),
        }
        s.push(b"world");
        assert!(rx.try_recv().is_err(), "paused by high-water mark until ack");
        s.ack("a", 6);
        assert!(matches!(rx.try_recv().unwrap(), WorkerMsg::Stream { .. }));
        // Another module cannot steal the subscription; a new generation of the same module can.
        let (tx2, _rx2) = crossbeam_channel::unbounded();
        assert!(s.subscribe(Subscriber { sub_id: "b".into(), module_id: "other".into(), gen_id: 9, encoding: Encoding::Utf8, hwm: 10, tx: tx2, paused: false }).is_err());
        s.subscribe(Subscriber { sub_id: "c".into(), module_id: "acp".into(), gen_id: 2, encoding: Encoding::Utf8, hwm: 100, tx, paused: false }).unwrap();
        s.finish(None);
        let mut got_eof = false;
        while let Ok(m) = rx.try_recv() {
            if let WorkerMsg::Stream { eof: true, .. } = m {
                got_eof = true;
            }
        }
        assert!(got_eof);
    }
    #[test]
    fn utf8_split_across_chunks() {
        let s = ByteStream::new("t", false);
        let (tx, rx) = crossbeam_channel::unbounded();
        s.subscribe(Subscriber { sub_id: "a".into(), module_id: "m".into(), gen_id: 1, encoding: Encoding::Utf8, hwm: 1 << 20, tx, paused: false }).unwrap();
        let bytes = "é".as_bytes();
        s.push(&bytes[..1]);
        assert!(rx.try_recv().is_err());
        s.push(&bytes[1..]);
        match rx.try_recv().unwrap() {
            WorkerMsg::Stream { data, .. } => assert_eq!(data.unwrap(), "é"),
            _ => panic!(),
        }
    }
}
