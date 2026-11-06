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
use std::process::{Child, ChildStdin, Stdio};
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

/// A process held by the daemon on the target machine.
#[derive(Clone, Debug)]
pub struct Persist { pub bin: String, pub dir: String, pub key: String }

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
    /// Run under the daemon on the target machine: (daemon binary, scoped key). The process then
    /// survives this connection; spawning the same key again reattaches.
    pub persist: Option<Persist>,
}

pub fn spawn(spec: SpawnSpec) -> HResult<Arc<ProcessRes>> {
    let mut cmd = match &spec.target {
        Target::Local if spec.persist.is_some() => {
            let p = spec.persist.clone().unwrap();
            let sh = quoting::remote_command(&spec.cwd, &spec.executable, &spec.args, &spec.env, &spec.env_remove, spec.login_shell)
                .map_err(HostError::invalid)?;
            let mut c = crate::util::command(&p.bin);
            c.args(["daemon", "proc-attach", "--dir", &p.dir, "--key", &p.key, "--cwd", &spec.cwd, "--sh", &sh]);
            c
        }
        Target::Local => {
            let mut c = crate::util::command(&spec.executable);
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
            let mut remote = quoting::remote_command(&spec.cwd, &spec.executable, &spec.args, &spec.env, &spec.env_remove, spec.login_shell)
                .map_err(HostError::invalid)?;
            if let Some(p) = &spec.persist {
                remote = format!("{} daemon proc-attach --dir {} --key {} --cwd {} --sh {}", quoting::sh_quote(&p.bin), quoting::sh_quote(&p.dir), quoting::sh_quote(&p.key), quoting::sh_quote(&spec.cwd), quoting::sh_quote(&remote));
            }
            ssh.remote_command(&remote)
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
            // No signals here: every request ends the process and its children.
            let _ = signal;
            if self.exit.lock().is_none() {
                let tree = crate::util::command(crate::util::system32("taskkill.exe")).args(["/T", "/F", "/PID", &self.pid.to_string()])
                    .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).status();
                if !matches!(tree, Ok(s) if s.success()) {
                    if let Some(c) = self.child.lock().as_mut() {
                        let _ = c.kill();
                    }
                }
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
    let started = Instant::now();
    let mut out = Vec::new();
    let mut err = Vec::new();
    let mut truncated = false;
    let drain = |stream: &ByteStream, output: &mut Vec<u8>, truncated: &mut bool| {
        let chunk = stream.take_all();
        let keep = chunk.len().min(limit.saturating_sub(output.len()));
        *truncated |= keep < chunk.len();
        output.extend_from_slice(&chunk[..keep]);
    };
    // Drain while the child runs: waiting for exit first deadlocks when stdout fills
    // its bounded stream buffer (for example, an esbuild bundle with image assets).
    let exit = loop {
        drain(&p.stdout, &mut out, &mut truncated);
        drain(&p.stderr, &mut err, &mut truncated);
        if let Some(exit) = p.exit.lock().clone() { break exit; }
        let remaining = timeout.saturating_sub(started.elapsed());
        if remaining.is_zero() {
            let _ = p.terminate(Some("KILL"));
            return Err(HostError::new("ETIMEDOUT", format!("command timed out after {}ms: {}", timeout.as_millis(), p.description)));
        }
        let _ = p.wait(Some(remaining.min(Duration::from_millis(5))));
    };
    // Pipe readers may still have bytes after the exit notification.
    let t0 = Instant::now();
    loop {
        drain(&p.stdout, &mut out, &mut truncated);
        drain(&p.stderr, &mut err, &mut truncated);
        if (p.stdout.is_eof() && p.stderr.is_eof()) || t0.elapsed() >= Duration::from_millis(1500) { break; }
        std::thread::sleep(Duration::from_millis(5));
    }
    Ok(json!({
        "code": exit.code, "signal": exit.signal,
        "stdout": String::from_utf8_lossy(&out), "stderr": String::from_utf8_lossy(&err), "truncated": truncated,
    }))
}


#[cfg(all(test, unix))]
mod tests {
    use super::*;

    fn command(script: &str) -> Arc<ProcessRes> {
        spawn(SpawnSpec { target: Target::Local, ssh: None, executable: "/bin/sh".into(),
            args: vec!["-c".into(), script.into()], cwd: "/tmp".into(), env: vec![],
            env_remove: vec![], login_shell: false, persist: None }).unwrap()
    }

    #[test]
    fn collect_drains_output_larger_than_stream_capacity() {
        let p = command("head -c 6291456 /dev/zero; printf done >&2");
        let r = run_collect(&p, None, Duration::from_secs(10), 8 * 1024 * 1024).unwrap();
        assert_eq!(r["code"], 0);
        assert_eq!(r["stdout"].as_str().unwrap().len(), 6 * 1024 * 1024);
        assert_eq!(r["stderr"], "done");
        assert_eq!(r["truncated"], false);
    }

    #[test]
    fn collect_keeps_draining_after_output_limit() {
        let p = command("head -c 6291456 /dev/zero; printf done >&2");
        let r = run_collect(&p, None, Duration::from_secs(10), 1024).unwrap();
        assert_eq!(r["code"], 0);
        assert_eq!(r["stdout"].as_str().unwrap().len(), 1024);
        assert_eq!(r["stderr"], "done");
        assert_eq!(r["truncated"], true);
    }

    #[test]
    fn collect_still_times_out_a_running_child() {
        let p = command("exec sleep 10");
        let e = run_collect(&p, None, Duration::from_millis(25), 1024).unwrap_err();
        assert!(e.to_string().contains("ETIMEDOUT"));
    }
}
