//! Kernel configuration: paths and command-line flags. No application semantics.
use std::path::{Path, PathBuf};

#[derive(Clone, Debug)]
pub struct Config {
    /// Repository root containing `modules/` (module source) and `build/modules` (seed artifacts).
    pub repo_root: PathBuf,
    /// Application data directory (sqlite, artifacts, registry, logs, ssh sockets, worktrees, shared).
    pub data_dir: PathBuf,
    /// Initial project root passed with `--root` (forwarded to TS bootstrap as plain data).
    pub initial_root: Option<PathBuf>,
    /// Start every module at its last-known-good version and show safe-mode chrome on failure.
    pub safe_mode: bool,
    /// Developer flag: watch build/modules and auto-stage+activate changed seeds (trusted local dev only).
    pub dev_watch: bool,
    /// Headless self-test run (no window); used by integration tests.
    pub headless: bool,
    /// Optional script for headless runs.
    pub headless_script: Option<PathBuf>,
}

impl Config {
    pub fn from_args(args: &[String]) -> anyhow::Result<Config> {
        let mut root = None;
        let mut data_dir = None;
        let mut repo_root = None;
        let mut safe_mode = false;
        let mut dev_watch = false;
        let mut headless = false;
        let mut headless_script = None;
        let mut i = 1;
        while i < args.len() {
            let a = &args[i];
            let mut next = || -> anyhow::Result<String> {
                i += 1;
                args.get(i).cloned().ok_or_else(|| anyhow::anyhow!("missing value for {a}"))
            };
            match a.as_str() {
                "--root" => root = Some(PathBuf::from(next()?)),
                "--data-dir" => data_dir = Some(PathBuf::from(next()?)),
                "--repo-root" | "--modules-root" => repo_root = Some(PathBuf::from(next()?)),
                "--safe-mode" => safe_mode = true,
                "--dev-watch" => dev_watch = true,
                "--headless" => headless = true,
                "--headless-script" => {
                    headless = true;
                    headless_script = Some(PathBuf::from(next()?))
                }
                "--help" | "-h" => {
                    println!("hato [--root PATH] [--data-dir PATH] [--repo-root PATH] [--safe-mode] [--dev-watch] [--headless] [--headless-script FILE]");
                    std::process::exit(0);
                }
                other => anyhow::bail!("unknown argument {other}"),
            }
            i += 1;
        }
        let cwd = std::env::current_dir()?;
        let repo_root = match repo_root {
            Some(p) => p,
            None => find_repo_root(&cwd)
                .or_else(|| std::env::current_exe().ok().and_then(|e| find_repo_root(&e)))
                .ok_or_else(|| anyhow::anyhow!("cannot locate repository root containing modules/; pass --repo-root"))?,
        };
        let repo_root = repo_root.canonicalize()?;
        let data_dir = match data_dir {
            Some(p) => p,
            None => dirs::data_dir().unwrap_or_else(|| cwd.join(".dev-data")).join("Hato"),
        };
        std::fs::create_dir_all(&data_dir)?;
        let data_dir = data_dir.canonicalize()?;
        let initial_root = Some(root.map(|r| if r.is_absolute() { r } else { cwd.join(r) }).unwrap_or_else(|| cwd.clone()));
        let initial_root = match initial_root {
            Some(r) => Some(r.canonicalize()?),
            None => None,
        };
        let cfg = Config { repo_root, data_dir, initial_root, safe_mode, dev_watch, headless, headless_script };
        for d in ["sqlite", "artifacts", "logs", "ssh", "shared"] {
            std::fs::create_dir_all(cfg.data_dir.join(d))?;
        }
        Ok(cfg)
    }

    pub fn modules_dir(&self) -> PathBuf { self.repo_root.join("modules") }
    pub fn seed_dir(&self) -> PathBuf { self.repo_root.join("build").join("modules") }
    pub fn artifacts_dir(&self) -> PathBuf { self.data_dir.join("artifacts") }
    pub fn registry_file(&self) -> PathBuf { self.data_dir.join("module-registry.json") }
    pub fn approved_grants_file(&self) -> PathBuf { self.data_dir.join("approved-grants.json") }
    pub fn logs_dir(&self) -> PathBuf { self.data_dir.join("logs") }
    pub fn sqlite_dir(&self) -> PathBuf { self.data_dir.join("sqlite") }
    pub fn ssh_dir(&self) -> PathBuf { self.data_dir.join("ssh") }
    pub fn shared_dir(&self) -> PathBuf { self.data_dir.join("shared") }

    /// esbuild native binary used by the `build` scope grant (developer tool, not needed at runtime).
    pub fn build_tool(&self) -> Option<PathBuf> {
        let candidates = [
            self.repo_root.join("node_modules/@esbuild").join(esbuild_platform_pkg()).join("bin/esbuild"),
            self.repo_root.join("node_modules/esbuild/bin/esbuild"),
        ];
        candidates.into_iter().find(|p| p.is_file()).and_then(|p| p.canonicalize().ok())
    }

    /// Directories module scope grants may never cover (kernel-owned state).
    pub fn protected_dirs(&self) -> Vec<PathBuf> {
        vec![
            self.sqlite_dir(),
            self.artifacts_dir(),
            self.logs_dir(),
            self.ssh_dir(),
            self.registry_file(),
            self.approved_grants_file(),
        ]
    }
}

fn esbuild_platform_pkg() -> String {
    let os = match std::env::consts::OS { "macos" => "darwin", o => o };
    let arch = match std::env::consts::ARCH { "aarch64" => "arm64", "x86_64" => "x64", a => a };
    format!("{os}-{arch}")
}

fn find_repo_root(start: &Path) -> Option<PathBuf> {
    let mut cur = Some(start);
    while let Some(p) = cur {
        if p.join("modules").is_dir() && p.join("grants").is_dir() {
            return Some(p.to_path_buf());
        }
        cur = p.parent();
    }
    None
}
