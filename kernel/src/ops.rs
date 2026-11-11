//! Capability broker: the single entry point for every host operation requested by JS.
//! Each call is checked against (1) the calling generation's lifecycle status, (2) its effective
//! capability set, (3) handle ownership and kind, and (4) the scope of the grant it presents.
use crate::approvals::{ApprovalOption, Decision};
use crate::bridge::UiMsg;
use crate::grants::{join_relative, normalize_posix, path_within, ScopeGrant, ScopeKind, Target};
use crate::util::canonical_string;
use crate::host::daemon_link;
use crate::host::db::DbRes;
use crate::host::fs as hfs;
use crate::host::net::{NetConn, NetListener};
use crate::host::process::{self, ProcessRes, SpawnSpec};
use crate::host::pty::{self, PtySession, PtySpec};
use crate::host::ssh::{SshMaster, SshProfile};
use crate::host::streams::{ByteStream, Encoding, Subscriber};
use crate::js::worker::op_result_msg;
use crate::quoting::sh_quote;
use crate::kernel::{Kernel, StreamSub};
use crate::router::{GenStatus, Generation, Reply};
use crate::util::{arg_opt_str, arg_str, now_ms, random_hex, uuid_v4, HResult, HostError};
use base64::Engine;
use serde_json::{json, Value};
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::Duration;

/// Opaque SSH connection resource handed to a module.
pub struct SshConnRef {
    pub master: Arc<SshMaster>,
}

pub struct Forward {
    pub master: Arc<SshMaster>,
    pub remote_port: u16,
    pub local_port: u16,
}

impl Drop for Forward {
    fn drop(&mut self) { self.master.cancel_reverse(self.remote_port, self.local_port); }
}

pub struct LocalForward(pub tokio::task::JoinHandle<()>);
impl Drop for LocalForward { fn drop(&mut self) { self.0.abort(); } }

pub struct Document {
    pub workspace_key: String,
    pub path: String,
    pub language: String,
    pub text: String,
    pub created_ms: u64,
}

const MAX_READ: usize = 8 * 1024 * 1024;

fn check_alive(gen: &Generation, mutating: bool) -> HResult<()> {
    let st = gen.status();
    match st {
        GenStatus::Retired | GenStatus::Failed(_) => Err(HostError::new("ESTALE", format!("{} is retired; operation rejected", gen.label()))),
        GenStatus::Draining if mutating => Err(HostError::new("ESTALE", format!("{} is draining; shared-state mutation rejected", gen.label()))),
        _ => Ok(()),
    }
}

// =============================================================================================
// Synchronous ops (cheap, never block)

pub fn host_sync(k: &Arc<Kernel>, gen: &Arc<Generation>, op: &str, args: Value) -> HResult<Value> {
    match op {
        "log" => {
            let level = arg_opt_str(&args, "level").unwrap_or("info");
            let msg = arg_opt_str(&args, "msg").unwrap_or("");
            k.logs.push(&gen.module_id, gen.gen_id, level, msg);
            Ok(Value::Null)
        }
        "random.uuid" => Ok(json!(uuid_v4())),
        "random.hex" => Ok(json!(random_hex(args.get("bytes").and_then(|b| b.as_u64()).unwrap_or(16).min(64) as usize))),
        "env.info" => Ok(json!({
            "abiVersion": 1,
            "appName": "hato",
            "platform": std::env::consts::OS,
            "arch": std::env::consts::ARCH,
            "home": dirs::home_dir().map(|h| h.to_string_lossy().into_owned()),
            "dataDir": k.cfg.data_dir.to_string_lossy(),
            "sharedDir": k.cfg.shared_dir().to_string_lossy(),
            "initialRoot": k.cfg.initial_root.as_ref().map(|p| p.to_string_lossy().into_owned()),
            "repoRoot": k.cfg.repo_root.to_string_lossy(),
            "uptimeMs": k.started.elapsed().as_millis() as u64,
            "headless": k.cfg.headless,
        })),
        "state.get" => {
            let key = arg_str(&args, "key")?;
            Ok(k.state.values.lock().get(key).cloned().unwrap_or(Value::Null))
        }
        "state.set" => {
            check_alive(gen, true)?;
            let key = arg_str(&args, "key")?;
            if !key.starts_with(&format!("{}.", gen.module_id)) {
                return Err(HostError::denied(format!("state key '{key}' is not in namespace '{}.'", gen.module_id)));
            }
            let value = args.get("value").cloned().unwrap_or(Value::Null);
            let changed = {
                let mut vals = k.state.values.lock();
                let prev = vals.insert(key.to_string(), value.clone());
                prev.as_ref() != Some(&value)
            };
            if changed {
                let watchers = k.state.watchers.lock().get(key).cloned().unwrap_or_default();
                let msg = json!({"t": "state", "key": key, "value": value}).to_string();
                for gid in watchers {
                    if let Some(g) = k.router.gen(gid) {
                        if g.status().may_mutate() {
                            let _ = g.tx.send(crate::js::worker::WorkerMsg::Dispatch(msg.clone()));
                        }
                    }
                }
            }
            Ok(Value::Null)
        }
        "state.watch" => {
            let key = arg_str(&args, "key")?;
            k.state.watchers.lock().entry(key.to_string()).or_default().push(gen.gen_id);
            Ok(Value::Null)
        }
        "events.emit" => {
            check_alive(gen, true)?;
            let topic = arg_str(&args, "topic")?;
            let own = topic.starts_with(&format!("{}.", gen.module_id));
            if !own && !gen.caps.has("events.publish:*") {
                return Err(HostError::denied(format!("module '{}' may only emit topics '{}.*'", gen.module_id, gen.module_id)));
            }
            if topic.starts_with("kernel.") {
                return Err(HostError::denied("kernel.* topics are reserved"));
            }
            k.router.emit(topic, args.get("payload").unwrap_or(&Value::Null));
            Ok(Value::Null)
        }
        "events.subscribe" => {
            check_alive(gen, false)?;
            k.router.subscribe(gen.gen_id, arg_str(&args, "topic")?);
            Ok(Value::Null)
        }
        "events.unsubscribe" => {
            k.router.unsubscribe(gen.gen_id, arg_str(&args, "topic")?);
            Ok(Value::Null)
        }
        "ui.invalidate" => {
            check_alive(gen, true)?;
            let target = arg_opt_str(&args, "moduleId").unwrap_or(&gen.module_id).to_string();
            if gen.status() == GenStatus::Active || target != gen.module_id {
                k.request_render(&target);
            }
            Ok(Value::Null)
        }
        "ui.toast" => {
            k.ui.send(UiMsg::Toast { level: arg_opt_str(&args, "level").unwrap_or("info").into(), text: format!("{}: {}", gen.module_id, arg_opt_str(&args, "text").unwrap_or("")) });
            Ok(Value::Null)
        }
        "streams.ack" => {
            let sub = arg_str(&args, "subId")?;
            let n = args.get("bytes").and_then(|b| b.as_u64()).unwrap_or(0) as usize;
            let s = k.subs.lock().get(sub).map(|s| s.stream.clone());
            if let Some(s) = s {
                s.ack(sub, n);
            }
            Ok(Value::Null)
        }
        _ => Err(HostError::invalid(format!("unknown sync op '{op}'"))),
    }
}

// =============================================================================================
// Asynchronous ops

pub fn host_async(k: &Arc<Kernel>, gen: &Arc<Generation>, op: String, args: Value, call_id: u64) {
    let tx = gen.tx.clone();
    if let Err(e) = check_alive(gen, false) {
        let _ = tx.send(op_result_msg(call_id, Err(e)));
        return;
    }
    // RPC is routed without a thread hop.
    if op == "modules.call" {
        let r = (|| -> HResult<()> {
            let target = arg_str(&args, "target")?.to_string();
            let method = arg_str(&args, "method")?.to_string();
            if !gen.caps.may_call(&target) {
                return Err(HostError::denied(format!("module '{}' is not allowed to call '{target}'", gen.module_id)));
            }
            let timeout = args.get("timeoutMs").and_then(|t| t.as_u64()).unwrap_or(30000).clamp(100, 30 * 60 * 1000);
            k.router.invoke(
                &target,
                json!({"kind": "call", "method": method, "args": args.get("args").cloned().unwrap_or(Value::Null), "caller": gen.module_id}),
                Reply::Worker { tx: tx.clone(), call_id },
                Duration::from_millis(timeout),
            );
            Ok(())
        })();
        if let Err(e) = r {
            let _ = tx.send(op_result_msg(call_id, Err(e)));
        }
        return;
    }
    let k = k.clone();
    let gen = gen.clone();
    let spawn = std::thread::Builder::new().name(format!("op:{op}")).spawn(move || {
        let r = dispatch(&k, &gen, &op, &args);
        if let Err(e) = &r {
            if e.code == "EPERM" || e.code == "EDENIED" {
                k.audit.record(&gen.module_id, gen.gen_id, &op, &audit_summary(&op, &args), &format!("{e}"), None);
            }
        }
        let _ = gen.tx.send(op_result_msg(call_id, r));
    });
    if spawn.is_err() {
        let _ = tx.send(op_result_msg(call_id, Err(HostError::new("EAGAIN", "cannot spawn op thread"))));
    }
}

/// Audit text for an op. Requests that can carry credentials (headers, form bodies) are reduced
/// to their method and host/path.
fn audit_summary(op: &str, args: &Value) -> String {
    if op == "net.fetch" {
        let url = args.get("url").and_then(|u| u.as_str()).unwrap_or("");
        let target = crate::host::http::check_url(url).unwrap_or_else(|_| url.split(['?', '#']).next().unwrap_or("").chars().take(200).collect());
        return format!("{} {target}", args.get("method").and_then(|m| m.as_str()).unwrap_or("GET"));
    }
    summarize(args)
}

fn summarize(v: &Value) -> String {
    let s = v.to_string();
    if s.len() > 300 { format!("{}…", &s[..s.char_indices().nth(300).map(|c| c.0).unwrap_or(s.len())]) } else { s }
}

fn grant(k: &Kernel, gen: &Generation, args: &Value) -> HResult<Arc<ScopeGrant>> {
    let h = arg_str(args, "grant")?;
    let g: Arc<ScopeGrant> = k.handles.get(h, "grant", &gen.module_id)?;
    g.check_live()?;
    Ok(g)
}

fn ssh_for(k: &Kernel, t: &Target) -> Option<Arc<SshMaster>> {
    match t {
        Target::Local => None,
        Target::Ssh { machine_id, .. } => k.ssh.by_machine(machine_id),
    }
}

fn protected(k: &Kernel, path: &str) -> bool {
    k.cfg.protected_dirs().iter().any(|p| {
        let ps = p.to_string_lossy();
        path_within(&ps, path)
    })
}

fn decode_text_arg(args: &Value) -> HResult<Vec<u8>> {
    if let Some(t) = args.get("text").and_then(|t| t.as_str()) {
        return Ok(t.as_bytes().to_vec());
    }
    if let Some(b) = args.get("base64").and_then(|t| t.as_str()) {
        return base64::engine::general_purpose::STANDARD.decode(b).map_err(|e| HostError::invalid(e.to_string()));
    }
    Err(HostError::invalid("missing 'text' or 'base64'"))
}

fn dispatch(k: &Arc<Kernel>, gen: &Arc<Generation>, op: &str, args: &Value) -> HResult<Value> {
    let owner = gen.module_id.as_str();
    if op.starts_with("test.") {
        return crate::headless::driver_op(k, gen, op, args);
    }
    match op {
        // ---------------------------------------------------------------- capabilities
        "capabilities.request" => request_grant(k, gen, args),
        "capabilities.release" => {
            let h = arg_str(args, "grant")?;
            let e = k.handles.remove(h, owner)?;
            if let Ok(g) = e.res.downcast::<ScopeGrant>() {
                g.revoked.store(true, std::sync::atomic::Ordering::SeqCst);
            }
            Ok(Value::Null)
        }

        // ---------------------------------------------------------------- filesystem
        "fs.watch" => {
            let g = grant(k, gen, args)?;
            if !matches!(g.kind, ScopeKind::Fs | ScopeKind::Source) {
                return Err(HostError::denied("grant does not allow file access"));
            }
            let ssh = ssh_for(k, &g.target);
            let be = hfs::backend(&g, ssh.clone())?;
            let real = hfs::resolve(&g, &be, arg_opt_str(args, "path").unwrap_or("."), true)?;
            if g.target == Target::Local && protected(k, &real) {
                return Err(HostError::denied("path is inside kernel-protected application state"));
            }
            let bin = if let Some(master) = &ssh {
                gen.caps.require("remote.daemon")?;
                daemon_link::ensure_ssh(&k.daemons, master, &k.cfg.data_dir, &k.cfg.repo_root)?.bin
            } else { std::env::current_exe()?.to_string_lossy().into_owned() };
            let mut argv = vec!["daemon".into(), "watch".into(), "--path".into(), real.clone()];
            if args.get("recursive").and_then(Value::as_bool) == Some(false) { argv.push("--non-recursive".into()); }
            let p = process::spawn(SpawnSpec {
                target: g.target.clone(), ssh, executable: bin, args: argv, cwd: g.root.clone(),
                env: vec![], env_remove: vec![], login_shell: false, persist: None,
            })?;
            let handle = k.handles.insert("process", owner, format!("watch {real}"), p);
            Ok(json!({"handle": handle}))
        }
        "fs.stat" | "fs.list" | "fs.read" | "fs.realpath" => {
            let g = grant(k, gen, args)?;
            if !matches!(g.kind, ScopeKind::Fs | ScopeKind::Source) {
                return Err(HostError::denied("grant does not allow file access"));
            }
            let be = hfs::backend(&g, ssh_for(k, &g.target))?;
            let rel = arg_opt_str(args, "path").unwrap_or(".");
            let real = hfs::resolve(&g, &be, rel, true)?;
            if g.target == Target::Local && protected(k, &real) {
                return Err(HostError::denied("path is inside kernel-protected application state"));
            }
            match op {
                "fs.realpath" => Ok(json!(real)),
                "fs.stat" => {
                    let mut s = hfs::stat(&be, &real)?;
                    s["path"] = json!(real);
                    Ok(s)
                }
                "fs.list" => {
                    let entries = hfs::list(&be, &real)?;
                    Ok(json!({"path": real, "entries": entries}))
                }
                _ => {
                    let limit = args.get("limitBytes").and_then(|l| l.as_u64()).unwrap_or(2 * 1024 * 1024).min(MAX_READ as u64) as usize;
                    let (bytes, truncated) = hfs::read(&be, &real, limit)?;
                    let sniff = &bytes[..bytes.len().min(8192)];
                    let binary = sniff.contains(&0) || matches!(std::str::from_utf8(sniff), Err(e) if e.error_len().is_some());
                    if binary {
                        Ok(json!({"path": real, "binary": true, "size": bytes.len(), "truncated": truncated, "base64": base64::engine::general_purpose::STANDARD.encode(&bytes[..bytes.len().min(64 * 1024)])}))
                    } else {
                        Ok(json!({"path": real, "binary": false, "size": bytes.len(), "truncated": truncated, "text": String::from_utf8_lossy(&bytes)}))
                    }
                }
            }
        }
        "fs.writeAtomic" | "fs.mkdir" => {
            let g = grant(k, gen, args)?;
            if !g.write || !matches!(g.kind, ScopeKind::Fs | ScopeKind::Source) {
                return Err(HostError::denied("grant is read-only"));
            }
            let be = hfs::backend(&g, ssh_for(k, &g.target))?;
            let rel = arg_str(args, "path")?;
            let real = hfs::resolve(&g, &be, rel, false)?;
            if g.target == Target::Local && protected(k, &real) {
                return Err(HostError::denied("path is inside kernel-protected application state"));
            }
            if op == "fs.mkdir" {
                hfs::mkdir_p(&be, &g.root, &real)?;
                return Ok(json!({"path": real}));
            }
            let data = decode_text_arg(args)?;
            if data.len() > MAX_READ {
                return Err(HostError::new("E2BIG", "file too large"));
            }
            if g.kind == ScopeKind::Source {
                // Kernel-computed diff in trusted chrome; per-operation approval.
                let old = std::fs::read(&real).unwrap_or_default();
                let old_s = String::from_utf8_lossy(&old);
                let new_s = String::from_utf8_lossy(&data);
                let rel_disp = real.strip_prefix(&g.root).unwrap_or(&real).trim_start_matches('/');
                let diff = similar::TextDiff::from_lines(old_s.as_ref(), new_s.as_ref())
                    .unified_diff()
                    .context_radius(3)
                    .header(&format!("a/{rel_disp}"), &format!("b/{rel_disp}"))
                    .to_string();
                let reason = arg_opt_str(args, "reason").unwrap_or("");
                let detail = format!("Module '{}' wants to modify module source:\n  modules/{rel_disp}\n{}\n{}",
                    gen.module_id,
                    if reason.is_empty() { String::new() } else { format!("Reason (module-supplied): {reason}\n") },
                    if diff.len() > 60_000 { format!("{}\n… (diff truncated)", &diff[..60_000]) } else { diff });
                k.require_approval(gen, "modules.source.write", &format!("Apply patch to modules/{rel_disp}?"), &detail)?;
            }
            let mode = args.get("mode").and_then(|m| m.as_u64()).unwrap_or(0o644) as u32 & 0o755;
            hfs::write_atomic(&be, &real, &data, mode)?;
            k.audit.record(owner, gen.gen_id, op, &real, "ok", None);
            Ok(json!({"path": real, "bytes": data.len()}))
        }

        // ---------------------------------------------------------------- processes
        "process.spawn" | "process.run" => {
            let g = grant(k, gen, args)?;
            let req = args.get("request").ok_or_else(|| HostError::invalid("missing request"))?;
            let mut spec = spawn_spec(k, &g, req)?;
            if op == "process.spawn" {
                spec.persist = persist_target(k, gen, req, &g.target)?;
            }
            let p = process::spawn(spec)?;
            if op == "process.run" {
                let timeout = args.get("timeoutMs").and_then(|t| t.as_u64()).unwrap_or(60_000).min(30 * 60_000);
                let limit = args.get("limitBytes").and_then(|t| t.as_u64()).unwrap_or(1 << 20).min(8 << 20) as usize;
                let stdin = args.get("stdin").and_then(|s| s.as_str()).map(|s| s.as_bytes().to_vec());
                return process::run_collect(&p, stdin.as_deref(), Duration::from_millis(timeout), limit);
            }
            let h = k.handles.insert("process", owner, p.description.clone(), p.clone());
            k.audit.record(owner, gen.gen_id, "process.spawn", &format!("{} on {}", p.description, p.machine_id), "ok", None);
            Ok(json!({"handle": h, "pid": p.pid, "machineId": p.machine_id}))
        }
        "process.write" => {
            let p: Arc<ProcessRes> = k.handles.get(arg_str(args, "handle")?, "process", owner)?;
            p.write(&decode_text_arg(args)?)?;
            Ok(Value::Null)
        }
        "process.closeStdin" => {
            let p: Arc<ProcessRes> = k.handles.get(arg_str(args, "handle")?, "process", owner)?;
            p.close_stdin();
            Ok(Value::Null)
        }
        "process.terminate" => {
            let p: Arc<ProcessRes> = k.handles.get(arg_str(args, "handle")?, "process", owner)?;
            p.terminate(arg_opt_str(args, "signal"))?;
            Ok(Value::Null)
        }
        "process.wait" => {
            let p: Arc<ProcessRes> = k.handles.get(arg_str(args, "handle")?, "process", owner)?;
            let t = args.get("timeoutMs").and_then(|t| t.as_u64()).map(Duration::from_millis);
            Ok(p.wait(t).map(|e| e.to_json()).unwrap_or(Value::Null))
        }
        "process.info" => {
            let p: Arc<ProcessRes> = k.handles.get(arg_str(args, "handle")?, "process", owner)?;
            Ok(p.info())
        }

        // ---------------------------------------------------------------- PTY
        "pty.open" => {
            let g = grant(k, gen, args)?;
            if g.kind != ScopeKind::Pty {
                return Err(HostError::denied("grant does not allow terminals"));
            }
            let req = args.get("request").ok_or_else(|| HostError::invalid("missing request"))?;
            let cwd = req.get("cwd").and_then(|c| c.as_str()).unwrap_or(&g.root);
            let cols = req.get("columns").and_then(|c| c.as_u64()).unwrap_or(100) as u16;
            let rows = req.get("rows").and_then(|c| c.as_u64()).unwrap_or(30) as u16;
            let shell = req.get("shell").and_then(|c| c.as_str());
            check_target(&g, req)?;
            let persist = persist_target(k, gen, req, &g.target)?;
            let spec = match &g.target {
                Target::Local => {
                    let real = canonical_string(std::path::Path::new(cwd)).map_err(HostError::from)?;
                    if !path_within(&g.root, &real) {
                        return Err(HostError::denied("terminal cwd outside granted root"));
                    }
                    let sh = shell.map(|s| s.to_string()).or_else(|| std::env::var("SHELL").ok()).unwrap_or_else(|| if cfg!(windows) { "powershell.exe".into() } else { "/bin/sh".into() });
                    let login = if cfg!(windows) { vec![] } else { vec!["-l".to_string()] };
                    match &persist {
                        Some(p) => PtySpec { remote: None, program: p.bin.clone(), args: vec!["daemon".into(), "pty-attach".into(), "--dir".into(), p.dir.clone(), "--key".into(), p.key.clone(), "--cwd".into(), real.clone(), "--shell".into(), sh],
                            cwd: Some(real.clone()), env: env_pairs(req)?, cols, rows, machine_id: "local".into(), display_cwd: real, answer_queries: false },
                        None => PtySpec { remote: None, program: sh, args: login, cwd: Some(real.clone()), env: env_pairs(req)?, cols, rows, machine_id: "local".into(), display_cwd: real, answer_queries: true },
                    }
                }
                Target::Ssh { machine_id, .. } => {
                    let master = k.ssh.by_machine(machine_id).ok_or_else(|| HostError::new("ENOTCONN", "SSH connection unavailable"))?;
                    master.ensure_alive()?;
                    let n = normalize_posix(cwd).ok_or_else(|| HostError::invalid("cwd must be absolute"))?;
                    let real = master.sftp()?.realpath(&n)?;
                    if !path_within(&g.root, &real) {
                        return Err(HostError::denied("terminal cwd outside granted root"));
                    }
                    let remote = match &persist {
                        Some(p) => format!("{} daemon pty-attach --dir {} --key {} --cwd {}{}", sh_quote(&p.bin), sh_quote(&p.dir), sh_quote(&p.key), sh_quote(&real),
                            shell.map(|s| format!(" --shell {}", sh_quote(s))).unwrap_or_default()),
                        None => crate::quoting::remote_shell(&real, shell),
                    };
                    let answer_queries = persist.is_none();
                    if master.is_wsl() {
                        let (program, pty_args) = master.wsl_pty_command(&remote);
                        PtySpec { remote: None, program, args: pty_args, cwd: None, env: vec![], cols, rows, machine_id: machine_id.clone(), display_cwd: real, answer_queries }
                    } else {
                        PtySpec { remote: Some(pty::RemotePty { master: master.clone(), command: remote }), program: String::new(), args: vec![], cwd: None, env: vec![],
                            cols, rows, machine_id: machine_id.clone(), display_cwd: real, answer_queries }
                    }
                }
            };
            let sess = pty::open(spec)?;
            let h = k.handles.insert("pty", owner, format!("pty {}", sess.cwd), sess.clone());
            let ui = k.ui.clone();
            let h2 = h.clone();
            *sess.notify.lock() = Some(Arc::new(move || ui.send(UiMsg::TerminalDirty(h2.clone()))));
            k.audit.record(owner, gen.gen_id, "pty.open", &format!("{} {}", sess.machine_id, sess.cwd), "ok", None);
            Ok(json!({"handle": h, "machineId": sess.machine_id, "cwd": sess.cwd}))
        }
        "pty.write" => {
            let p: Arc<PtySession> = k.handles.get(arg_str(args, "handle")?, "pty", owner)?;
            p.write(&decode_text_arg(args)?)?;
            Ok(Value::Null)
        }
        "pty.resize" => {
            let p: Arc<PtySession> = k.handles.get(arg_str(args, "handle")?, "pty", owner)?;
            p.resize(args.get("columns").and_then(|c| c.as_u64()).unwrap_or(80) as u16, args.get("rows").and_then(|c| c.as_u64()).unwrap_or(24) as u16)?;
            Ok(Value::Null)
        }
        "pty.close" => {
            let h = arg_str(args, "handle")?;
            let p: Arc<PtySession> = k.handles.get(h, "pty", owner)?;
            p.kill();
            k.handles.remove(h, owner)?;
            Ok(Value::Null)
        }
        "pty.read" => {
            let p: Arc<PtySession> = k.handles.get(arg_str(args, "handle")?, "pty", owner)?;
            let cursor = match args.get("cursor") {
                None | Some(Value::Null) => None,
                Some(value) => Some(value.as_u64().ok_or_else(|| HostError::invalid("invalid output cursor"))?),
            };
            let limit = args.get("limitBytes").and_then(|n| n.as_u64()).unwrap_or(65536).min(65536) as usize;
            Ok(p.read_output(cursor, limit))
        }
        "pty.info" => {
            let p: Arc<PtySession> = k.handles.get(arg_str(args, "handle")?, "pty", owner)?;
            let mut i = p.info();
            i["screen"] = json!(p.screen_text());
            Ok(i)
        }

        // ---------------------------------------------------------------- SSH
        "ssh.connect" => {
            gen.caps.require("ssh.connect")?;
            let profile: SshProfile = serde_json::from_value(args.get("profile").cloned().unwrap_or(Value::Null)).map_err(|e| HostError::invalid(format!("profile: {e}")))?;
            profile.validate()?;
            let master = k.ssh.get_or_create(&profile)?;
            master.connect(&k.approvals, owner, gen.gen_id, args["interactive"].as_bool().unwrap_or(false))?;
            let home = master.sftp().and_then(|s| s.realpath(".")).ok();
            let key = format!("ssh:{}", profile.machine_id());
            let h = match k.handles.lookup(owner, &key) {
                Some(h) => h,
                None => {
                    let h = k.handles.insert("ssh", owner, profile.machine_id(), Arc::new(SshConnRef { master: master.clone() }));
                    k.handles.retain(&h, owner, &key)?;
                    h
                }
            };
            k.audit.record(owner, gen.gen_id, "ssh.connect", &profile.label(), "ok", None);
            Ok(json!({"connection": h, "machineId": profile.machine_id(), "home": home}))
        }
        "ssh.wslDistributions" => {
            gen.caps.require("ssh.connect")?;
            Ok(json!(crate::host::wsl::distributions()?))
        }
        "ssh.status" => {
            let c: Arc<SshConnRef> = k.handles.get(arg_str(args, "connection")?, "ssh", owner)?;
            Ok(c.master.status_json())
        }
        "ssh.disconnect" => {
            gen.caps.require("ssh.connect")?;
            let c: Arc<SshConnRef> = k.handles.get(arg_str(args, "connection")?, "ssh", owner)?;
            c.master.disconnect();
            k.audit.record(owner, gen.gen_id, "ssh.disconnect", &c.master.profile.machine_id(), "ok", None);
            Ok(Value::Null)
        }
        "ssh.forwardLoopback" => {
            gen.caps.require("ssh.forward")?;
            let c: Arc<SshConnRef> = k.handles.get(arg_str(args, "connection")?, "ssh", owner)?;
            let lh = arg_str(args, "listener")?;
            let l: Arc<NetListener> = k.handles.get(lh, "listener", owner)?;
            let rport = daemon_link::forward_reverse(&c.master, l.port, &k.cfg.data_dir, &k.cfg.repo_root)?;
            let f = Arc::new(Forward { master: c.master.clone(), remote_port: rport, local_port: l.port });
            let h = k.handles.insert("forward", owner, format!("{}:127.0.0.1:{rport}->127.0.0.1:{}", c.master.profile.machine_id(), l.port), f);
            k.audit.record(owner, gen.gen_id, "ssh.forwardLoopback", &format!("{} remote 127.0.0.1:{rport} -> local 127.0.0.1:{}", c.master.profile.machine_id(), l.port), "ok", None);
            Ok(json!({"handle": h, "remotePort": rport, "localPort": l.port}))
        }
        "ssh.localForward" => {
            gen.caps.require("ssh.forward")?;
            let c: Arc<SshConnRef> = k.handles.get(arg_str(args, "connection")?, "ssh", owner)?;
            let port = args["localPort"].as_u64().filter(|p| *p <= 65535).ok_or_else(|| HostError::invalid("invalid local port"))? as u16;
            let target_port = args["remotePort"].as_u64().filter(|p| *p > 0 && *p <= 65535).ok_or_else(|| HostError::invalid("invalid remote port"))? as u16;
            let host = arg_str(args, "remoteHost")?.trim();
            if host.is_empty() || host.len() > 255 || host.chars().any(|c| c.is_control() || c.is_whitespace()) { return Err(HostError::invalid("invalid remote host")); }
            let (task, actual) = c.master.local_forward(port, host.to_string(), target_port)?;
            let h = k.handles.insert("local-forward", owner, format!("127.0.0.1:{actual}->{host}:{target_port}"), Arc::new(LocalForward(task)));
            k.audit.record(owner, gen.gen_id, "ssh.localForward", &format!("{} 127.0.0.1:{actual} -> {host}:{target_port}", c.master.profile.machine_id()), "ok", None);
            Ok(json!({"handle": h, "localPort": actual}))
        }
        "ssh.cancelForward" => {
            k.handles.remove(arg_str(args, "handle")?, owner)?;
            Ok(Value::Null)
        }

        // ---------------------------------------------------------------- loopback net
        "net.fetch" => {
            gen.caps.require("net.fetch")?;
            let r = crate::host::http::fetch(args);
            let status = r.as_ref().map(|v| v["status"].to_string()).unwrap_or_else(|e| e.code.clone());
            k.audit.record(owner, gen.gen_id, "net.fetch", &audit_summary(op, args), &status, None);
            r
        }
        "net.listen" => {
            gen.caps.require("net.loopback")?;
            let kk = k.clone();
            let own = owner.to_string();
            let port = args.get("port").and_then(|p| p.as_u64()).unwrap_or(0);
            if port != 0 && !(1024..=65535).contains(&port) { return Err(HostError::invalid("port must be 0 or 1024–65535")); }
            let l = NetListener::bind_port(port as u16, Arc::new(move |conn: Arc<NetConn>| kk.handles.insert("netconn", &own, conn.peer.clone(), conn)))?;
            let h = k.handles.insert("listener", owner, format!("127.0.0.1:{}", l.port), l.clone());
            Ok(json!({"handle": h, "port": l.port}))
        }
        "net.write" => {
            let c: Arc<NetConn> = k.handles.get(arg_str(args, "handle")?, "netconn", owner)?;
            c.write(&decode_text_arg(args)?)?;
            Ok(Value::Null)
        }
        "net.close" => {
            let h = arg_str(args, "handle")?;
            match k.handles.kind_of(h) {
                Some("netconn") => {
                    let c: Arc<NetConn> = k.handles.get(h, "netconn", owner)?;
                    c.close();
                }
                Some("listener") => {
                    let l: Arc<NetListener> = k.handles.get(h, "listener", owner)?;
                    l.close();
                }
                _ => return Err(HostError::new("EBADF", "not a network handle")),
            }
            k.handles.remove(h, owner)?;
            Ok(Value::Null)
        }

        // ---------------------------------------------------------------- SQLite
        "db.open" => {
            let ns = arg_str(args, "namespace")?;
            gen.caps.require(&format!("db:{ns}"))?;
            let key = format!("db:{ns}");
            if let Some(h) = k.handles.lookup(owner, &key) {
                return Ok(json!(h));
            }
            let db = Arc::new(DbRes::open(&k.cfg.sqlite_dir(), ns)?);
            let h = k.handles.insert("db", owner, key.clone(), db);
            k.handles.retain(&h, owner, &key)?;
            Ok(json!(h))
        }
        "db.query" | "db.exec" | "db.transaction" => {
            let db: Arc<DbRes> = k.handles.get(arg_str(args, "db")?, "db", owner)?;
            gen.caps.require(&format!("db:{}", db.namespace))?;
            match op {
                "db.query" => db.query(arg_str(args, "sql")?, args.get("params").unwrap_or(&Value::Null)),
                "db.exec" => db.exec(arg_str(args, "sql")?, args.get("params").unwrap_or(&Value::Null)),
                _ => db.transaction(args.get("statements").unwrap_or(&Value::Null)),
            }
        }

        // ---------------------------------------------------------------- streams
        "streams.subscribe" => {
            let h = arg_str(args, "handle")?;
            let sub_id = arg_str(args, "subId")?.to_string();
            if !sub_id.starts_with(&format!("{}:{}:", gen.module_id, gen.gen_id)) {
                return Err(HostError::invalid("bad subscription id"));
            }
            let channel = arg_opt_str(args, "channel").unwrap_or("stdout");
            let stream: Arc<ByteStream> = match k.handles.kind_of(h) {
                Some("process") => {
                    let p: Arc<ProcessRes> = k.handles.get(h, "process", owner)?;
                    if channel == "stderr" { p.stderr.clone() } else { p.stdout.clone() }
                }
                Some("netconn") => k.handles.get::<NetConn>(h, "netconn", owner)?.stream.clone(),
                Some("listener") => k.handles.get::<NetListener>(h, "listener", owner)?.events.clone(),
                _ => return Err(HostError::new("EBADF", "handle has no stream")),
            };
            let encoding = if arg_opt_str(args, "encoding") == Some("base64") { Encoding::Base64 } else { Encoding::Utf8 };
            let hwm = args.get("highWaterMark").and_then(|x| x.as_u64()).unwrap_or(1 << 20).clamp(4096, 16 << 20) as usize;
            // Replace this module's previous subscription to the same stream (generation hand-over).
            {
                let mut subs = k.subs.lock();
                let stale: Vec<String> = subs.iter().filter(|(_, s)| Arc::ptr_eq(&s.stream, &stream) && s.module_id == gen.module_id).map(|(k, _)| k.clone()).collect();
                for s in stale {
                    subs.remove(&s);
                }
            }
            let paused = k.router.is_fenced(&gen.module_id) && gen.status() == GenStatus::Active;
            stream.subscribe(Subscriber { sub_id: sub_id.clone(), module_id: gen.module_id.clone(), gen_id: gen.gen_id, encoding, hwm, tx: gen.tx.clone(), paused }).map_err(HostError::denied)?;
            k.subs.lock().insert(sub_id.clone(), StreamSub { stream, module_id: gen.module_id.clone(), gen_id: gen.gen_id });
            Ok(json!({"subId": sub_id}))
        }
        "streams.unsubscribe" => {
            let sub_id = arg_str(args, "subId")?;
            let s = k.subs.lock().remove(sub_id);
            if let Some(s) = s {
                if s.module_id != gen.module_id {
                    return Err(HostError::denied("not your subscription"));
                }
                s.stream.unsubscribe(sub_id);
            }
            Ok(Value::Null)
        }

        // ---------------------------------------------------------------- resources
        "resources.retain" => {
            k.handles.retain(arg_str(args, "handle")?, owner, arg_str(args, "stableKey")?)?;
            Ok(Value::Null)
        }
        "resources.lookup" => Ok(k.handles.lookup(owner, arg_str(args, "stableKey")?).map(Value::String).unwrap_or(Value::Null)),
        "resources.info" => {
            let h = arg_str(args, "handle")?;
            if k.handles.owner_of(h).as_deref() != Some(owner) {
                return Err(HostError::denied("not your handle"));
            }
            let mut i = k.handles.info(h).unwrap_or(Value::Null);
            match k.handles.kind_of(h) {
                Some("pty") => {
                    let p: Arc<PtySession> = k.handles.get(h, "pty", owner)?;
                    i["pty"] = p.info();
                }
                Some("process") => {
                    let p: Arc<ProcessRes> = k.handles.get(h, "process", owner)?;
                    i["process"] = p.info();
                }
                _ => {}
            }
            Ok(i)
        }
        "resources.release" => {
            let h = arg_str(args, "handle")?;
            match k.handles.kind_of(h) {
                Some("pty") => {
                    let p: Arc<PtySession> = k.handles.get(h, "pty", owner)?;
                    p.kill();
                }
                Some("process") => {
                    let p: Arc<ProcessRes> = k.handles.get(h, "process", owner)?;
                    let _ = p.terminate(None);
                }
                _ => {}
            }
            k.handles.remove(h, owner)?;
            Ok(Value::Null)
        }

        // ---------------------------------------------------------------- module lifecycle
        "modules.list" => {
            gen.caps.require("modules.read")?;
            Ok(k.modules_json())
        }
        "modules.describe" => {
            gen.caps.require("modules.read")?;
            let id = arg_str(args, "id")?;
            let (m, dir) = k.source_manifest(id)?;
            let all = k.modules_json();
            let status = all.as_array().and_then(|a| a.iter().find(|x| x["id"] == id).cloned()).unwrap_or(Value::Null);
            let grant = k.grants.install_grant(id).cloned();
            let rel = dir.strip_prefix(k.cfg.plugin_root()).map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
            Ok(json!({"manifest": m, "sourceDir": rel, "installGrant": grant, "status": status, "logs": k.logs.tail(id, 20)}))
        }
        "modules.logs" => {
            gen.caps.require("modules.read")?;
            let id = arg_str(args, "id")?;
            let limit = args.get("limit").and_then(|l| l.as_u64()).unwrap_or(100).min(600) as usize;
            Ok(json!(k.logs.tail(id, limit)))
        }
        "modules.sourceInfo" => {
            gen.caps.require("modules.read")?;
            Ok(json!({"repoRoot": k.cfg.plugin_root().to_string_lossy(), "sdkRoot": k.cfg.repo_root.join("sdk").to_string_lossy(), "modulesRoot": k.cfg.modules_dir().to_string_lossy(),
                      "buildTool": k.cfg.build_tool().map(|p| p.to_string_lossy().into_owned())}))
        }
        "modules.stage" => {
            gen.caps.require("modules.admin")?;
            let id = arg_str(args, "id")?;
            let code = arg_str(args, "code")?;
            k.stage(gen, id, code, "build", true)
        }
        "modules.activate" => {
            gen.caps.require("modules.admin")?;
            let force = args.get("force").and_then(|v| v.as_bool()).unwrap_or(false);
            k.activate_staged(Some(gen), arg_str(args, "id")?, arg_str(args, "stageId")?, true, force)
        }
        "modules.rollback" => {
            gen.caps.require("modules.admin")?;
            let to = args.get("toVersion").and_then(|v| v.as_u64()).map(|v| v as u32);
            let force = args.get("force").and_then(|v| v.as_bool()).unwrap_or(false);
            k.rollback(Some(gen), arg_str(args, "id")?, to, true, force)
        }
        "modules.discard" => {
            gen.caps.require("modules.admin")?;
            k.discard(arg_str(args, "stageId")?)?;
            Ok(Value::Null)
        }

        // ---------------------------------------------------------------- plugins
        // Listing is plain metadata (layouts need it to discover panels); mutations need
        // `plugins.manage`, and anything that widens trust also needs a native approval.
        "plugins.list" => Ok(k.plugins_json()),
        "plugins.providers" => Ok(json!(k.providers(arg_str(args, "contract")?))),
        "plugins.dependents" => Ok(json!(k.dependents_of(arg_str(args, "id")?))),
        "plugins.enable" => {
            gen.caps.require("plugins.manage")?;
            k.enable_plugin(Some(gen), arg_str(args, "id")?)
        }
        "plugins.disable" => {
            gen.caps.require("plugins.manage")?;
            let cascade = args.get("cascade").and_then(|c| c.as_bool()).unwrap_or(false);
            k.disable_plugin(Some(gen), arg_str(args, "id")?, cascade)
        }
        "plugins.setRoot" => {
            gen.caps.require("plugins.manage")?;
            k.set_root_plugin(arg_opt_str(args, "id"))?;
            Ok(Value::Null)
        }
        "plugins.install" => {
            gen.caps.require("plugins.manage")?;
            k.install_plugin(gen, arg_str(args, "path")?)
        }
        "plugins.installMany" => {
            gen.caps.require("plugins.manage")?;
            let paths: Vec<String> = serde_json::from_value(args.get("paths").cloned().unwrap_or(Value::Null)).map_err(|_| HostError::invalid("paths must be an array of strings"))?;
            k.install_plugins(gen, &paths)
        }
        "plugins.rollback" => {
            gen.caps.require("plugins.manage")?;
            k.rollback_plugin(gen, arg_str(args, "id")?)
        }
        "plugins.uninstall" => {
            gen.caps.require("plugins.manage")?;
            k.uninstall_plugin(gen, arg_str(args, "id")?)
        }
        "plugins.rescan" => {
            gen.caps.require("plugins.manage")?;
            Ok(k.rescan_plugins())
        }

        // ---------------------------------------------------------------- remote runtime
        "daemon.ensure" => {
            gen.caps.require("remote.daemon")?;
            let info = match daemon_target(k, owner, args)? {
                None => daemon_link::ensure_local(&k.daemons)?,
                Some(m) => daemon_link::ensure_ssh(&k.daemons, &m, &k.cfg.data_dir, &k.cfg.repo_root)?,
            };
            k.audit.record(owner, gen.gen_id, "daemon.ensure", &info.machine_id, "ok", None);
            Ok(daemon_link::status_json(&info))
        }
        "daemon.status" => {
            gen.caps.require("remote.daemon")?;
            let machine = daemon_target(k, owner, args)?.map(|m| m.profile.machine_id()).unwrap_or_else(|| "local".into());
            Ok(k.daemons.get(&machine).map(|i| daemon_link::status_json(&i)).unwrap_or(Value::Null))
        }
        "daemon.request" => {
            gen.caps.require("remote.daemon")?;
            let master = daemon_target(k, owner, args)?;
            let machine = master.as_ref().map(|m| m.profile.machine_id()).unwrap_or_else(|| "local".into());
            let info = k.daemons.get(&machine).ok_or_else(|| HostError::new("EDAEMON", format!("no daemon on {machine}; call daemon.ensure first")))?;
            let op = arg_str(args, "op")?;
            if !daemon_link::allowed_op(op) {
                return Err(HostError::denied(format!("daemon op '{op}' is not available to modules")));
            }
            let mut dargs = args.get("args").cloned().unwrap_or(json!({}));
            // `remote.daemon.admin` (e.g. a remote-runtime manager) sees and stops every module's
            // resources using full `<module>/<key>` keys; everyone else only their own.
            let admin = gen.caps.has("remote.daemon.admin");
            match op {
                "pty.read" | "pty.write" | "pty.kill" | "proc.kill" | "proc.closeStdin" => {
                    let raw = dargs["key"].as_str().unwrap_or("");
                    let key = if admin && raw.contains('/') { raw.to_string() } else { daemon_link::scoped_key(owner, raw)? };
                    dargs["key"] = json!(key);
                }
                // Only plugins installed and approved on this desktop may be pushed, with exactly
                // the permissions approved here.
                "plugins.push" => dargs = push_payload(k, dargs["id"].as_str().unwrap_or(""))?,
                _ => {}
            }
            let r = daemon_link::request(&k.daemons, &info, master.as_ref(), &json!({"op": op, "args": dargs}))?;
            if (op == "resources.list" || op == "hello" || op == "status") && !admin {
                return Ok(own_resources(r, owner));
            }
            if op == "plugins.push" {
                k.audit.record(owner, gen.gen_id, "daemon.pushPlugin", &format!("{} to {machine}", r["id"].as_str().unwrap_or("?")), "ok", None);
            }
            Ok(r)
        }

        // ---------------------------------------------------------------- approvals (module-sourced)
        "approvals.request" => {
            gen.caps.require("approvals.request")?;
            let title = arg_str(args, "title")?;
            let detail = arg_opt_str(args, "detail").unwrap_or("");
            let mut options: Vec<ApprovalOption> = Vec::new();
            if let Some(arr) = args.get("options").and_then(|o| o.as_array()) {
                for o in arr.iter().take(6) {
                    options.push(ApprovalOption {
                        id: o.get("id").and_then(|x| x.as_str()).unwrap_or("").chars().take(64).collect(),
                        label: o.get("label").and_then(|x| x.as_str()).unwrap_or("?").chars().take(60).collect(),
                        kind: match o.get("kind").and_then(|x| x.as_str()) { Some("allow") => "allow", Some("deny") => "deny", _ => "neutral" }.into(),
                    });
                }
            }
            if options.is_empty() {
                options = crate::approvals::Approvals::allow_deny();
            }
            let timeout = args.get("timeoutMs").and_then(|t| t.as_u64()).unwrap_or(600_000).min(3_600_000);
            let operation = arg_opt_str(args, "operation").unwrap_or("agent-permission");
            match k.approvals.request(owner, gen.gen_id, &format!("module:{operation}"), &title.chars().take(200).collect::<String>(), &detail.chars().take(20000).collect::<String>(), true, options, Duration::from_millis(timeout)) {
                Decision::Option(o) => {
                    k.audit.record(owner, gen.gen_id, "approvals.request", title, &format!("chose {o}"), Some("native-user"));
                    Ok(json!({"optionId": o}))
                }
                Decision::Expired => Ok(json!({"optionId": null, "expired": true})),
            }
        }

        // ---------------------------------------------------------------- native UI helpers
        "ui.documentOpen" => {
            gen.caps.require("ui.document")?;
            let text = arg_str(args, "text")?;
            if text.len() > MAX_READ {
                return Err(HostError::new("E2BIG", "document too large"));
            }
            let doc = Arc::new(Document {
                workspace_key: arg_str(args, "workspaceKey")?.to_string(),
                path: arg_opt_str(args, "path").unwrap_or("").to_string(),
                language: arg_opt_str(args, "language").unwrap_or("text").to_string(),
                text: text.to_string(),
                created_ms: now_ms(),
            });
            let label = format!("{} {}", doc.workspace_key, doc.path);
            let h = k.handles.insert("document", owner, label, doc);
            Ok(json!(h))
        }
        "ui.openUrl" => {
            gen.caps.require("ui.openUrl")?;
            let url = arg_str(args, "url")?;
            let lower = url.to_ascii_lowercase();
            if !(lower.starts_with("https://") || lower.starts_with("http://")) || url.len() > 8192 || url.chars().any(|c| c.is_control()) {
                return Err(HostError::invalid("only http(s) URLs can be opened"));
            }
            if !k.ui.connected() {
                return Err(HostError::new("ENOTSUP", "no window (headless)"));
            }
            k.audit.record(owner, gen.gen_id, "ui.openUrl", &url.split(['?', '#']).next().unwrap_or("").chars().take(200).collect::<String>(), "ok", None);
            k.ui.send(UiMsg::OpenUrl(url.to_string()));
            Ok(Value::Null)
        }
        "ui.pickFolder" => {
            gen.caps.require("ui.dialog")?;
            if !k.ui.connected() {
                return Err(HostError::new("ENOTSUP", "no window (headless)"));
            }
            let (tx, rx) = crossbeam_channel::bounded(1);
            k.ui.send(UiMsg::PickFolder(tx));
            Ok(rx.recv_timeout(Duration::from_secs(600)).ok().flatten().map(Value::String).unwrap_or(Value::Null))
        }
        _ => Err(HostError::invalid(format!("unknown op '{op}'"))),
    }
}

fn env_pairs(req: &Value) -> HResult<Vec<(String, String)>> {
    let mut out = Vec::new();
    if let Some(o) = req.get("env").or_else(|| req.get("envRefs")).and_then(|e| e.as_object()) {
        for (k, v) in o {
            let v = v.as_str().ok_or_else(|| HostError::invalid("env values must be strings"))?;
            if k.is_empty() || k.contains('=') || k.contains('\0') || v.contains('\0') {
                return Err(HostError::invalid(format!("invalid env entry {k}")));
            }
            out.push((k.clone(), v.to_string()));
        }
    }
    Ok(out)
}

/// The machine named in a request must match the grant's machine; never substituted.
fn check_target(g: &ScopeGrant, req: &Value) -> HResult<()> {
    if let Some(t) = req.get("target") {
        let kind = t.get("kind").and_then(|x| x.as_str()).unwrap_or("");
        let requested = match kind {
            "local" => "local".to_string(),
            "ssh" => t.get("machineId").and_then(|x| x.as_str()).unwrap_or("").to_string(),
            _ => return Err(HostError::invalid("target.kind must be 'local' or 'ssh'")),
        };
        if requested != g.target.machine_id() {
            return Err(HostError::denied(format!("execution target {requested} does not match the grant's machine {} (no fallback)", g.target.machine_id())));
        }
    }
    Ok(())
}

fn spawn_spec(k: &Kernel, g: &ScopeGrant, req: &Value) -> HResult<SpawnSpec> {
    let exe = req.get("executable").and_then(|e| e.as_str()).ok_or_else(|| HostError::invalid("missing executable"))?.to_string();
    let args: Vec<String> = req.get("args").and_then(|a| a.as_array()).map(|a| a.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect()).unwrap_or_default();
    let cwd = req.get("cwd").and_then(|c| c.as_str()).unwrap_or(&g.root).to_string();
    let login_shell = req.get("loginShell").and_then(|b| b.as_bool()).unwrap_or(false);
    let env = env_pairs(req)?;
    let env_remove: Vec<String> = req.get("envRemove").and_then(|a| a.as_array()).map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default();
    if env_remove.iter().any(|k| k.is_empty() || k.contains('=') || k.contains('\0') || k.len() > 128) {
        return Err(HostError::invalid("invalid envRemove entry"));
    }
    check_target(g, req)?;
    match g.kind {
        ScopeKind::Process => {}
        ScopeKind::Build => {
            let tool = k.cfg.build_tool().ok_or_else(|| HostError::not_found("esbuild not installed (run npm ci)"))?;
            if std::path::Path::new(&exe) != tool.as_path() {
                return Err(HostError::denied("build grant only permits the configured build tool"));
            }
            for a in &args {
                let l = a.to_ascii_lowercase();
                if ["--outfile", "--outdir", "--metafile", "--allow-overwrite", "--write", "--serve", "--watch", "--outbase", "--sourcemap=external", "--analyze"].iter().any(|f| l.starts_with(f)) || l.starts_with("--log-override") {
                    return Err(HostError::denied(format!("build argument {a} is not permitted (output must go to stdout)")));
                }
                if !a.starts_with('-') {
                    let p = k.cfg.plugin_root().join(a);
                    let real = canonical_string(&p).map_err(|_| HostError::not_found(format!("entry {a} not found")))?;
                    if !path_within(&canonical_string(&k.cfg.modules_dir()).map_err(HostError::from)?, &real) {
                        return Err(HostError::denied("build entry must be inside modules/"));
                    }
                }
            }
            if login_shell || !env.is_empty() || !env_remove.is_empty() {
                return Err(HostError::denied("build grant does not allow env or login shell"));
            }
        }
        _ => return Err(HostError::denied("grant does not allow processes")),
    }
    let cwd = match &g.target {
        Target::Local => {
            let real = canonical_string(std::path::Path::new(&cwd)).map_err(|e| HostError::new("ENOENT", format!("cwd {cwd}: {e}")))?;
            if !path_within(&g.root, &real) {
                return Err(HostError::denied(format!("cwd {real} is outside the granted root {}", g.root)));
            }
            real
        }
        Target::Ssh { machine_id, .. } => {
            let master = k.ssh.by_machine(machine_id).ok_or_else(|| HostError::new("ENOTCONN", "SSH connection unavailable (no local fallback)"))?;
            master.ensure_alive()?;
            let n = normalize_posix(&cwd).ok_or_else(|| HostError::invalid("cwd must be absolute"))?;
            let real = master.sftp()?.realpath(&n)?;
            if !path_within(&g.root, &real) {
                return Err(HostError::denied(format!("cwd {real} is outside the granted root {}", g.root)));
            }
            real
        }
    };
    let ssh = ssh_for(k, &g.target);
    Ok(SpawnSpec { target: g.target.clone(), ssh, executable: exe, args, cwd, env, env_remove, login_shell, persist: None })
}

/// `persist: {key}` on a PTY/process request → (daemon binary, owner-scoped key).
fn persist_target(k: &Kernel, gen: &Generation, req: &Value, target: &Target) -> HResult<Option<process::Persist>> {
    let Some(key) = req.get("persist").and_then(|p| p.get("key")).and_then(|k| k.as_str()) else { return Ok(None) };
    gen.caps.require("remote.daemon")?;
    let key = daemon_link::scoped_key(&gen.module_id, key)?;
    let info = match target {
        Target::Local => match k.daemons.get("local") {
            Some(i) => i,
            None => daemon_link::ensure_local(&k.daemons)?,
        },
        Target::Ssh { machine_id, .. } => k.daemons.get(machine_id)
            .ok_or_else(|| HostError::new("EDAEMON", format!("no daemon on {machine_id}; call daemon.ensure first")))?,
    };
    Ok(Some(process::Persist { bin: info.bin, dir: info.dir, key }))
}

/// `target` of a daemon op: absent/local → None, ssh → the connection's master.
fn daemon_target(k: &Kernel, owner: &str, args: &Value) -> HResult<Option<Arc<SshMaster>>> {
    let t = args.get("target").cloned().unwrap_or(json!({"kind": "local"}));
    match t.get("kind").and_then(|x| x.as_str()) {
        Some("local") | None => Ok(None),
        Some("ssh") => {
            let ch = t.get("connection").and_then(|x| x.as_str()).ok_or_else(|| HostError::invalid("ssh target requires a connection handle"))?;
            let c: Arc<SshConnRef> = k.handles.get(ch, "ssh", owner)?;
            Ok(Some(c.master.clone()))
        }
        _ => Err(HostError::invalid("target.kind must be local or ssh")),
    }
}

/// Manifest, code and approvals of a locally installed, fully approved plugin.
fn push_payload(k: &Kernel, id: &str) -> HResult<Value> {
    let (m, _) = k.source_manifest(id)?;
    if m.placement() == "ui" {
        return Err(HostError::invalid(format!("'{id}' is a UI plugin and runs only in the window")));
    }
    let pending = k.grants.escalation(&m);
    if !pending.is_empty() {
        return Err(HostError::denied(format!("'{id}' has unapproved permissions ({}); enable it here first", pending.join(", "))));
    }
    let active = k.artifacts.lock().get(id).and_then(|r| r.active).ok_or_else(|| HostError::not_found(format!("'{id}' has no built artifact")))?;
    let (code, _, _) = k.artifacts.lock().load(id, active)?;
    let approved: Vec<String> = m.capabilities.iter().cloned().chain(m.calls.iter().map(|c| format!("call:{c}"))).collect();
    Ok(json!({"manifest": m, "code": code, "approved": approved}))
}

/// Strip other modules' resources from a daemon status reply and unscope keys.
fn own_resources(mut v: Value, owner: &str) -> Value {
    let prefix = format!("{owner}/");
    let res = if v.get("resources").is_some() { &mut v["resources"] } else { &mut v };
    for kind in ["ptys", "procs"] {
        if let Some(arr) = res.get_mut(kind).and_then(|a| a.as_array_mut()) {
            arr.retain(|e| e["key"].as_str().map(|k| k.starts_with(&prefix)).unwrap_or(false));
            for e in arr.iter_mut() {
                let k = e["key"].as_str().unwrap_or("").trim_start_matches(&prefix).to_string();
                e["key"] = json!(k);
            }
        }
    }
    v
}

fn request_grant(k: &Arc<Kernel>, gen: &Arc<Generation>, args: &Value) -> HResult<Value> {
    let kind = ScopeKind::parse(arg_str(args, "kind")?)?;
    let write = args.get("write").and_then(|w| w.as_bool()).unwrap_or(false);
    let owner = gen.module_id.as_str();
    let (target, root) = match kind {
        ScopeKind::Source => {
            gen.caps.require(if write { "modules.source.write" } else { "modules.source.read" })?;
            (Target::Local, canonical_string(&k.cfg.modules_dir()).map_err(HostError::from)?)
        }
        ScopeKind::Build => {
            gen.caps.require("process.build")?;
            (Target::Local, k.cfg.repo_root.to_string_lossy().into_owned())
        }
        ScopeKind::Fs | ScopeKind::Process | ScopeKind::Pty => {
            gen.caps.require(match kind { ScopeKind::Fs => "fs.scope", ScopeKind::Process => "process.scope", _ => "pty.scope" })?;
            let root = arg_str(args, "root")?;
            let t = args.get("target").cloned().unwrap_or(json!({"kind": "local"}));
            match t.get("kind").and_then(|x| x.as_str()) {
                Some("local") | None => {
                    let rs = canonical_string(std::path::Path::new(root)).map_err(|e| HostError::new("ENOENT", format!("root {root}: {e}")))?;
                    let real = std::path::Path::new(&rs);
                    if !real.is_dir() {
                        return Err(HostError::invalid("root must be a directory"));
                    }
                    // `/`, or a Windows drive root.
                    if real.parent().is_none() {
                        return Err(HostError::denied("the filesystem root cannot be granted"));
                    }
                    if protected(k, &rs) {
                        return Err(HostError::denied("kernel-protected application state cannot be granted"));
                    }
                    (Target::Local, rs)
                }
                Some("ssh") => {
                    let ch = t.get("connection").and_then(|x| x.as_str()).ok_or_else(|| HostError::invalid("ssh target requires a connection handle"))?;
                    let c: Arc<SshConnRef> = k.handles.get(ch, "ssh", owner)?;
                    if let Some(mid) = t.get("machineId").and_then(|x| x.as_str()) {
                        if mid != c.master.profile.machine_id() {
                            return Err(HostError::denied("machineId does not match the connection"));
                        }
                    }
                    c.master.ensure_alive()?;
                    let n = normalize_posix(root).ok_or_else(|| HostError::invalid("remote root must be an absolute path"))?;
                    let sftp = c.master.sftp()?;
                    let real = sftp.realpath(&n)?;
                    let a = sftp.stat(&real)?;
                    if !a.is_dir() {
                        return Err(HostError::invalid("remote root must be a directory"));
                    }
                    if real == "/" {
                        return Err(HostError::denied("the filesystem root cannot be granted"));
                    }
                    (Target::Ssh { machine_id: c.master.profile.machine_id(), master_key: c.master.profile.machine_id() }, real)
                }
                _ => return Err(HostError::invalid("target.kind must be local or ssh")),
            }
        }
    };
    if write && kind == ScopeKind::Fs {
        let shared = canonical_string(&k.cfg.shared_dir()).map_err(HostError::from)?;
        let inside_shared = target == Target::Local && path_within(&shared, &root);
        if !inside_shared {
            let purpose = arg_opt_str(args, "purpose").unwrap_or("");
            let detail = format!("Module '{}' requests WRITE access to:\n  {} : {}\n{}",
                owner, target.machine_id(), root, if purpose.is_empty() { String::new() } else { format!("Purpose (module-supplied): {purpose}") });
            k.require_approval(gen, "capabilities.fsWrite", &format!("Allow writing files under {root}?"), &detail)?;
        }
    }
    let g = Arc::new(ScopeGrant { kind, target: target.clone(), root: root.clone(), write, owner: owner.to_string(), revoked: AtomicBool::new(false) });
    let h = k.handles.insert("grant", owner, format!("{}:{}:{}{}", kind.name(), target.machine_id(), root, if write { ":rw" } else { "" }), g);
    Ok(json!({"grant": h, "root": root, "machineId": target.machine_id(), "kind": kind.name(), "write": write}))
}

#[allow(dead_code)]
fn _assert_join(root: &str) -> HResult<String> { join_relative(root, ".") }
