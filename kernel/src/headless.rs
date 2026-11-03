//! Headless runner for integration tests: boots the kernel without a window and runs a driver
//! script as a special `__driver` module. The driver's extra `test.*` operations exist ONLY in
//! this mode (launched explicitly from the command line); they are never available to modules
//! in a normal GUI run.
use crate::grants::{EffectiveCaps, Manifest};
use crate::kernel::Kernel;
use crate::router::{GenStatus, Generation};
use crate::util::{arg_str, HResult, HostError};
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;

pub static DONE: Mutex<Option<(bool, Value)>> = Mutex::new(None);

pub fn run(k: &Arc<Kernel>, script: &std::path::Path) -> anyhow::Result<bool> {
    let code = std::fs::read_to_string(script)?;
    let manifest = Manifest {
        schema_version: 1, id: "__driver".into(), kind: "service".into(), entry: script.display().to_string(),
        module_api_version: 1, dependencies: vec![], capabilities: vec![], state_version: 1, description: "headless test driver".into(), ..Default::default()
    };
    let (tx, rx) = crossbeam_channel::unbounded();
    let gen = Arc::new(Generation {
        gen_id: k.router.alloc_gen_id(), module_id: "__driver".into(), version: 1, kind: "service".into(), hash: String::new(),
        stage_id: String::new(), manifest, caps: EffectiveCaps { caps: ["remote.daemon", "pty.scope", "process.scope", "fs.scope", "ssh.connect"].into_iter().map(String::from).collect(), calls: ["*".to_string()].into_iter().collect() },
        tx, status: Mutex::new(GenStatus::Loading), inflight: Default::default(), exports: Mutex::new(Value::Null),
        errors: Default::default(), created: std::time::Instant::now(),
    });
    k.router.register_gen(gen.clone());
    k.router.ensure_slot("__driver");
    crate::js::worker::spawn(k.me.clone(), gen.clone(), code, rx).map_err(|e| anyhow::anyhow!("driver failed to load: {e}"))?;
    gen.set_status(GenStatus::Active);
    k.router.cutover_and_unfence("__driver", Some(gen.clone()));
    let r = k.router.invoke_gen_blocking(&gen, json!({"kind": "activate", "prev": null}), Duration::from_secs(1800));
    if let Err(e) = &r {
        eprintln!("driver activate failed: {e}");
    }
    let done = DONE.lock().clone();
    match done {
        Some((ok, report)) => {
            println!("{}", serde_json::to_string_pretty(&report).unwrap_or_default());
            Ok(ok && r.is_ok())
        }
        None => Ok(r.is_ok()),
    }
}

/// `test.*` host ops for the driver module (only reachable when module id is `__driver` and the
/// kernel runs headless).
pub fn driver_op(k: &Arc<Kernel>, gen: &Arc<Generation>, op: &str, args: &Value) -> HResult<Value> {
    if gen.module_id != "__driver" || !k.cfg.headless {
        return Err(HostError::denied("test ops unavailable"));
    }
    match op {
        "test.render" => k.router.invoke_blocking(arg_str(args, "module")?, json!({"kind": "render"}), Duration::from_secs(20)),
        "test.event" => {
            let m = arg_str(args, "module")?.to_string();
            let r = k.router.invoke_blocking(&m, json!({"kind": "event", "event": args.get("event").cloned().unwrap_or(Value::Null)}), Duration::from_secs(600));
            k.request_render(&m);
            r
        }
        "test.approvals" => {
            let policy = arg_str(args, "policy")?.to_string();
            let log: Arc<Mutex<Vec<Value>>> = TEST_APPROVALS.clone();
            *k.approvals.headless_policy.lock() = Some(Arc::new(move |req| {
                log.lock().push(json!({"operation": req.operation, "title": req.title, "module": req.module, "detail": req.detail.chars().take(4000).collect::<String>()}));
                match policy.as_str() {
                    "allow" => req.options.iter().find(|o| o.kind == "allow").map(|o| o.id.clone()),
                    "deny" => req.options.iter().find(|o| o.kind == "deny").map(|o| o.id.clone()),
                    _ => None,
                }
            }));
            Ok(Value::Null)
        }
        "test.approvalLog" => {
            let v = TEST_APPROVALS.lock().clone();
            if args.get("clear").and_then(|c| c.as_bool()).unwrap_or(false) {
                TEST_APPROVALS.lock().clear();
            }
            Ok(Value::Array(v))
        }
        "test.modules" => Ok(k.modules_json()),
        "test.handles" => Ok(Value::Array(k.handles.list())),
        "test.ptyScreen" => {
            let p: Arc<crate::host::pty::PtySession> = k.handles.get_kernel(arg_str(args, "handle")?, "pty").ok_or_else(|| HostError::not_found("pty"))?;
            let mut i = p.info();
            i["screen"] = json!(p.screen_text());
            Ok(i)
        }
        "test.ptyWrite" => {
            let p: Arc<crate::host::pty::PtySession> = k.handles.get_kernel(arg_str(args, "handle")?, "pty").ok_or_else(|| HostError::not_found("pty"))?;
            p.write(arg_str(args, "text")?.as_bytes())?;
            Ok(Value::Null)
        }
        "test.document" => {
            let d: Arc<crate::ops::Document> = k.handles.get_kernel(arg_str(args, "handle")?, "document").ok_or_else(|| HostError::not_found("document"))?;
            Ok(json!({"path": d.path, "language": d.language, "length": d.text.len(), "head": d.text.chars().take(200).collect::<String>(), "workspaceKey": d.workspace_key}))
        }
        "test.stage" => {
            let id = arg_str(args, "id")?;
            k.stage(gen, id, arg_str(args, "code")?, "test", false)
        }
        "test.activate" => k.activate_staged(None, arg_str(args, "id")?, arg_str(args, "stageId")?, false),
        "test.rollback" => k.rollback(None, arg_str(args, "id")?, args.get("toVersion").and_then(|v| v.as_u64()).map(|v| v as u32), false),
        // Plugin lifecycle with the driver as requester (approvals follow the test.approvals policy).
        "test.pluginEnable" => k.enable_plugin(Some(gen), arg_str(args, "id")?),
        "test.pluginDisable" => k.disable_plugin(Some(gen), arg_str(args, "id")?, args.get("cascade").and_then(|c| c.as_bool()).unwrap_or(false)),
        "test.pluginRoot" => k.set_root_plugin(args.get("id").and_then(|v| v.as_str())).map(|_| Value::Null),
        "test.pluginRescan" => Ok(k.rescan_plugins()),
        "test.pluginInstall" => k.install_plugin(gen, arg_str(args, "path")?),
        "test.pluginUninstall" => k.uninstall_plugin(gen, arg_str(args, "id")?),
        "test.logs" => Ok(json!(k.logs.tail(arg_str(args, "id")?, 200))),
        "test.state" => Ok(k.state.values.lock().get(arg_str(args, "key")?).cloned().unwrap_or(Value::Null)),
        "test.env" => Ok(std::env::var(arg_str(args, "name")?).map(Value::String).unwrap_or(Value::Null)),
        "test.readFile" => Ok(json!(std::fs::read_to_string(arg_str(args, "path")?).map_err(HostError::from)?)),
        "test.exec" => {
            let argv: Vec<String> = args.get("argv").and_then(|a| a.as_array()).map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default();
            let out = std::process::Command::new(&argv[0]).args(&argv[1..]).current_dir(arg_str(args, "cwd").unwrap_or(".")).output().map_err(HostError::from)?;
            Ok(json!({"code": out.status.code(), "stdout": String::from_utf8_lossy(&out.stdout), "stderr": String::from_utf8_lossy(&out.stderr)}))
        }
        "test.done" => {
            *DONE.lock() = Some((args.get("ok").and_then(|o| o.as_bool()).unwrap_or(false), args.get("report").cloned().unwrap_or(Value::Null)));
            Ok(Value::Null)
        }
        _ => Err(HostError::invalid(format!("unknown test op {op}"))),
    }
}

static TEST_APPROVALS: once_cell_lite::Lazy<Arc<Mutex<Vec<Value>>>> = once_cell_lite::Lazy::new(|| Arc::new(Mutex::new(Vec::new())));

mod once_cell_lite {
    pub struct Lazy<T> {
        cell: std::sync::OnceLock<T>,
        init: fn() -> T,
    }
    impl<T> Lazy<T> {
        pub const fn new(init: fn() -> T) -> Self { Lazy { cell: std::sync::OnceLock::new(), init } }
    }
    impl<T> std::ops::Deref for Lazy<T> {
        type Target = T;
        fn deref(&self) -> &T { self.cell.get_or_init(self.init) }
    }
}
