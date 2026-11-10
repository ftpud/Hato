//! Plugin registry: which modules exist, where they came from, and whether the user enabled them.
//!
//! Every module is a plugin. Built-in plugins ship in the repository (`modules/{services,ui}`);
//! user plugins live in the kernel-owned `<data>/plugins/<id>/` directory and are installed only
//! through a native approval. The registry stores *preferences* (enabled, root override); it never
//! interprets what a plugin does. Contracts (`provides`/`requires`) are opaque strings.
use crate::grants::Manifest;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// Contract implemented by the plugin that renders the main window.
pub const ROOT_CONTRACT: &str = "shell.root";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    Builtin,
    User,
}

impl Source {
    pub fn name(&self) -> &'static str {
        match self {
            Source::Builtin => "builtin",
            Source::User => "user",
        }
    }
}

#[derive(Debug, Clone)]
pub struct Discovered {
    pub manifest: Manifest,
    pub dir: PathBuf,
    pub source: Source,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PluginPref {
    pub enabled: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct RegistryState {
    #[serde(rename = "schemaVersion", default)]
    schema_version: u32,
    #[serde(default)]
    plugins: BTreeMap<String, PluginPref>,
    /// Explicit plugin id to mount as the window root (must provide `shell.root`).
    #[serde(default)]
    root: Option<String>,
}

pub struct PluginRegistry {
    path: PathBuf,
    state: Mutex<RegistryState>,
}

impl PluginRegistry {
    pub fn open(path: PathBuf) -> Self {
        let state = std::fs::read_to_string(&path).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
        PluginRegistry { path, state: Mutex::new(state) }
    }

    fn save(&self, st: &RegistryState) {
        let mut st = st.clone();
        st.schema_version = 1;
        if let Ok(s) = serde_json::to_string_pretty(&st) {
            let tmp = self.path.with_extension("json.tmp");
            if std::fs::write(&tmp, s).is_ok() {
                let _ = std::fs::rename(&tmp, &self.path);
            }
        }
    }

    /// Built-in plugins default to enabled; user plugins stay disabled until the user enables them
    /// (enabling is where their capabilities are approved).
    pub fn is_enabled(&self, id: &str, source: Source) -> bool {
        match self.state.lock().plugins.get(id) {
            Some(p) => p.enabled,
            None => source == Source::Builtin,
        }
    }

    pub fn set_enabled(&self, id: &str, enabled: bool) {
        let mut st = self.state.lock();
        st.plugins.entry(id.to_string()).or_default().enabled = enabled;
        self.save(&st);
    }

    pub fn forget(&self, id: &str) {
        let mut st = self.state.lock();
        st.plugins.remove(id);
        if st.root.as_deref() == Some(id) {
            st.root = None;
        }
        self.save(&st);
    }

    pub fn root_override(&self) -> Option<String> { self.state.lock().root.clone() }

    pub fn set_root(&self, id: Option<String>) {
        let mut st = self.state.lock();
        st.root = id;
        self.save(&st);
    }
}

/// Read and validate `<dir>/manifest.json`.
pub fn read_manifest(dir: &Path) -> anyhow::Result<Manifest> {
    let m: Manifest = serde_json::from_str(&std::fs::read_to_string(dir.join("manifest.json"))?)?;
    m.validate().map_err(|e| anyhow::anyhow!("{e}"))?;
    let dir_name = dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    anyhow::ensure!(m.id == dir_name, "manifest id '{}' does not match directory '{dir_name}'", m.id);
    Ok(m)
}

/// Prebuilt artifact of a user plugin: `dist/<id>.mjs`, `dist/index.mjs`, or the entry itself when
/// it is already JavaScript.
pub fn user_seed(dir: &Path, m: &Manifest) -> Option<PathBuf> {
    let candidates = [dir.join("dist").join(format!("{}.mjs", m.id)), dir.join("dist").join("index.mjs")];
    if let Some(p) = candidates.into_iter().find(|p| p.is_file()) {
        return Some(p);
    }
    let entry = dir.join(&m.entry);
    let is_js = matches!(entry.extension().and_then(|e| e.to_str()), Some("js" | "mjs"));
    (is_js && entry.is_file()).then_some(entry)
}

/// Kernel-private staging directory, cleaned on every return path.
pub struct StagingDir { pub path: PathBuf }
impl StagingDir {
    pub fn new(parent: &Path, prefix: &str) -> std::io::Result<Self> {
        let path = parent.join(format!(".{prefix}-{}", crate::util::random_hex(8)));
        std::fs::create_dir_all(&path)?;
        Ok(Self { path })
    }
}
impl Drop for StagingDir {
    fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.path); }
}

/// Recursively copy a plugin directory, skipping VCS metadata and dependency folders.
pub fn copy_plugin_dir(from: &Path, to: &Path) -> std::io::Result<u64> {
    let mut total = 0u64;
    std::fs::create_dir_all(to)?;
    for e in std::fs::read_dir(from)? {
        let e = e?;
        let name = e.file_name();
        let n = name.to_string_lossy();
        if n == ".git" || n == "node_modules" {
            continue;
        }
        let ft = e.file_type()?;
        if ft.is_symlink() {
            continue; // never follow links out of the plugin folder
        }
        let dst = to.join(&name);
        if ft.is_dir() {
            total += copy_plugin_dir(&e.path(), &dst)?;
        } else if ft.is_file() {
            total += std::fs::copy(e.path(), &dst)?;
            if total > 64 * 1024 * 1024 {
                return Err(std::io::Error::new(std::io::ErrorKind::Other, "plugin folder is larger than 64 MB"));
            }
        }
    }
    Ok(total)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_and_persistence() {
        let dir = std::env::temp_dir().join(format!("hato-plugins-{}", crate::util::random_hex(6)));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("plugins.json");
        let r = PluginRegistry::open(f.clone());
        assert!(r.is_enabled("ai", Source::Builtin));
        assert!(!r.is_enabled("mine", Source::User));
        r.set_enabled("ai", false);
        r.set_enabled("mine", true);
        r.set_root(Some("mine".into()));
        let r2 = PluginRegistry::open(f);
        assert!(!r2.is_enabled("ai", Source::Builtin));
        assert!(r2.is_enabled("mine", Source::User));
        assert_eq!(r2.root_override().as_deref(), Some("mine"));
        r2.forget("mine");
        assert_eq!(r2.root_override(), None);
        let _ = std::fs::remove_dir_all(dir);
    }
}
