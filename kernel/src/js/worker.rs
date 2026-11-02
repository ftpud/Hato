//! One QuickJS runtime per module generation, running on its own OS thread with an explicit
//! message pump. QuickJS objects never leave this thread. Every entry into JS runs under a CPU
//! deadline enforced by the interrupt handler, and the runtime has a memory limit.
use crate::kernel::Kernel;
use crate::router::Generation;
use crate::util::{HostError, HResult};
use crossbeam_channel::{Receiver, RecvTimeoutError, Sender};
use rquickjs::{Context, Ctx, Function, Module, Runtime, Value as JsValue};
use serde_json::{json, Value};
use std::cell::RefCell;
use std::collections::BinaryHeap;
use std::cmp::Reverse;
use std::rc::Rc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Weak};
use std::time::{Duration, Instant};

pub const PRELUDE: &str = include_str!("prelude.js");
const MEMORY_LIMIT: usize = 256 * 1024 * 1024;
const STACK_LIMIT: usize = 4 * 1024 * 1024;
/// CPU budget for one synchronous slice of JS (a dispatch or a batch of promise jobs).
pub const SLICE_BUDGET: Duration = Duration::from_secs(4);

pub enum WorkerMsg {
    /// JSON message for `__hato_dispatch`.
    Dispatch(String),
    Stream { sub_id: String, data: Option<String>, eof: bool, nbytes: usize, error: Option<String> },
    Shutdown,
}

#[derive(Clone)]
pub struct WorkerHandle {
    pub tx: Sender<WorkerMsg>,
}

pub fn op_result_msg(call_id: u64, r: HResult<Value>) -> WorkerMsg {
    let v = match r {
        Ok(v) => json!({"t": "op", "id": call_id, "ok": true, "value": v}),
        Err(e) => json!({"t": "op", "id": call_id, "ok": false, "error": e.to_json()}),
    };
    WorkerMsg::Dispatch(v.to_string())
}

/// Spawn the worker thread, evaluate prelude + artifact. Returns once the module evaluated
/// (Ok(exports-info JSON)) or failed.
pub fn spawn(
    kernel: Weak<Kernel>,
    gen: Arc<Generation>,
    source: String,
    rx: Receiver<WorkerMsg>,
) -> HResult<Value> {
    let (ready_tx, ready_rx) = crossbeam_channel::bounded::<HResult<Value>>(1);
    let name = format!("js-{}@{}", gen.module_id, gen.gen_id);
    std::thread::Builder::new()
        .name(name)
        .stack_size(16 * 1024 * 1024)
        .spawn(move || worker_main(kernel, gen, source, rx, ready_tx))
        .map_err(HostError::io)?;
    match ready_rx.recv_timeout(Duration::from_secs(20)) {
        Ok(r) => r,
        Err(_) => Err(HostError::new("ETIMEDOUT", "module evaluation timed out")),
    }
}

fn js_error_string(ctx: &Ctx<'_>, e: rquickjs::Error) -> String {
    if let rquickjs::Error::Exception = e {
        let v: JsValue = ctx.catch();
        if let Some(obj) = v.as_object() {
            let msg: String = obj.get("message").unwrap_or_default();
            let stack: String = obj.get("stack").unwrap_or_default();
            return format!("{msg}\n{stack}");
        }
        if let Some(s) = v.as_string() {
            return s.to_string().unwrap_or_default();
        }
        return format!("{v:?}");
    }
    e.to_string()
}

struct Timers {
    heap: BinaryHeap<Reverse<(Instant, u64)>>,
    live: std::collections::HashSet<u64>,
}

fn worker_main(
    kernel: Weak<Kernel>,
    gen: Arc<Generation>,
    source: String,
    rx: Receiver<WorkerMsg>,
    ready_tx: Sender<HResult<Value>>,
) {
    let deadline = Arc::new(AtomicU64::new(u64::MAX));
    let rt = match Runtime::new() {
        Ok(rt) => rt,
        Err(e) => {
            let _ = ready_tx.send(Err(HostError::new("EJS", e.to_string())));
            return;
        }
    };
    rt.set_memory_limit(MEMORY_LIMIT);
    rt.set_max_stack_size(STACK_LIMIT);
    let epoch = Instant::now();
    {
        let deadline = deadline.clone();
        rt.set_interrupt_handler(Some(Box::new(move || {
            let now = epoch.elapsed().as_millis() as u64;
            now > deadline.load(Ordering::Relaxed)
        })));
    }
    let arm = |d: &AtomicU64| d.store(epoch.elapsed().as_millis() as u64 + SLICE_BUDGET.as_millis() as u64, Ordering::Relaxed);
    let disarm = |d: &AtomicU64| d.store(u64::MAX, Ordering::Relaxed);

    let ctx = match Context::full(&rt) {
        Ok(c) => c,
        Err(e) => {
            let _ = ready_tx.send(Err(HostError::new("EJS", e.to_string())));
            return;
        }
    };
    let timers = Rc::new(RefCell::new(Timers { heap: BinaryHeap::new(), live: Default::default() }));

    // Install natives, prelude and the module.
    arm(&deadline);
    let init: Result<Value, String> = ctx.with(|ctx| {
        let g = ctx.globals();
        let meta = json!({"moduleId": gen.module_id, "generation": gen.gen_id, "version": gen.version, "kind": gen.kind});
        g.set("__hato_meta", meta.to_string()).map_err(|e| e.to_string())?;
        {
            let k = kernel.clone();
            let gen2 = gen.clone();
            let f = Function::new(ctx.clone(), move |op: String, args: String| -> String {
                let r = match k.upgrade() {
                    Some(k) => {
                        let args: Value = serde_json::from_str(&args).unwrap_or(Value::Null);
                        crate::ops::host_sync(&k, &gen2, &op, args)
                    }
                    None => Err(HostError::new("ESHUTDOWN", "kernel shutting down")),
                };
                match r {
                    Ok(v) => json!({"ok": true, "value": v}).to_string(),
                    Err(e) => json!({"ok": false, "error": e.to_json()}).to_string(),
                }
            })
            .map_err(|e| e.to_string())?;
            g.set("__host_sync", f).map_err(|e| e.to_string())?;
        }
        {
            let k = kernel.clone();
            let gen2 = gen.clone();
            let f = Function::new(ctx.clone(), move |op: String, args: String, call_id: f64| {
                let call_id = call_id as u64;
                match k.upgrade() {
                    Some(k) => {
                        let args: Value = serde_json::from_str(&args).unwrap_or(Value::Null);
                        crate::ops::host_async(&k, &gen2, op, args, call_id);
                    }
                    None => {
                        let _ = gen2.tx.send(op_result_msg(call_id, Err(HostError::new("ESHUTDOWN", "kernel shutting down"))));
                    }
                }
            })
            .map_err(|e| e.to_string())?;
            g.set("__host_async", f).map_err(|e| e.to_string())?;
        }
        {
            let k = kernel.clone();
            let gen2 = gen.clone();
            let f = Function::new(ctx.clone(), move |req: f64, ok: bool, payload: String| {
                if let Some(k) = k.upgrade() {
                    let v: Value = serde_json::from_str(&payload).unwrap_or(Value::Null);
                    let r = if ok {
                        Ok(v)
                    } else {
                        let msg = v.get("message").and_then(|m| m.as_str()).unwrap_or("module error").to_string();
                        let code = v.get("code").and_then(|m| m.as_str()).unwrap_or("EMODULE").to_string();
                        let stack = v.get("stack").and_then(|m| m.as_str()).unwrap_or("");
                        if !stack.is_empty() {
                            k.logs.push(&gen2.module_id, gen2.gen_id, "error", &format!("{msg}\n{stack}"));
                        }
                        Err(HostError { code, message: msg })
                    };
                    k.router.complete(req as u64, gen2.gen_id, r);
                }
            })
            .map_err(|e| e.to_string())?;
            g.set("__host_reply", f).map_err(|e| e.to_string())?;
        }
        {
            let t = timers.clone();
            let f = Function::new(ctx.clone(), move |id: f64, ms: f64| {
                let mut t = t.borrow_mut();
                let id = id as u64;
                t.live.insert(id);
                t.heap.push(Reverse((Instant::now() + Duration::from_millis(ms.max(0.0) as u64), id)));
            })
            .map_err(|e| e.to_string())?;
            g.set("__host_timer", f).map_err(|e| e.to_string())?;
            let t = timers.clone();
            let f = Function::new(ctx.clone(), move |id: f64| {
                t.borrow_mut().live.remove(&(id as u64));
            })
            .map_err(|e| e.to_string())?;
            g.set("__host_timer_clear", f).map_err(|e| e.to_string())?;
        }
        ctx.eval::<(), _>(PRELUDE).map_err(|e| format!("prelude: {}", js_error_string(&ctx, e)))?;
        let module_name = format!("{}@{}.mjs", gen.module_id, gen.version);
        let declared = Module::declare(ctx.clone(), module_name, source.as_bytes().to_vec())
            .map_err(|e| format!("module parse failed: {}", js_error_string(&ctx, e)))?;
        let (evaluated, promise) = declared.eval().map_err(|e| format!("module evaluation failed: {}", js_error_string(&ctx, e)))?;
        // Drive top-level await to completion.
        let _ = promise;
        let ns = evaluated.namespace().map_err(|e| js_error_string(&ctx, e))?;
        let default: JsValue = ns.get("default").map_err(|e| js_error_string(&ctx, e))?;
        let setm: Function = g.get("__hato_setModule").map_err(|e| e.to_string())?;
        let info: String = setm.call((default,)).map_err(|e| format!("module rejected: {}", js_error_string(&ctx, e)))?;
        serde_json::from_str(&info).map_err(|e| e.to_string())
    });
    let init = init.and_then(|v| {
        run_jobs(&rt, &deadline, &arm).map(|_| v)
    });
    disarm(&deadline);
    let failed = init.is_err();
    let _ = ready_tx.send(init.map_err(|e| HostError::new("EMODULE", e)));
    if failed {
        return;
    }

    // Message pump.
    loop {
        let timeout = {
            let t = timers.borrow();
            t.heap.peek().map(|Reverse((when, _))| when.saturating_duration_since(Instant::now()))
        };
        let msg = match timeout {
            Some(d) => match rx.recv_timeout(d) {
                Ok(m) => Some(m),
                Err(RecvTimeoutError::Timeout) => None,
                Err(RecvTimeoutError::Disconnected) => break,
            },
            None => match rx.recv() {
                Ok(m) => Some(m),
                Err(_) => break,
            },
        };
        arm(&deadline);
        let mut stop = false;
        if let Some(msg) = msg {
            // Remember which invocation this dispatch carries so an aborted slice can fail it promptly.
            let invoke_req = match &msg {
                WorkerMsg::Dispatch(json) if json.starts_with("{\"t\":\"invoke\"") || json.contains("\"t\":\"invoke\"") => {
                    serde_json::from_str::<Value>(json).ok().and_then(|v| v.get("req").and_then(|r| r.as_u64()))
                }
                _ => None,
            };
            let r: Result<(), String> = ctx.with(|ctx| match msg {
                WorkerMsg::Dispatch(json) => {
                    let f: Function = ctx.globals().get("__hato_dispatch").map_err(|e| e.to_string())?;
                    f.call::<_, ()>((json,)).map_err(|e| js_error_string(&ctx, e))
                }
                WorkerMsg::Stream { sub_id, data, eof, nbytes, error } => {
                    let f: Function = ctx.globals().get("__hato_stream").map_err(|e| e.to_string())?;
                    f.call::<_, ()>((sub_id, data, eof, nbytes as f64, error)).map_err(|e| js_error_string(&ctx, e))
                }
                WorkerMsg::Shutdown => {
                    stop = true;
                    Ok(())
                }
            });
            if let Err(e) = r {
                if let Some(k) = kernel.upgrade() {
                    k.logs.push(&gen.module_id, gen.gen_id, "error", &format!("uncaught: {e}"));
                    if let Some(req) = invoke_req {
                        let msg = if e.contains("interrupted") { format!("interrupted: {} exceeded its {}s CPU slice", gen.label(), SLICE_BUDGET.as_secs()) } else { e.clone() };
                        k.router.complete(req, gen.gen_id, Err(HostError::new("EINTERRUPTED", msg)));
                    }
                }
            }
        }
        // Fire due timers.
        loop {
            let due = {
                let mut t = timers.borrow_mut();
                match t.heap.peek() {
                    Some(Reverse((when, _))) if *when <= Instant::now() => {
                        let Reverse((_, id)) = t.heap.pop().unwrap();
                        if t.live.remove(&id) { Some(id) } else { continue; }
                    }
                    _ => None,
                }
            };
            let Some(id) = due else { break };
            let _ = ctx.with(|ctx| -> Result<(), String> {
                let f: Function = ctx.globals().get("__hato_dispatch").map_err(|e| e.to_string())?;
                f.call::<_, ()>((json!({"t": "timer", "id": id}).to_string(),)).map_err(|e| js_error_string(&ctx, e))
            });
        }
        if let Err(e) = run_jobs(&rt, &deadline, &arm) {
            if let Some(k) = kernel.upgrade() {
                k.logs.push(&gen.module_id, gen.gen_id, "error", &format!("job failed: {e}"));
            }
        }
        disarm(&deadline);
        if stop {
            break;
        }
    }
    if let Some(k) = kernel.upgrade() {
        k.router.worker_exited(gen.gen_id);
    }
}

fn run_jobs(rt: &Runtime, deadline: &AtomicU64, arm: &dyn Fn(&AtomicU64)) -> Result<(), String> {
    arm(deadline);
    let mut first_err = None;
    loop {
        match rt.execute_pending_job() {
            Ok(true) => continue,
            Ok(false) => break,
            Err(e) => {
                if first_err.is_none() {
                    first_err = Some(format!("{e:?}"));
                }
            }
        }
    }
    match first_err {
        Some(e) => Err(e),
        None => Ok(()),
    }
}
