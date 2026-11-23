//! Filesystem primitives for scope grants: local (std::fs with canonicalization) and remote (SFTP).
//! Every path is resolved (symlinks included) and checked against the grant's canonical root.
use crate::grants::{join_local, join_relative, path_within, ScopeGrant, Target};
use crate::host::cloud::Connection;
use crate::host::ssh::SshMaster;
use crate::util::{canonical_string, HResult, HostError};
use serde_json::{json, Value};
use std::path::Path;
use std::sync::Arc;

pub enum FsBackend {
    Local,
    Remote(Arc<SshMaster>),
    Cloud { connection: Arc<Connection>, root: String },
}

pub fn backend(g: &ScopeGrant, ssh: Option<Arc<SshMaster>>, cloud: Option<Arc<Connection>>) -> HResult<FsBackend> {
    match &g.target {
        Target::Local => Ok(FsBackend::Local),
        Target::Ssh { .. } => ssh.map(FsBackend::Remote).ok_or_else(|| HostError::new("ENOTCONN", "SSH connection unavailable (no local fallback)")),
        Target::Cloud { .. } => Ok(FsBackend::Cloud {
            connection: cloud.ok_or_else(|| HostError::new("ECLOUD", "Cloud connection unavailable"))?,
            root: g.root.clone(),
        }),
    }
}

fn cloud_call(connection: &Connection, root: &str, op: &str, path: &str, mut args: Value) -> HResult<Value> {
    args["root"] = json!(root);
    args["path"] = json!(path);
    Connection::wait(connection.request(&json!({"op":op,"args":args})))
}

fn cloud_path(value: Value) -> HResult<String> {
    value.as_str().map(str::to_owned).ok_or_else(|| HostError::new("ECLOUD", "Invalid Cloud path reply"))
}

pub fn cloud_root(connection: &Connection, root: &str) -> HResult<String> {
    let result = Connection::wait(connection.request(&json!({"op":"fs.root","args":{"root":root}})));
    match result {
        Err(error) if error.code == "EINVAL" && error.message == "unknown daemon op 'fs.root'" => {
            Err(HostError::new("ENOTSUP", "Update and restart hatod on the Cloud host to use Files and Git"))
        }
        other => cloud_path(other?),
    }
}

/// Resolve `rel` against the grant root, following symlinks, and verify containment.
/// For non-existent targets (writes), the parent directory is resolved instead.
pub fn resolve(g: &ScopeGrant, be: &FsBackend, rel: &str, must_exist: bool) -> HResult<String> {
    let lexical = match be {
        FsBackend::Local => join_local(&g.root, rel)?,
        FsBackend::Remote(_) => join_relative(&g.root, rel)?,
        FsBackend::Cloud { .. } => {
            let rel = match &g.target {
                Target::Cloud { requested_root, .. } if path_within(requested_root, rel) => {
                    rel.strip_prefix(requested_root.trim_end_matches('/')).unwrap_or(rel).trim_start_matches('/')
                }
                _ => rel,
            };
            join_relative(&g.root, rel)?
        }
    };
    let real = match be {
        FsBackend::Local => match canonical_string(Path::new(&lexical)) {
            Ok(p) => p,
            Err(e) if !must_exist && e.kind() == std::io::ErrorKind::NotFound => {
                let p = Path::new(&lexical);
                let parent = p.parent().ok_or_else(|| HostError::invalid("no parent"))?;
                let name = p.file_name().ok_or_else(|| HostError::invalid("no file name"))?.to_string_lossy().into_owned();
                let rp = canonical_string(parent)?;
                format!("{}/{}", rp.trim_end_matches('/'), name)
            }
            Err(e) => return Err(e.into()),
        },
        FsBackend::Remote(ssh) => {
            let sftp = ssh.sftp()?;
            match sftp.realpath(&lexical) {
                Ok(p) if sftp.stat(&p).is_ok() || !must_exist => p,
                Ok(_) => return Err(HostError::not_found(format!("{rel} not found"))),
                Err(e) if !must_exist => {
                    let _ = e;
                    let (parent, name) = lexical.rsplit_once('/').ok_or_else(|| HostError::invalid("bad path"))?;
                    let parent = if parent.is_empty() { "/" } else { parent };
                    format!("{}/{}", sftp.realpath(parent)?.trim_end_matches('/'), name)
                }
                Err(e) => return Err(e),
            }
        }
        FsBackend::Cloud { connection, root } => cloud_path(cloud_call(connection, root, "fs.resolve", &lexical,
            json!({"mustExist":must_exist}))?)?,
    };
    if !path_within(&g.root, &real) {
        return Err(HostError::denied(format!("{rel:?} resolves outside the granted root (symlink escape)")));
    }
    Ok(real)
}

fn kind_of_local(m: &std::fs::Metadata) -> &'static str {
    if m.is_dir() { "dir" } else if m.is_file() { "file" } else if m.file_type().is_symlink() { "symlink" } else { "other" }
}

pub fn stat(be: &FsBackend, path: &str) -> HResult<Value> {
    match be {
        FsBackend::Local => {
            let m = std::fs::metadata(path)?;
            let mtime = m.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs());
            Ok(json!({"kind": kind_of_local(&m), "size": m.len(), "mtime": mtime}))
        }
        FsBackend::Remote(ssh) => {
            let a = ssh.sftp()?.stat(path)?;
            let kind = if a.is_dir() { "dir" } else if a.is_file() { "file" } else { "other" };
            Ok(json!({"kind": kind, "size": a.size, "mtime": a.mtime}))
        }
        FsBackend::Cloud { connection, root } => cloud_call(connection, root, "fs.stat", path, json!({})),
    }
}

pub fn list(be: &FsBackend, path: &str) -> HResult<Value> {
    let mut out = Vec::new();
    match be {
        FsBackend::Local => {
            for e in std::fs::read_dir(path)? {
                let e = e?;
                let name = e.file_name().to_string_lossy().into_owned();
                let ft = e.file_type()?;
                let (kind, size) = if ft.is_symlink() {
                    match std::fs::metadata(e.path()) {
                        Ok(m) => (if m.is_dir() { "dir" } else { "file" }, m.len()),
                        Err(_) => ("symlink", 0),
                    }
                } else {
                    let m = e.metadata()?;
                    (kind_of_local(&m), m.len())
                };
                out.push(json!({"name": name, "kind": kind, "size": size, "symlink": ft.is_symlink()}));
                if out.len() >= 20000 {
                    break;
                }
            }
        }
        FsBackend::Remote(ssh) => {
            let sftp = ssh.sftp()?;
            for (name, a) in sftp.list(path)? {
                let (kind, size) = if a.is_symlink() {
                    match sftp.stat(&format!("{}/{}", path.trim_end_matches('/'), name)) {
                        Ok(t) => (if t.is_dir() { "dir" } else { "file" }, t.size.unwrap_or(0)),
                        Err(_) => ("symlink", 0),
                    }
                } else {
                    (if a.is_dir() { "dir" } else if a.is_file() { "file" } else { "other" }, a.size.unwrap_or(0))
                };
                out.push(json!({"name": name, "kind": kind, "size": size, "symlink": a.is_symlink()}));
            }
        }
        FsBackend::Cloud { connection, root } => return cloud_call(connection, root, "fs.list", path, json!({})),
    }
    Ok(Value::Array(out))
}

pub fn read(be: &FsBackend, path: &str, limit: usize) -> HResult<(Vec<u8>, bool)> {
    match be {
        FsBackend::Local => {
            use std::io::Read;
            let f = std::fs::File::open(path)?;
            let mut buf = Vec::new();
            f.take(limit as u64 + 1).read_to_end(&mut buf)?;
            let truncated = buf.len() > limit;
            buf.truncate(limit);
            Ok((buf, truncated))
        }
        FsBackend::Remote(ssh) => ssh.sftp()?.read(path, limit),
        FsBackend::Cloud { connection, root } => {
            use base64::Engine;
            let result = cloud_call(connection, root, "fs.read", path, json!({"limit":limit}))?;
            let bytes = base64::engine::general_purpose::STANDARD.decode(
                result["base64"].as_str().ok_or_else(|| HostError::new("ECLOUD", "Missing Cloud file data"))?
            ).map_err(|_| HostError::new("ECLOUD", "Invalid Cloud file data"))?;
            if bytes.len() > limit { return Err(HostError::new("ECLOUD", "Cloud file exceeded the requested limit")); }
            Ok((bytes, result["truncated"] == true))
        }
    }
}

pub fn write_atomic(be: &FsBackend, path: &str, data: &[u8], mode: u32) -> HResult<()> {
    match be {
        FsBackend::Local => {
            let tmp = format!("{path}.hato-tmp-{}", crate::util::random_hex(4));
            std::fs::write(&tmp, data)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(mode))?;
            }
            std::fs::rename(&tmp, path).map_err(|e| {
                let _ = std::fs::remove_file(&tmp);
                HostError::from(e)
            })
        }
        FsBackend::Remote(ssh) => ssh.sftp()?.write_atomic(path, data, mode),
        FsBackend::Cloud { connection, root } => cloud_write(connection, root, path, data, Some(mode), true),
    }
}

pub fn write_transfer(be: &FsBackend, path: &str, data: &[u8], replace: bool) -> HResult<()> {
    match be {
        FsBackend::Local => {
            use std::io::Write;
            let parent = Path::new(path).parent().ok_or_else(|| HostError::invalid("missing parent directory"))?;
            let mut file = tempfile::NamedTempFile::new_in(parent)?;
            file.write_all(data)?;
            file.as_file().sync_all()?;
            if replace { file.persist(path) } else { file.persist_noclobber(path) }
                .map_err(|e| HostError::from(e.error))?;
            Ok(())
        }
        FsBackend::Remote(ssh) => ssh.sftp()?.write_atomic_with_replace(path, data, 0o644, replace),
        FsBackend::Cloud { connection, root } => cloud_write(connection, root, path, data, None, replace),
    }
}

pub fn mkdir_p(be: &FsBackend, root: &str, path: &str) -> HResult<()> {
    match be {
        FsBackend::Local => Ok(std::fs::create_dir_all(path)?),
        FsBackend::Remote(ssh) => {
            let sftp = ssh.sftp()?;
            let mut cur = root.trim_end_matches('/').to_string();
            let rest = path.strip_prefix(&cur).unwrap_or("").trim_start_matches('/').to_string();
            for part in rest.split('/').filter(|p| !p.is_empty()) {
                cur = format!("{cur}/{part}");
                if sftp.stat(&cur).is_err() {
                    sftp.mkdir(&cur)?;
                }
            }
            Ok(())
        }
        FsBackend::Cloud { connection, root } => cloud_call(connection, root, "fs.mkdir", path, json!({})).map(|_| ()),
    }
}

fn cloud_write(connection: &Connection, root: &str, path: &str, data: &[u8], mode: Option<u32>, replace: bool) -> HResult<()> {
    use base64::Engine;
    cloud_call(connection, root, "fs.write", path, json!({
        "base64":base64::engine::general_purpose::STANDARD.encode(data), "replace":replace, "mode":mode,
    })).map(|_| ())
}
