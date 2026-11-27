//! One-time consent before Hato installs its background runner (`hatod`) on a machine.
//!
//! The first install on each machine asks natively; the answer "Install" is remembered in the
//! kernel data dir (`daemon-consent.json`). Machines that already have a daemon home (installed
//! before this prompt existed, or by another Hato) are recorded without asking. "Not now" is
//! remembered for the rest of the session, so callers fail fast instead of asking again and again.
use super::ssh::SshMaster;
use crate::approvals::{ApprovalOption, Decision};
use crate::kernel::Kernel;
use crate::router::Generation;
use crate::util::{HResult, HostError};
use parking_lot::Mutex;
use serde_json::json;
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

pub struct DaemonConsent {
    file: PathBuf,
    allowed: Mutex<HashSet<String>>,
    declined: Mutex<HashSet<String>>,
    /// One prompt at a time: concurrent first callers wait for the same answer.
    asking: Mutex<()>,
}

impl DaemonConsent {
    pub fn load(data_dir: &std::path::Path) -> Self {
        let file = data_dir.join("daemon-consent.json");
        let allowed = std::fs::read(&file).ok()
            .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
            .and_then(|v| v["machines"].as_array().map(|a| a.iter().filter_map(|m| m.as_str().map(str::to_owned)).collect()))
            .unwrap_or_default();
        DaemonConsent { file, allowed: Mutex::new(allowed), declined: Default::default(), asking: Mutex::new(()) }
    }

    fn record(&self, machine: &str) {
        let machines: Vec<String> = {
            let mut allowed = self.allowed.lock();
            allowed.insert(machine.to_owned());
            let mut list: Vec<String> = allowed.iter().cloned().collect();
            list.sort();
            list
        };
        let tmp = self.file.with_extension("json.tmp");
        let saved = std::fs::write(&tmp, json!({ "machines": machines }).to_string()).and_then(|_| std::fs::rename(&tmp, &self.file));
        if let Err(e) = saved {
            log::warn!("could not save daemon consent: {e}");
        }
    }

    /// Ask once before the daemon is first installed on `master`'s machine (`None`: this one).
    pub fn require(&self, k: &Kernel, gen: &Generation, master: Option<&Arc<SshMaster>>) -> HResult<()> {
        let machine = master.map(|m| m.profile.machine_id()).unwrap_or_else(|| "local".into());
        if self.allowed.lock().contains(&machine) {
            return Ok(());
        }
        let _asking = self.asking.lock();
        if self.allowed.lock().contains(&machine) {
            return Ok(());
        }
        let place = master.map(|m| if m.is_wsl() { format!("the WSL distribution {}", m.profile.host) } else { m.profile.destination() });
        if self.declined.lock().contains(&machine) {
            return Err(declined(place.as_deref()));
        }
        let (installed, home) = match master {
            None => {
                let home = crate::daemon::home_dir(None);
                (home.join("run").exists() || home.join("bin").exists(), home.to_string_lossy().into_owned())
            }
            Some(m) => {
                // Windows SSH hosts get no daemon (`daemon_link::install` refuses): nothing to ask.
                if m.platform().is_ok_and(|(os, _)| os == "windows") {
                    return Ok(());
                }
                super::daemon_link::ssh_daemon_installed(m)?
            }
        };
        if installed {
            self.record(&machine);
            return Ok(());
        }
        let title = match &place {
            None => "Install Hato's background runner?".to_owned(),
            Some(place) => format!("Install Hato's background runner on {place}?"),
        };
        let detail = format!(
            "Hato installs hatod, its background runner, {where_}.\n\n\
             hatod runs in the background so terminals, processes, agents and workflows keep running \
             when Hato is closed or the connection drops, and are still there when you come back.\n\n\
             It is installed for your user only, in {home}, and needs no administrator rights.\n\n\
             This is asked once per machine.",
            where_ = place.as_deref().map(|p| format!("on {p}")).unwrap_or_else(|| "on this computer".into()),
        );
        let options = vec![
            ApprovalOption { id: "allow".into(), label: "Install".into(), kind: "allow".into() },
            ApprovalOption { id: "deny".into(), label: "Not now".into(), kind: "deny".into() },
        ];
        let op = "daemon.install";
        match k.approvals.request(&gen.module_id, gen.gen_id, op, &title, &detail, false, options, Duration::from_secs(600)) {
            Decision::Option(o) | Decision::Automatic(o) if o == "allow" => {
                k.audit.record(&gen.module_id, gen.gen_id, op, &machine, "approved", Some("native-user"));
                self.record(&machine);
                Ok(())
            }
            Decision::Option(_) | Decision::Automatic(_) => {
                k.audit.record(&gen.module_id, gen.gen_id, op, &machine, "denied", Some("native-user"));
                self.declined.lock().insert(machine);
                Err(declined(place.as_deref()))
            }
            Decision::Expired => {
                k.audit.record(&gen.module_id, gen.gen_id, op, &machine, "expired", None);
                Err(HostError::new("EDENIED", "Hato's background runner was not installed: the request expired"))
            }
        }
    }
}


fn declined(place: Option<&str>) -> HostError {
    let place = place.map(|p| format!(" on {p}")).unwrap_or_default();
    HostError::new("EDENIED", format!("Hato's background runner (hatod) was not installed{place}. Restart Hato to be asked again."))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn consent_is_remembered_per_machine_across_loads() {
        let dir = std::env::temp_dir().join(format!("hato-consent-{}", crate::util::random_hex(6)));
        std::fs::create_dir_all(&dir).unwrap();
        let consent = DaemonConsent::load(&dir);
        assert!(consent.allowed.lock().is_empty());
        consent.record("ssh:box");
        consent.record("local");
        let again = DaemonConsent::load(&dir);
        assert!(again.allowed.lock().contains("local") && again.allowed.lock().contains("ssh:box"));
        assert!(!again.allowed.lock().contains("ssh:other"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
