//! A running program with byte pipes: a local child process, or a channel on a built-in SSH
//! connection. Processes, SFTP and the daemon link use this so they need not care which.
use crate::host::process::ExitInfo;
use crate::host::sshc::ChannelCtl;
use crate::util::{HResult, HostError};
use std::io::{Read, Write};
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::time::{Duration, Instant};

pub enum ProcHandle {
    Local(Child),
    Channel(Arc<ChannelCtl>),
}

impl ProcHandle {
    /// OS process id; 0 for an SSH channel (nothing runs locally).
    pub fn id(&self) -> u32 {
        match self {
            ProcHandle::Local(c) => c.id(),
            ProcHandle::Channel(_) => 0,
        }
    }

    pub fn try_wait(&mut self) -> std::io::Result<Option<ExitInfo>> {
        match self {
            ProcHandle::Local(c) => Ok(c.try_wait()?.map(|s| exit_info(&s))),
            ProcHandle::Channel(c) => Ok(c.try_wait()),
        }
    }

    pub fn kill(&mut self) {
        match self {
            ProcHandle::Local(c) => {
                let _ = c.kill();
                let _ = c.wait();
            }
            ProcHandle::Channel(c) => c.close(),
        }
    }

    /// Waits up to `timeout` (forever when `None`).
    pub fn wait(&mut self, timeout: Option<Duration>) -> Option<ExitInfo> {
        match self {
            ProcHandle::Channel(c) => c.wait(timeout),
            ProcHandle::Local(c) => {
                let deadline = timeout.map(|t| Instant::now() + t);
                loop {
                    match c.try_wait() {
                        Ok(Some(s)) => return Some(exit_info(&s)),
                        Ok(None) => {}
                        Err(_) => return Some(ExitInfo { code: None, signal: None }),
                    }
                    if deadline.is_some_and(|d| Instant::now() >= d) {
                        return None;
                    }
                    std::thread::sleep(Duration::from_millis(10));
                }
            }
        }
    }
}

pub fn exit_info(s: &std::process::ExitStatus) -> ExitInfo {
    #[cfg(unix)]
    let signal = {
        use std::os::unix::process::ExitStatusExt;
        s.signal()
    };
    #[cfg(not(unix))]
    let signal = None;
    ExitInfo { code: s.code(), signal }
}

pub struct Spawned {
    pub handle: ProcHandle,
    pub stdin: Option<Box<dyn Write + Send>>,
    pub stdout: Option<Box<dyn Read + Send>>,
    pub stderr: Option<Box<dyn Read + Send>>,
}

impl Spawned {
    /// Start a local program with all three pipes.
    pub fn spawn(mut cmd: Command, what: &str) -> HResult<Spawned> {
        cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        let mut child = cmd.spawn().map_err(|e| HostError::new("ENOEXEC", format!("failed to start {what}: {e}")))?;
        Ok(Spawned {
            stdin: child.stdin.take().map(|w| Box::new(w) as Box<dyn Write + Send>),
            stdout: child.stdout.take().map(|r| Box::new(r) as Box<dyn Read + Send>),
            stderr: child.stderr.take().map(|r| Box::new(r) as Box<dyn Read + Send>),
            handle: ProcHandle::Local(child),
        })
    }

    /// Feed `stdin` (then close it), collect stdout/stderr and the exit code. Killed on timeout.
    pub fn collect(mut self, stdin: Option<&[u8]>, timeout: Duration) -> HResult<(i32, String, String)> {
        let mut w = self.stdin.take();
        if let (Some(data), Some(mut w)) = (stdin, w.take()) {
            let data = data.to_vec();
            std::thread::spawn(move || { let _ = w.write_all(&data).and_then(|_| w.flush()); });
        }
        drop(w);
        let read_all = |r: Option<Box<dyn Read + Send>>| std::thread::spawn(move || {
            let mut v = Vec::new();
            if let Some(mut r) = r {
                let _ = r.read_to_end(&mut v);
            }
            v
        });
        let (out, err) = (read_all(self.stdout.take()), read_all(self.stderr.take()));
        let Some(exit) = self.handle.wait(Some(timeout)) else {
            self.handle.kill();
            return Err(HostError::new("ETIMEDOUT", "remote command timed out"));
        };
        let (out, err) = (out.join().unwrap_or_default(), err.join().unwrap_or_default());
        Ok((exit.code.unwrap_or(-1), String::from_utf8_lossy(&out).into_owned(), String::from_utf8_lossy(&err).into_owned()))
    }
}
