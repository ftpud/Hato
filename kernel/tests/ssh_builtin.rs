//! The built-in SSH client against a real, throwaway OpenSSH server (user-level `sshd` on a free
//! loopback port, everything under a temp directory). Skipped when `/usr/sbin/sshd` is missing.
//! One test function: the known_hosts override is process-wide.
#![cfg(unix)]
use hato_kernel::approvals::Approvals;
use hato_kernel::bridge::UiBridge;
use hato_kernel::grants::Target;
use hato_kernel::host::process::{self, SpawnSpec};
use hato_kernel::host::pty::{self, PtySpec, RemotePty};
use hato_kernel::host::ssh::{SshMaster, SshProfile};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

struct Sshd {
    child: Child,
    port: u16,
    dir: PathBuf,
}

impl Drop for Sshd {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn keygen(path: &Path) {
    let ok = Command::new("ssh-keygen").args(["-q", "-t", "ed25519", "-N", "", "-f"]).arg(path).status().unwrap().success();
    assert!(ok, "ssh-keygen");
}

fn start_sshd() -> Option<Sshd> {
    let sftp = ["/usr/lib/openssh/sftp-server", "/usr/libexec/openssh/sftp-server", "/usr/libexec/sftp-server", "/usr/lib/ssh/sftp-server"]
        .into_iter().find(|p| Path::new(p).exists())?;
    if !Path::new("/usr/sbin/sshd").exists() {
        return None;
    }
    let dir = std::env::temp_dir().join(format!("hato-sshc-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    keygen(&dir.join("host_key"));
    keygen(&dir.join("client_key"));
    keygen(&dir.join("other_key"));
    std::fs::copy(dir.join("client_key.pub"), dir.join("authorized_keys")).unwrap();
    let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    let d = dir.display();
    std::fs::write(dir.join("sshd_config"), format!(
        "Port {port}\nListenAddress 127.0.0.1\nHostKey {d}/host_key\nAuthorizedKeysFile {d}/authorized_keys\nPasswordAuthentication no\n\
         KbdInteractiveAuthentication no\nUsePAM no\nStrictModes no\nPidFile {d}/sshd.pid\nAllowTcpForwarding yes\nSubsystem sftp {sftp}\n")).unwrap();
    let child = Command::new("/usr/sbin/sshd").args(["-D", "-e", "-f"]).arg(dir.join("sshd_config"))
        .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap();
    let t = Instant::now();
    while std::net::TcpStream::connect(("127.0.0.1", port)).is_err() {
        assert!(t.elapsed() < Duration::from_secs(10), "sshd did not start");
        std::thread::sleep(Duration::from_millis(50));
    }
    Some(Sshd { child, port, dir })
}

fn wait_for(what: &str, timeout: Duration, mut f: impl FnMut() -> bool) {
    let t = Instant::now();
    while !f() {
        assert!(t.elapsed() < timeout, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn built_in_client_against_openssh() {
    let Some(sshd) = start_sshd() else {
        eprintln!("skipped: no /usr/sbin/sshd or sftp-server");
        return;
    };
    let kh = sshd.dir.join("known_hosts");
    std::env::set_var("HATO_SSH_KNOWN_HOSTS", &kh);
    let user = std::env::var("USER").unwrap();
    let profile = |id: &str, key: &str| SshProfile {
        profile_id: id.into(), host: "127.0.0.1".into(), port: sshd.port, user: user.clone(),
        identity_file: Some(sshd.dir.join(key).display().to_string()), transport: None, auth: None,
    };
    let approvals = Approvals::new(UiBridge::disconnected());
    let asked = Arc::new(Mutex::new(Vec::<String>::new()));
    let a2 = asked.clone();
    *approvals.headless_policy.lock() = Some(Arc::new(move |r| {
        a2.lock().unwrap().push(format!("{}: {}", r.operation, r.detail));
        Some("allow".into())
    }));

    // Unknown host: the fingerprint is approved once and learned.
    let m = SshMaster::new(profile("t1", "client_key"));
    let t0 = Instant::now();
    m.connect(&approvals, "test", 1, false).unwrap();
    eprintln!("connect + host key approval: {:?}", t0.elapsed());
    assert!(m.is_alive());
    assert_eq!(asked.lock().unwrap().len(), 1, "one trust prompt");
    assert!(asked.lock().unwrap()[0].contains("SHA256:"), "prompt shows the fingerprint");
    let learned = std::fs::read_to_string(&kh).unwrap();
    assert!(learned.starts_with(&format!("[127.0.0.1]:{} ssh-ed25519 ", sshd.port)), "{learned}");
    m.disconnect();
    assert!(!m.is_alive());
    let m = SshMaster::new(profile("t2", "client_key"));
    m.connect(&approvals, "test", 1, false).unwrap();
    assert_eq!(asked.lock().unwrap().len(), 1, "a known host is not asked again");

    // Commands: exit codes, separate streams, stdin, large output, concurrency.
    let t0 = Instant::now();
    let (code, out, err) = m.exec("echo out; echo err >&2; exit 3").unwrap().collect(None, Duration::from_secs(10)).unwrap();
    eprintln!("one command round trip: {:?}", t0.elapsed());
    assert_eq!((code, out.as_str(), err.as_str()), (3, "out\n", "err\n"));
    let input: Vec<u8> = (0..3_000_000u32).map(|i| (i % 251) as u8).collect();
    let (code, out, _) = m.exec("cat | sha256sum").unwrap().collect(Some(&input), Duration::from_secs(30)).unwrap();
    let local = Command::new("sha256sum").stdin(Stdio::piped()).stdout(Stdio::piped()).spawn().map(|mut c| {
        c.stdin.take().unwrap().write_all(&input).unwrap();
        String::from_utf8(c.wait_with_output().unwrap().stdout).unwrap()
    }).unwrap();
    assert_eq!((code, out.split(' ').next()), (0, local.split(' ').next()), "3 MB through stdin");
    let (_, out, _) = m.exec("head -c 6000000 /dev/zero").unwrap().collect(None, Duration::from_secs(30)).unwrap();
    assert_eq!(out.len(), 6_000_000, "6 MB of output");
    let t0 = Instant::now();
    let threads: Vec<_> = (0..16).map(|i| {
        let m = m.clone();
        std::thread::spawn(move || m.exec(&format!("echo {i}")).unwrap().collect(None, Duration::from_secs(10)).unwrap().1)
    }).collect();
    for (i, t) in threads.into_iter().enumerate() {
        assert_eq!(t.join().unwrap(), format!("{i}\n"));
    }
    eprintln!("16 concurrent commands: {:?}", t0.elapsed());

    // SFTP.
    let sftp = m.sftp().unwrap();
    let home = sftp.realpath(".").unwrap();
    assert!(home.starts_with('/'), "{home}");
    let f = format!("{}/sftp-test.txt", sshd.dir.display());
    sftp.write_atomic(&f, b"hello sftp", 0o600).unwrap();
    assert_eq!(sftp.read(&f, 1 << 20).unwrap().0, b"hello sftp");
    assert!(sftp.list(&sshd.dir.display().to_string()).unwrap().iter().any(|(n, _)| n == "sftp-test.txt"));

    // Processes: a running program is ended by terminate().
    let p = process::spawn(SpawnSpec {
        target: Target::Ssh { machine_id: m.profile.machine_id(), master_key: m.profile.machine_id() }, ssh: Some(m.clone()),
        executable: "sleep".into(), args: vec!["30".into()], cwd: "/tmp".into(), env: vec![], env_remove: vec![], login_shell: false, persist: None,
    }).unwrap();
    std::thread::sleep(Duration::from_millis(300));
    p.terminate(Some("TERM")).unwrap();
    let exit = p.wait(Some(Duration::from_secs(5)));
    assert!(exit.is_some(), "terminated process reports an exit: {}", p.info());
    assert_eq!(exit.unwrap().signal, Some(15), "ended by SIGTERM");

    // Terminals: remote PTY with its size, then a resize.
    let s = pty::open(PtySpec {
        remote: Some(RemotePty { master: m.clone(), command: "printf 'pty-ok\\n'; stty size; read x; stty size; sleep 0.2".into() }),
        program: String::new(), args: vec![], cwd: None, env: vec![], cols: 100, rows: 30, machine_id: "ssh:t2".into(), display_cwd: "/tmp".into(), answer_queries: true,
    }).unwrap();
    wait_for("pty output", Duration::from_secs(10), || s.screen_text().contains("30 100"));
    assert!(s.screen_text().contains("pty-ok"));
    s.resize(120, 40).unwrap();
    s.write(b"\r").unwrap();
    wait_for("pty resize", Duration::from_secs(10), || s.screen_text().contains("40 120"));
    wait_for("pty exit", Duration::from_secs(10), || s.is_exited());
    assert!(s.info()["exit"].as_str().unwrap().contains("code 0"), "{}", s.info());

    // Reverse forward: the remote side reaches a listener on this machine's loopback.
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let local_port = listener.local_addr().unwrap().port();
    std::thread::spawn(move || {
        let (mut c, _) = listener.accept().unwrap();
        let mut b = [0u8; 4];
        c.read_exact(&mut b).unwrap();
        assert_eq!(&b, b"ping");
        c.write_all(b"pong").unwrap();
    });
    let remote_port = m.forward_reverse(local_port).unwrap();
    let (code, out, err) = m.exec(&format!("bash -c 'exec 3<>/dev/tcp/127.0.0.1/{remote_port}; printf ping >&3; head -c 4 <&3'"))
        .unwrap().collect(None, Duration::from_secs(10)).unwrap();
    assert_eq!((code, out.as_str()), (0, "pong"), "{err}");
    m.cancel_reverse(remote_port, local_port);

    // A key the server does not know is refused with a clear error.
    let bad = SshMaster::new(profile("t3", "other_key"));
    let e = bad.connect(&approvals, "test", 1, false).unwrap_err();
    assert_eq!(e.code, "EAUTH", "{e}");

    // A changed host key is never accepted, approved or not.
    let other = std::fs::read_to_string(sshd.dir.join("other_key.pub")).unwrap();
    std::fs::write(&kh, format!("[127.0.0.1]:{} {}", sshd.port, other)).unwrap();
    let changed = SshMaster::new(profile("t4", "client_key"));
    let e = changed.connect(&approvals, "test", 1, false).unwrap_err();
    assert_eq!(e.code, "EHOSTKEY", "{e}");
    assert!(e.message.contains("HAS CHANGED"), "{e}");
    assert_eq!(asked.lock().unwrap().len(), 1, "no prompt for a changed key");

    m.disconnect();
    assert!(m.exec("true").is_err(), "no channels after disconnect");
}
