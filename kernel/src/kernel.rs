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
use crate::plugins::{self, Discovered, PluginRegistry, Source};
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
    /// Remote runtimes started on machines (by machine id).
    pub daemons: crate::host::daemon_link::DaemonTable,
    pub subs: Mutex<HashMap<String, StreamSub>>,
    render: Mutex<HashMap<String, RenderSched>>,
    pub manifests: Mutex<HashMap<String, (Manifest, PathBuf)>>,
    sources: Mutex<HashMap<String, Source>>,
    pub plugins: PluginRegistry,
    /// Serializes module lifecycle operations per module id.
    swap_locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    staged: Mutex<HashMap<String, Arc<Generation>>>,
    pub shutting_down: AtomicBool,
    pub boot_report: Mutex<Vec<Value>>,
    pub started: Instant,
}

pub const KERNEL_TOPIC_MODULES: &str = "kernel.modules.changed";
/// Router error for slots of disabled plugins.
pub const DISABLED: &str = "plugin is disabled";

impl Kernel {
    pub fn new(cfg: Config, ui: UiBridge) -> anyhow::Result<Arc<Kernel>> {
        let grants = GrantRegistry::load(cfg.approved_grants_file())?;
        let audit = Audit::new(cfg.logs_dir().join("audit.log"));
        let logs = ModuleLogs::open(cfg.logs_dir().join("modules.log"));
        let artifacts = ArtifactStore::open(cfg.artifacts_dir(), cfg.registry_file());
        let plugin_registry = cfg.plugin_registry_file();
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
            daemons: Default::default(),
            subs: Mutex::new(HashMap::new()),
            render: Mutex::new(HashMap::new()),
            manifests: Mutex::new(HashMap::new()),
            sources: Mutex::new(HashMap::new()),
            plugins: PluginRegistry::open(plugin_registry),
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
        self.discover_all().into_iter().map(|d| (d.manifest, d.dir)).collect()
    }

    /// Every plugin on disk: built-ins from the repository, then user plugins from the data dir.
    /// A user plugin may not reuse a built-in id (replace built-ins through contracts instead).
    pub fn discover_all(&self) -> Vec<Discovered> {
        let mut out: Vec<Discovered> = Vec::new();
        let sorted_dirs = |d: &std::path::Path| -> Vec<PathBuf> {
            let Ok(rd) = std::fs::read_dir(d) else { return Vec::new() };
            let mut dirs: Vec<PathBuf> = rd.filter_map(|e| e.ok().map(|e| e.path())).filter(|p| p.join("manifest.json").is_file()).collect();
            dirs.sort();
            dirs
        };
        for sub in ["services", "ui"] {
            for dir in sorted_dirs(&self.cfg.modules_dir().join(sub)) {
                match plugins::read_manifest(&dir) {
                    Ok(m) => {
                        let expected_kind = if sub == "services" { "service" } else { "ui" };
                        if m.kind != expected_kind {
                            log::error!("manifest {} kind does not match its location", dir.display());
                            continue;
                        }
                        out.push(Discovered { manifest: m, dir, source: Source::Builtin });
                    }
                    Err(e) => log::error!("invalid manifest in {}: {e}", dir.display()),
                }
            }
        }
        for dir in sorted_dirs(&self.cfg.plugins_dir()) {
            match plugins::read_manifest(&dir) {
                Ok(m) if out.iter().any(|d| d.manifest.id == m.id) => {
                    log::error!("user plugin {} reuses the id of a built-in plugin; skipped", dir.display());
                }
                Ok(m) => out.push(Discovered { manifest: m, dir, source: Source::User }),
                Err(e) => log::error!("invalid user plugin in {}: {e}", dir.display()),
            }
        }
        out
    }

    pub fn plugin_source(&self, id: &str) -> Option<Source> { self.sources.lock().get(id).copied() }

    pub fn plugin_enabled(&self, id: &str) -> bool {
        match self.plugin_source(id) {
            Some(s) => self.plugins.is_enabled(id, s),
            None => id.starts_with("__"),
        }
    }

    /// Plugin that renders the window: the explicit override if it is enabled and provides the
    /// root contract, else the first enabled provider (user plugins before built-ins).
    pub fn root_module(&self) -> Option<String> {
        let manifests = self.manifests.lock();
        let provides_root = |id: &str| manifests.get(id).map(|(m, _)| m.provides.iter().any(|c| c == plugins::ROOT_CONTRACT)).unwrap_or(false);
        if let Some(id) = self.plugins.root_override() {
            if provides_root(&id) && self.plugin_enabled(&id) {
                return Some(id);
            }
        }
        let mut candidates: Vec<(u8, String)> = manifests.keys().filter(|id| provides_root(id) && self.plugin_enabled(id))
            .map(|id| (if self.plugin_source(id) == Some(Source::User) { 0 } else { 1 }, id.clone())).collect();
        candidates.sort();
        candidates.into_iter().next().map(|(_, id)| id)
    }

    /// Enabled plugins implementing a contract.
    pub fn providers(&self, contract: &str) -> Vec<String> {
        let mut v: Vec<String> = self.manifests.lock().iter()
            .filter(|(_, (m, _))| m.provides.iter().any(|c| c == contract))
            .map(|(id, _)| id.clone()).filter(|id| self.plugin_enabled(id)).collect();
        v.sort();
        v
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
        let discovered = self.register_discovered();
        let enabled: Vec<&Discovered> = discovered.iter().filter(|d| self.plugins.is_enabled(&d.manifest.id, d.source)).collect();
        for d in &enabled {
            let _ = self.router.fence(&d.manifest.id);
        }
        // Services first, then UI.
        let mut order = enabled;
        order.sort_by_key(|d| if d.manifest.kind == "service" { 0 } else { 1 });
        let mut waits = Vec::new();
        for d in order {
            if let Some(rx) = self.load_plugin(d) {
                waits.push(rx);
            }
        }
        for rx in waits {
            let _ = rx.recv_timeout(Duration::from_secs(35));
        }
        self.ui.send(UiMsg::ModulesChanged);
        self.rerender_all_ui();
    }

    /// Record every discovered plugin (manifest, source, router slot). Disabled plugins get a slot
    /// whose error explains why calls fail.
    fn register_discovered(&self) -> Vec<Discovered> {
        let discovered = self.discover_all();
        {
            let mut m = self.manifests.lock();
            let mut s = self.sources.lock();
            for d in &discovered {
                m.insert(d.manifest.id.clone(), (d.manifest.clone(), d.dir.clone()));
                s.insert(d.manifest.id.clone(), d.source);
            }
        }
        for d in &discovered {
            self.router.ensure_slot(&d.manifest.id);
            if !self.plugins.is_enabled(&d.manifest.id, d.source) && self.router.active(&d.manifest.id).is_none() {
                self.router.set_last_error(&d.manifest.id, Some(DISABLED.into()));
            }
        }
        discovered
    }

    fn seed_path(&self, d: &Discovered) -> Option<PathBuf> {
        match d.source {
            Source::Builtin => Some(self.cfg.seed_dir().join(format!("{}.mjs", d.manifest.id))),
            Source::User => plugins::user_seed(&d.dir, &d.manifest),
        }
    }

    /// Load one (fenced) plugin at its active version, importing a changed seed first. Activation
    /// runs asynchronously; the returned channel fires when it finished.
    fn load_plugin(&self, d: &Discovered) -> Option<crossbeam_channel::Receiver<()>> {
        let m = &d.manifest;
        {
            let id = m.id.clone();
            // Import a changed seed build (developer `npm run modules:build`, or a user plugin's dist).
            if let Some(code) = self.seed_path(d).and_then(|p| std::fs::read_to_string(p).ok()) {
                let hash = sha256_hex(code.as_bytes());
                let mut store = self.artifacts.lock();
                let known = store.has_hash(&id, &hash);
                let rec_seed = store.get(&id).and_then(|r| r.seed_hash.clone());
                if rec_seed.as_deref() != Some(hash.as_str()) && !self.cfg.safe_mode {
                    let v = match known {
                        Some(v) => Some(v),
                        None => match store.put(&id, &code, m, if d.source == Source::User { "plugin" } else { "seed" }) {
                            Ok(vr) => Some(vr.version),
                            Err(e) => {
                                log::error!("cannot store seed artifact for {id}: {e}");
                                None
                            }
                        },
                    };
                    if let Some(v) = v {
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
                let hint = if d.source == Source::User { "build the plugin into dist/<id>.mjs" } else { "run `npm run modules:build`" };
                let msg = if errors.is_empty() { format!("{id}: no artifact ({hint})") } else { errors.join("; ") };
                log::error!("module {id} unavailable: {msg}");
                self.router.set_last_error(&id, Some(msg.clone()));
                self.boot_report.lock().push(json!({"module": id, "ok": false, "error": msg}));
                self.router.cutover_and_unfence(&id, None);
                return None;
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
            Some(rx)
        }
    }

    // ---- plugin lifecycle -------------------------------------------------------------------------

    /// Enable and load a plugin. New capabilities/call targets need a trusted approval first.
    pub fn enable_plugin(&self, requester: Option<&Generation>, id: &str) -> HResult<Value> {
        let d = self.discover_all().into_iter().find(|d| d.manifest.id == id).ok_or_else(|| HostError::not_found(format!("no plugin '{id}'")))?;
        let escalation = self.grants.escalation(&d.manifest);
        if !escalation.is_empty() {
            let req = requester.ok_or_else(|| HostError::denied("enabling this plugin needs an approval requester"))?;
            let detail = format!(
                "Plugin: {} ({id}, {} {})\nSource folder: {}\n\nIt asks for:\n  {}\n\n`call:<module>` entries let it call that module's methods. Only allow plugins you trust.",
                d.manifest.display_name(), d.source.name(), d.manifest.kind, d.dir.display(), escalation.join("\n  "));
            self.require_approval(req, "plugins.enable", &format!("Enable plugin '{}' with these permissions?", d.manifest.display_name()), &detail)?;
            self.grants.record_approval(id, &escalation);
        }
        self.plugins.set_enabled(id, true);
        let discovered = self.register_discovered();
        let Some(d) = discovered.iter().find(|x| x.manifest.id == id) else { return Err(HostError::not_found(id.to_string())) };
        if self.router.active(id).is_none() {
            self.router.set_last_error(id, None);
            self.router.fence(id)?;
            if let Some(rx) = self.load_plugin(d) {
                let _ = rx.recv_timeout(Duration::from_secs(35));
            }
        }
        self.after_plugin_change(id);
        if let Some(r) = requester {
            self.audit.record(&r.module_id, r.gen_id, "plugins.enable", id, "ok", None);
        }
        let err = self.router.last_error(id);
        Ok(json!({"id": id, "enabled": true, "active": self.router.active(id).is_some(), "error": err}))
    }

    /// Plugins that would lose something they need if `id` were disabled.
    pub fn dependents_of(&self, id: &str) -> Vec<String> {
        let manifests: Vec<Manifest> = self.manifests.lock().values().map(|(m, _)| m.clone()).collect();
        let target = manifests.iter().find(|m| m.id == id).cloned();
        let mut out = Vec::new();
        for m in &manifests {
            if m.id == id || !self.plugin_enabled(&m.id) {
                continue;
            }
            let needs_module = m.dependencies.iter().any(|d| d == id);
            let needs_contract = target.as_ref().map(|t| m.requires.iter().any(|c| {
                t.provides.contains(c) && self.providers(c).iter().all(|p| p == id)
            })).unwrap_or(false);
            if needs_module || needs_contract {
                out.push(m.id.clone());
            }
        }
        out.sort();
        out
    }

    /// Disable and unload a plugin (and, with `cascade`, everything that depends on it).
    /// Kernel-owned resources the plugin held are released.
    pub fn disable_plugin(&self, requester: Option<&Generation>, id: &str, cascade: bool) -> HResult<Value> {
        if self.plugin_source(id).is_none() {
            return Err(HostError::not_found(format!("no plugin '{id}'")));
        }
        if requester.map(|r| r.module_id == id).unwrap_or(false) {
            return Err(HostError::invalid("a plugin cannot disable itself"));
        }
        let mut dependents: Vec<String> = Vec::new();
        let mut work = vec![id.to_string()];
        while let Some(cur) = work.pop() {
            for d in self.dependents_of(&cur) {
                if d != id && !dependents.contains(&d) {
                    dependents.push(d.clone());
                    work.push(d);
                }
            }
        }
        if !dependents.is_empty() && !cascade {
            return Err(HostError::new("EDEPENDENTS", format!("plugins that depend on '{id}': {}", dependents.join(", "))));
        }
        let mut disabled = vec![];
        for dep in dependents.iter().chain(std::iter::once(&id.to_string())) {
            self.plugins.set_enabled(dep, false);
            self.unload_plugin(dep);
            disabled.push(dep.clone());
        }
        self.after_plugin_change(id);
        if let Some(r) = requester {
            self.audit.record(&r.module_id, r.gen_id, "plugins.disable", &disabled.join(","), "ok", None);
        }
        Ok(json!({"disabled": disabled}))
    }

    fn unload_plugin(&self, id: &str) {
        let lock = self.swap_lock(id);
        let _g = lock.lock();
        if self.router.fence(id).is_err() {
            return;
        }
        let old = self.router.clear_active(id);
        self.router.set_last_error(id, Some(DISABLED.into()));
        self.router.cutover_and_unfence(id, None);
        if let Some(o) = old {
            o.set_status(GenStatus::Draining);
            self.release_stream_subs_of_gen(o.gen_id);
            let _ = self.router.invoke_gen_blocking(&o, json!({"kind": "deactivate"}), Duration::from_secs(3));
            self.router.retire(&o);
        }
        for h in self.handles.handles_owned_by(id) {
            self.release_handle(&h);
        }
    }

    /// Kernel-side release of one resource (PTYs and processes are terminated).
    fn release_handle(&self, h: &str) {
        match self.handles.kind_of(h) {
            Some("pty") => {
                if let Some(p) = self.handles.get_kernel::<crate::host::pty::PtySession>(h, "pty") {
                    p.kill();
                }
            }
            Some("process") => {
                if let Some(p) = self.handles.get_kernel::<crate::host::process::ProcessRes>(h, "process") {
                    p.close_stdin();
                    let _ = p.terminate(Some("TERM"));
                }
            }
            _ => {}
        }
        let _ = self.handles.remove(h, "*kernel*");
    }

    fn after_plugin_change(&self, id: &str) {
        self.router.emit(KERNEL_TOPIC_MODULES, &json!({"module": id, "plugins": true}));
        self.ui.send(UiMsg::ModulesChanged);
        self.rerender_all_ui();
    }

    pub fn set_root_plugin(&self, id: Option<&str>) -> HResult<()> {
        if let Some(id) = id {
            let provides = self.manifests.lock().get(id).map(|(m, _)| m.provides.iter().any(|c| c == plugins::ROOT_CONTRACT)).unwrap_or(false);
            if !provides {
                return Err(HostError::invalid(format!("'{id}' does not provide {}", plugins::ROOT_CONTRACT)));
            }
        }
        self.plugins.set_root(id.map(str::to_owned));
        self.after_plugin_change(id.unwrap_or(""));
        Ok(())
    }

    /// Copy a plugin folder into the kernel-owned plugins dir (disabled until enabled).
    pub fn install_plugin(&self, requester: &Generation, from: &str) -> HResult<Value> {
        let src = std::fs::canonicalize(from).map_err(|e| HostError::new("ENOENT", format!("{from}: {e}")))?;
        let m = plugins::read_manifest(&src).map_err(|e| HostError::invalid(format!("not a plugin folder: {e}")))?;
        if self.plugin_source(&m.id) == Some(Source::Builtin) {
            return Err(HostError::invalid(format!("'{}' is a built-in plugin id", m.id)));
        }
        let dst = self.cfg.plugins_dir().join(&m.id);
        let replacing = dst.exists();
        let detail = format!(
            "Install plugin '{}' ({}, {})\nfrom {}\n{}\nRequested capabilities: {}\nCalls: {}\n\nInstalled plugins stay disabled until you enable them.",
            m.display_name(), m.id, m.kind, src.display(),
            if replacing { "This REPLACES the installed copy." } else { "" },
            if m.capabilities.is_empty() { "none".into() } else { m.capabilities.join(", ") },
            if m.calls.is_empty() { "none".into() } else { m.calls.join(", ") });
        self.require_approval(requester, "plugins.install", &format!("Install plugin '{}'?", m.display_name()), &detail)?;
        if replacing {
            self.unload_plugin(&m.id);
            std::fs::remove_dir_all(&dst)?;
        }
        plugins::copy_plugin_dir(&src, &dst)?;
        self.register_discovered();
        let id = m.id.clone();
        let was_enabled = self.plugin_enabled(&id);
        if replacing && was_enabled {
            // Reload the new copy.
            if let Some(d) = self.discover_all().into_iter().find(|d| d.manifest.id == id) {
                if self.router.fence(&id).is_ok() {
                    if let Some(rx) = self.load_plugin(&d) {
                        let _ = rx.recv_timeout(Duration::from_secs(35));
                    }
                }
            }
        }
        self.audit.record(&requester.module_id, requester.gen_id, "plugins.install", &id, "ok", Some("native-user"));
        self.after_plugin_change(&id);
        Ok(json!({"id": id, "enabled": was_enabled, "dir": dst.to_string_lossy()}))
    }

    pub fn uninstall_plugin(&self, requester: &Generation, id: &str) -> HResult<Value> {
        if self.plugin_source(id) != Some(Source::User) {
            return Err(HostError::invalid("only user-installed plugins can be uninstalled; disable built-ins instead"));
        }
        let dependents = self.dependents_of(id);
        let detail = format!("Remove plugin '{id}' and its approvals.{}", if dependents.is_empty() { String::new() } else { format!("\nThese plugins will be disabled: {}", dependents.join(", ")) });
        self.require_approval(requester, "plugins.uninstall", &format!("Uninstall plugin '{id}'?"), &detail)?;
        for dep in &dependents {
            self.plugins.set_enabled(dep, false);
            self.unload_plugin(dep);
        }
        self.unload_plugin(id);
        let dir = self.cfg.plugins_dir().join(id);
        if dir.starts_with(self.cfg.plugins_dir()) && dir.exists() {
            std::fs::remove_dir_all(&dir)?;
        }
        self.plugins.forget(id);
        self.grants.forget(id);
        self.manifests.lock().remove(id);
        self.sources.lock().remove(id);
        self.router.set_last_error(id, Some("uninstalled".into()));
        self.audit.record(&requester.module_id, requester.gen_id, "plugins.uninstall", id, "ok", Some("native-user"));
        self.after_plugin_change(id);
        Ok(json!({"id": id, "uninstalled": true, "disabled": dependents}))
    }

    /// Pick up plugin folders added or edited on disk; enabled new plugins are loaded.
    pub fn rescan_plugins(&self) -> Value {
        let before: Vec<String> = self.sources.lock().keys().cloned().collect();
        let discovered = self.register_discovered();
        let mut added = Vec::new();
        for d in &discovered {
            if before.contains(&d.manifest.id) {
                continue;
            }
            added.push(d.manifest.id.clone());
            if self.plugins.is_enabled(&d.manifest.id, d.source) && self.router.active(&d.manifest.id).is_none() && self.router.fence(&d.manifest.id).is_ok() {
                if let Some(rx) = self.load_plugin(d) {
                    let _ = rx.recv_timeout(Duration::from_secs(35));
                }
            }
        }
        self.after_plugin_change("");
        json!({"added": added})
    }

    pub fn plugins_json(&self) -> Value {
        let manifests: Vec<(Manifest, PathBuf)> = self.manifests.lock().values().cloned().collect();
        let mut out: Vec<Value> = manifests.iter().map(|(m, dir)| {
            let id = &m.id;
            let source = self.plugin_source(id).unwrap_or(Source::Builtin);
            let active = self.router.active(id);
            json!({
                "id": id, "name": m.display_name(), "kind": m.kind, "description": m.description, "source": source.name(),
                "enabled": self.plugins.is_enabled(id, source), "active": active.as_ref().map(|g| g.label()),
                "provides": m.provides, "requires": m.requires, "dependencies": m.dependencies, "runsOn": m.placement(),
                "capabilities": m.capabilities, "calls": m.calls, "pendingApprovals": self.grants.escalation(m),
                "contributes": m.contributes, "lastError": self.router.last_error(id),
                "dir": if source == Source::User { Value::String(dir.to_string_lossy().into_owned()) } else { Value::Null },
            })
        }).collect();
        out.sort_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));
        json!({"plugins": out, "root": self.root_module(), "rootOverride": self.plugins.root_override()})
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
        // Discovery subscribers need the same lifecycle event at boot as at hot cutover.
        self.router.emit(KERNEL_TOPIC_MODULES, &json!({"module": id, "version": gen.version, "generation": gen.gen_id}));
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
        for id in ids.into_iter().filter(|id| self.router.active(id).is_some() || self.router.is_fenced(id)) {
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
