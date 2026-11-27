//! Operator limits applied to every module a kernel runs. `hato daemon` loads them from its
//! directory; the desktop kernel runs with none. A desktop sets them through the daemon's
//! `policy.set` (admin-only), so a pushed plugin cannot change the limits it runs under.
//!
//! The limits cover what modules ask the kernel for (capabilities, scope roots, processes,
//! terminals, process memory). They are not a sandbox: programs a module starts (for example an
//! agent's own shell commands) run as the same user and are bound only by the process limits.
//! Which agent, project or workflow is affected is decided in modules, not here.

use crate::util::HostError;
use parking_lot::{Mutex, RwLock};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::path::PathBuf;

const MAX_ENTRIES: usize = 64;
const MAX_DENIALS: usize = 50;

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct HostPolicy {
    /// Capabilities no module receives, whatever was approved. `*` denies all of them.
    pub capability_deny: Vec<String>,
    /// Absolute folders that local fs/process/terminal scopes must fall inside. Empty: any.
    pub fs_roots: Vec<String>,
    /// Most live processes / terminals started by modules. 0: no limit.
    pub max_processes: u32,
    pub max_terminals: u32,
    /// Memory limit for each process tree started by a module (MiB). 0: no limit.
    pub process_memory_mb: u64,
}

impl HostPolicy {
    fn validate(&self) -> Result<(), String> {
        if self.capability_deny.len() > MAX_ENTRIES || self.fs_roots.len() > MAX_ENTRIES {
            return Err(format!("at most {MAX_ENTRIES} capabilities and {MAX_ENTRIES} folders"));
        }
        for c in &self.capability_deny {
            if c.is_empty() || c.len() > 64 || !c.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b".:*-_".contains(&b)) {
                return Err(format!("invalid capability name '{c}'"));
            }
        }
        for r in &self.fs_roots {
            if !std::path::Path::new(r).is_absolute() {
                return Err(format!("folder '{r}' must be an absolute path"));
            }
        }
        if self.max_processes > 10_000 || self.max_terminals > 10_000 || self.process_memory_mb > 1 << 22 {
            return Err("limit out of range".into());
        }
        Ok(())
    }
}

#[derive(Debug, Default)]
pub struct PolicyState {
    path: Mutex<Option<PathBuf>>,
    policy: RwLock<HostPolicy>,
    denials: Mutex<VecDeque<Value>>,
}

impl PolicyState {
    /// Load the saved policy. An unreadable or invalid file denies every capability (fail closed)
    /// until a desktop sets a valid policy.
    pub fn load(&self, path: PathBuf) {
        let policy = match std::fs::read_to_string(&path) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => HostPolicy::default(),
            Err(e) => Self::closed(&format!("cannot read {}: {e}", path.display())),
            Ok(text) => match serde_json::from_str::<HostPolicy>(&text).map_err(|e| e.to_string()).and_then(|p| p.validate().map(|_| p)) {
                Ok(p) => p,
                Err(e) => Self::closed(&format!("invalid {}: {e}", path.display())),
            },
        };
        *self.policy.write() = policy;
        *self.path.lock() = Some(path);
    }

    fn closed(reason: &str) -> HostPolicy {
        log::error!("host policy: {reason}; denying all capabilities until a valid policy is set");
        HostPolicy { capability_deny: vec!["*".into()], ..Default::default() }
    }

    pub fn get(&self) -> HostPolicy { self.policy.read().clone() }

    /// Validate, save (when loaded from a file) and apply.
    pub fn set(&self, value: &Value) -> Result<HostPolicy, HostError> {
        let policy: HostPolicy = serde_json::from_value(value.clone()).map_err(|e| HostError::invalid(format!("policy: {e}")))?;
        policy.validate().map_err(HostError::invalid)?;
        if let Some(path) = self.path.lock().as_ref() {
            let text = serde_json::to_string_pretty(&policy).map_err(|e| HostError::invalid(e.to_string()))?;
            let tmp = path.with_extension("json.tmp");
            std::fs::write(&tmp, text).and_then(|_| std::fs::rename(&tmp, path)).map_err(HostError::from)?;
        }
        *self.policy.write() = policy.clone();
        Ok(policy)
    }

    pub fn denies_capability(&self, cap: &str) -> bool {
        self.policy.read().capability_deny.iter().any(|c| c == "*" || c == cap)
    }

    /// `root` is canonical. Folders in the policy are canonicalized the same way when checked, so
    /// a symlinked policy folder still matches; a folder that does not exist matches nothing.
    pub fn check_root(&self, root: &str) -> Result<(), String> {
        let roots = self.policy.read().fs_roots.clone();
        if roots.is_empty() {
            return Ok(());
        }
        let inside = roots.iter().any(|r| {
            let canonical = crate::util::canonical_string(std::path::Path::new(r)).unwrap_or_else(|_| r.clone());
            local_within(&canonical, root)
        });
        if inside { Ok(()) } else { Err(format!("{root} is outside the folders this machine allows ({})", roots.join(", "))) }
    }

    /// `live` resources of `kind` ("process" / "terminal") already exist.
    pub fn check_count(&self, kind: &str, live: usize) -> Result<(), String> {
        let p = self.policy.read();
        let max = if kind == "terminal" { p.max_terminals } else { p.max_processes } as usize;
        let noun = match (kind, max) { ("terminal", 1) => "terminal", ("terminal", _) => "terminals", (_, 1) => "process", _ => "processes" };
        if max > 0 && live >= max { Err(format!("this machine allows at most {max} {noun} started by plugins")) } else { Ok(()) }
    }

    pub fn memory_limit_mb(&self) -> Option<u64> {
        let mb = self.policy.read().process_memory_mb;
        (mb > 0).then_some(mb)
    }

    pub fn record_denial(&self, module: &str, op: &str, reason: &str) {
        log::warn!("host policy denied {op} for {module}: {reason}");
        let mut d = self.denials.lock();
        if d.len() == MAX_DENIALS {
            d.pop_front();
        }
        d.push_back(json!({"time": crate::util::now_iso(), "module": module, "op": op, "reason": reason}));
    }

    pub fn status_json(&self) -> Value {
        json!({"policy": self.get(), "denials": self.denials.lock().iter().rev().cloned().collect::<Vec<_>>()})
    }
}

/// Containment for canonical local paths, separator-aware and case-insensitive on Windows.
pub fn local_within(root: &str, path: &str) -> bool {
    let norm = |p: &str| {
        let p = p.replace('\\', "/");
        let p = p.strip_prefix("//?/").unwrap_or(&p).trim_end_matches('/').to_string();
        if cfg!(windows) { p.to_lowercase() } else { p }
    };
    let (r, p) = (norm(root), norm(path));
    !r.is_empty() && (p == r || p.starts_with(&format!("{r}/")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn containment_respects_boundaries() {
        assert!(local_within("/home/u/work", "/home/u/work"));
        assert!(local_within("/home/u/work", "/home/u/work/a/b"));
        assert!(!local_within("/home/u/work", "/home/u/workshop"));
        assert!(!local_within("/home/u/work", "/home/u"));
        assert!(local_within("/home/u/work/", "/home/u/work/x"));
    }

    #[test]
    fn set_validates_and_persists_and_bad_files_fail_closed() {
        let dir = std::env::temp_dir().join(format!("hato-policy-{}", crate::util::random_hex(6)));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("policy.json");
        let s = PolicyState::default();
        s.load(path.clone());
        assert!(!s.denies_capability("fs.scope"));
        assert!(s.set(&json!({"capabilityDeny": ["Bad Name"]})).is_err());
        assert!(s.set(&json!({"fsRoots": ["relative"]})).is_err());
        assert!(s.set(&json!({"unknown": 1})).is_err());
        s.set(&json!({"capabilityDeny": ["net.fetch"], "maxProcesses": 2})).unwrap();
        assert!(s.denies_capability("net.fetch") && !s.denies_capability("fs.scope"));
        assert!(s.check_count("process", 1).is_ok() && s.check_count("process", 2).is_err());
        assert!(s.check_count("terminal", 99).is_ok());
        let again = PolicyState::default();
        again.load(path.clone());
        assert_eq!(again.get(), s.get());
        std::fs::write(&path, "{not json").unwrap();
        let broken = PolicyState::default();
        broken.load(path);
        assert!(broken.denies_capability("fs.scope"));
        let _ = std::fs::remove_dir_all(dir);
    }
}
