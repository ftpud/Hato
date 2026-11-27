//! Native Windows workspaces keep persistent terminals in the local daemon. The desktop views them
//! over the daemon socket (`pty::open_daemon`): detaching leaves the terminal running, reattaching
//! replays its history, and the program's exit ends the terminal.
#![cfg(windows)]

use hato_kernel::host::pty::{self, PtySession, PtySpec};
use serde_json::json;
use std::io::Write;
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::time::{Duration, Instant};

fn hato(home: &str, args: &[&str], stdin: &str) -> String {
    let mut child = Command::new(env!("CARGO_BIN_EXE_hato")).arg("daemon").args(args).args(["--dir", home])
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
    child.stdin.take().unwrap().write_all(stdin.as_bytes()).unwrap();
    let out = child.wait_with_output().unwrap();
    assert!(out.status.success(), "hato daemon {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).into_owned()
}

fn wait_for(what: &str, mut done: impl FnMut() -> bool) {
    let t = Instant::now();
    while !done() {
        assert!(t.elapsed() < Duration::from_secs(20), "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn view(home: &str, cwd: &str) -> Arc<PtySession> {
    let spec = PtySpec { remote: None, program: String::new(), args: vec![], cwd: None, env: vec![], env_remove: vec![],
        cols: 100, rows: 30, machine_id: "local".into(), display_cwd: cwd.into(), answer_queries: false };
    pty::open_daemon(spec, home, json!({"key": "test/term", "cwd": cwd, "shell": "cmd.exe", "columns": 100, "rows": 30})).unwrap()
}

#[test]
fn desktop_views_a_persistent_terminal_over_the_daemon_socket() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("daemon").to_string_lossy().into_owned();
    let cwd = dir.path().to_string_lossy().into_owned();
    let status = hato(&home, &["ensure"], "");
    assert!(status.contains("\"os\":\"windows\""), "{status}");

    let first = view(&home, &cwd);
    first.write(b"echo first-view\r").unwrap();
    wait_for("the first viewer's output", || first.screen_text().contains("\nfirst-view"));
    first.kill(); // detaches; the daemon keeps the shell
    wait_for("the first viewer to detach", || first.is_exited());

    let second = view(&home, &cwd);
    wait_for("history replayed to the second viewer", || second.screen_text().contains("\nfirst-view"));
    second.write(b"exit\r").unwrap();
    wait_for("the shell's exit to end the terminal", || second.is_exited());
    let exit = second.exit.lock().clone().unwrap_or_default();
    assert!(exit.contains("exited"), "{exit}");

    let resources = hato(&home, &["ctl"], r#"{"op":"resources.list"}"#);
    assert!(resources.contains("\"ptys\":[]"), "{resources}");
    hato(&home, &["stop"], "");
}
