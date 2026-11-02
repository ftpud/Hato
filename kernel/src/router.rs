//! Generation router: stable logical module ids -> currently active generation.
//! Implements point-to-point RPC (request ids, deadlines, bounded queues), fencing during swaps,
//! the event bus (generation-tagged subscriptions) and generation lifecycle bookkeeping.
use crate::grants::{EffectiveCaps, Manifest};
use crate::js::worker::{op_result_msg, WorkerMsg};
use crate::util::{HResult, HostError};
use crossbeam_channel::Sender;
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::collections::{BTreeSet, HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

#[derive(Debug, Clone, PartialEq)]
pub enum GenStatus {
    Loading,
    Staged,
    Activating,
    Active,
    Draining,
    Retired,
    Failed(String),
}

impl GenStatus {
    pub fn name(&self) -> &'static str {
        match self {
            GenStatus::Loading => "loading",
            GenStatus::Staged => "staged",
            GenStatus::Activating => "activating",
            GenStatus::Active => "active",
            GenStatus::Draining => "draining",
            GenStatus::Retired => "retired",
            GenStatus::Failed(_) => "failed",
        }
    }
    /// Whether host operations that mutate shared state are allowed from this generation.
    pub fn may_mutate(&self) -> bool {
        matches!(self, GenStatus::Loading | GenStatus::Staged | GenStatus::Activating | GenStatus::Active)
    }
}

pub struct Generation {
    pub gen_id: u64,
    pub module_id: String,
    pub version: u32,
    pub kind: String,
    pub hash: String,
    pub stage_id: String,
    pub manifest: Manifest,
    pub caps: EffectiveCaps,
    pub tx: Sender<WorkerMsg>,
    pub status: Mutex<GenStatus>,
    pub inflight: AtomicUsize,
    pub exports: Mutex<Value>,
    pub errors: AtomicUsize,
    pub created: Instant,
}

impl Generation {
    pub fn status(&self) -> GenStatus { self.status.lock().clone() }
    pub fn set_status(&self, s: GenStatus) { *self.status.lock() = s; }
    pub fn label(&self) -> String { format!("{}@{:04}", self.module_id, self.version) }
}

pub enum Reply {
    Worker { tx: Sender<WorkerMsg>, call_id: u64 },
    Native(Box<dyn FnOnce(HResult<Value>) + Send>),
}

impl Reply {
    pub fn deliver(self, r: HResult<Value>) {
        match self {
            Reply::Worker { tx, call_id } => {
                let _ = tx.send(op_result_msg(call_id, r));
            }
            Reply::Native(f) => f(r),
        }
    }
}

struct PendingReq {
    gen_id: u64,
    reply: Reply,
    deadline: Instant,
    desc: String,
}

pub struct QueuedInvoke {
    payload: Value,
    reply: Reply,
    timeout: Duration,
    queued_at: Instant,
    desc: String,
}

#[derive(Default)]
pub struct Slot {
    pub active: Option<Arc<Generation>>,
    pub fenced: bool,
    queue: VecDeque<QueuedInvoke>,
    event_queue: VecDeque<(String, Value)>,
    pub last_error: Option<String>,
}

const MAX_QUEUE: usize = 512;
const MAX_WORKER_BACKLOG: usize = 2048;

pub struct Router {
    slots: Mutex<HashMap<String, Slot>>,
    gens: Mutex<HashMap<u64, Arc<Generation>>>,
    pending: Mutex<HashMap<u64, PendingReq>>,
    topics: Mutex<HashMap<String, BTreeSet<u64>>>,
    next_req: AtomicU64,
    next_gen: AtomicU64,
}

impl Default for Router {
    fn default() -> Self {
        Router {
            slots: Mutex::new(HashMap::new()),
            gens: Mutex::new(HashMap::new()),
            pending: Mutex::new(HashMap::new()),
            topics: Mutex::new(HashMap::new()),
            next_req: AtomicU64::new(1),
            next_gen: AtomicU64::new(1),
        }
    }
}

impl Router {
    pub fn alloc_gen_id(&self) -> u64 { self.next_gen.fetch_add(1, Ordering::SeqCst) }

    pub fn ensure_slot(&self, id: &str) { self.slots.lock().entry(id.to_string()).or_default(); }

    pub fn has_slot(&self, id: &str) -> bool { self.slots.lock().contains_key(id) }

    pub fn register_gen(&self, g: Arc<Generation>) { self.gens.lock().insert(g.gen_id, g); }

    pub fn gen(&self, gen_id: u64) -> Option<Arc<Generation>> { self.gens.lock().get(&gen_id).cloned() }

    pub fn active(&self, id: &str) -> Option<Arc<Generation>> { self.slots.lock().get(id).and_then(|s| s.active.clone()) }

    pub fn is_fenced(&self, id: &str) -> bool { self.slots.lock().get(id).map(|s| s.fenced).unwrap_or(false) }

    pub fn set_last_error(&self, id: &str, e: Option<String>) {
        if let Some(s) = self.slots.lock().get_mut(id) {
            s.last_error = e;
        }
    }

    pub fn last_error(&self, id: &str) -> Option<String> { self.slots.lock().get(id).and_then(|s| s.last_error.clone()) }

    pub fn module_ids(&self) -> Vec<String> {
        let mut v: Vec<String> = self.slots.lock().keys().cloned().collect();
        v.sort();
        v
    }

    pub fn all_gens(&self) -> Vec<Arc<Generation>> {
        let mut v: Vec<Arc<Generation>> = self.gens.lock().values().cloned().collect();
        v.sort_by_key(|g| g.gen_id);
        v
    }

    fn send_to_gen(&self, gen: &Arc<Generation>, mut payload: Value, reply: Reply, timeout: Duration, desc: String) {
        if gen.tx.len() > MAX_WORKER_BACKLOG {
            reply.deliver(Err(HostError::new("EBUSY", format!("{} queue is full", gen.label()))));
            return;
        }
        let req = self.next_req.fetch_add(1, Ordering::SeqCst);
        payload["t"] = json!("invoke");
        payload["req"] = json!(req);
        self.pending.lock().insert(req, PendingReq { gen_id: gen.gen_id, reply, deadline: Instant::now() + timeout, desc });
        gen.inflight.fetch_add(1, Ordering::SeqCst);
        if gen.tx.send(WorkerMsg::Dispatch(payload.to_string())).is_err() {
            if let Some(p) = self.pending.lock().remove(&req) {
                gen.inflight.fetch_sub(1, Ordering::SeqCst);
                p.reply.deliver(Err(HostError::new("ESHUTDOWN", format!("{} is not running", gen.label()))));
            }
        }
    }

    /// Route an invocation to the currently active generation of `module_id`; queue while fenced
    /// or not yet loaded.
    pub fn invoke(&self, module_id: &str, payload: Value, reply: Reply, timeout: Duration) {
        let desc = format!("{module_id}:{}", payload.get("method").and_then(|m| m.as_str()).unwrap_or(payload.get("kind").and_then(|k| k.as_str()).unwrap_or("?")));
        let target = {
            let mut slots = self.slots.lock();
            let Some(slot) = slots.get_mut(module_id) else {
                drop(slots);
                reply.deliver(Err(HostError::not_found(format!("no module '{module_id}'"))));
                return;
            };
            if !slot.fenced && slot.active.is_none() {
                let err = slot.last_error.clone().unwrap_or_else(|| "no active generation".into());
                drop(slots);
                reply.deliver(Err(HostError::new("EUNAVAILABLE", format!("module '{module_id}' is unavailable: {err}"))));
                return;
            }
            if slot.fenced {
                if slot.queue.len() >= MAX_QUEUE {
                    drop(slots);
                    reply.deliver(Err(HostError::new("EBUSY", format!("module '{module_id}' queue full"))));
                    return;
                }
                slot.queue.push_back(QueuedInvoke { payload, reply, timeout, queued_at: Instant::now(), desc });
                return;
            }
            slot.active.clone().unwrap()
        };
        self.send_to_gen(&target, payload, reply, timeout, desc);
    }

    /// Invoke a specific generation directly (lifecycle calls on staged/old generations).
    pub fn invoke_gen(&self, gen: &Arc<Generation>, payload: Value, reply: Reply, timeout: Duration) {
        let desc = format!("{}:{}", gen.label(), payload.get("kind").and_then(|k| k.as_str()).unwrap_or("?"));
        self.send_to_gen(gen, payload, reply, timeout, desc);
    }

    /// Blocking helper for kernel-internal lifecycle code (never call on UI or JS threads).
    pub fn invoke_gen_blocking(&self, gen: &Arc<Generation>, payload: Value, timeout: Duration) -> HResult<Value> {
        let (tx, rx) = crossbeam_channel::bounded(1);
        self.invoke_gen(gen, payload, Reply::Native(Box::new(move |r| { let _ = tx.send(r); })), timeout);
        rx.recv_timeout(timeout + Duration::from_secs(1)).unwrap_or_else(|_| Err(HostError::new("ETIMEDOUT", "lifecycle call timed out")))
    }

    pub fn invoke_blocking(&self, module_id: &str, payload: Value, timeout: Duration) -> HResult<Value> {
        let (tx, rx) = crossbeam_channel::bounded(1);
        self.invoke(module_id, payload, Reply::Native(Box::new(move |r| { let _ = tx.send(r); })), timeout);
        rx.recv_timeout(timeout + Duration::from_secs(1)).unwrap_or_else(|_| Err(HostError::new("ETIMEDOUT", "call timed out")))
    }

    pub fn complete(&self, req: u64, from_gen: u64, r: HResult<Value>) {
        let p = {
            let mut pending = self.pending.lock();
            match pending.get(&req) {
                Some(p) if p.gen_id == from_gen => pending.remove(&req),
                _ => None, // late, duplicate or forged reply: ignored
            }
        };
        if let Some(p) = p {
            if let Some(g) = self.gen(p.gen_id) {
                g.inflight.fetch_sub(1, Ordering::SeqCst);
                if r.is_err() {
                    g.errors.fetch_add(1, Ordering::Relaxed);
                }
            }
            p.reply.deliver(r);
        }
    }

    /// Fail expired requests (called periodically by the reaper thread).
    pub fn reap(&self) {
        let now = Instant::now();
        let expired: Vec<(u64, PendingReq)> = {
            let mut pending = self.pending.lock();
            let ids: Vec<u64> = pending.iter().filter(|(_, p)| p.deadline <= now).map(|(k, _)| *k).collect();
            ids.into_iter().filter_map(|k| pending.remove(&k).map(|p| (k, p))).collect()
        };
        for (_, p) in expired {
            if let Some(g) = self.gen(p.gen_id) {
                g.inflight.fetch_sub(1, Ordering::SeqCst);
            }
            p.reply.deliver(Err(HostError::new("ETIMEDOUT", format!("{} timed out", p.desc))));
        }
        // Queued (fenced) invocations also time out.
        let mut timed_out = Vec::new();
        {
            let mut slots = self.slots.lock();
            for slot in slots.values_mut() {
                let mut keep = VecDeque::new();
                while let Some(q) = slot.queue.pop_front() {
                    if q.queued_at.elapsed() > q.timeout { timed_out.push(q) } else { keep.push_back(q) }
                }
                slot.queue = keep;
            }
        }
        for q in timed_out {
            q.reply.deliver(Err(HostError::new("ETIMEDOUT", format!("{} timed out while queued (module swapping or not loaded)", q.desc))));
        }
    }

    pub fn worker_exited(&self, gen_id: u64) {
        let failed: Vec<PendingReq> = {
            let mut pending = self.pending.lock();
            let ids: Vec<u64> = pending.iter().filter(|(_, p)| p.gen_id == gen_id).map(|(k, _)| *k).collect();
            ids.into_iter().filter_map(|k| pending.remove(&k)).collect()
        };
        for p in failed {
            p.reply.deliver(Err(HostError::new("ESHUTDOWN", format!("{} generation exited; retry", p.desc))));
        }
        self.unsubscribe_all(gen_id);
    }

    // ---- fencing & cutover ---------------------------------------------------------------------

    pub fn fence(&self, id: &str) -> HResult<()> {
        let mut slots = self.slots.lock();
        let slot = slots.get_mut(id).ok_or_else(|| HostError::not_found(format!("no module '{id}'")))?;
        if slot.fenced {
            return Err(HostError::new("EBUSY", format!("module '{id}' is already swapping")));
        }
        slot.fenced = true;
        Ok(())
    }

    /// Install `new_active` (or keep the old one if None), unfence and flush queued work in order.
    pub fn cutover_and_unfence(&self, id: &str, new_active: Option<Arc<Generation>>) -> Option<Arc<Generation>> {
        let (target, queue, events, old) = {
            let mut slots = self.slots.lock();
            let slot = slots.entry(id.to_string()).or_default();
            let old = if let Some(n) = new_active { slot.active.replace(n) } else { None };
            slot.fenced = false;
            let q: Vec<QueuedInvoke> = slot.queue.drain(..).collect();
            let e: Vec<(String, Value)> = slot.event_queue.drain(..).collect();
            (slot.active.clone(), q, e, old)
        };
        if let Some(t) = target {
            for q in queue {
                let remaining = q.timeout.saturating_sub(q.queued_at.elapsed()).max(Duration::from_millis(500));
                self.send_to_gen(&t, q.payload, q.reply, remaining, q.desc);
            }
            for (topic, payload) in events {
                if self.topics.lock().get(&topic).map(|s| s.contains(&t.gen_id)).unwrap_or(false) {
                    let _ = t.tx.send(WorkerMsg::Dispatch(json!({"t": "event", "topic": topic, "payload": payload}).to_string()));
                }
            }
        } else {
            for q in queue {
                q.reply.deliver(Err(HostError::new("EUNAVAILABLE", format!("module '{id}' has no active generation"))));
            }
        }
        old
    }

    pub fn clear_active(&self, id: &str) -> Option<Arc<Generation>> {
        self.slots.lock().get_mut(id).and_then(|s| s.active.take())
    }

    pub fn retire(&self, gen: &Arc<Generation>) {
        gen.set_status(GenStatus::Retired);
        self.unsubscribe_all(gen.gen_id);
        let _ = gen.tx.send(WorkerMsg::Shutdown);
    }

    pub fn forget_gen(&self, gen_id: u64) { self.gens.lock().remove(&gen_id); }

    // ---- event bus -----------------------------------------------------------------------------

    pub fn subscribe(&self, gen_id: u64, topic: &str) { self.topics.lock().entry(topic.to_string()).or_default().insert(gen_id); }

    pub fn unsubscribe(&self, gen_id: u64, topic: &str) {
        if let Some(s) = self.topics.lock().get_mut(topic) {
            s.remove(&gen_id);
        }
    }

    pub fn unsubscribe_all(&self, gen_id: u64) {
        for s in self.topics.lock().values_mut() {
            s.remove(&gen_id);
        }
    }

    pub fn subscription_count(&self, gen_id: u64) -> usize { self.topics.lock().values().filter(|s| s.contains(&gen_id)).count() }

    /// Deliver an event to every subscribed live generation. Events for fenced modules are queued
    /// and delivered to whichever generation wins the swap (if it subscribes to the topic).
    pub fn emit(&self, topic: &str, payload: &Value) {
        let subs: Vec<u64> = self.topics.lock().get(topic).map(|s| s.iter().cloned().collect()).unwrap_or_default();
        let msg = json!({"t": "event", "topic": topic, "payload": payload}).to_string();
        let mut queued_for = BTreeSet::new();
        for gid in subs {
            let Some(g) = self.gen(gid) else { continue };
            let st = g.status();
            if !st.may_mutate() {
                continue;
            }
            if self.is_fenced(&g.module_id) {
                if queued_for.insert(g.module_id.clone()) {
                    if let Some(slot) = self.slots.lock().get_mut(&g.module_id) {
                        if slot.event_queue.len() < 1000 {
                            slot.event_queue.push_back((topic.to_string(), payload.clone()));
                        }
                    }
                }
                continue;
            }
            let _ = g.tx.send(WorkerMsg::Dispatch(msg.clone()));
        }
    }

    pub fn pending_count(&self) -> usize { self.pending.lock().len() }
}
