//! `wsl.exe` adapter: the Windows desktop reaches Linux workspaces through it.
//!
//! Windows OpenSSH has no ControlMaster, so on Windows the `SshMaster` either runs its channels
//! directly in a distribution (`transport: "wsl"`) or runs the distribution's own OpenSSH client.
//! `--exec` passes argv through unmodified: no shell of `wsl.exe` re-parses the arguments.
use crate::util::{HResult, HostError};
use std::process::Command;

/// Absolute path, so a `wsl.exe` next to the app or in a workspace can never be picked up.
pub fn exe() -> String {
    let root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
    format!(r"{root}\System32\wsl.exe")
}

/// `wsl.exe` arguments running `argv` in a distribution (`None` = the default one), from `$HOME`.
pub fn exec_args(distro: Option<&str>, argv: &[&str]) -> Vec<String> {
    let mut v = Vec::with_capacity(argv.len() + 5);
    if let Some(d) = distro {
        v.extend(["-d".to_string(), d.to_string()]);
    }
    v.extend(["--cd".to_string(), "~".to_string(), "--exec".to_string()]);
    v.extend(argv.iter().map(|a| a.to_string()));
    v
}

pub fn command(distro: Option<&str>, argv: &[&str]) -> Command {
    let mut c = crate::util::command(exe());
    c.args(exec_args(distro, argv));
    c
}

/// `wsl.exe`'s own messages are UTF-16LE; output of Linux programs passes through as bytes.
pub fn decode(bytes: &[u8]) -> String {
    let utf16 = bytes.len() >= 2 && bytes.len() % 2 == 0 && bytes.iter().skip(1).step_by(2).filter(|b| **b == 0).count() * 2 >= bytes.len();
    if utf16 {
        let units: Vec<u16> = bytes.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
        String::from_utf16_lossy(&units).trim_start_matches('\u{feff}').to_string()
    } else {
        String::from_utf8_lossy(bytes).into_owned()
    }
}

/// Installed distributions, the default first. Empty off Windows.
pub fn distributions() -> HResult<Vec<String>> {
    if !cfg!(windows) {
        return Ok(vec![]);
    }
    let out = crate::util::command(exe()).args(["-l", "-q"]).output().map_err(|e| HostError::new("ENOEXEC", format!("cannot run wsl.exe: {e}")))?;
    if !out.status.success() {
        // "no installed distributions" is reported as a failure of `-l`.
        return Ok(vec![]);
    }
    Ok(parse_distributions(&decode(&out.stdout)))
}

fn parse_distributions(listing: &str) -> Vec<String> {
    listing.lines().map(str::trim).filter(|l| !l.is_empty() && !l.starts_with("docker-desktop")).map(String::from).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_wsl_utf16_and_leaves_linux_output_alone() {
        let wide: Vec<u8> = "Ubuntu\r\nUbuntu-22.04\r\n".encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
        assert_eq!(parse_distributions(&decode(&wide)), vec!["Ubuntu", "Ubuntu-22.04"]);
        assert_eq!(decode("héllo\n".as_bytes()), "héllo\n");
        assert_eq!(decode(b"ab"), "ab");
    }

    #[test]
    fn hides_docker_backends() {
        assert_eq!(parse_distributions("Debian\ndocker-desktop\ndocker-desktop-data\n"), vec!["Debian"]);
    }

    #[test]
    fn exec_args_keep_argv_intact() {
        assert_eq!(exec_args(Some("Ubuntu"), &["/bin/sh", "-c", "echo 'a b'"]), vec!["-d", "Ubuntu", "--cd", "~", "--exec", "/bin/sh", "-c", "echo 'a b'"]);
        assert_eq!(exec_args(None, &["ssh"]), vec!["--cd", "~", "--exec", "ssh"]);
    }
}
