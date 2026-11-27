//! The daemon's operator policy: a desktop sets it over the control socket, the daemon validates
//! it, keeps it across restarts and reports it with recent denials.

use serde_json::Value;
use std::io::Write;
use std::process::{Command, Stdio};

fn hato(home: &str, args: &[&str], stdin: &str) -> (bool, String) {
    let mut child = Command::new(env!("CARGO_BIN_EXE_hato")).arg("daemon").args(args).args(["--dir", home])
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
    child.stdin.take().unwrap().write_all(stdin.as_bytes()).unwrap();
    let out = child.wait_with_output().unwrap();
    (out.status.success(), format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr)))
}

fn ctl(home: &str, request: &str) -> Value {
    let (_, out) = hato(home, &["ctl"], request);
    let reply: Value = serde_json::from_str(out.trim()).unwrap_or_else(|e| panic!("ctl reply {out:?}: {e}"));
    // {"ok": true, "value": …} or {"ok": false, "error": …}
    if reply["ok"] == true { reply["value"].clone() } else { reply }
}

/// Stops the test daemon even when an assertion fails, so it does not keep the binary locked.
struct Stop(String);
impl Drop for Stop {
    fn drop(&mut self) { let _ = hato(&self.0, &["stop"], ""); }
}

#[test]
fn policy_is_validated_kept_across_restarts_and_reported() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("daemon").to_string_lossy().into_owned();
    let _stop = Stop(home.clone());
    let (ok, out) = hato(&home, &["ensure"], "");
    assert!(ok, "{out}");

    let empty = ctl(&home, r#"{"op":"policy.get"}"#);
    assert_eq!(empty["policy"]["maxProcesses"], 0, "{empty}");

    let bad = ctl(&home, r#"{"op":"policy.set","args":{"policy":{"fsRoots":["not/absolute"]}}}"#);
    assert!(bad.to_string().contains("absolute"), "{bad}");

    let set = ctl(&home, r#"{"op":"policy.set","args":{"policy":{"capabilityDeny":["net.fetch"],"maxProcesses":3,"processMemoryMb":2048}}}"#);
    assert_eq!(set["policy"]["maxProcesses"], 3, "{set}");

    let (ok, out) = hato(&home, &["stop"], "");
    assert!(ok, "{out}");
    let (ok, out) = hato(&home, &["ensure"], "");
    assert!(ok, "{out}");
    let kept = ctl(&home, r#"{"op":"policy.get"}"#);
    assert_eq!(kept["policy"]["capabilityDeny"][0], "net.fetch", "{kept}");
    assert_eq!(kept["policy"]["processMemoryMb"], 2048, "{kept}");
    assert!(kept["denials"].is_array(), "{kept}");
}
