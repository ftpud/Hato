//! Trusted approval queue. Requests are created inside privileged kernel operations (or by modules
//! holding `approvals.request`) and can only be resolved by native GPUI chrome in response to a
//! real user gesture. Modules never receive a token they could replay: the privileged operation
//! itself blocks until the user decides.
use crate::bridge::{UiBridge, UiMsg};
use crate::audit::Audit;
use crate::util::{now_ms, random_hex};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
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
    audit: Option<Audit>,
    auto_approve: AtomicBool,
    #[cfg(any(feature = "gui", test))]
    security_file: Option<PathBuf>,
    /// Headless test hook: auto-decisions (only settable from the kernel's own headless runner).
    pub headless_policy: Mutex<Option<Arc<dyn Fn(&ApprovalRequest) -> Option<String> + Send + Sync>>>,
    /// Headless test hook: what a secret prompt "types". Without it, secret prompts are cancelled.
    pub headless_secret: Mutex<Option<String>>,
}

#[derive(Debug, Clone)]
pub enum Decision {
    Option(String),
    Automatic(String),
    Expired,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SecuritySettings {
    auto_approve: bool,
}

impl SecuritySettings {
    fn load_auto_approve(path: &Path) -> bool {
        if !std::fs::symlink_metadata(path).is_ok_and(|metadata| metadata.is_file()) { return false; }
        std::fs::read(path).ok()
            .and_then(|bytes| serde_json::from_slice::<Self>(&bytes).ok())
            .is_some_and(|settings| settings.auto_approve)
    }

    #[cfg(any(feature = "gui", test))]
    fn save(&self, path: &Path) -> std::io::Result<()> {
        use std::io::Write;
        let parent = path.parent().expect("security file is in the application data directory");
        std::fs::create_dir_all(parent)?;
        let mut file = tempfile::NamedTempFile::new_in(parent)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            file.as_file().set_permissions(std::fs::Permissions::from_mode(0o600))?;
        }
        serde_json::to_writer(&mut file, self)?;
        file.write_all(b"\n")?;
        file.as_file().sync_all()?;
        file.persist(path).map_err(|error| error.error)?;
        Ok(())
    }
}

impl Approvals {
    pub fn new(ui: UiBridge) -> Self {
        Approvals { pending: Mutex::new(Vec::new()), ui, audit: None, auto_approve: AtomicBool::new(false),
            #[cfg(any(feature = "gui", test))]
            security_file: None,
            headless_policy: Mutex::new(None), headless_secret: Mutex::new(None) }
    }

    pub(crate) fn with_audit(ui: UiBridge, audit: Audit, security_file: Option<PathBuf>) -> Self {
        let auto_approve = security_file.as_deref().is_some_and(SecuritySettings::load_auto_approve);
        if auto_approve {
            audit.record("kernel", 0, "security.autoApprove", "Native security setting",
                "restored from saved setting", Some("native-startup"));
        }
        Self { audit: Some(audit), auto_approve: AtomicBool::new(auto_approve),
            #[cfg(any(feature = "gui", test))]
            security_file,
            ..Self::new(ui) }
    }

    pub fn auto_approve_enabled(&self) -> bool {
        self.auto_approve.load(Ordering::Acquire)
    }

    #[cfg(any(feature = "gui", test))]
    pub(crate) fn set_auto_approve_from_native_ui(&self, enabled: bool) -> std::io::Result<()> {
        let previous = self.auto_approve_enabled();
        // Turn off in-memory approval even if the saved preference cannot be updated.
        if !enabled { self.auto_approve.store(false, Ordering::Release); }
        let saved = self.security_file.as_deref().map_or(Ok(()), |path| {
            SecuritySettings { auto_approve: enabled }.save(path)
        });
        if enabled {
            if saved.is_err() { return saved; }
            self.auto_approve.store(true, Ordering::Release);
        }
        if enabled != previous {
            if let Some(audit) = &self.audit {
                audit.record("kernel", 0, "security.autoApprove", "Native security setting",
                    if enabled { "enabled" } else { "disabled" }, Some("native-user"));
            }
            self.ui.send(UiMsg::ApprovalsChanged);
        }
        saved
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
        if self.auto_approve_enabled() {
            if let Some(allow) = req.options.iter().find(|option| option.kind == "allow" && !option.id.is_empty()) {
                if let Some(audit) = &self.audit {
                    audit.record(&req.module, req.generation, &req.operation, &req.title,
                        &format!("auto-approved ({})", allow.id), Some("native-auto-approve"));
                }
                return Decision::Automatic(allow.id.clone());
            }
        }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn automatic_approvals_persist_are_audited_and_stop_immediately() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("audit.log");
        let security_file = dir.path().join("security/settings.json");
        let reopen = || Approvals::with_audit(UiBridge::disconnected(), Audit::new(path.clone()), Some(security_file.clone()));
        let approvals = reopen();
        let ask = || approvals.request("files", 3, "capabilities.fsWrite", "Allow writing files?", "", false,
            Approvals::allow_deny(), Duration::from_millis(1));
        assert!(!approvals.auto_approve_enabled());
        assert!(matches!(ask(), Decision::Expired));

        approvals.set_auto_approve_from_native_ui(true).unwrap();
        assert!(matches!(ask(), Decision::Automatic(option) if option == "allow"));
        assert_eq!(approvals.count(), 0);
        assert!(reopen().auto_approve_enabled());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&security_file).unwrap().permissions().mode() & 0o777, 0o600);
        }

        let deny_only = vec![ApprovalOption { id: "deny".into(), label: "Deny".into(), kind: "deny".into() }];
        assert!(matches!(approvals.request("agent", 4, "module:permission", "Choose", "", true, deny_only,
            Duration::from_millis(1)), Decision::Expired));
        assert!(approvals.request_secret("workspace", 1, "ssh.password", "Password", "", "Password", "Connect",
            Duration::from_millis(1)).is_none());
        approvals.set_auto_approve_from_native_ui(false).unwrap();
        assert!(matches!(ask(), Decision::Expired));
        let settings: serde_json::Value = serde_json::from_slice(&std::fs::read(&security_file).unwrap()).unwrap();
        assert_eq!(settings, serde_json::json!({"autoApprove": false}));
        assert!(!reopen().auto_approve_enabled());

        let audit = std::fs::read_to_string(path).unwrap();
        let entries: Vec<serde_json::Value> = audit.lines().map(|line| serde_json::from_str(line).unwrap()).collect();
        let expected = [
            ("security.autoApprove", "enabled", "native-user"),
            ("capabilities.fsWrite", "auto-approved (allow)", "native-auto-approve"),
            ("security.autoApprove", "restored from saved setting", "native-startup"),
            ("security.autoApprove", "disabled", "native-user"),
        ];
        let actual: Vec<_> = entries.iter().map(|entry| (
            entry["op"].as_str().unwrap(), entry["result"].as_str().unwrap(), entry["approver"].as_str().unwrap(),
        )).collect();
        assert_eq!(actual, expected);
    }

    #[test]
    fn malformed_or_unreadable_security_settings_default_to_off() {
        let dir = tempfile::tempdir().unwrap();
        let security_file = dir.path().join("settings.json");
        let reopen = || Approvals::with_audit(UiBridge::disconnected(),
            Audit::new(dir.path().join("audit.log")), Some(security_file.clone()));
        for contents in ["{", "{}", r#"{"autoApprove": "true"}"#] {
            std::fs::write(&security_file, contents).unwrap();
            assert!(!reopen().auto_approve_enabled());
        }
        std::fs::remove_file(&security_file).unwrap();
        std::fs::create_dir(&security_file).unwrap();
        assert!(!reopen().auto_approve_enabled());
        assert!(std::fs::read_to_string(dir.path().join("audit.log")).unwrap().is_empty());
    }

    #[test]
    fn failed_saves_do_not_enable_automatic_approvals_or_prevent_disabling() {
        let dir = tempfile::tempdir().unwrap();
        let security_file = dir.path().join("settings.json");
        std::fs::write(&security_file, r#"{"autoApprove":true}"#).unwrap();
        let approvals = Approvals::with_audit(UiBridge::disconnected(),
            Audit::new(dir.path().join("audit.log")), Some(security_file.clone()));
        assert!(approvals.auto_approve_enabled());
        std::fs::remove_file(&security_file).unwrap();
        std::fs::create_dir(&security_file).unwrap();

        assert!(approvals.set_auto_approve_from_native_ui(false).is_err());
        assert!(!approvals.auto_approve_enabled());
        assert!(approvals.set_auto_approve_from_native_ui(true).is_err());
        assert!(!approvals.auto_approve_enabled());
    }

    #[cfg(feature = "gui")]
    #[test]
    fn only_the_interactive_gui_kernel_restores_automatic_approvals() {
        use crate::{config::Config, kernel::Kernel};
        let dir = tempfile::tempdir().unwrap();
        let cfg = Config::from_args(&[
            "hato".into(),
            "--repo-root".into(), dir.path().display().to_string(),
            "--data-dir".into(), dir.path().join("data").display().to_string(),
        ]).unwrap();
        let gui = Kernel::new_gui(cfg.clone(), UiBridge::disconnected()).unwrap();
        gui.approvals.set_auto_approve_from_native_ui(true).unwrap();
        gui.shutdown();

        let runner = Kernel::new(cfg.clone(), UiBridge::disconnected()).unwrap();
        assert!(!runner.approvals.auto_approve_enabled());
        runner.shutdown();
        let gui = Kernel::new_gui(cfg, UiBridge::disconnected()).unwrap();
        assert!(gui.approvals.auto_approve_enabled());
        gui.shutdown();
    }
}
