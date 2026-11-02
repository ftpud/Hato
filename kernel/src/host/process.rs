//! Child processes with piped stdio. Local processes are spawned with argv (no shell). Remote
//! processes run over the SSH master of the grant's machine via the audited quoting adapter; a
//! dead SSH master is an error — there is never a local fallback.
use crate::grants::Target;
use crate::host::ssh::SshMaster;
use crate::host::streams::ByteStream;
use crate::quoting;
use crate::util::{HResult, HostError};
use parking_lot::{Condvar, Mutex};
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Arc;
use std::time::{Duration, Instant};

#[derive(Debug, Clone)]
pub struct ExitInfo {
    pub code: Option<i32>,
    pub signal: Option<i32>,
}

impl ExitInfo {
    pub fn to_json(&self) -> Value { json!({"code": self.code, "signal": self.signal}) }
}

pub struct ProcessRes {
    pub pid: u32,
    pub machine_id: String,
    pub description: String,
    pub child: Mutex<Option<Child>>,
    pub stdin: Mutex<Option<ChildStdin>>,
    pub stdout: Arc<ByteStream>,
    pub stderr: Arc<ByteStream>,
    pub exit: Mutex<Option<ExitInfo>>,
    pub exit_cv: Condvar,
}

pub struct SpawnSpec {
    pub target: Target,
    pub ssh: Option<Arc<SshMaster>>,
    pub executable: String,
    pub args: Vec<String>,
    pub cwd: String,
    pub env: Vec<(String, String)>,
    /// Variables removed from the inherited environment (e.g. to keep an API key away from an agent).
    pub env_remove: Vec<String>,
    pub login_shell: bool,
}

pub fn spawn(spec: SpawnSpec) -> HResult<Arc<ProcessRes>> {
    let mut cmd = match &spec.target {
        Target::Local => {
            let mut c = Command::new(&spec.executable);
            c.args(&spec.args).current_dir(&spec.cwd);
            for (k, v) in &spec.env {
                c.env(k, v);
            }
            for k in &spec.env_remove {
                c.env_remove(k);
            }
            c
        }
        Target::Ssh { .. } => {
            let ssh = spec.ssh.as_ref().ok_or_else(|| HostError::new("ENOTCONN", "SSH connection unavailable"))?;
            ssh.ensure_alive()?;
            let remote = quoting::remote_command(&spec.cwd, &spec.executable, &spec.args, &spec.env, &spec.env_remove, spec.login_shell)
                .map_err(HostError::invalid)?;
            let mut c = ssh.client_command(&["-T"]);
            c.arg("--").arg(remote);
            c
        }
    };
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    let mut child = cmd.spawn().map_err(|e| HostError::new("ENOEXEC", format!("failed to start {}: {e}", spec.executable)))?;
    let pid = child.id();
    let stdout = ByteStream::new(format!("{}:stdout", spec.executable), false);
    let stderr = ByteStream::new(format!("{}:stderr", spec.executable), true);
    let mut out = child.stdout.take().unwrap();
    let mut err = child.stderr.take().unwrap();
    let stdin = child.stdin.take();
    let res = Arc::new(ProcessRes {
        pid,
        machine_id: spec.target.machine_id(),
        description: format!("{} {}", spec.executable, spec.args.join(" ")),
        child: Mutex::new(Some(child)),
        stdin: Mutex::new(stdin),
        stdout: stdout.clone(),
        stderr: stderr.clone(),
        exit: Mutex::new(None),
        exit_cv: Condvar::new(),
    });
    std::thread::spawn(move || pump(&mut out, &stdout));
    std::thread::spawn(move || pump(&mut err, &stderr));
    let r2 = res.clone();
    std::thread::spawn(move || loop {
        let st = {
            let mut c = r2.child.lock();
            match c.as_mut() {
                Some(ch) => ch.try_wait(),
                None => return,
            }
        };
        match st {
            Ok(Some(status)) => {
                #[cfg(unix)]
                let signal = {
                    use std::os::unix::process::ExitStatusExt;
                    status.signal()
                };
                #[cfg(not(unix))]
                let signal = None;
                *r2.exit.lock() = Some(ExitInfo { code: status.code(), signal });
                r2.exit_cv.notify_all();
                return;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(_) => {
                *r2.exit.lock() = Some(ExitInfo { code: None, signal: None });
                r2.exit_cv.notify_all();
                return;
            }
        }
    });
    Ok(res)
}

fn pump(r: &mut dyn Read, s: &Arc<ByteStream>) {
    let mut buf = vec![0u8; 32 * 1024];
    loop {
        match r.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => s.push(&buf[..n]),
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => {
                s.finish(Some(e.to_string()));
                return;
            }
        }
    }
    s.finish(None);
}

impl ProcessRes {
    pub fn write(&self, data: &[u8]) -> HResult<()> {
        let mut g = self.stdin.lock();
        let w = g.as_mut().ok_or_else(|| HostError::new("EPIPE", "stdin closed"))?;
        w.write_all(data).and_then(|_| w.flush()).map_err(|e| HostError::new("EPIPE", e.to_string()))
    }
    pub fn close_stdin(&self) { self.stdin.lock().take(); }
    pub fn terminate(&self, signal: Option<&str>) -> HResult<()> {
        #[cfg(unix)]
        {
            let sig = match signal.unwrap_or("TERM") {
                "KILL" | "SIGKILL" => libc::SIGKILL,
                "INT" | "SIGINT" => libc::SIGINT,
                "HUP" | "SIGHUP" => libc::SIGHUP,
                _ => libc::SIGTERM,
            };
            if self.exit.lock().is_none() {
                unsafe {
                    libc::kill(-(self.pid as i32), sig);
                    libc::kill(self.pid as i32, sig);
                }
            }
            Ok(())
        }
        #[cfg(not(unix))]
        {
            let _ = signal;
            if let Some(c) = self.child.lock().as_mut() {
                let _ = c.kill();
            }
            Ok(())
        }
    }
    pub fn wait(&self, timeout: Option<Duration>) -> Option<ExitInfo> {
        let deadline = timeout.map(|t| Instant::now() + t);
        let mut g = self.exit.lock();
        loop {
            if let Some(e) = g.clone() {
                return Some(e);
            }
            match deadline {
                Some(d) => {
                    if Instant::now() >= d {
                        return None;
                    }
                    self.exit_cv.wait_until(&mut g, d);
                }
                None => self.exit_cv.wait(&mut g),
            }
        }
    }
    pub fn info(&self) -> Value {
        let (out_total, out_buf, _) = self.stdout.stats();
        json!({"pid": self.pid, "machineId": self.machine_id, "description": self.description,
               "exit": self.exit.lock().as_ref().map(|e| e.to_json()), "stdoutBytes": out_total, "stdoutBuffered": out_buf})
    }
}

/// Run to completion collecting output (bounded), with a timeout. Used for short commands such as git.
pub fn run_collect(p: &Arc<ProcessRes>, stdin: Option<&[u8]>, timeout: Duration, limit: usize) -> HResult<Value> {
    if let Some(data) = stdin {
        let _ = p.write(data);
    }
    p.close_stdin();
    let exit = match p.wait(Some(timeout)) {
        Some(e) => e,
        None => {
            let _ = p.terminate(Some("KILL"));
            return Err(HostError::new("ETIMEDOUT", format!("command timed out after {}ms: {}", timeout.as_millis(), p.description)));
        }
    };
    // Give pipe readers a moment to observe EOF.
    let t0 = Instant::now();
    while (!p.stdout.is_eof() || !p.stderr.is_eof()) && t0.elapsed() < Duration::from_millis(1500) {
        std::thread::sleep(Duration::from_millis(5));
    }
    let mut out = p.stdout.take_all();
    let mut err = p.stderr.take_all();
    let truncated = out.len() > limit || err.len() > limit;
    out.truncate(limit);
    err.truncate(limit);
    Ok(json!({
        "code": exit.code, "signal": exit.signal,
        "stdout": String::from_utf8_lossy(&out), "stderr": String::from_utf8_lossy(&err), "truncated": truncated,
    }))
}
