//! Resource registry: opaque, unforgeable handles with explicit owner, kind and lifetime.
//! A handle string is random (128 bits) and only meaningful together with the registry entry,
//! which records the owning logical module. Ownership is per logical module id (stable across
//! module generations), so a hot-swapped generation can keep using its resources.
use crate::util::{random_hex, HResult, HostError};
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::any::Any;
use std::collections::HashMap;
use std::sync::Arc;

pub struct Entry {
    pub kind: &'static str,
    pub owner: String,
    pub res: Arc<dyn Any + Send + Sync>,
    pub stable_key: Option<String>,
    pub created_ms: u64,
    pub label: String,
}

#[derive(Default)]
pub struct HandleRegistry {
    map: Mutex<HashMap<String, Entry>>,
    stable: Mutex<HashMap<String, String>>,
}

impl HandleRegistry {
    pub fn insert<T: Any + Send + Sync>(&self, kind: &'static str, owner: &str, label: impl Into<String>, res: Arc<T>) -> String {
        let h = format!("h_{kind}_{}", random_hex(16));
        self.map.lock().insert(
            h.clone(),
            Entry { kind, owner: owner.to_string(), res, stable_key: None, created_ms: crate::util::now_ms(), label: label.into() },
        );
        h
    }

    /// Fetch a resource of the expected kind owned by `owner`. Foreign or unknown handles are denied.
    pub fn get<T: Any + Send + Sync>(&self, handle: &str, kind: &'static str, owner: &str) -> HResult<Arc<T>> {
        let map = self.map.lock();
        let e = map.get(handle).ok_or_else(|| HostError::new("EBADF", format!("unknown or released handle {handle}")))?;
        if e.kind != kind {
            return Err(HostError::new("EBADF", format!("handle {handle} is a {} handle, expected {kind}", e.kind)));
        }
        if e.owner != owner && owner != "*kernel*" {
            return Err(HostError::denied(format!("handle {handle} is owned by module '{}'", e.owner)));
        }
        e.res.clone().downcast::<T>().map_err(|_| HostError::new("EBADF", "handle type mismatch"))
    }

    /// Kernel-internal lookup (e.g. native renderer resolving a PTY referenced by a UI tree).
    pub fn get_kernel<T: Any + Send + Sync>(&self, handle: &str, kind: &'static str) -> Option<Arc<T>> {
        self.get::<T>(handle, kind, "*kernel*").ok()
    }

    pub fn kind_of(&self, handle: &str) -> Option<&'static str> { self.map.lock().get(handle).map(|e| e.kind) }

    pub fn owner_of(&self, handle: &str) -> Option<String> { self.map.lock().get(handle).map(|e| e.owner.clone()) }

    pub fn remove(&self, handle: &str, owner: &str) -> HResult<Entry> {
        let mut map = self.map.lock();
        match map.get(handle) {
            None => Err(HostError::new("EBADF", "unknown handle")),
            Some(e) if e.owner != owner && owner != "*kernel*" => Err(HostError::denied("not the owner of this handle")),
            Some(_) => {
                let e = map.remove(handle).unwrap();
                if let Some(k) = &e.stable_key {
                    self.stable.lock().remove(k);
                }
                Ok(e)
            }
        }
    }

    /// Associate a handle with a stable key (e.g. "pty:<workspace>:main") so a later generation can reattach.
    pub fn retain(&self, handle: &str, owner: &str, key: &str) -> HResult<()> {
        let mut map = self.map.lock();
        let e = map.get_mut(handle).ok_or_else(|| HostError::new("EBADF", "unknown handle"))?;
        if e.owner != owner {
            return Err(HostError::denied("not the owner of this handle"));
        }
        let scoped = format!("{owner}/{key}");
        e.stable_key = Some(scoped.clone());
        self.stable.lock().insert(scoped, handle.to_string());
        Ok(())
    }

    pub fn lookup(&self, owner: &str, key: &str) -> Option<String> {
        let scoped = format!("{owner}/{key}");
        let h = self.stable.lock().get(&scoped).cloned()?;
        if self.map.lock().contains_key(&h) { Some(h) } else { None }
    }

    pub fn info(&self, handle: &str) -> Option<Value> {
        self.map.lock().get(handle).map(|e| {
            json!({"handle": handle, "kind": e.kind, "owner": e.owner, "stableKey": e.stable_key, "createdMs": e.created_ms, "label": e.label})
        })
    }

    pub fn list(&self) -> Vec<Value> {
        let map = self.map.lock();
        let mut v: Vec<Value> = map
            .iter()
            .map(|(h, e)| json!({"handle": h, "kind": e.kind, "owner": e.owner, "stableKey": e.stable_key, "label": e.label}))
            .collect();
        v.sort_by(|a, b| a["handle"].as_str().cmp(&b["handle"].as_str()));
        v
    }

    pub fn handles_owned_by(&self, owner: &str) -> Vec<String> {
        self.map.lock().iter().filter(|(_, e)| e.owner == owner).map(|(h, _)| h.clone()).collect()
    }

    pub fn handles_of_kind(&self, kind: &str) -> Vec<String> {
        self.map.lock().iter().filter(|(_, e)| e.kind == kind).map(|(h, _)| h.clone()).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ownership_and_kinds() {
        let r = HandleRegistry::default();
        let h = r.insert("db", "persistence", "db", Arc::new(5u32));
        assert!(r.get::<u32>(&h, "db", "persistence").is_ok());
        assert_eq!(r.get::<u32>(&h, "db", "projects").unwrap_err().code, "EPERM");
        assert_eq!(r.get::<u32>(&h, "pty", "persistence").unwrap_err().code, "EBADF");
        assert_eq!(r.get::<u32>("h_db_forged", "db", "persistence").unwrap_err().code, "EBADF");
        r.retain(&h, "persistence", "main").unwrap();
        assert_eq!(r.lookup("persistence", "main"), Some(h.clone()));
        assert_eq!(r.lookup("projects", "main"), None);
        assert!(r.remove(&h, "projects").is_err());
        r.remove(&h, "persistence").unwrap();
        assert_eq!(r.lookup("persistence", "main"), None);
    }
}
