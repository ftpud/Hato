//! Commands and terminals through the Hato daemon over forwarded channels to its Unix socket
//! (`direct-streamlocal`), against a real OpenSSH server allowing ONE session per connection.
//! Skipped when `/usr/sbin/sshd` is missing. Own test binary: the known_hosts override is
//! process-wide.
#![cfg(unix)]
use hato_kernel::approvals::Approvals;
use hato_kernel::bridge::UiBridge;
use hato_kernel::grants::Target;
use hato_kernel::host::process::{self, SpawnSpec};
use hato_kernel::host::pty::{self, PtySpec, RemotePty};
use hato_kernel::host::ssh::{SshMaster, SshProfile};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::time::{Duration, Instant};

struct Server {
    sshd: Child,
    daemon: Child,
    port: u16,
    dir: PathBuf,
}

impl Drop for Server {
    fn drop(&mut self) {
        for c in [&mut self.sshd, &mut self.daemon] {
            let _ = c.kill();
            let _ = c.wait();
        }
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn keygen(path: &Path) {
    assert!(Command::new("ssh-keygen").args(["-q", "-t", "ed25519", "-N", "", "-f"]).arg(path).status().unwrap().success());
}

fn wait_for(what: &str, timeout: Duration, mut f: impl FnMut() -> bool) {
    let t = Instant::now();
    while !f() {
        assert!(t.elapsed() < timeout, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn start(streamlocal: bool) -> Option<Server> {
    let sftp = ["/usr/lib/openssh/sftp-server", "/usr/libexec/openssh/sftp-server", "/usr/libexec/sftp-server", "/usr/lib/ssh/sftp-server"]
        .into_iter().find(|p| Path::new(p).exists())?;
    if !Path::new("/usr/sbin/sshd").exists() {
        return None;
    }
    let dir = std::env::temp_dir().join(format!("hato-route-{}-{}", std::process::id(), streamlocal));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    keygen(&dir.join("host_key"));
    keygen(&dir.join("client_key"));
    std::fs::copy(dir.join("client_key.pub"), dir.join("authorized_keys")).unwrap();
    let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    let d = dir.display();
    std::fs::write(dir.join("sshd_config"), format!(
        "Port {port}\nListenAddress 127.0.0.1\nHostKey {d}/host_key\nAuthorizedKeysFile {d}/authorized_keys\nPasswordAuthentication no\n\
         KbdInteractiveAuthentication no\nUsePAM no\nStrictModes no\nPidFile {d}/sshd.pid\nMaxSessions 1\n\
         AllowStreamLocalForwarding {}\nSubsystem sftp {sftp}\n", if streamlocal { "yes" } else { "no" })).unwrap();
    let sshd = Command::new("/usr/sbin/sshd").args(["-D", "-e", "-f"]).arg(dir.join("sshd_config"))
        .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap();
    let daemon = Command::new(env!("CARGO_BIN_EXE_hato")).args(["daemon", "serve", "--dir"]).arg(dir.join("daemon"))
        .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap();
    let t = Instant::now();
    while std::net::TcpStream::connect(("127.0.0.1", port)).is_err() || !socket(&dir).exists() {
        assert!(t.elapsed() < Duration::from_secs(15), "sshd or daemon did not start");
        std::thread::sleep(Duration::from_millis(50));
    }
    Some(Server { sshd, daemon, port, dir })
}

fn socket(dir: &Path) -> PathBuf { hato_kernel::daemon::socket_path(&dir.join("daemon")) }

fn connect(s: &Server, id: &str) -> Arc<SshMaster> {
    let approvals = Approvals::new(UiBridge::disconnected());
    *approvals.headless_policy.lock() = Some(Arc::new(|_| Some("allow".into())));
    let m = SshMaster::new(SshProfile {
        profile_id: id.into(), host: "127.0.0.1".into(), port: s.port, user: std::env::var("USER").unwrap(),
        identity_file: Some(s.dir.join("client_key").display().to_string()), transport: None, auth: None,
    });
    m.connect(&approvals, "test", 1, false).unwrap();
    m
}

fn run(m: &SshMaster, cmd: &str) -> (i32, String, String) { m.exec(cmd).unwrap().collect(None, Duration::from_secs(20)).unwrap() }

#[test]
fn daemon_route_bypasses_the_session_limit() {
    let Some(s) = start(true) else {
        eprintln!("skipped: no /usr/sbin/sshd or sftp-server");
        return;
    };
    std::env::set_var("HATO_SSH_KNOWN_HOSTS", s.dir.join("known_hosts"));
    let m = connect(&s, "route");
    let daemon_pid = s.daemon.id().to_string();

    // Without the route, commands are children of sshd; with it, of the daemon.
    let (_, ppid, _) = run(&m, "echo $PPID");
    assert_ne!(ppid.trim(), daemon_pid);
    m.set_daemon_route(Some(socket(&s.dir).display().to_string()));
    let (_, ppid, _) = run(&m, "echo $PPID");
    assert_eq!(ppid.trim(), daemon_pid, "routed commands run in the daemon");

    // Exit codes, separate streams, stdin (3 MB), large output.
    assert_eq!(run(&m, "echo out; echo err >&2; exit 3"), (3, "out\n".into(), "err\n".into()));
    let input: Vec<u8> = (0..3_000_000u32).map(|i| (i % 251) as u8).collect();
    let (code, out, _) = m.exec("wc -c").unwrap().collect(Some(&input), Duration::from_secs(30)).unwrap();
    assert_eq!((code, out.trim()), (0, "3000000"));
    let (_, out, _) = run(&m, "head -c 6000000 /dev/zero");
    assert_eq!(out.len(), 6_000_000);

    // MaxSessions is 1, yet 24 commands run at once on a single connection.
    let t0 = Instant::now();
    let threads: Vec<_> = (0..24).map(|i| {
        let m = m.clone();
        std::thread::spawn(move || run(&m, &format!("sleep 1; echo {i}")).1)
    }).collect();
    for (i, t) in threads.into_iter().enumerate() {
        assert_eq!(t.join().unwrap(), format!("{i}\n"));
    }
    eprintln!("24 concurrent 1 s commands: {:?}", t0.elapsed());
    assert!(t0.elapsed() < Duration::from_secs(6), "ran concurrently");
    assert_eq!(m.status_json()["connections"], 1, "no extra connections were needed");

    // A spawned process ends on terminate() with its signal.
    let p = process::spawn(SpawnSpec {
        target: Target::Ssh { machine_id: m.profile.machine_id(), master_key: m.profile.machine_id() }, ssh: Some(m.clone()),
        executable: "sleep".into(), args: vec!["30".into()], cwd: "/tmp".into(), env: vec![], env_remove: vec![], login_shell: false, persist: None,
    }).unwrap();
    std::thread::sleep(Duration::from_millis(300));
    p.terminate(Some("TERM")).unwrap();
    let exit = p.wait(Some(Duration::from_secs(5))).expect("terminated process reports an exit");
    assert_eq!(exit.signal, Some(15), "ended by SIGTERM");

    // Dropping the connection hangs up the program (as closing an SSH channel does).
    let mut h = m.exec("echo $$; exec sleep 30").unwrap();
    let mut out = h.stdout.take().unwrap();
    let mut pid = Vec::new();
    let mut b = [0u8; 1];
    while std::io::Read::read(&mut out, &mut b).unwrap() == 1 && b[0] != b'\n' { pid.push(b[0]); }
    let pid = String::from_utf8(pid).unwrap();
    h.handle.kill();
    wait_for("hang-up", Duration::from_secs(5), || !Command::new("kill").args(["-0", &pid]).status().unwrap().success());

    // Terminals: size, resize, exit code.
    let t = pty::open(PtySpec {
        remote: Some(RemotePty { master: m.clone(), command: "printf 'pty-ok\\n'; stty size; read x; stty size; sleep 0.2".into() }),
        program: String::new(), args: vec![], cwd: None, env: vec![], cols: 100, rows: 30, machine_id: "ssh:route".into(), display_cwd: "/tmp".into(), answer_queries: true,
    }).unwrap();
    wait_for("pty output", Duration::from_secs(10), || t.screen_text().contains("30 100"));
    assert!(t.screen_text().contains("pty-ok"));
    t.resize(120, 40).unwrap();
    t.write(b"\r").unwrap();
    wait_for("pty resize", Duration::from_secs(10), || t.screen_text().contains("40 120"));
    wait_for("pty exit", Duration::from_secs(10), || t.is_exited());
    assert!(t.info()["exit"].as_str().unwrap().contains("code 0"), "{}", t.info());

    // A socket that is gone drops the route and falls back to sessions, once.
    m.set_daemon_route(Some(format!("{}/missing.sock", s.dir.display())));
    assert_eq!(run(&m, "echo fallback").1, "fallback\n");
    assert!(m.status_json()["daemonRoute"].is_null());
    assert!(m.status_json()["daemonRouteError"].is_string());
    m.disconnect();

    // A server that forbids socket forwarding: commands still work through sessions.
    drop(s);
    let s = start(false).unwrap();
    let m = connect(&s, "noforward");
    m.set_daemon_route(Some(socket(&s.dir).display().to_string()));
    let (_, ppid, _) = run(&m, "echo $PPID");
    assert_ne!(ppid.trim(), s.daemon.id().to_string(), "fell back to an SSH session");
    assert!(m.status_json()["daemonRoute"].is_null());
    m.disconnect();
}
