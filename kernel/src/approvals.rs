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
    /// Label of a masked field in the native prompt. The typed text is never part of this request.
    pub secret_label: Option<String>,
    pub options: Vec<ApprovalOption>,
    pub created_ms: u64,
    pub expires_ms: u64,
}

/// Text typed into native chrome, for a privileged operation only. Not serializable or printable,
/// and overwritten when dropped.
pub struct Secret(String);

impl Secret {
    pub fn new(text: String) -> Self { Secret(text) }
    pub fn expose(&self) -> &str { &self.0 }
}

impl Drop for Secret {
    fn drop(&mut self) {
        // SAFETY: zero bytes are valid UTF-8, and the string is not used afterwards.
        unsafe { self.0.as_bytes_mut().fill(0); }
    }
}

struct Resolution {
    option: String,
    secret: Option<Secret>,
}

struct Pending {
    req: ApprovalRequest,
    tx: crossbeam_channel::Sender<Resolution>,
}

pub struct Approvals {
    pending: Mutex<Vec<Pending>>,
    ui: UiBridge,
    /// Headless test hook: auto-decisions (only settable from the kernel's own headless runner).
    pub headless_policy: Mutex<Option<Arc<dyn Fn(&ApprovalRequest) -> Option<String> + Send + Sync>>>,
    /// Headless test hook: what a secret prompt "types". Without it, secret prompts are cancelled.
    pub headless_secret: Mutex<Option<String>>,
}

#[derive(Debug, Clone)]
pub enum Decision {
    Option(String),
    Expired,
}

impl Approvals {
    pub fn new(ui: UiBridge) -> Self {
        Approvals { pending: Mutex::new(Vec::new()), ui, headless_policy: Mutex::new(None), headless_secret: Mutex::new(None) }
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
        let req = Self::new_request(module, generation, operation, title, detail, module_supplied, None, options, timeout);
        if let Some(policy) = self.headless_policy.lock().clone() {
            if let Some(choice) = policy(&req) {
                log::info!("headless approval policy chose {choice} for {} ({})", req.operation, req.title);
                return Decision::Option(choice);
            }
        }
        match self.wait(req, timeout) {
            Some(resolution) => Decision::Option(resolution.option),
            None => Decision::Expired,
        }
    }

    /// Blocking, like `request`: asks for a secret in native chrome, so the caller's module never
    /// sees it. `None` when the user cancels or the prompt expires.
    pub fn request_secret(&self, module: &str, generation: u64, operation: &str, title: &str, detail: &str, label: &str, confirm: &str, timeout: Duration) -> Option<Secret> {
        let options = vec![
            ApprovalOption { id: "allow".into(), label: confirm.into(), kind: "allow".into() },
            ApprovalOption { id: "deny".into(), label: "Cancel".into(), kind: "deny".into() },
        ];
        let req = Self::new_request(module, generation, operation, title, detail, false, Some(label.into()), options, timeout);
        if let Some(policy) = self.headless_policy.lock().clone() {
            let _ = policy(&req);
            return self.headless_secret.lock().clone().map(Secret::new);
        }
        self.wait(req, timeout).and_then(|resolution| resolution.secret)
    }

    #[allow(clippy::too_many_arguments)]
    fn new_request(module: &str, generation: u64, operation: &str, title: &str, detail: &str, module_supplied: bool, secret_label: Option<String>, options: Vec<ApprovalOption>, timeout: Duration) -> ApprovalRequest {
        ApprovalRequest {
            id: format!("appr_{}", random_hex(8)),
            module: module.into(),
            generation,
            operation: operation.into(),
            title: title.into(),
            detail: detail.into(),
            module_supplied,
            secret_label,
            options,
            created_ms: now_ms(),
            expires_ms: now_ms() + timeout.as_millis() as u64,
        }
    }

    fn wait(&self, req: ApprovalRequest, timeout: Duration) -> Option<Resolution> {
        let (tx, rx) = crossbeam_channel::bounded(1);
        let id = req.id.clone();
        self.pending.lock().push(Pending { req, tx });
        self.ui.send(UiMsg::ApprovalsChanged);
        let res = rx.recv_timeout(timeout);
        self.pending.lock().retain(|p| p.req.id != id);
        self.ui.send(UiMsg::ApprovalsChanged);
        res.ok()
    }

    pub fn snapshot(&self) -> Vec<ApprovalRequest> { self.pending.lock().iter().map(|p| p.req.clone()).collect() }

    pub fn count(&self) -> usize { self.pending.lock().len() }

    /// Called ONLY from native GPUI click handlers.
    pub fn resolve_from_native_ui(&self, id: &str, option: &str) {
        let pending = self.pending.lock();
        if let Some(p) = pending.iter().find(|p| p.req.id == id) {
            if p.req.options.iter().any(|o| o.id == option) {
                let _ = p.tx.try_send(Resolution { option: option.to_string(), secret: None });
            }
        }
    }

    /// Called ONLY from native GPUI handlers, with text from the prompt's own masked field.
    pub fn resolve_secret_from_native_ui(&self, id: &str, secret: Secret) {
        let pending = self.pending.lock();
        if let Some(p) = pending.iter().find(|p| p.req.id == id && p.req.secret_label.is_some()) {
            let _ = p.tx.try_send(Resolution { option: "allow".to_string(), secret: Some(secret) });
        }
    }
}
