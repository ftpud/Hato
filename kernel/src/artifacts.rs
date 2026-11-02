//! Versioned module artifact store: `artifacts/<id>/<NNNN>.mjs` + `<NNNN>.manifest.json`, with
//! SHA-256 integrity recorded in the kernel-owned `module-registry.json`. Artifacts are never
//! overwritten in place.
use crate::grants::Manifest;
use crate::util::{now_iso, sha256_hex, HResult, HostError};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VersionRec {
    pub version: u32,
    pub sha256: String,
    pub created: String,
    /// "seed" (developer build at startup), "build" (module-dev), "dev-watch".
    pub origin: String,
    /// "ok", "failed", or "untested"
    pub status: String,
    #[serde(default)]
    pub note: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ModuleRecord {
    pub versions: Vec<VersionRec>,
    pub active: Option<u32>,
    #[serde(rename = "lastKnownGood")]
    pub last_known_good: Option<u32>,
    /// Stack of previously active versions (for rollback).
    #[serde(default)]
    pub previous: Vec<u32>,
    /// Hash of the most recently imported seed build (to detect `npm run modules:build` changes).
    #[serde(rename = "seedHash", default)]
    pub seed_hash: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct RegistryFile {
    #[serde(rename = "schemaVersion", default)]
    pub schema_version: u32,
    pub modules: BTreeMap<String, ModuleRecord>,
}

pub struct ArtifactStore {
    pub dir: PathBuf,
    pub file: PathBuf,
    pub reg: RegistryFile,
}

impl ArtifactStore {
    pub fn open(dir: PathBuf, file: PathBuf) -> Self {
        let reg = std::fs::read_to_string(&file).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(RegistryFile { schema_version: 1, modules: BTreeMap::new() });
        ArtifactStore { dir, file, reg }
    }

    pub fn save(&self) {
        if let Ok(s) = serde_json::to_string_pretty(&self.reg) {
            let tmp = self.file.with_extension("json.tmp");
            if std::fs::write(&tmp, s).is_ok() {
                let _ = std::fs::rename(&tmp, &self.file);
            }
        }
    }

    pub fn record(&mut self, id: &str) -> &mut ModuleRecord { self.reg.modules.entry(id.to_string()).or_default() }

    pub fn get(&self, id: &str) -> Option<&ModuleRecord> { self.reg.modules.get(id) }

    fn paths(&self, id: &str, v: u32) -> (PathBuf, PathBuf) {
        let d = self.dir.join(id);
        (d.join(format!("{v:04}.mjs")), d.join(format!("{v:04}.manifest.json")))
    }

    /// Store a new artifact version; returns its number. Never overwrites.
    pub fn put(&mut self, id: &str, code: &str, manifest: &Manifest, origin: &str) -> HResult<VersionRec> {
        let d = self.dir.join(id);
        std::fs::create_dir_all(&d)?;
        let rec = self.record(id);
        let mut v = rec.versions.iter().map(|x| x.version).max().unwrap_or(0) + 1;
        let (mut code_p, mut man_p);
        loop {
            (code_p, man_p) = (d.join(format!("{v:04}.mjs")), d.join(format!("{v:04}.manifest.json")));
            if !code_p.exists() {
                break;
            }
            v += 1;
        }
        let hash = sha256_hex(code.as_bytes());
        std::fs::write(&code_p, code)?;
        std::fs::write(&man_p, serde_json::to_string_pretty(manifest).unwrap_or_default())?;
        let vr = VersionRec { version: v, sha256: hash, created: now_iso(), origin: origin.into(), status: "untested".into(), note: String::new() };
        self.record(id).versions.push(vr.clone());
        self.save();
        Ok(vr)
    }

    /// Load and integrity-check an artifact version.
    pub fn load(&self, id: &str, v: u32) -> HResult<(String, Manifest, VersionRec)> {
        let rec = self.get(id).ok_or_else(|| HostError::not_found(format!("no artifacts for {id}")))?;
        let vr = rec.versions.iter().find(|x| x.version == v).cloned().ok_or_else(|| HostError::not_found(format!("{id}@{v:04} not found")))?;
        let (cp, mp) = self.paths(id, v);
        let code = std::fs::read_to_string(&cp)?;
        if sha256_hex(code.as_bytes()) != vr.sha256 {
            return Err(HostError::new("EINTEGRITY", format!("{id}@{v:04} failed integrity check (sha256 mismatch)")));
        }
        let m: Manifest = serde_json::from_str(&std::fs::read_to_string(&mp)?).map_err(|e| HostError::invalid(e.to_string()))?;
        Ok((code, m, vr))
    }

    pub fn set_status(&mut self, id: &str, v: u32, status: &str, note: &str) {
        if let Some(x) = self.record(id).versions.iter_mut().find(|x| x.version == v) {
            x.status = status.into();
            x.note = note.chars().take(500).collect();
        }
        self.save();
    }

    pub fn has_hash(&self, id: &str, hash: &str) -> Option<u32> {
        self.get(id).and_then(|r| r.versions.iter().rev().find(|v| v.sha256 == hash).map(|v| v.version))
    }
}
