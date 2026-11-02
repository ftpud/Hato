//! Append-only audit log and per-module bounded log ring buffers.
use crate::util::{now_iso, redact};
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::io::Write;
use std::path::PathBuf;

pub struct Audit {
    file: Mutex<Option<std::fs::File>>,
}

impl Audit {
    pub fn new(path: PathBuf) -> Self {
        let f = std::fs::OpenOptions::new().create(true).append(true).open(path).ok();
        Audit { file: Mutex::new(f) }
    }
    pub fn record(&self, module: &str, generation: u64, op: &str, detail: &str, result: &str, approver: Option<&str>) {
        let line = json!({
            "time": now_iso(), "module": module, "generation": generation, "op": op,
            "detail": redact(detail), "result": redact(result), "approver": approver,
        });
        if let Some(f) = self.file.lock().as_mut() {
            let _ = writeln!(f, "{line}");
        }
        log::info!("audit {line}");
    }
}

const RING: usize = 600;

#[derive(Default)]
pub struct ModuleLogs {
    rings: Mutex<HashMap<String, VecDeque<Value>>>,
    file: Mutex<Option<std::fs::File>>,
}

impl ModuleLogs {
    pub fn open(path: PathBuf) -> Self {
        let f = std::fs::OpenOptions::new().create(true).append(true).open(path).ok();
        ModuleLogs { rings: Mutex::new(HashMap::new()), file: Mutex::new(f) }
    }
    pub fn push(&self, module: &str, generation: u64, level: &str, msg: &str) {
        let msg = redact(msg);
        let msg = if msg.len() > 4000 { format!("{}…", &msg[..msg.char_indices().nth(4000).map(|c| c.0).unwrap_or(msg.len())]) } else { msg };
        let entry = json!({"time": now_iso(), "generation": generation, "level": level, "msg": msg});
        if let Some(f) = self.file.lock().as_mut() {
            let _ = writeln!(f, "{} [{module}@{generation}] {level}: {msg}", now_iso());
        }
        if level == "error" {
            log::warn!(target: "module", "[{module}@{generation}] {msg}");
        } else {
            log::debug!(target: "module", "[{module}@{generation}] {msg}");
        }
        let mut rings = self.rings.lock();
        let r = rings.entry(module.to_string()).or_default();
        if r.len() >= RING {
            r.pop_front();
        }
        r.push_back(entry);
    }
    pub fn tail(&self, module: &str, limit: usize) -> Vec<Value> {
        let rings = self.rings.lock();
        match rings.get(module) {
            Some(r) => r.iter().rev().take(limit).rev().cloned().collect(),
            None => vec![],
        }
    }
}
