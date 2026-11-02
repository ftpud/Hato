//! The kernel: owns the registries and implements module lifecycle (boot, stage, swap, rollback).
//! It does not know what any module *means*.
use crate::approvals::{Approvals, Decision};
use crate::artifacts::ArtifactStore;
use crate::audit::{Audit, ModuleLogs};
use crate::bridge::{UiBridge, UiMsg};
use crate::config::Config;
use crate::grants::{GrantRegistry, Manifest};
use crate::handles::HandleRegistry;
use crate::host::ssh::SshTable;
use crate::host::streams::ByteStream;
use crate::js::worker::{self, WorkerMsg};
use crate::router::{GenStatus, Generation, Reply, Router};
use crate::util::{random_hex, sha256_hex, HResult, HostError};
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Weak};
use std::time::{Duration, Instant};

pub struct StreamSub {
    pub stream: Arc<ByteStream>,
    pub module_id: String,
    pub gen_id: u64,
}

#[derive(Default)]
pub struct StateStore {
    pub values: Mutex<HashMap<String, Value>>,
    pub watchers: Mutex<HashMap<String, Vec<u64>>>,
}

#[derive(Default)]
struct RenderSched {
    in_flight: bool,
    dirty: bool,
}

pub struct Kernel {
    pub cfg: Config,
    pub me: Weak<Kernel>,
    pub handles: HandleRegistry,
    pub grants: GrantRegistry,
    pub approvals: Approvals,
    pub audit: Audit,
    pub logs: ModuleLogs,
    pub router: Router,
    pub artifacts: Mutex<ArtifactStore>,
    pub state: StateStore,
    pub ui: UiBridge,
    pub ssh: SshTable,
    pub subs: Mutex<HashMap<String, StreamSub>>,
    render: Mutex<HashMap<String, RenderSched>>,
    pub manifests: Mutex<HashMap<String, (Manifest, PathBuf)>>,
    /// Serializes module lifecycle operations per module id.
    swap_locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    staged: Mutex<HashMap<String, Arc<Generation>>>,
    pub shutting_down: AtomicBool,
    pub boot_report: Mutex<Vec<Value>>,
    pub started: Instant,
}

pub const KERNEL_TOPIC_MODULES: &str = "kernel.modules.changed";

impl Kernel {
    pub fn new(cfg: Config, ui: UiBridge) -> anyhow::Result<Arc<Kernel>> {
        let grants = GrantRegistry::load(cfg.approved_grants_file())?;
        let audit = Audit::new(cfg.logs_dir().join("audit.log"));
        let logs = ModuleLogs::open(cfg.logs_dir().join("modules.log"));
        let artifacts = ArtifactStore::open(cfg.artifacts_dir(), cfg.registry_file());
        let k = Arc::new_cyclic(|me| Kernel {
            approvals: Approvals::new(ui.clone()),
            cfg,
            me: me.clone(),
            handles: HandleRegistry::default(),
            grants,
            audit,
            logs,
            router: Router::default(),
            artifacts: Mutex::new(artifacts),
            state: StateStore::default(),
            ui,
            ssh: SshTable::default(),
            subs: Mutex::new(HashMap::new()),
            render: Mutex::new(HashMap::new()),
            manifests: Mutex::new(HashMap::new()),
            swap_locks: Mutex::new(HashMap::new()),
            staged: Mutex::new(HashMap::new()),
            shutting_down: AtomicBool::new(false),
            boot_report: Mutex::new(Vec::new()),
            started: Instant::now(),
        });
        // RPC deadline reaper.
        let w = Arc::downgrade(&k);
        std::thread::Builder::new().name("reaper".into()).spawn(move || loop {
            std::thread::sleep(Duration::from_millis(200));
            match w.upgrade() {
                Some(k) => k.router.reap(),
                None => return,
            }
        })?;
        Ok(k)
    }

    pub fn arc(&self) -> Arc<Kernel> { self.me.upgrade().expect("kernel alive") }

    fn swap_lock(&self, id: &str) -> Arc<Mutex<()>> { self.swap_locks.lock().entry(id.to_string()).or_default().clone() }

    // ---- discovery -----------------------------------------------------------------------------

    pub fn discover(&self) -> Vec<(Manifest, PathBuf)> {
        let mut out = Vec::new();
        for sub in ["services", "ui"] {
            let d = self.cfg.modules_dir().join(sub);
            let Ok(rd) = std::fs::read_dir(&d) else { continue };
            let mut dirs: Vec<PathBuf> = rd.filter_map(|e| e.ok().map(|e| e.path())).filter(|p| p.join("manifest.json").is_file()).collect();
            dirs.sort();
            for dir in dirs {
                match std::fs::read_to_string(dir.join("manifest.json")).map_err(anyhow::Error::from).and_then(|s| Ok(serde_json::from_str::<Manifest>(&s)?)) {
                    Ok(m) => {
                        if let Err(e) = m.validate() {
                            log::error!("invalid manifest {}: {e}", dir.display());
                            continue;
                        }
                        let expected_kind = if sub == "services" { "service" } else { "ui" };
                        let dir_name = dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                        if m.kind != expected_kind || m.id != dir_name {
                            log::error!("manifest {} id/kind does not match its location", dir.display());
                            continue;
                        }
                        out.push((m, dir));
                    }
                    Err(e) => log::error!("cannot read manifest in {}: {e}", dir.display()),
                }
            }
        }
        out
    }

    /// Static manifest for a module, read fresh from its source directory (never from JS).
    pub fn source_manifest(&self, id: &str) -> HResult<(Manifest, PathBuf)> {
        let found = self.discover().into_iter().find(|(m, _)| m.id == id);
        found.ok_or_else(|| HostError::not_found(format!("no module source for '{id}'")))
    }

    // ---- generations ---------------------------------------------------------------------------

    fn spawn_generation(&self, manifest: &Manifest, version: u32, code: &str) -> HResult<Arc<Generation>> {
        let (tx, rx) = crossbeam_channel::unbounded::<WorkerMsg>();
        let caps = self.grants.effective(manifest);
        let gen = Arc::new(Generation {
            gen_id: self.router.alloc_gen_id(),
            module_id: manifest.id.clone(),
            version,
            kind: manifest.kind.clone(),
            hash: sha256_hex(code.as_bytes()),
            stage_id: format!("stage_{}", random_hex(6)),
            manifest: manifest.clone(),
            caps,
            tx,
            status: Mutex::new(GenStatus::Loading),
            inflight: Default::default(),
            exports: Mutex::new(Value::Null),
            errors: Default::default(),
            created: Instant::now(),
        });
        self.router.register_gen(gen.clone());
        match worker::spawn(self.me.clone(), gen.clone(), code.to_string(), rx) {
            Ok(exports) => {
                *gen.exports.lock() = exports;
                gen.set_status(GenStatus::Staged);
                Ok(gen)
            }
            Err(e) => {
                gen.set_status(GenStatus::Failed(e.message.clone()));
                self.router.forget_gen(gen.gen_id);
                Err(e)
            }
        }
    }

    // ---- boot ----------------------------------------------------------------------------------

    /// Load every discovered module at its active version (importing seed builds when new),
    /// falling back to last-known-good on failure. Activations run in parallel; calls queue
    /// until the target module finished `activate()`.
    pub fn boot(&self) {
        let discovered = self.discover();
        {
            let mut m = self.manifests.lock();
            for (man, dir) in &discovered {
                m.insert(man.id.clone(), (man.clone(), dir.clone()));
            }
        }
        for (m, _) in &discovered {
            self.router.ensure_slot(&m.id);
            let _ = self.router.fence(&m.id);
        }
        // Services first, then UI.
        let mut order: Vec<&(Manifest, PathBuf)> = discovered.iter().collect();
        order.sort_by_key(|(m, _)| if m.kind == "service" { 0 } else { 1 });
        let mut waits = Vec::new();
        for (m, _) in order {
            let id = m.id.clone();
            let seed = self.cfg.seed_dir().join(format!("{id}.mjs"));
            // Import a changed seed build (developer `npm run modules:build`).
            if let Ok(code) = std::fs::read_to_string(&seed) {
                let hash = sha256_hex(code.as_bytes());
                let mut store = self.artifacts.lock();
                let known = store.has_hash(&id, &hash);
                let rec_seed = store.get(&id).and_then(|r| r.seed_hash.clone());
                if rec_seed.as_deref() != Some(hash.as_str()) && !self.cfg.safe_mode {
                    let v = match known {
                        Some(v) => v,
                        None => match store.put(&id, &code, m, "seed") {
                            Ok(vr) => vr.version,
                            Err(e) => {
                                log::error!("cannot store seed artifact for {id}: {e}");
                                continue;
                            }
                        },
                    };
                    let rec = store.record(&id);
                    if let Some(a) = rec.active {
                        if a != v {
                            rec.previous.push(a);
                        }
                    }
                    rec.active = Some(v);
                    rec.seed_hash = Some(hash);
                    store.save();
                }
            }
            let (active, lkg) = {
                let store = self.artifacts.lock();
                let r = store.get(&id).cloned().unwrap_or_default();
                (r.active, r.last_known_good)
            };
            let mut candidates: Vec<u32> = Vec::new();
            if self.cfg.safe_mode {
                candidates.extend(lkg);
            } else {
                candidates.extend(active);
                if lkg != active {
                    candidates.extend(lkg);
                }
            }
            let mut loaded = None;
            let mut errors = Vec::new();
            for v in candidates {
                let r = {
                    let store = self.artifacts.lock();
                    store.load(&id, v)
                };
                match r.and_then(|(code, man, _)| {
                    if man.id != id {
                        return Err(HostError::invalid("artifact manifest id mismatch"));
                    }
                    self.spawn_generation(&man, v, &code)
                }) {
                    Ok(g) => {
                        loaded = Some(g);
                        break;
                    }
                    Err(e) => {
                        errors.push(format!("{id}@{v:04}: {e}"));
                        self.artifacts.lock().set_status(&id, v, "failed", &e.message);
                    }
                }
            }
            let Some(gen) = loaded else {
                let msg = if errors.is_empty() { format!("{id}: no artifact (run `npm run modules:build`)") } else { errors.join("; ") };
                log::error!("module {id} unavailable: {msg}");
                self.router.set_last_error(&id, Some(msg.clone()));
                self.boot_report.lock().push(json!({"module": id, "ok": false, "error": msg}));
                self.router.cutover_and_unfence(&id, None);
                continue;
            };
            if !errors.is_empty() {
                self.router.set_last_error(&id, Some(format!("fell back to last-known-good: {}", errors.join("; "))));
            }
            gen.set_status(GenStatus::Activating);
            let (tx, rx) = crossbeam_channel::bounded(1);
            let k = self.arc();
            let g2 = gen.clone();
            // Cut over as soon as THIS module's activate() finishes, so modules that call it while
            // activating (in parallel) are served immediately.
            self.router.invoke_gen(&gen, json!({"kind": "activate", "prev": null}), Reply::Native(Box::new(move |r| {
                k.finish_boot_activation(&g2, r);
                let _ = tx.send(());
            })), Duration::from_secs(30));
            waits.push(rx);
        }
        for rx in waits {
            let _ = rx.recv_timeout(Duration::from_secs(35));
        }
        self.ui.send(UiMsg::ModulesChanged);
        for (m, _) in &discovered {
            if m.kind == "ui" {
                self.request_render(&m.id);
            }
        }
    }

    fn finish_boot_activation(&self, gen: &Arc<Generation>, r: HResult<Value>) {
        let id = gen.module_id.clone();
        match r {
            Ok(_) => {
                gen.set_status(GenStatus::Active);
                self.router.cutover_and_unfence(&id, Some(gen.clone()));
                let mut store = self.artifacts.lock();
                store.set_status(&id, gen.version, "ok", "");
                let rec = store.record(&id);
                rec.active = Some(gen.version);
                rec.last_known_good = Some(gen.version);
                store.save();
                self.boot_report.lock().push(json!({"module": id, "ok": true, "version": gen.version}));
            }
            Err(e) => {
                log::error!("activate {} failed: {e}", gen.label());
                self.logs.push(&id, gen.gen_id, "error", &format!("activate failed: {e}"));
                gen.set_status(GenStatus::Failed(e.message.clone()));
                self.router.retire(gen);
                self.artifacts.lock().set_status(&id, gen.version, "failed", &e.message);
                self.router.set_last_error(&id, Some(format!("activate failed: {e}")));
                self.router.cutover_and_unfence(&id, None);
                self.boot_report.lock().push(json!({"module": id, "ok": false, "error": e.message}));
            }
        }
        if gen.kind == "ui" {
            self.request_render(&id);
        }
    }

    // ---- staging / activation / rollback ---------------------------------------------------------

    /// Stage a new artifact: validate the static manifest, check grants (escalation needs native
    /// approval), persist as a new version, evaluate it in a fresh runtime. Not yet routed.
    pub fn stage(&self, requester: &Generation, id: &str, code: &str, origin: &str, require_approval: bool) -> HResult<Value> {
        let lock = self.swap_lock(id);
        let _g = lock.lock();
        let (manifest, _dir) = self.source_manifest(id)?;
        manifest.validate()?;
        if code.len() > 8 * 1024 * 1024 {
            return Err(HostError::new("E2BIG", "artifact too large"));
        }
        let hash = sha256_hex(code.as_bytes());
        if require_approval {
            let escalation = self.grants.escalation(&manifest);
            let detail = format!(
                "Module: {id} ({})\nArtifact SHA-256: {hash}\nSize: {} bytes\nRequested capabilities: {}\nNew capabilities beyond install grant: {}\n\nStaging evaluates the new build in an isolated runtime. It does not activate it.",
                manifest.kind,
                code.len(),
                manifest.capabilities.join(", "),
                if escalation.is_empty() { "none".to_string() } else { escalation.join(", ") }
            );
            self.require_approval(requester, "modules.stage", &format!("Build & stage new version of '{id}'?"), &detail)?;
            if !escalation.is_empty() {
                let detail = format!("Module '{id}' requests capabilities it was not installed with:\n\n  {}\n\nThese would let the module use additional native operations. Deny unless you trust this change.", escalation.join("\n  "));
                self.require_approval(requester, "grants.escalate", &format!("Grant new capabilities to '{id}'?"), &detail)?;
                self.grants.record_approval(id, &escalation);
            }
        }
        let vr = self.artifacts.lock().put(id, code, &manifest, origin)?;
        let gen = match self.spawn_generation(&manifest, vr.version, code) {
            Ok(g) => g,
            Err(e) => {
                self.artifacts.lock().set_status(id, vr.version, "failed", &e.message);
                self.audit.record(&requester.module_id, requester.gen_id, "modules.stage", &format!("{id}@{:04}", vr.version), &format!("failed: {e}"), None);
                return Err(HostError::new("ESTAGE", format!("{id}@{:04} failed to evaluate: {}", vr.version, e.message)));
            }
        };
        let stage_id = gen.stage_id.clone();
        self.staged.lock().insert(stage_id.clone(), gen.clone());
        self.audit.record(&requester.module_id, requester.gen_id, "modules.stage", &format!("{id}@{:04} sha256={hash}", vr.version), "ok", None);
        self.ui.send(UiMsg::ModulesChanged);
        Ok(json!({"stageId": stage_id, "id": id, "version": vr.version, "label": gen.label(), "sha256": hash, "exports": gen.exports.lock().clone()}))
    }

    pub fn discard(&self, stage_id: &str) -> HResult<()> {
        let g = self.staged.lock().remove(stage_id).ok_or_else(|| HostError::not_found("no such staged generation"))?;
        self.router.retire(&g);
        Ok(())
    }

    pub fn require_approval(&self, requester: &Generation, op: &str, title: &str, detail: &str) -> HResult<()> {
        let d = self.approvals.request(&requester.module_id, requester.gen_id, op, title, detail, false, Approvals::allow_deny(), Duration::from_secs(600));
        match d {
            Decision::Option(o) if o == "allow" => {
                self.audit.record(&requester.module_id, requester.gen_id, op, title, "approved", Some("native-user"));
                Ok(())
            }
            Decision::Option(_) => {
                self.audit.record(&requester.module_id, requester.gen_id, op, title, "denied", Some("native-user"));
                Err(HostError::new("EDENIED", format!("user denied: {title}")))
            }
            Decision::Expired => {
                self.audit.record(&requester.module_id, requester.gen_id, op, title, "expired", None);
                Err(HostError::new("EDENIED", format!("approval expired: {title}")))
            }
        }
    }

    pub fn activate_staged(&self, requester: Option<&Generation>, id: &str, stage_id: &str, require_approval: bool) -> HResult<Value> {
        let gen = {
            let st = self.staged.lock();
            st.get(stage_id).cloned().ok_or_else(|| HostError::not_found(format!("no staged generation {stage_id}")))?
        };
        if gen.module_id != id {
            return Err(HostError::invalid("stage id belongs to a different module"));
        }
        if require_approval {
            let req = requester.ok_or_else(|| HostError::denied("approval requires a requester"))?;
            let old = self.router.active(id).map(|g| g.label()).unwrap_or_else(|| "(none)".into());
            let detail = format!("Swap module '{id}' from {old} to {}.\nSHA-256: {}\nCapabilities: {}\n\nExisting terminals, agent processes and data are kept. The previous version stays available for rollback.",
                gen.label(), gen.hash, gen.caps.caps.iter().cloned().collect::<Vec<_>>().join(", "));
            self.require_approval(req, "modules.activate", &format!("Activate {}?", gen.label()), &detail)?;
        }
        self.staged.lock().remove(stage_id);
        let r = self.swap(id, gen.clone());
        if r.is_err() && gen.status() == GenStatus::Staged {
            // Deferred: keep it staged so the caller can retry.
            self.staged.lock().insert(stage_id.to_string(), gen);
        }
        r
    }

    pub fn rollback(&self, requester: Option<&Generation>, id: &str, to: Option<u32>, require_approval: bool) -> HResult<Value> {
        let (target, current) = {
            let store = self.artifacts.lock();
            let rec = store.get(id).cloned().unwrap_or_default();
            let current = rec.active;
            let target = match to {
                Some(v) => Some(v),
                None => rec.previous.iter().rev().find(|v| Some(**v) != current && rec.versions.iter().any(|x| x.version == **v && x.status != "failed")).cloned()
                    .or_else(|| rec.last_known_good.filter(|v| Some(*v) != current)),
            };
            (target, current)
        };
        let target = target.ok_or_else(|| HostError::not_found(format!("no earlier healthy version of '{id}' to roll back to")))?;
        if require_approval {
            let req = requester.ok_or_else(|| HostError::denied("approval requires a requester"))?;
            let detail = format!("Roll back module '{id}' from {} to {id}@{target:04}.", current.map(|v| format!("{id}@{v:04}")).unwrap_or("(none)".into()));
            self.require_approval(req, "modules.rollback", &format!("Roll back '{id}' to version {target:04}?"), &detail)?;
        }
        let (code, man, _) = self.artifacts.lock().load(id, target)?;
        let gen = self.spawn_generation(&man, target, &code)?;
        let r = self.swap(id, gen)?;
        {
            let mut store = self.artifacts.lock();
            let rec = store.record(id);
            // Rolling back consumes the history entry we returned to.
            if let Some(pos) = rec.previous.iter().rposition(|v| *v == target) {
                rec.previous.truncate(pos);
            }
            store.save();
        }
        Ok(r)
    }

    /// The swap protocol (fence -> snapshot -> candidate activate(prev) -> health -> cutover ->
    /// drain/retire old). On any failure before cutover the old generation stays active.
    fn swap(&self, id: &str, new: Arc<Generation>) -> HResult<Value> {
        let lock = self.swap_lock(id);
        let _g = lock.lock();
        let t0 = Instant::now();
        let old = self.router.active(id);
        if let Some(o) = &old {
            if o.exports.lock().get("canSwap").and_then(|v| v.as_bool()).unwrap_or(false) {
                let r = self.router.invoke_gen_blocking(o, json!({"kind": "canSwap"}), Duration::from_secs(3));
                match r {
                    Ok(v) if v.get("ok").and_then(|x| x.as_bool()) == Some(false) => {
                        let reason = v.get("reason").and_then(|x| x.as_str()).unwrap_or("module is busy").to_string();
                        return Err(HostError::new("EDEFERRED", format!("swap of '{id}' deferred: {reason}. Retry when idle.")));
                    }
                    Err(e) => log::warn!("canSwap on {} failed: {e}", o.label()),
                    _ => {}
                }
            }
        }
        self.router.fence(id)?;
        self.set_streams_paused(id, true);
        let prev = match &old {
            Some(o) if o.exports.lock().get("snapshot").and_then(|v| v.as_bool()).unwrap_or(false) => {
                match self.router.invoke_gen_blocking(o, json!({"kind": "snapshot"}), Duration::from_secs(5)) {
                    Ok(v) => v,
                    Err(e) => {
                        log::warn!("snapshot of {} failed: {e}", o.label());
                        Value::Null
                    }
                }
            }
            _ => Value::Null,
        };
        new.set_status(GenStatus::Activating);
        let mut result = self.router.invoke_gen_blocking(&new, json!({"kind": "activate", "prev": prev}), Duration::from_secs(20));
        if result.is_ok() && new.kind == "ui" {
            // Health check for UI modules: must render.
            result = self.router.invoke_gen_blocking(&new, json!({"kind": "render"}), Duration::from_secs(5)).map(|_| Value::Null);
        } else if result.is_ok() && new.exports.lock().get("methods").and_then(|m| m.as_array()).map(|a| a.iter().any(|x| x == "health")).unwrap_or(false) {
            result = self.router.invoke_gen_blocking(&new, json!({"kind": "call", "method": "health", "args": null, "caller": "kernel"}), Duration::from_secs(5));
        }
        if let Err(e) = result {
            new.set_status(GenStatus::Failed(e.message.clone()));
            self.router.retire(&new);
            self.release_stream_subs_of_gen(new.gen_id);
            self.set_streams_paused(id, false);
            self.router.cutover_and_unfence(id, None);
            self.artifacts.lock().set_status(id, new.version, "failed", &e.message);
            self.logs.push(id, new.gen_id, "error", &format!("activation of {} failed; previous version kept: {e}", new.label()));
            self.ui.send(UiMsg::ModulesChanged);
            return Err(HostError::new("EACTIVATE", format!("{} failed activation/health check; {} remains active: {}", new.label(), old.map(|o| o.label()).unwrap_or("nothing".into()), e.message)));
        }
        new.set_status(GenStatus::Active);
        // Cutover: the old generation's stream subscriptions are released; the new one subscribed
        // in activate() (same logical module) or will do so lazily.
        if let Some(o) = &old {
            o.set_status(GenStatus::Draining);
            self.release_stream_subs_of_gen(o.gen_id);
        }
        self.router.cutover_and_unfence(id, Some(new.clone()));
        self.set_streams_paused(id, false);
        {
            let mut store = self.artifacts.lock();
            store.set_status(id, new.version, "ok", "");
            let rec = store.record(id);
            if let Some(o) = &old {
                if rec.previous.last() != Some(&o.version) {
                    rec.previous.push(o.version);
                }
            }
            rec.active = Some(new.version);
            rec.last_known_good = Some(new.version);
            store.save();
        }
        self.router.set_last_error(id, None);
        if let Some(o) = old.clone() {
            let k = self.arc();
            std::thread::spawn(move || {
                let _ = k.router.invoke_gen_blocking(&o, json!({"kind": "deactivate"}), Duration::from_secs(3));
                let t = Instant::now();
                while o.inflight.load(Ordering::SeqCst) > 0 && t.elapsed() < Duration::from_secs(5) {
                    std::thread::sleep(Duration::from_millis(20));
                }
                k.router.retire(&o);
                k.ui.send(UiMsg::ModulesChanged);
            });
        }
        let ms = t0.elapsed().as_millis() as u64;
        self.logs.push(id, new.gen_id, "info", &format!("activated {} in {ms}ms", new.label()));
        self.router.emit(KERNEL_TOPIC_MODULES, &json!({"module": id, "version": new.version, "generation": new.gen_id}));
        self.ui.send(UiMsg::ModulesChanged);
        if new.kind == "ui" {
            self.request_render(id);
        }
        // Layout modules embed other UI modules via slots; re-render everything cheaply.
        self.rerender_all_ui();
        Ok(json!({"ok": true, "id": id, "version": new.version, "label": new.label(), "previous": old.map(|o| o.label()), "swapMs": ms}))
    }

    fn set_streams_paused(&self, module_id: &str, paused: bool) {
        let subs = self.subs.lock();
        for s in subs.values() {
            if s.module_id == module_id {
                s.stream.set_paused_for_module(module_id, paused);
            }
        }
    }

    pub fn release_stream_subs_of_gen(&self, gen_id: u64) {
        let mut subs = self.subs.lock();
        let ids: Vec<String> = subs.iter().filter(|(_, s)| s.gen_id == gen_id).map(|(k, _)| k.clone()).collect();
        for k in ids {
            if let Some(s) = subs.remove(&k) {
                s.stream.unsubscribe_gen(gen_id);
            }
        }
    }

    // ---- UI rendering --------------------------------------------------------------------------

    /// Coalesced asynchronous render: at most one render in flight per module.
    pub fn request_render(&self, module_id: &str) {
        {
            let mut r = self.render.lock();
            let s = r.entry(module_id.to_string()).or_default();
            if s.in_flight {
                s.dirty = true;
                return;
            }
            s.in_flight = true;
            s.dirty = false;
        }
        let k = self.arc();
        let id = module_id.to_string();
        let gen_label = self.router.active(module_id).map(|g| g.gen_id).unwrap_or(0);
        self.router.invoke(
            module_id,
            json!({"kind": "render"}),
            Reply::Native(Box::new(move |r| {
                match r {
                    Ok(tree) => k.ui.send(UiMsg::Tree { module: id.clone(), generation: gen_label, tree: Arc::new(tree) }),
                    Err(e) => k.ui.send(UiMsg::RenderError { module: id.clone(), error: e.to_string() }),
                }
                let again = {
                    let mut r = k.render.lock();
                    let s = r.entry(id.clone()).or_default();
                    s.in_flight = false;
                    std::mem::take(&mut s.dirty)
                };
                if again {
                    k.request_render(&id);
                }
            })),
            Duration::from_secs(10),
        );
    }

    pub fn rerender_all_ui(&self) {
        let ids: Vec<String> = self.manifests.lock().values().filter(|(m, _)| m.kind == "ui").map(|(m, _)| m.id.clone()).collect();
        for id in ids {
            self.request_render(&id);
        }
    }

    /// Native UI event -> module onEvent (fire-and-forget; errors are logged and surfaced).
    pub fn ui_event(&self, module_id: &str, event: Value) {
        let k = self.arc();
        let id = module_id.to_string();
        self.router.invoke(
            module_id,
            json!({"kind": "event", "event": event}),
            Reply::Native(Box::new(move |r| {
                if let Err(e) = r {
                    k.logs.push(&id, 0, "error", &format!("onEvent failed: {e}"));
                    k.ui.send(UiMsg::Toast { level: "error".into(), text: format!("{id}: {}", e.message) });
                }
                k.request_render(&id);
            })),
            Duration::from_secs(120),
        );
    }

    // ---- introspection ---------------------------------------------------------------------------

    pub fn modules_json(&self) -> Value {
        let store = self.artifacts.lock();
        let gens = self.router.all_gens();
        let mut out = Vec::new();
        for id in self.router.module_ids() {
            if id.starts_with("__") {
                continue; // kernel-internal slots (e.g. the headless test driver)
            }
            let active = self.router.active(&id);
            let rec = store.get(&id).cloned().unwrap_or_default();
            let manifest = self.manifests.lock().get(&id).map(|(m, _)| m.clone());
            let generations: Vec<Value> = gens.iter().filter(|g| g.module_id == id).map(|g| json!({
                "generation": g.gen_id, "version": g.version, "status": g.status().name(),
                "inflight": g.inflight.load(Ordering::Relaxed), "errors": g.errors.load(Ordering::Relaxed),
                "subscriptions": self.router.subscription_count(g.gen_id), "stageId": g.stage_id,
            })).collect();
            out.push(json!({
                "id": id,
                "kind": manifest.as_ref().map(|m| m.kind.clone()),
                "active": active.as_ref().map(|g| json!({"version": g.version, "generation": g.gen_id, "label": g.label(), "sha256": g.hash, "capabilities": g.caps.caps.iter().cloned().collect::<Vec<_>>()})),
                "lastKnownGood": rec.last_known_good,
                "previous": rec.previous,
                "versions": rec.versions,
                "generations": generations,
                "lastError": self.router.last_error(&id),
                "fenced": self.router.is_fenced(&id),
            }));
        }
        Value::Array(out)
    }

    /// Developer opt-in (`--dev-watch`): when `npm run modules:watch` rewrites a seed build, stage and
    /// activate it without approval prompts. Only for trusted local development — anything that can
    /// write `build/modules/` can then change running code. Off by default.
    pub fn start_dev_watch(&self) {
        let k = self.arc();
        std::thread::Builder::new().name("dev-watch".into()).spawn(move || {
            let mut seen: HashMap<String, String> = HashMap::new();
            loop {
                std::thread::sleep(Duration::from_millis(700));
                if k.shutting_down.load(Ordering::SeqCst) {
                    return;
                }
                let ids: Vec<String> = k.manifests.lock().keys().cloned().collect();
                for id in ids {
                    let Ok(code) = std::fs::read_to_string(k.cfg.seed_dir().join(format!("{id}.mjs"))) else { continue };
                    let h = sha256_hex(code.as_bytes());
                    let prev = seen.insert(id.clone(), h.clone());
                    if prev.is_none() || prev.as_deref() == Some(h.as_str()) {
                        continue;
                    }
                    if k.router.active(&id).map(|g| g.hash == h).unwrap_or(false) {
                        continue;
                    }
                    let Some(req) = k.router.active(&id) else { continue };
                    let r = k.stage(&req, &id, &code, "dev-watch", false).and_then(|v| {
                        let sid = v["stageId"].as_str().unwrap_or("").to_string();
                        k.activate_staged(None, &id, &sid, false)
                    });
                    let text = match &r { Ok(v) => format!("dev-watch: {} active", v["label"].as_str().unwrap_or(&id)), Err(e) => format!("dev-watch: {id} not activated: {e}") };
                    log::info!("{text}");
                    k.ui.send(UiMsg::Toast { level: if r.is_ok() { "info".into() } else { "error".into() }, text });
                }
            }
        }).ok();
    }

    pub fn shutdown(&self) {
        self.shutting_down.store(true, Ordering::SeqCst);
        // Live process/PTY resources only need to survive JS reloads, not a kernel exit.
        for h in self.handles.handles_of_kind("process") {
            if let Some(p) = self.handles.get_kernel::<crate::host::process::ProcessRes>(&h, "process") {
                p.close_stdin();
                let _ = p.terminate(Some("TERM"));
            }
        }
        for h in self.handles.handles_of_kind("pty") {
            if let Some(p) = self.handles.get_kernel::<crate::host::pty::PtySession>(&h, "pty") {
                p.kill();
            }
        }
        self.ssh.shutdown();
        for g in self.router.all_gens() {
            let _ = g.tx.send(WorkerMsg::Shutdown);
        }
    }
}
