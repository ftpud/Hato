//! PTY sessions with a native terminal emulator (alacritty_terminal) owned by the kernel.
//! PTY bytes are parsed and rendered natively; modules can explicitly read bounded output by cursor.
//! Sessions are independent of module generations and survive TS hot-swaps.
use crate::daemon::{F_DETACHED, F_ERR, F_EXIT, F_IN, F_OUT, F_RESIZE};
use crate::host::cloud::{Connection as CloudConnection, Program as CloudProgram};
use crate::host::ssh::SshMaster;
use crate::host::stdio::ProcHandle;
use crate::util::{HResult, HostError};
use alacritty_terminal::event::{Event, EventListener};
use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::term::{Config as TermConfig, Term};
use alacritty_terminal::vte::ansi::Processor;
use parking_lot::Mutex;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

#[derive(Clone, Copy, Debug)]
pub struct TermDims {
    pub cols: usize,
    pub rows: usize,
}
impl Dimensions for TermDims {
    fn total_lines(&self) -> usize { self.rows }
    fn screen_lines(&self) -> usize { self.rows }
    fn columns(&self) -> usize { self.cols }
}

type SharedWriter = Arc<Mutex<Box<dyn Write + Send>>>;

#[derive(Clone)]
pub struct Listener {
    writer: SharedWriter,
    title: Arc<Mutex<String>>,
    /// Reply to terminal queries (DA, cursor position, colors). Off for viewers of a daemon PTY:
    /// the daemon's own emulator already answers, and replayed history would be answered again,
    /// arriving at the shell as typed garbage like `6c1R9;3R`.
    answer_queries: bool,
}
impl EventListener for Listener {
    fn send_event(&self, event: Event) {
        match event {
            Event::PtyWrite(s) if self.answer_queries => {
                let mut w = self.writer.lock();
                let _ = w.write_all(s.as_bytes());
                let _ = w.flush();
            }
            Event::Title(t) => *self.title.lock() = t,
            _ => {}
        }
    }
}

pub struct PtySession {
    pub term: Mutex<Term<Listener>>,
    processor: Mutex<Processor>,
    writer: SharedWriter,
    backend: Mutex<Backend>,
    pub exit: Mutex<Option<String>>,
    pub size: Mutex<TermDims>,
    pub title: Arc<Mutex<String>>,
    pub machine_id: String,
    pub cwd: String,
    pub description: String,
    pub dirty: AtomicBool,
    pub notify: Mutex<Option<Arc<dyn Fn() + Send + Sync>>>,
    output: Mutex<super::pty_output::OutputJournal>,
    pub bytes_in: std::sync::atomic::AtomicU64,
}

/// Where the terminal's program runs.
enum Backend {
    /// A local pseudo-terminal (openpty / ConPTY) and its child.
    Local { master: Box<dyn MasterPty + Send>, child: Box<dyn Child + Send + Sync> },
    /// A PTY channel on a built-in SSH connection.
    Remote(ProcHandle),
    Cloud { program: Arc<CloudProgram>, status: Arc<Mutex<Option<String>>> },
}

/// A terminal on an SSH machine: `command` runs on a remote PTY of `master`'s connection.
pub struct RemotePty {
    pub master: Arc<SshMaster>,
    pub command: String,
}

pub struct PtySpec {
    /// When set, `program`/`args`/`cwd`/`env` are unused.
    pub remote: Option<RemotePty>,
    pub program: String,
    pub args: Vec<String>,
    pub cwd: Option<String>,
    pub env: Vec<(String, String)>,
    pub env_remove: Vec<String>,
    pub cols: u16,
    pub rows: u16,
    pub machine_id: String,
    pub display_cwd: String,
    /// False when the program is itself a terminal relay (`hato daemon pty-attach`, locally or
    /// over SSH) whose far end already answers terminal queries.
    pub answer_queries: bool,
}

pub fn open(spec: PtySpec) -> HResult<Arc<PtySession>> {
    let cols = spec.cols.clamp(10, 1000);
    let rows = spec.rows.clamp(3, 500);
    let (backend, reader, writer, description, local) = match &spec.remote {
        Some(r) => {
            let mut p = r.master.exec_pty(&r.command, cols, rows)?;
            let reader = p.stdout.take().unwrap();
            let writer = p.stdin.take().unwrap();
            (Backend::Remote(p.handle), reader, writer, format!("{} (ssh)", r.command), false)
        }
        None => {
            let pair = native_pty_system()
                .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
                .map_err(|e| HostError::new("EPTY", format!("openpty: {e}")))?;
            let mut cmd = CommandBuilder::new(&spec.program);
            cmd.args(&spec.args);
            if let Some(cwd) = &spec.cwd {
                cmd.cwd(cwd);
            }
            cmd.env("TERM", "xterm-256color");
            cmd.env("COLORTERM", "truecolor");
            for key in &spec.env_remove { cmd.env_remove(key); }
            for (k, v) in &spec.env {
                cmd.env(k, v);
            }
            let child = pair.slave.spawn_command(cmd).map_err(|e| HostError::new("ENOEXEC", format!("spawn {}: {e}", spec.program)))?;
            drop(pair.slave);
            let reader = pair.master.try_clone_reader().map_err(|e| HostError::new("EPTY", e.to_string()))?;
            let writer = pair.master.take_writer().map_err(|e| HostError::new("EPTY", e.to_string()))?;
            (Backend::Local { master: pair.master, child }, reader, writer, format!("{} {}", spec.program, spec.args.join(" ")), true)
        }
    };
    attach(spec, backend, reader, writer, description, local)
}

/// Run an argv process on a native PTY using an already validated process scope.
pub fn spawn(spec: super::process::SpawnSpec, cols: u16, rows: u16) -> HResult<Arc<PtySession>> {
    let mut pty = PtySpec { remote: None, program: spec.executable.clone(), args: spec.args.clone(),
        cwd: Some(spec.cwd.clone()), env: spec.env.clone(), env_remove: spec.env_remove.clone(),
        cols, rows, machine_id: spec.target.machine_id(), display_cwd: spec.cwd.clone(), answer_queries: true };
    match &spec.target {
        crate::grants::Target::Local => open(pty),
        _ => {
            let command = crate::quoting::remote_command(&spec.cwd, &spec.executable, &spec.args, &spec.env, &spec.env_remove, spec.login_shell).map_err(HostError::invalid)?;
            if let Some(connection) = spec.cloud {
                let program = CloudConnection::wait(connection.program(super::cloud::Kind::Pty, json!({"sh":command,"columns":cols,"rows":rows})))?;
                return open_cloud(pty, program);
            }
            let master = spec.ssh.ok_or_else(|| HostError::new("ENOTCONN", "terminal connection unavailable"))?;
            if master.is_wsl() {
                let (program, args) = master.wsl_pty_command(&command);
                pty.program=program; pty.args=args; pty.cwd=None; pty.env.clear(); pty.env_remove.clear();
            } else { pty.remote=Some(RemotePty { master, command }); }
            open(pty)
        }
    }
}

pub fn open_cloud(spec: PtySpec, program: CloudProgram) -> HResult<Arc<PtySession>> {
    let program = Arc::new(program);
    let status = Arc::new(Mutex::new(None));
    let reader = CloudReader { program: program.clone(), status: status.clone(), bytes: std::io::Cursor::new(Vec::new()) };
    let writer = CloudWriter(program.clone());
    attach(spec, Backend::Cloud { program, status }, Box::new(reader), Box::new(writer), "Cloud terminal".into(), false)
}

fn attach(
    spec: PtySpec, backend: Backend, mut reader: Box<dyn Read + Send>, writer: Box<dyn Write + Send>,
    description: String, local: bool,
) -> HResult<Arc<PtySession>> {
    let cols = spec.cols.clamp(10, 1000);
    let rows = spec.rows.clamp(3, 500);
    let spec_answers = spec.answer_queries;
    let writer: SharedWriter = Arc::new(Mutex::new(writer));
    let title = Arc::new(Mutex::new(String::new()));
    let listener = Listener { writer: writer.clone(), title: title.clone(), answer_queries: spec.answer_queries };
    let dims = TermDims { cols: cols as usize, rows: rows as usize };
    let term = Term::new(TermConfig { scrolling_history: 5000, ..TermConfig::default() }, &dims, listener);
    let sess = Arc::new(PtySession {
        term: Mutex::new(term),
        processor: Mutex::new(Processor::new()),
        writer,
        backend: Mutex::new(backend),
        exit: Mutex::new(None),
        size: Mutex::new(dims),
        title,
        machine_id: spec.machine_id,
        cwd: spec.display_cwd,
        description,
        dirty: AtomicBool::new(true),
        notify: Mutex::new(None),
        output: Default::default(),
        bytes_in: Default::default(),
    });
    let s2 = sess.clone();
    // ConPTY opens with a cursor position query and stays silent until it is answered. The session
    // answers it unless it is a relay, whose far end cannot: it only answers for the far program.
    let mut conpty_query_pending = cfg!(windows) && local && !spec_answers;
    std::thread::Builder::new()
        .name("pty-reader".into())
        .spawn(move || {
            let mut buf = vec![0u8; 64 * 1024];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        if conpty_query_pending && buf[..n].windows(4).any(|w| w == b"\x1b[6n") {
                            conpty_query_pending = false;
                            let _ = s2.write(b"\x1b[1;1R");
                        }
                        s2.feed(&buf[..n]);
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(_) => break,
                }
            }
            let status = match &mut *s2.backend.lock() {
                Backend::Local { child, .. } => child.wait().map(|s| format!("exited with code {}", s.exit_code())).unwrap_or_else(|e| format!("exited ({e})")),
                Backend::Cloud { status, .. } => status.lock().clone().unwrap_or_else(|| "exited (Cloud connection closed)".into()),
                Backend::Remote(h) => match h.wait(Some(std::time::Duration::from_secs(5))) {
                    Some(e) if e.code.is_some() => format!("exited with code {}", e.code.unwrap_or(0)),
                    Some(e) if e.signal.is_some() => format!("exited (signal {})", e.signal.unwrap_or(0)),
                    _ => "exited (connection closed)".to_string(),
                },
            };
            *s2.exit.lock() = Some(status.clone());
            s2.feed(format!("\r\n\x1b[1;31m[process {status}]\x1b[0m\r\n").as_bytes());
        })
        .map_err(HostError::io)?;
    Ok(sess)
}

struct CloudWriter(Arc<CloudProgram>);

impl Write for CloudWriter {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        let n = bytes.len().min(64 * 1024);
        CloudConnection::wait(self.0.send_frame(F_IN, &bytes[..n]))
            .map(|_| n)
            .map_err(|e| std::io::Error::other(e.to_string()))
    }

    fn flush(&mut self) -> std::io::Result<()> { Ok(()) }
}

struct CloudReader {
    program: Arc<CloudProgram>,
    status: Arc<Mutex<Option<String>>>,
    bytes: std::io::Cursor<Vec<u8>>,
}

impl Read for CloudReader {
    fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
        if out.is_empty() { return Ok(0); }
        loop {
            let n = self.bytes.read(out)?;
            if n > 0 { return Ok(n); }
            let frame = CloudConnection::wait(self.program.terminal_frame()).map_err(|e| std::io::Error::other(e.to_string()))?;
            let Some((kind, bytes)) = frame else { continue };
            match kind {
                F_OUT | F_ERR => self.bytes = std::io::Cursor::new(bytes),
                F_EXIT | F_DETACHED => {
                    *self.status.lock() = if kind == F_DETACHED {
                        Some("detached (terminal attached elsewhere)".into())
                    } else {
                        serde_json::from_slice::<Value>(&bytes).ok().and_then(|v| v["status"].as_str().map(str::to_owned))
                    };
                    CloudConnection::wait(self.program.close());
                    return Ok(0);
                }
                _ => {}
            }
        }
    }
}

impl PtySession {
    pub fn feed(&self, bytes: &[u8]) {
        self.output.lock().push(bytes);
        self.bytes_in.fetch_add(bytes.len() as u64, Ordering::Relaxed);
        {
            let mut term = self.term.lock();
            let mut p = self.processor.lock();
            p.advance(&mut *term, bytes);
        }
        if !self.dirty.swap(true, Ordering::SeqCst) {
            if let Some(n) = self.notify.lock().clone() {
                n();
            }
        }
    }

    pub fn read_output(&self, cursor: Option<u64>, limit: usize) -> Value {
        let mut value = self.output.lock().read(cursor, limit);
        value["exit"] = json!(self.exit.lock().clone());
        value
    }

    pub fn write(&self, data: &[u8]) -> HResult<()> {
        if self.exit.lock().is_some() {
            return Err(HostError::new("EPIPE", "terminal process has exited"));
        }
        let mut w = self.writer.lock();
        w.write_all(data).and_then(|_| w.flush()).map_err(|e| HostError::new("EPIPE", e.to_string()))
    }

    pub fn resize(&self, cols: u16, rows: u16) -> HResult<()> {
        let cols = cols.clamp(10, 1000);
        let rows = rows.clamp(3, 500);
        {
            let mut s = self.size.lock();
            if s.cols == cols as usize && s.rows == rows as usize {
                return Ok(());
            }
            *s = TermDims { cols: cols as usize, rows: rows as usize };
        }
        self.term.lock().resize(TermDims { cols: cols as usize, rows: rows as usize });
        match &*self.backend.lock() {
            Backend::Local { master, .. } => master
                .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
                .map_err(|e| HostError::new("EPTY", e.to_string()))?,
            Backend::Cloud { program, .. } => {
                let mut dimensions = [0; 4];
                dimensions[..2].copy_from_slice(&cols.to_be_bytes());
                dimensions[2..].copy_from_slice(&rows.to_be_bytes());
                CloudConnection::wait(program.send_frame(F_RESIZE, &dimensions))?;
            }
            Backend::Remote(ProcHandle::Channel(c)) => c.resize(cols, rows),
            Backend::Remote(_) => {}
        }
        self.dirty.store(true, Ordering::SeqCst);
        Ok(())
    }

    pub fn kill(&self) {
        match &mut *self.backend.lock() {
            Backend::Local { child, .. } => { let _ = child.kill(); }
            Backend::Cloud { program, .. } => CloudConnection::wait(program.close()),
            Backend::Remote(h) => h.kill(),
        }
    }

    pub fn is_exited(&self) -> bool { self.exit.lock().is_some() }

    pub fn info(&self) -> Value {
        let s = *self.size.lock();
        json!({"machineId": self.machine_id, "cwd": self.cwd, "columns": s.cols, "rows": s.rows,
               "exit": self.exit.lock().clone(), "title": self.title.lock().clone(), "description": self.description,
               "bytesIn": self.bytes_in.load(Ordering::Relaxed)})
    }

    /// Plain-text dump of the visible screen (diagnostics / headless tests).
    pub fn screen_text(&self) -> String {
        let term = self.term.lock();
        let content = term.renderable_content();
        let rows = term.screen_lines();
        let cols = term.columns();
        let mut lines = vec![vec![' '; cols]; rows];
        for cell in content.display_iter {
            let line = cell.point.line.0 + content.display_offset as i32;
            if line >= 0 && (line as usize) < rows && cell.point.column.0 < cols {
                lines[line as usize][cell.point.column.0] = cell.c;
            }
        }
        lines.into_iter().map(|l| l.into_iter().collect::<String>().trim_end().to_string()).collect::<Vec<_>>().join("\n")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Sink(Arc<Mutex<Vec<u8>>>);
    impl Write for Sink {
        fn write(&mut self, b: &[u8]) -> std::io::Result<usize> { self.0.lock().extend_from_slice(b); Ok(b.len()) }
        fn flush(&mut self) -> std::io::Result<()> { Ok(()) }
    }

    fn replies(answer_queries: bool) -> Vec<u8> {
        let out = Arc::new(Mutex::new(Vec::new()));
        let listener = Listener { writer: Arc::new(Mutex::new(Box::new(Sink(out.clone())))), title: Default::default(), answer_queries };
        let mut term = Term::new(TermConfig::default(), &TermDims { cols: 80, rows: 24 }, listener);
        // Device attributes and cursor position queries, as zsh prompts send them.
        Processor::<alacritty_terminal::vte::ansi::StdSyncHandler>::new().advance(&mut term, b"\x1b[c\x1b[6n");
        let v = out.lock().clone();
        v
    }

    #[test]
    fn relay_viewers_do_not_answer_terminal_queries() {
        let answered = replies(true);
        assert!(answered.windows(2).any(|w| w == b"6c") && answered.contains(&b'R'), "shell terminals answer: {answered:?}");
        assert!(replies(false).is_empty(), "attach viewers must not inject replies into the shell");
    }
}
