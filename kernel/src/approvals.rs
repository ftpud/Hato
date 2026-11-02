//! Trusted approval queue. Requests are created inside privileged kernel operations (or by modules
//! holding `approvals.request`) and can only be resolved by native GPUI chrome in response to a
//! real user gesture. Modules never receive a token they could replay: the privileged operation
//! itself blocks until the user decides.
use crate::bridge::{UiBridge, UiMsg};
use crate::util::{now_ms, random_hex};
use parking_lot::Mutex;
use serde::Serialize;
use std::sync::Arc;
use std::time::Duration;

#[derive(Debug, Clone, Serialize)]
pub struct ApprovalOption {
    pub id: String,
    pub label: String,
    /// "allow" | "deny" | "neutral"
    pub kind: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ApprovalRequest {
    pub id: String,
    /// Logical module id that triggered the request.
    pub module: String,
    pub generation: u64,
    /// Kernel operation name (e.g. "modules.activate"), or "agent-permission" for module-sourced asks.
    pub operation: String,
    pub title: String,
    /// Kernel-computed detail (e.g. a diff) — or, for module-sourced requests, clearly labeled module text.
    pub detail: String,
    /// True when the detail text was supplied by a module rather than computed by the kernel.
    pub module_supplied: bool,
    pub options: Vec<ApprovalOption>,
    pub created_ms: u64,
    pub expires_ms: u64,
}

struct Pending {
    req: ApprovalRequest,
    tx: crossbeam_channel::Sender<String>,
}

pub struct Approvals {
    pending: Mutex<Vec<Pending>>,
    ui: UiBridge,
    /// Headless test hook: auto-decisions (only settable from the kernel's own headless runner).
    pub headless_policy: Mutex<Option<Arc<dyn Fn(&ApprovalRequest) -> Option<String> + Send + Sync>>>,
}

#[derive(Debug, Clone)]
pub enum Decision {
    Option(String),
    Expired,
}

impl Approvals {
    pub fn new(ui: UiBridge) -> Self {
        Approvals { pending: Mutex::new(Vec::new()), ui, headless_policy: Mutex::new(None) }
    }

    pub fn allow_deny() -> Vec<ApprovalOption> {
        vec![
            ApprovalOption { id: "allow".into(), label: "Approve".into(), kind: "allow".into() },
            ApprovalOption { id: "deny".into(), label: "Deny".into(), kind: "deny".into() },
        ]
    }

    /// Blocking: must be called off the UI thread and off any JS worker thread.
    pub fn request(
        &self,
        module: &str,
        generation: u64,
        operation: &str,
        title: &str,
        detail: &str,
        module_supplied: bool,
        options: Vec<ApprovalOption>,
        timeout: Duration,
    ) -> Decision {
        let (tx, rx) = crossbeam_channel::bounded(1);
        let req = ApprovalRequest {
            id: format!("appr_{}", random_hex(8)),
            module: module.into(),
            generation,
            operation: operation.into(),
            title: title.into(),
            detail: detail.into(),
            module_supplied,
            options,
            created_ms: now_ms(),
            expires_ms: now_ms() + timeout.as_millis() as u64,
        };
        let id = req.id.clone();
        if let Some(policy) = self.headless_policy.lock().clone() {
            if let Some(choice) = policy(&req) {
                log::info!("headless approval policy chose {choice} for {} ({})", req.operation, req.title);
                return Decision::Option(choice);
            }
        }
        self.pending.lock().push(Pending { req, tx });
        self.ui.send(UiMsg::ApprovalsChanged);
        let res = rx.recv_timeout(timeout);
        self.pending.lock().retain(|p| p.req.id != id);
        self.ui.send(UiMsg::ApprovalsChanged);
        match res {
            Ok(choice) => Decision::Option(choice),
            Err(_) => Decision::Expired,
        }
    }

    pub fn snapshot(&self) -> Vec<ApprovalRequest> { self.pending.lock().iter().map(|p| p.req.clone()).collect() }

    pub fn count(&self) -> usize { self.pending.lock().len() }

    /// Called ONLY from native GPUI click handlers.
    pub fn resolve_from_native_ui(&self, id: &str, option: &str) {
        let pending = self.pending.lock();
        if let Some(p) = pending.iter().find(|p| p.req.id == id) {
            if p.req.options.iter().any(|o| o.id == option) {
                let _ = p.tx.try_send(option.to_string());
            }
        }
    }
}
