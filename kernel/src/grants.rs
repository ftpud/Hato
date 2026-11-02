//! Capability grants.
//!
//! * Install-time grants: the first-party grant registry (`grants/first-party.json`) is compiled into
//!   the kernel binary, so no module (or agent with a shell) can widen it at runtime. Additional
//!   capabilities requested by a changed manifest need a trusted native approval and are recorded in
//!   the kernel-owned `approved-grants.json` in the protected data dir.
//! * Effective capabilities of a generation = manifest request ∩ (install grant ∪ approved extras).
//! * Scope grants: runtime, resource-specific grants (a local root, a verified remote root, the module
//!   source tree, the build tool) handed out as opaque handles and checked on every operation.
use crate::util::{HResult, HostError};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, HashMap};
use std::path::PathBuf;

pub const FIRST_PARTY_GRANTS: &str = include_str!("../../grants/first-party.json");

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
pub struct InstallGrant {
    pub kind: String,
    pub capabilities: Vec<String>,
    #[serde(default)]
    pub calls: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct GrantFile {
    #[serde(rename = "schemaVersion")]
    schema_version: u32,
    modules: HashMap<String, InstallGrant>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Manifest {
    #[serde(rename = "schemaVersion")]
    pub schema_version: u32,
    pub id: String,
    pub kind: String,
    pub entry: String,
    #[serde(rename = "moduleApiVersion")]
    pub module_api_version: u32,
    #[serde(default)]
    pub dependencies: Vec<String>,
    #[serde(default)]
    pub capabilities: Vec<String>,
    #[serde(rename = "stateVersion", default)]
    pub state_version: u32,
    #[serde(default)]
    pub description: String,
}

impl Manifest {
    pub fn validate(&self) -> HResult<()> {
        if self.schema_version != 1 {
            return Err(HostError::invalid(format!("unsupported manifest schemaVersion {}", self.schema_version)));
        }
        if self.module_api_version != 1 {
            return Err(HostError::invalid(format!("unsupported moduleApiVersion {}", self.module_api_version)));
        }
        if !valid_module_id(&self.id) {
            return Err(HostError::invalid(format!("invalid module id {:?}", self.id)));
        }
        if self.kind != "service" && self.kind != "ui" {
            return Err(HostError::invalid(format!("invalid module kind {:?}", self.kind)));
        }
        for c in &self.capabilities {
            if c.len() > 80 || c.chars().any(|ch| ch.is_whitespace()) {
                return Err(HostError::invalid(format!("invalid capability {c:?}")));
            }
        }
        Ok(())
    }
}

pub fn valid_module_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 48 && id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

#[derive(Debug, Clone)]
pub struct EffectiveCaps {
    pub caps: BTreeSet<String>,
    pub calls: BTreeSet<String>,
}

impl EffectiveCaps {
    pub fn has(&self, cap: &str) -> bool { self.caps.contains(cap) }
    pub fn require(&self, cap: &str) -> HResult<()> {
        if self.has(cap) { Ok(()) } else { Err(HostError::denied(format!("capability '{cap}' not granted to this module"))) }
    }
    pub fn may_call(&self, target: &str) -> bool { self.calls.contains("*") || self.calls.contains(target) }
}

pub struct GrantRegistry {
    install: HashMap<String, InstallGrant>,
    approved_path: PathBuf,
    approved: Mutex<HashMap<String, BTreeSet<String>>>,
}

impl GrantRegistry {
    pub fn load(approved_path: PathBuf) -> anyhow::Result<Self> {
        Self::from_str(FIRST_PARTY_GRANTS, approved_path)
    }

    pub fn from_str(src: &str, approved_path: PathBuf) -> anyhow::Result<Self> {
        let f: GrantFile = serde_json::from_str(src)?;
        anyhow::ensure!(f.schema_version == 1, "unsupported grants schema");
        let approved = std::fs::read_to_string(&approved_path)
            .ok()
            .and_then(|s| serde_json::from_str::<HashMap<String, BTreeSet<String>>>(&s).ok())
            .unwrap_or_default();
        Ok(GrantRegistry { install: f.modules, approved_path, approved: Mutex::new(approved) })
    }

    pub fn install_grant(&self, id: &str) -> Option<&InstallGrant> { self.install.get(id) }

    /// Capabilities requested by the manifest but not covered by install grant or prior approvals.
    pub fn escalation(&self, m: &Manifest) -> Vec<String> {
        let approved = self.approved.lock();
        let base: BTreeSet<String> = self.install.get(&m.id).map(|g| g.capabilities.iter().cloned().collect()).unwrap_or_default();
        let extra = approved.get(&m.id).cloned().unwrap_or_default();
        m.capabilities.iter().filter(|c| !base.contains(*c) && !extra.contains(*c)).cloned().collect()
    }

    pub fn record_approval(&self, id: &str, caps: &[String]) {
        let mut approved = self.approved.lock();
        approved.entry(id.to_string()).or_default().extend(caps.iter().cloned());
        if let Ok(s) = serde_json::to_string_pretty(&*approved) {
            let _ = std::fs::write(&self.approved_path, s);
        }
    }

    /// Effective capability set: request ∩ (install ∪ approved). Never more than the upper bound.
    pub fn effective(&self, m: &Manifest) -> EffectiveCaps {
        let approved = self.approved.lock();
        let mut upper: BTreeSet<String> = self.install.get(&m.id).map(|g| g.capabilities.iter().cloned().collect()).unwrap_or_default();
        if let Some(extra) = approved.get(&m.id) {
            upper.extend(extra.iter().cloned());
        }
        let caps = m.capabilities.iter().filter(|c| upper.contains(*c)).cloned().collect();
        let calls = self.install.get(&m.id).map(|g| g.calls.iter().cloned().collect()).unwrap_or_default();
        EffectiveCaps { caps, calls }
    }

    pub fn known_modules(&self) -> Vec<String> {
        let mut v: Vec<String> = self.install.keys().cloned().collect();
        v.sort();
        v
    }
}

// ---------------------------------------------------------------------------------------------
// Scope grants

#[derive(Debug, Clone, PartialEq)]
pub enum Target {
    Local,
    /// Remote machine reached through a live SSH master; `machine_id` is kernel-derived.
    Ssh { machine_id: String, master_key: String },
}

impl Target {
    pub fn machine_id(&self) -> String {
        match self {
            Target::Local => "local".into(),
            Target::Ssh { machine_id, .. } => machine_id.clone(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ScopeKind {
    /// Workspace files (read-only unless `write`).
    Fs,
    /// Processes with cwd inside root.
    Process,
    /// PTYs with cwd inside root.
    Pty,
    /// Allowlisted module source tree (`<repo>/modules`). Writes need per-operation native approval.
    Source,
    /// Build tool execution (esbuild only, cwd = repo root, output to stdout only).
    Build,
}

impl ScopeKind {
    pub fn parse(s: &str) -> HResult<Self> {
        Ok(match s {
            "fs" => ScopeKind::Fs,
            "process" => ScopeKind::Process,
            "pty" => ScopeKind::Pty,
            "source" => ScopeKind::Source,
            "build" => ScopeKind::Build,
            _ => return Err(HostError::invalid(format!("unknown scope kind {s:?}"))),
        })
    }
    pub fn name(&self) -> &'static str {
        match self {
            ScopeKind::Fs => "fs",
            ScopeKind::Process => "process",
            ScopeKind::Pty => "pty",
            ScopeKind::Source => "source",
            ScopeKind::Build => "build",
        }
    }
}

#[derive(Debug)]
pub struct ScopeGrant {
    pub kind: ScopeKind,
    pub target: Target,
    /// Canonical root on the target machine.
    pub root: String,
    pub write: bool,
    pub owner: String,
    pub revoked: std::sync::atomic::AtomicBool,
}

impl ScopeGrant {
    pub fn check_live(&self) -> HResult<()> {
        if self.revoked.load(std::sync::atomic::Ordering::SeqCst) {
            Err(HostError::denied("grant has been revoked"))
        } else {
            Ok(())
        }
    }
}

/// Lexical containment check for already-canonical absolute paths.
pub fn path_within(root: &str, path: &str) -> bool {
    if path == root {
        return true;
    }
    let r = root.trim_end_matches('/');
    if r.is_empty() {
        return path.starts_with('/');
    }
    path.starts_with(r) && path.as_bytes().get(r.len()) == Some(&b'/')
}

/// Normalize a POSIX path lexically (resolve `.` and `..`), returning None if it escapes `/`.
pub fn normalize_posix(path: &str) -> Option<String> {
    if !path.starts_with('/') {
        return None;
    }
    let mut parts: Vec<&str> = Vec::new();
    for p in path.split('/') {
        match p {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            x => parts.push(x),
        }
    }
    Some(format!("/{}", parts.join("/")))
}

/// Join a workspace-relative path onto a root, rejecting absolute or escaping relative paths.
pub fn join_relative(root: &str, rel: &str) -> HResult<String> {
    if rel.contains('\0') {
        return Err(HostError::invalid("NUL in path"));
    }
    let joined = if rel.starts_with('/') { rel.to_string() } else { format!("{}/{}", root.trim_end_matches('/'), rel) };
    let n = normalize_posix(&joined).ok_or_else(|| HostError::denied("path escapes root"))?;
    if !path_within(root, &n) {
        return Err(HostError::denied(format!("path {rel:?} is outside the granted root")));
    }
    Ok(n)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn reg() -> GrantRegistry {
        GrantRegistry::from_str(
            r#"{"schemaVersion":1,"modules":{"projects":{"kind":"service","capabilities":["db:persistence","fs.scope"],"calls":["persistence"]}}}"#,
            std::env::temp_dir().join(format!("hato-approved-{}.json", crate::util::random_hex(4))),
        )
        .unwrap()
    }
    fn manifest(caps: &[&str]) -> Manifest {
        Manifest {
            schema_version: 1, id: "projects".into(), kind: "service".into(), entry: "src/index.ts".into(),
            module_api_version: 1, dependencies: vec![], capabilities: caps.iter().map(|s| s.to_string()).collect(),
            state_version: 1, description: String::new(),
        }
    }
    #[test]
    fn manifest_cannot_self_escalate() {
        let r = reg();
        let m = manifest(&["fs.scope", "process.scope", "modules.admin"]);
        let eff = r.effective(&m);
        assert!(eff.has("fs.scope"));
        assert!(!eff.has("process.scope"));
        assert!(!eff.has("modules.admin"));
        assert_eq!(r.escalation(&m), vec!["process.scope".to_string(), "modules.admin".to_string()]);
        r.record_approval("projects", &["process.scope".to_string()]);
        assert!(r.effective(&m).has("process.scope"));
        assert!(!r.effective(&m).has("modules.admin"));
        assert!(r.effective(&m).may_call("persistence"));
        assert!(!r.effective(&m).may_call("module-dev"));
    }
    #[test]
    fn containment() {
        assert!(path_within("/a/b", "/a/b/c"));
        assert!(!path_within("/a/b", "/a/bc"));
        assert_eq!(join_relative("/a/b", "c/../d").unwrap(), "/a/b/d");
        assert!(join_relative("/a/b", "../x").is_err());
        assert!(join_relative("/a/b", "/etc/passwd").is_err());
        assert_eq!(normalize_posix("/../x"), None);
    }
}
