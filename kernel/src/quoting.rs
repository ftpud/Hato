//! The single audited POSIX shell quoting adapter used for remote (SSH) execution.
//! Local execution never goes through a shell: it uses argv directly.

/// Quote one word for a POSIX shell using single quotes.
pub fn sh_quote(s: &str) -> String {
    if !s.is_empty() && s.bytes().all(|b| b.is_ascii_alphanumeric() || b"-_./:=@%+,".contains(&b)) {
        return s.to_string();
    }
    let mut out = String::with_capacity(s.len() + 2);
    out.push('\'');
    for c in s.chars() {
        if c == '\'' {
            out.push_str("'\\''");
        } else {
            out.push(c);
        }
    }
    out.push('\'');
    out
}

fn valid_env_name(k: &str) -> bool {
    !k.is_empty() && k.bytes().enumerate().all(|(i, b)| b == b'_' || b.is_ascii_alphabetic() || (i > 0 && b.is_ascii_digit()))
}

/// Build the remote command line: `cd -- <cwd> && exec [env K=V...] <exe> <args...>`.
/// When `login_shell` is set the inner command is run through the user's login shell so that
/// PATH from profile files applies (the inner command is itself quoted as one word).
pub fn remote_command(cwd: &str, exe: &str, args: &[String], env: &[(String, String)], env_remove: &[String], login_shell: bool) -> Result<String, String> {
    if exe.is_empty() {
        return Err("empty executable".into());
    }
    if exe.contains('\0') || cwd.contains('\0') || args.iter().any(|a| a.contains('\0')) {
        return Err("NUL byte in command".into());
    }
    let mut inner = format!("cd -- {} && exec ", sh_quote(cwd));
    if !env.is_empty() || !env_remove.is_empty() {
        inner.push_str("env ");
        for k in env_remove {
            if !valid_env_name(k) {
                return Err(format!("invalid environment variable name {k:?}"));
            }
            inner.push_str("-u ");
            inner.push_str(k);
            inner.push(' ');
        }
        for (k, v) in env {
            if !valid_env_name(k) {
                return Err(format!("invalid environment variable name {k:?}"));
            }
            inner.push_str(&sh_quote(&format!("{k}={v}")));
            inner.push(' ');
        }
    }
    inner.push_str(&sh_quote(exe));
    for a in args {
        inner.push(' ');
        inner.push_str(&sh_quote(a));
    }
    if login_shell {
        Ok(format!("exec \"${{SHELL:-/bin/sh}}\" -lc {}", sh_quote(&inner)))
    } else {
        Ok(inner)
    }
}

/// Remote interactive shell for a PTY, started in `cwd`.
pub fn remote_shell(cwd: &str, shell: Option<&str>) -> String {
    match shell {
        Some(s) => format!("cd -- {} && exec {} -l", sh_quote(cwd), sh_quote(s)),
        None => format!("cd -- {} && exec \"${{SHELL:-/bin/sh}}\" -l", sh_quote(cwd)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn quoting() {
        assert_eq!(sh_quote("abc"), "abc");
        assert_eq!(sh_quote("a b"), "'a b'");
        assert_eq!(sh_quote("it's"), "'it'\\''s'");
        assert_eq!(sh_quote("$(rm -rf /)"), "'$(rm -rf /)'");
        assert_eq!(sh_quote(""), "''");
    }
    #[test]
    fn command() {
        let c = remote_command("/tmp/x y", "git", &["-C".into(), "/a;b".into()], &[], &[], false).unwrap();
        assert_eq!(c, "cd -- '/tmp/x y' && exec git -C '/a;b'");
        let c = remote_command("/r", "node", &[], &[("A".into(), "1 2".into())], &[], true).unwrap();
        assert!(c.starts_with("exec \"${SHELL:-/bin/sh}\" -lc "));
        assert!(remote_command("/r", "x", &[], &[("A;B".into(), "1".into())], &[], false).is_err());
        let c = remote_command("/r", "agent", &[], &[], &["ANTHROPIC_API_KEY".into()], false).unwrap();
        assert_eq!(c, "cd -- /r && exec env -u ANTHROPIC_API_KEY agent");
        assert!(remote_command("/r", "x", &[], &[], &["A B".into()], false).is_err());
    }
}
