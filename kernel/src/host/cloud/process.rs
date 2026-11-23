use super::{Connection, Kind, Program};
use crate::daemon::{F_EOF, F_ERR, F_EXIT, F_IN, F_OUT, F_SIGNAL};
use crate::host::process::ExitInfo;
use crate::host::stdio::{ProcHandle, Spawned};
use crate::util::{HResult, HostError};
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::io::{self, Write};
use std::sync::Arc;

pub struct CloudChild {
    program: Program,
    exit: Mutex<Option<Result<ExitInfo, HostError>>>,
}

impl CloudChild {
    pub fn spawn(connection: &Connection, command: String) -> HResult<Spawned> {
        let child = Arc::new(Self {
            program: Connection::wait(connection.program(Kind::Exec, json!({"sh":command})))?,
            exit: Mutex::new(None),
        });
        let (out, mut out_tx) = io::pipe()?;
        let (err, mut err_tx) = io::pipe()?;
        let pump = child.clone();
        std::thread::spawn(move || {
            let result = (|| -> HResult<ExitInfo> {
                loop {
                    let (kind, bytes) = Connection::wait(pump.program.next_frame())?
                        .ok_or_else(|| HostError::new("ECLOUD", "Cloud process closed without an exit status"))?;
                    match kind {
                        F_OUT => out_tx.write_all(&bytes)?,
                        F_ERR => err_tx.write_all(&bytes)?,
                        F_EXIT => {
                            let exit: Value = serde_json::from_slice(&bytes)
                                .map_err(|_| HostError::new("ECLOUD", "Invalid Cloud process exit status"))?;
                            return Ok(ExitInfo {
                                code: exit["code"].as_i64().and_then(|n| i32::try_from(n).ok()),
                                signal: exit["signal"].as_i64().and_then(|n| i32::try_from(n).ok()),
                            });
                        }
                        _ => return Err(HostError::new("ECLOUD", "Unexpected Cloud process frame")),
                    }
                }
            })();
            *pump.exit.lock() = Some(result);
            Connection::wait(pump.program.close());
        });
        Ok(Spawned {
            stdin: Some(Box::new(Input(child.clone()))),
            stdout: Some(Box::new(out)),
            stderr: Some(Box::new(err)),
            handle: ProcHandle::Cloud(child),
        })
    }

    pub fn try_wait(&self) -> io::Result<Option<ExitInfo>> {
        match self.exit.lock().as_ref() {
            Some(Ok(exit)) => Ok(Some(exit.clone())),
            Some(Err(error)) => Err(io::Error::other(error.to_string())),
            None => Ok(None),
        }
    }

    pub fn terminate(&self, signal: &str) {
        let signal = match signal.trim_start_matches("SIG") {
            "KILL" => b"KILL".as_slice(),
            "INT" => b"INT",
            "HUP" => b"HUP",
            _ => b"TERM",
        };
        let _ = Connection::wait(self.program.send_frame(F_SIGNAL, signal));
        Connection::wait(self.program.close());
    }
}

struct Input(Arc<CloudChild>);

impl Write for Input {
    fn write(&mut self, data: &[u8]) -> io::Result<usize> {
        let chunk = &data[..data.len().min(64 * 1024)];
        Connection::wait(self.0.program.send_frame(F_IN, chunk))
            .map_err(|e| io::Error::new(io::ErrorKind::BrokenPipe, e.to_string()))?;
        Ok(chunk.len())
    }

    fn flush(&mut self) -> io::Result<()> { Ok(()) }
}

impl Drop for Input {
    fn drop(&mut self) {
        let _ = Connection::wait(self.0.program.send_frame(F_EOF, &[]));
    }
}
