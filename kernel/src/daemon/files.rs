//! Scoped file operations for daemon socket clients. The Cloud relay carries encrypted bytes.
use crate::config::Config;
use crate::grants::{path_within, ScopeGrant, ScopeKind, Target};
use crate::host::fs::{self as hfs, FsBackend::Local};
use crate::util::{arg_str, canonical_string, HResult, HostError};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::path::Path;
use std::sync::atomic::AtomicBool;

const MAX_BYTES: usize = 8 * 1024 * 1024;

pub(super) fn request(config: &Config, home: &Path, op: &str, args: &Value) -> HResult<Value> {
    let home = canonical_string(home)?;
    let protected = |path: &str| {
        path_within(&home, path)
            || config.protected_dirs().iter().any(|dir| path_within(&dir.to_string_lossy(), path))
    };
    let requested = arg_str(args, "root")?;
    if !Path::new(requested).is_absolute() {
        return Err(HostError::invalid("Cloud scope requires an absolute root"));
    }
    let root = canonical_string(Path::new(requested))?;
    if root == "/" || protected(&root) {
        return Err(HostError::denied("this Cloud root cannot be granted"));
    }
    if !Path::new(&root).is_dir() {
        return Err(HostError::invalid("Cloud scope root must be a directory"));
    }
    if op == "fs.root" {
        return Ok(json!(root));
    }
    if root != requested {
        return Err(HostError::new("ESTALE", "Cloud scope root has changed"));
    }
    let scope = ScopeGrant {
        kind: ScopeKind::Fs, target: Target::Local, root, write: false,
        owner: String::new(), revoked: AtomicBool::new(false),
    };
    let must_exist = match op {
        "fs.resolve" => args["mustExist"] != false,
        "fs.mkdir" | "fs.write" => false,
        _ => true,
    };
    let path = hfs::resolve(&scope, &Local, arg_str(args, "path")?, must_exist)?;
    if protected(&path) || (!must_exist && std::fs::symlink_metadata(&path).is_ok_and(|m| m.is_symlink())) {
        return Err(HostError::denied("protected path or unresolved symlink"));
    }
    match op {
        "fs.resolve" => Ok(json!(path)),
        "fs.stat" => hfs::stat(&Local, &path),
        "fs.list" => {
            let mut entries = hfs::list(&Local, &path)?;
            for entry in entries.as_array_mut().into_iter().flatten().filter(|entry| entry["symlink"] == true) {
                let link = Path::new(&path).join(entry["name"].as_str().unwrap_or(""));
                if !canonical_string(&link).is_ok_and(|resolved| path_within(&scope.root, &resolved) && !protected(&resolved)) {
                    entry["kind"] = json!("symlink");
                    entry["size"] = json!(0);
                }
            }
            Ok(entries)
        }
        "fs.read" => {
            if !Path::new(&path).is_file() { return Err(HostError::invalid("expected a regular file")); }
            let limit = args["limit"].as_u64().unwrap_or(MAX_BYTES as u64).min(MAX_BYTES as u64) as usize;
            let (data, truncated) = hfs::read(&Local, &path, limit)?;
            Ok(json!({"base64": STANDARD.encode(data), "truncated": truncated}))
        }
        "fs.mkdir" => {
            hfs::mkdir_p(&Local, &scope.root, &path)?;
            Ok(Value::Null)
        }
        "fs.write" => {
            let encoded = arg_str(args, "base64")?;
            if encoded.len() > 4 * MAX_BYTES.div_ceil(3) { return Err(HostError::new("E2BIG", "file too large")); }
            let data = STANDARD.decode(encoded).map_err(|_| HostError::invalid("invalid file bytes"))?;
            if data.len() > MAX_BYTES { return Err(HostError::new("E2BIG", "file too large")); }
            if let Some(mode) = args["mode"].as_u64() {
                hfs::write_atomic(&Local, &path, &data, (mode & 0o755) as u32)?;
            } else {
                hfs::write_transfer(&Local, &path, &data, args["replace"] == true)?;
            }
            Ok(Value::Null)
        }
        _ => Err(HostError::invalid("unsupported file operation")),
    }
}
