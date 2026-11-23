use super::{Channel, Connection, Kind};
use crate::daemon::{self, F_DETACHED, F_EOF, F_ERR, F_EXIT, F_IN, F_OUT, F_RESIZE, F_SIGNAL};
use crate::util::{HResult, HostError};
use base64::Engine;
use serde_json::{json, Value};
use std::io;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader, ReadHalf, WriteHalf};
use tokio::sync::Mutex;
use tokio::time::timeout;

const CONTROL_TIMEOUT: Duration = Duration::from_secs(60);
const IO_TIMEOUT: Duration = Duration::from_secs(10);

fn disconnected(error: impl std::fmt::Display) -> HostError {
    HostError::new(
        "ECLOUD",
        format!("{error}. The host may have acted on a sent request"),
    )
}

async fn exchange(
    connection: &Connection,
    kind: Kind,
    request: &Value,
) -> HResult<(BufReader<Channel>, Value)> {
    let mut channel = connection
        .open(kind)
        .await
        .map_err(|error| HostError::new("ECLOUD", error.to_string()))?;
    let line = format!("{request}\n");
    if line.len() > daemon::MAX_FRAME {
        return Err(HostError::invalid("daemon request exceeds size limit"));
    }
    channel
        .write_all(line.as_bytes())
        .await
        .map_err(disconnected)?;
    let mut reader = BufReader::new(channel);
    let mut line = Vec::new();
    (&mut reader)
        .take(daemon::MAX_FRAME as u64)
        .read_until(b'\n', &mut line)
        .await
        .map_err(disconnected)?;
    if line.last() != Some(&b'\n') {
        return Err(disconnected("Cloud daemon reply was truncated"));
    }
    let reply = serde_json::from_slice(&line)
        .map_err(|_| disconnected("Cloud daemon returned invalid JSON"))?;
    Ok((reader, super::super::daemon_link::reply_value(&reply)?))
}

impl Connection {
    pub async fn request(&self, request: &Value) -> HResult<Value> {
        let (_, reply) = timeout(CONTROL_TIMEOUT, exchange(self, Kind::Control, request))
            .await
            .map_err(|_| disconnected("Cloud daemon request timed out"))??;
        Ok(reply)
    }

    pub async fn program(&self, kind: Kind, args: Value) -> HResult<Program> {
        let op = match kind {
            Kind::Exec => "exec",
            Kind::Pty => "pty.exec",
            Kind::Control => {
                return Err(HostError::invalid("program channel requires exec or PTY"))
            }
        };
        self.open_program(kind, op, args).await
    }

    pub async fn terminal(&self, args: Value) -> HResult<Program> {
        self.open_program(Kind::Pty, "pty.attach", args).await
    }

    async fn open_program(&self, kind: Kind, op: &str, args: Value) -> HResult<Program> {
        let (mut reader, _) = timeout(
            IO_TIMEOUT,
            exchange(self, kind, &json!({ "op": op, "args": args })),
        )
        .await
        .map_err(|_| disconnected("Cloud program start timed out"))??;
        let buffered = reader.buffer().to_vec();
        reader.consume(buffered.len());
        let (reader, writer) = tokio::io::split(reader.into_inner());
        Ok(Program {
            reader: Mutex::new(ProgramReader {
                reader,
                buffered,
                exited: false,
            }),
            writer: Mutex::new(writer),
            failed: AtomicBool::new(false),
        })
    }
}

struct ProgramReader {
    reader: ReadHalf<Channel>,
    buffered: Vec<u8>,
    exited: bool,
}

impl ProgramReader {
    async fn frame(&mut self) -> io::Result<Option<(u8, Vec<u8>)>> {
        if self.exited {
            return Ok(None);
        }
        loop {
            if let Some(header) = self.buffered.first_chunk() {
                let (kind, len) = daemon::frame_header(header)?;
                if self.buffered.len() >= 5 + len {
                    let payload = self.buffered[5..5 + len].to_vec();
                    self.buffered.drain(..5 + len);
                    self.exited = matches!(kind, F_EXIT | F_DETACHED);
                    return Ok(Some((kind, payload)));
                }
            }
            if self.reader.read_buf(&mut self.buffered).await? == 0 {
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "Cloud program ended without an exit frame",
                ));
            }
        }
    }
}

pub struct Program {
    reader: Mutex<ProgramReader>,
    writer: Mutex<WriteHalf<Channel>>,
    failed: AtomicBool,
}

impl Program {
    pub(super) async fn next_frame(&self) -> HResult<Option<(u8, Vec<u8>)>> {
        self.reader.lock().await.frame().await.map_err(disconnected)
    }

    pub async fn terminal_frame(&self) -> HResult<Option<(u8, Vec<u8>)>> {
        if self.failed.load(Ordering::Acquire) {
            return Err(disconnected("Cloud terminal closed"));
        }
        let mut reader = self
            .reader
            .try_lock()
            .map_err(|_| HostError::new("EBUSY", "a read is already pending"))?;
        match timeout(Duration::from_millis(500), reader.frame()).await {
            Err(_) => Ok(None),
            Ok(Err(error)) => Err(disconnected(error)),
            Ok(Ok(frame)) => Ok(frame.or(Some((F_DETACHED, Vec::new())))),
        }
    }

    pub async fn close(&self) {
        self.failed.store(true, Ordering::Release);
        let _ = self.writer.lock().await.shutdown().await;
    }

    pub async fn read(&self, wait: Duration) -> HResult<Value> {
        if self.failed.load(Ordering::Acquire) {
            return Err(disconnected("Cloud program channel failed"));
        }
        let mut reader = self
            .reader
            .try_lock()
            .map_err(|_| HostError::new("EBUSY", "a read is already pending"))?;
        let (kind, data) = match timeout(wait, reader.frame()).await {
            Err(_) => return Ok(json!({ "kind": "pending" })),
            Ok(Err(error)) => return Err(disconnected(error)),
            Ok(Ok(None)) => return Ok(json!({ "kind": "closed" })),
            Ok(Ok(Some(frame))) => frame,
        };
        match kind {
            F_OUT | F_ERR => Ok(
                json!({ "kind": if kind == F_OUT { "stdout" } else { "stderr" },
                "base64": base64::engine::general_purpose::STANDARD.encode(data) }),
            ),
            F_EXIT => {
                let exit: Value = serde_json::from_slice(&data)
                    .map_err(|_| disconnected("invalid Cloud program exit frame"))?;
                Ok(json!({ "kind": "exit", "code": exit["code"], "signal": exit["signal"] }))
            }
            _ => Err(disconnected("unexpected Cloud program frame")),
        }
    }

    pub async fn write(&self, kind: &str, frame: &Value) -> HResult<()> {
        if self.failed.load(Ordering::Acquire) {
            return Err(disconnected("Cloud program channel failed"));
        }
        let (op, data) = match kind {
            "stdin" => {
                let text = frame["base64"]
                    .as_str()
                    .filter(|s| s.len() <= 88_000)
                    .ok_or_else(|| HostError::invalid("expected up to 64 KiB of base64 input"))?;
                let data = base64::engine::general_purpose::STANDARD
                    .decode(text)
                    .map_err(|_| HostError::invalid("expected base64 input"))?;
                if data.len() > 65_536 {
                    return Err(HostError::invalid("stdin frame too large"));
                }
                (F_IN, data)
            }
            "eof" => (F_EOF, Vec::new()),
            "resize" => {
                let dim = |name: &str| {
                    frame[name]
                        .as_u64()
                        .and_then(|n| u16::try_from(n).ok())
                        .ok_or_else(|| HostError::invalid("expected 16-bit terminal dimensions"))
                };
                let mut data = dim("columns")?.to_be_bytes().to_vec();
                data.extend(dim("rows")?.to_be_bytes());
                (F_RESIZE, data)
            }
            "signal" => {
                let signal = frame["signal"]
                    .as_str()
                    .filter(|s| matches!(*s, "TERM" | "KILL" | "INT" | "HUP"))
                    .ok_or_else(|| HostError::invalid("unsupported program signal"))?;
                (F_SIGNAL, signal.as_bytes().to_vec())
            }
            _ => return Err(HostError::invalid("unsupported Cloud program input")),
        };
        self.send_frame(op, &data).await
    }

    pub async fn send_frame(&self, op: u8, data: &[u8]) -> HResult<()> {
        if self.failed.load(Ordering::Acquire) {
            return Err(disconnected("Cloud program channel failed"));
        }
        let mut buffer = Vec::with_capacity(data.len() + 5);
        daemon::write_frame(&mut buffer, op, data).map_err(disconnected)?;
        let mut writer = self
            .writer
            .try_lock()
            .map_err(|_| HostError::new("EBUSY", "a write is already pending"))?;
        match timeout(IO_TIMEOUT, writer.write_all(&buffer)).await {
            Ok(Ok(())) => Ok(()),
            result => {
                self.failed.store(true, Ordering::Release);
                let _ = writer.shutdown().await;
                match result {
                    Ok(Err(error)) => Err(disconnected(error)),
                    _ => Err(disconnected("Cloud program input timed out")),
                }
            }
        }
    }
}
