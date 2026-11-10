//! Generic first-run installation of a hash-pinned module set into persistent app data.
//! Download policy comes from the app's lock file; no domain-specific plugins are named here.
use crate::{config::Config, grants::Manifest, util::sha256_hex};
use anyhow::{ensure, Context};
use serde::Deserialize;
use std::{collections::HashSet, path::Path};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Lock {
    schema_version: u32,
    revision: String,
    base_url: String,
    modules: Vec<Module>,
}
#[derive(Deserialize)]
struct File { path: String, sha256: String }
#[derive(Deserialize)]
struct Module { id: String, kind: String, manifest: File, bundle: File }

fn identifier(id: &str) -> bool {
    !id.is_empty() && id.len() <= 48 && id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && id.as_bytes()[0].is_ascii_alphanumeric()
}
fn validate(lock: &Lock) -> anyhow::Result<()> {
    ensure!(lock.schema_version == 1 && !lock.modules.is_empty(), "invalid plugin lock schema");
    ensure!(lock.revision.len() == 40 && lock.revision.bytes().all(|b| b.is_ascii_hexdigit()), "invalid pinned revision");
    ensure!(lock.base_url.starts_with("https://") && lock.base_url.ends_with(&format!("/{}/", lock.revision)), "plugin URL must pin the revision");
    let mut ids = HashSet::new();
    for m in &lock.modules {
        ensure!(identifier(&m.id) && ids.insert(&m.id), "invalid or duplicate plugin id");
        ensure!(m.kind == "service" || m.kind == "ui", "invalid plugin kind");
        for f in [&m.manifest, &m.bundle] {
            ensure!(f.path.starts_with("packages/") && f.path.split('/').all(|s| !s.is_empty() && s != "." && s != "..")
                && f.path.bytes().all(|b| b.is_ascii_alphanumeric() || b"/._-".contains(&b)), "unsafe plugin path");
            ensure!(f.sha256.len() == 64 && f.sha256.bytes().all(|b| b.is_ascii_hexdigit()), "invalid plugin digest");
        }
    }
    Ok(())
}
fn checked(fetch: &mut impl FnMut(&str) -> anyhow::Result<String>, base: &str, f: &File, cache: &Path) -> anyhow::Result<String> {
    let cached = cache.join(&f.sha256);
    if let Ok(text) = std::fs::read_to_string(&cached) {
        if sha256_hex(text.as_bytes()) == f.sha256 { return Ok(text); }
    }
    let text = fetch(&format!("{base}{}", f.path))?;
    ensure!(sha256_hex(text.as_bytes()) == f.sha256, "integrity mismatch: {}", f.path);
    std::fs::create_dir_all(cache)?;
    let pending = cache.join(format!(".{}-{}", f.sha256, crate::util::random_hex(4)));
    std::fs::write(&pending, &text)?;
    std::fs::rename(&pending, &cached)?;
    Ok(text)
}

/// A whole initial set is made visible with one directory rename. Failures leave no partial install.
fn install(lock_text: &str, destination: &Path, fetch: &mut impl FnMut(&str) -> anyhow::Result<String>) -> anyhow::Result<()> {
    let lock: Lock = serde_json::from_str(lock_text)?;
    validate(&lock)?;
    let parent = destination.parent().context("missing runtime parent")?;
    std::fs::create_dir_all(parent)?;
    let pending = parent.join(format!(".install-{:016x}", rand::random::<u64>()));
    std::fs::create_dir(&pending)?;
    let result = (|| {
        std::fs::create_dir_all(pending.join("build/modules"))?;
        for m in &lock.modules {
            let manifest = checked(fetch, &lock.base_url, &m.manifest, &parent.join("downloads"))?;
            let parsed: Manifest = serde_json::from_str(&manifest)?;
            parsed.validate().map_err(|e| anyhow::anyhow!("{e}"))?;
            ensure!(parsed.id == m.id && parsed.kind == m.kind, "plugin metadata mismatch");
            let bundle = checked(fetch, &lock.base_url, &m.bundle, &parent.join("downloads"))?;
            let dir = pending.join("modules").join(if m.kind == "ui" { "ui" } else { "services" }).join(&m.id);
            std::fs::create_dir_all(&dir)?;
            std::fs::write(dir.join("manifest.json"), manifest)?;
            std::fs::write(pending.join("build/modules").join(format!("{}.mjs", m.id)), bundle)?;
        }
        std::fs::write(pending.join("installed.lock.json"), lock_text)?;
        let backup = parent.join(format!(".previous-{}", crate::util::random_hex(8)));
        let existed = destination.exists();
        if existed { std::fs::rename(destination, &backup)?; }
        if let Err(error) = std::fs::rename(&pending, destination) {
            if existed { let _ = std::fs::rename(&backup, destination); }
            return Err(error.into());
        }
        let _ = std::fs::remove_dir_all(backup);
        std::fs::write(parent.join("installed.lock.json"), lock_text)?;
        Ok(())
    })();
    let _ = std::fs::remove_dir_all(&pending);
    result
}

pub fn ensure_runtime(cfg: &Config) -> anyhow::Result<()> {
    // Development and legacy launches already have their source tree. Installed runtimes are
    // independent of app versions, and never require network access on subsequent launches.
    if cfg.plugin_root() != cfg.runtime_dir().join("plugins") { return Ok(()); }
    let lock = [cfg.runtime_dir().join("installed.lock.json"), cfg.runtime_dir().join("plugins/installed.lock.json"), cfg.repo_root.join("plugins.lock.json")]
        .iter().filter_map(|path| std::fs::read_to_string(path).ok())
        .find(|text| serde_json::from_str::<Lock>(text).map(|lock| validate(&lock).is_ok()).unwrap_or(false))
        .context("no valid plugin lock file available")?;
    let pinned: Lock = serde_json::from_str(&lock)?;
    validate(&pinned)?;
    let intact = pinned.modules.iter().all(|m| {
        let dir = cfg.modules_dir().join(if m.kind == "ui" { "ui" } else { "services" }).join(&m.id);
        [(dir.join("manifest.json"), &m.manifest), (cfg.seed_dir().join(format!("{}.mjs", m.id)), &m.bundle)].iter()
            .all(|(path, file)| std::fs::read(path).map(|bytes| sha256_hex(&bytes) == file.sha256).unwrap_or(false))
    });
    if intact { return Ok(()); }
    install(&lock, &cfg.runtime_dir().join("plugins"), &mut |url| {
        let result = crate::host::http::fetch(&serde_json::json!({"url":url,"maxBytes":8*1024*1024,"timeoutMs":60000}))
            .map_err(|e| anyhow::anyhow!("{e}"))?;
        ensure!(result["status"] == 200, "plugin download HTTP {}", result["status"]);
        Ok(result["body"].as_str().context("missing response body")?.to_string())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (String, String, String) {
        let manifest = r#"{"schemaVersion":2,"id":"test","kind":"service","entry":"src/index.ts","moduleApiVersion":1,"dependencies":[],"capabilities":[]}"#.to_string();
        let code = "export default {id:'test',moduleApiVersion:1};".to_string();
        let revision = "a".repeat(40);
        let lock = serde_json::json!({"schemaVersion":1,"revision":revision,"baseUrl":format!("https://example.com/{revision}/"),"modules":[{
            "id":"test","kind":"service","manifest":{"path":"packages/test/manifest.json","sha256":sha256_hex(manifest.as_bytes())},
            "bundle":{"path":"packages/test/test.mjs","sha256":sha256_hex(code.as_bytes())}}]}).to_string();
        (lock, manifest, code)
    }
    #[test]
    fn verified_install_is_atomic_and_failures_are_clean() {
        let temp = tempfile::tempdir().unwrap();
        let dest = temp.path().join("runtime");
        let (lock, manifest, code) = fixture();
        assert!(install(&lock, &dest, &mut |_| Ok("corrupt".into())).is_err());
        assert!(!dest.exists());
        assert_eq!(std::fs::read_dir(temp.path()).unwrap().count(), 0);
        install(&lock, &dest, &mut |url| Ok(if url.ends_with(".json") {manifest.clone()} else {code.clone()})).unwrap();
        assert_eq!(std::fs::read_to_string(dest.join("build/modules/test.mjs")).unwrap(), code);
        assert!(dest.join("installed.lock.json").is_file());
        // Repair from verified cached downloads without any network request.
        std::fs::remove_file(dest.join("build/modules/test.mjs")).unwrap();
        install(&lock, &dest, &mut |_| panic!("offline repair must use cache")).unwrap();
        assert_eq!(std::fs::read_to_string(dest.join("build/modules/test.mjs")).unwrap(), code);
    }
    #[test]
    fn unsafe_paths_and_duplicate_ids_fail_before_fetch() {
        let (text, _, _) = fixture();
        let mut lock: serde_json::Value = serde_json::from_str(&text).unwrap();
        lock["modules"][0]["bundle"]["path"] = "packages/../../escape".into();
        let temp = tempfile::tempdir().unwrap();
        assert!(install(&lock.to_string(), &temp.path().join("runtime"), &mut |_| panic!("must not fetch")).is_err());
        let mut lock: serde_json::Value = serde_json::from_str(&text).unwrap();
        let duplicate = lock["modules"][0].clone();
        lock["modules"].as_array_mut().unwrap().push(duplicate);
        assert!(install(&lock.to_string(), &temp.path().join("runtime"), &mut |_| panic!("must not fetch")).is_err());
    }
}
