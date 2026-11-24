use anyhow::{bail, Context, Result};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

fn marker(home: &Path) -> PathBuf {
    home.join("cloud/daemon-managed")
}

pub fn daemon_managed(home: &Path) -> bool {
    marker(home).is_file()
}

fn write_file(path: &Path, contents: &[u8]) -> Result<()> {
    let dir = path.parent().context("Cloud service path has no parent")?;
    std::fs::create_dir_all(dir)?;
    let mut temp = tempfile::NamedTempFile::new_in(dir)?;
    temp.write_all(contents)?;
    temp.as_file().sync_all()?;
    temp.persist(path)?;
    Ok(())
}

fn systemctl(args: &[&str]) -> bool {
    Command::new("systemctl")
        .arg("--user")
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}

fn service_id(home: &str) -> String {
    format!("hato-cloud-{}", &crate::util::sha256_hex(home.as_bytes())[..16])
}

fn user_systemd(unit: &str, exe: &str, home: &str) -> Result<bool> {
    if !systemctl(&["show-environment"]) {
        return Ok(false);
    }
    let uid = unsafe { libc::getuid() }.to_string();
    let linger = || {
        Command::new("loginctl")
            .args(["show-user", &uid, "-p", "Linger", "--value"])
            .output()
            .is_ok_and(|result| {
                result.status.success() && String::from_utf8_lossy(&result.stdout).trim() == "yes"
            })
    };
    if !linger() {
        let _ = Command::new("loginctl")
            .args(["--no-ask-password", "enable-linger", &uid])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        if !linger() {
            return Ok(false);
        }
    }
    let quote = |value: &str| {
        format!(
            "\"{}\"",
            value
                .replace('\\', "\\\\")
                .replace('"', "\\\"")
                .replace('%', "%%")
                .replace('$', "$$")
        )
    };
    let config = dirs::config_dir().context("No user service configuration directory")?;
    let file = config.join("systemd/user").join(unit);
    write_file(&file, format!(
        "[Unit]\nDescription=Hato Cloud connector\n\n[Service]\nExecStart={} cloud service --dir {}\nRestart=always\nRestartSec=3\nKillMode=process\n\n[Install]\nWantedBy=default.target\n",
        quote(exe), quote(home),
    ).as_bytes())?;
    if !systemctl(&["daemon-reload"])
        || !systemctl(&["enable", "--now", unit])
        || !systemctl(&["restart", unit])
    {
        bail!("Could not start the Hato Cloud user service");
    }
    Ok(true)
}

fn install_cron(id: &str, exe: &str, home: &str) -> Result<()> {
    let old = Command::new("crontab")
        .env("LC_ALL", "C")
        .arg("-l")
        .output()
        .context("Automatic boot requires user systemd with lingering or crontab")?;
    if !old.status.success() && !String::from_utf8_lossy(&old.stderr).contains("no crontab") {
        bail!("Could not read the user crontab for Hato Cloud");
    }
    let tag = format!("# {id}");
    let old = String::from_utf8(old.stdout).context("User crontab is not UTF-8")?;
    let mut contents = old
        .lines()
        .filter(|line| !line.ends_with(&tag))
        .map(|line| format!("{line}\n"))
        .collect::<String>();
    let quote = |value: &str| crate::quoting::sh_quote(value).replace('%', "\\%");
    contents.push_str(&format!(
        "@reboot {} daemon ensure --dir {} >/dev/null 2>&1 {tag}\n",
        quote(exe),
        quote(home)
    ));
    let mut update = Command::new("crontab")
        .arg("-")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .spawn()?;
    update
        .stdin
        .take()
        .context("could not open crontab input")?
        .write_all(contents.as_bytes())?;
    if !update.wait()?.success() {
        bail!("Could not install the Hato Cloud boot entry");
    }
    Ok(())
}

pub fn install(home: &Path, require_systemd: bool) -> Result<()> {
    let home = home
        .canonicalize()
        .context("Hato daemon home is unavailable")?;
    let exe = std::env::current_exe()?;
    let home_arg = home.to_str().context("Hato daemon home is not UTF-8")?;
    let exe = exe.to_str().context("Hato binary path is not UTF-8")?;
    if [home_arg, exe]
        .iter()
        .any(|value| value.chars().any(char::is_control))
    {
        bail!("Invalid Hato service path");
    }
    crate::daemon::secure_socket_dir(&home.join("cloud"), false)?;
    super::Config::load(&home.join("cloud/host.json"))?;
    let id = service_id(home_arg);
    if user_systemd(&format!("{id}.service"), exe, home_arg)? {
        if marker(&home).exists() {
            std::fs::remove_file(marker(&home))?;
        }
        println!("Cloud connector supervised by systemd");
    } else {
        if require_systemd {
            bail!("The running daemon needs an update before it can supervise the Cloud connector");
        }
        install_cron(&id, exe, home_arg)?;
        write_file(&marker(&home), exe.as_bytes())?;
        println!("Cloud connector supervised by hatod with a crontab boot entry");
    }
    Ok(())
}

pub(super) fn upgrade(home: &Path) -> Result<()> {
    let home = home.canonicalize()?;
    let home_arg = home.to_str().context("Hato daemon home is not UTF-8")?;
    let unit = format!("{}.service", service_id(home_arg));
    let managed = daemon_managed(&home);
    let systemd = systemctl(&["cat", &unit]);
    if systemd && !systemctl(&["stop", &unit]) {
        bail!("Could not stop the Hato Cloud connector");
    }
    let restarted = crate::daemon::client::ensure(&home, true).and_then(|()| {
        if systemd || managed { install(&home, systemd)?; }
        Ok(())
    });
    if restarted.is_err() && systemd {
        // Bring the connector back even if refreshing the user service failed.
        let _ = systemctl(&["start", &unit]);
    }
    restarted
}

pub fn service(home: &Path) -> Result<()> {
    let exe = std::env::current_exe()?;
    let root = home.to_path_buf();
    let wake = move || {
        // A connector upgrade must leave an already running daemon and its resources alone.
        if crate::daemon::client::request(&root, &serde_json::json!({"op":"hello"})).is_ok() {
            return Ok(true);
        }
        Command::new(&exe)
            .args(["daemon", "ensure", "--dir"])
            .arg(&root)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .status()
            .map(|status| status.success())
    };
    // Connect to the relay even if the daemon is still starting (e.g. an upgrade is replacing it):
    // the host stays online and channels work as soon as the daemon answers. Retry quickly while
    // it's down, then settle to a slow health check.
    let mut healthy = matches!(wake(), Ok(true));
    if !healthy {
        eprintln!("hato cloud: hatod is not answering yet; retrying every 5 s");
    }
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(if healthy { 30 } else { 5 }));
        healthy = matches!(wake(), Ok(true));
    });
    let config = super::Config::load(&home.join("cloud/host.json"))?;
    super::run_connector(config, home)
}

pub fn watch(home: PathBuf) {
    let mut child: Option<std::process::Child> = None;
    loop {
        let path = std::fs::read_to_string(marker(&home)).ok();
        if let Some(process) = &mut child {
            if path.is_none() {
                drop(process.stdin.take());
                let _ = process.wait();
                child = None;
            } else if process.try_wait().ok().flatten().is_some() {
                child = None;
            }
        }
        if let Some(path) = path.filter(|_| child.is_none()) {
            child = Command::new(path)
                .args(["cloud", "connect", "--parent-stdin", "--dir"])
                .arg(&home)
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .spawn()
                .ok();
        }
        std::thread::sleep(Duration::from_secs(3));
    }
}

pub fn close_on_parent_exit() {
    std::thread::spawn(|| {
        let _ = std::io::copy(&mut std::io::stdin().lock().take(1), &mut std::io::sink());
        std::process::exit(0);
    });
}
