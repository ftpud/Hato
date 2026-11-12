//! Kernel configuration: paths and command-line flags. No application semantics.
use crate::util::canonical_string;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug)]
pub struct Config {
    /// Native host root containing the SDK and pinned initial plugin lock.
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
    /// Development-only: render a panel to a PNG without showing a window (feature `snapshot`).
    pub snapshot: Option<SnapshotSpec>,
}

/// Options for `--snapshot`. Pure data; the renderer lives in `ui::snapshot`.
#[derive(Clone, Debug)]
pub struct SnapshotSpec {
    pub out: PathBuf,
    /// UI module whose tree fills the window; `None` renders the normal root layout.
    pub module: Option<String>,
    /// Render this JSON node tree instead of a module (design mock-ups, no module needed).
    pub tree: Option<PathBuf>,
    /// Driver script run after boot and before the frame is captured (selects a project, seeds state…).
    pub setup: Option<PathBuf>,
    pub width: f32,
    pub height: f32,
    /// Extra settle time after the module published its tree.
    pub delay_ms: u64,
    /// Maximum time to wait for the module's first tree.
    pub timeout_ms: u64,
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
        let mut snap = SnapshotSpec { out: PathBuf::new(), module: None, tree: None, setup: None, width: 1000.0, height: 700.0, delay_ms: 800, timeout_ms: 20_000 };
        let mut want_snap = false;
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
                "--snapshot" => {
                    want_snap = true;
                    let v = next()?;
                    snap.out = std::env::current_dir()?.join(v);
                }
                "--snapshot-module" => snap.module = Some(next()?),
                "--snapshot-setup" => snap.setup = Some(std::env::current_dir()?.join(next()?)),
                "--snapshot-tree" => snap.tree = Some(std::env::current_dir()?.join(next()?)),
                "--snapshot-size" => {
                    let v = next()?;
                    let (w, h) = v.split_once('x').ok_or_else(|| anyhow::anyhow!("--snapshot-size expects WIDTHxHEIGHT"))?;
                    snap.width = w.parse()?;
                    snap.height = h.parse()?;
                }
                "--snapshot-delay" => snap.delay_ms = next()?.parse()?,
                "--snapshot-timeout" => snap.timeout_ms = next()?.parse()?,
                "--help" | "-h" => {
                    println!("hato [--root PATH] [--data-dir PATH] [--repo-root PATH] [--safe-mode] [--dev-watch] [--headless] [--headless-script FILE]\n     dev builds (--features snapshot): --snapshot OUT.png [--snapshot-module ID | --snapshot-tree FILE.json] [--snapshot-setup SCRIPT.js] [--snapshot-size WxH] [--snapshot-delay MS] [--snapshot-timeout MS]");
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
                .ok_or_else(|| anyhow::anyhow!("cannot locate repository host root containing plugins.lock.json or grants/; pass --repo-root"))?,
        };
        let repo_root = PathBuf::from(canonical_string(&repo_root)?);
        let data_dir = match data_dir {
            Some(p) => p,
            None => dirs::data_dir().unwrap_or_else(|| cwd.join(".dev-data")).join("Hato"),
        };
        std::fs::create_dir_all(&data_dir)?;
        let data_dir = PathBuf::from(canonical_string(&data_dir)?);
        let initial_root = Some(root.map(|r| if r.is_absolute() { r } else { cwd.join(r) }).unwrap_or_else(|| cwd.clone()));
        let initial_root = match initial_root {
            Some(r) => Some(PathBuf::from(canonical_string(&r)?)),
            None => None,
        };
        let cfg = Config { repo_root, data_dir, initial_root, safe_mode, dev_watch, headless, headless_script, snapshot: want_snap.then_some(snap) };
        for d in ["sqlite", "artifacts", "logs", "ssh", "shared", "plugins"] {
            std::fs::create_dir_all(cfg.data_dir.join(d))?;
        }
        Ok(cfg)
    }

    /// Editable checkout in development; persistent downloaded runtime in packaged launches.
    pub fn plugin_root(&self) -> PathBuf {
        let checkout = self.repo_root.join("Hato-plugins");
        if checkout.join("modules").is_dir() { checkout }
        else if self.repo_root.join("modules").is_dir() { self.repo_root.clone() }
        else { self.runtime_dir().join("plugins") }
    }
    pub fn runtime_dir(&self) -> PathBuf { under(&self.data_dir, "runtime") }
    pub fn modules_dir(&self) -> PathBuf { self.plugin_root().join("modules") }
    pub fn seed_dir(&self) -> PathBuf { self.plugin_root().join("build/modules") }
    pub fn artifacts_dir(&self) -> PathBuf { under(&self.data_dir, "artifacts") }
    pub fn registry_file(&self) -> PathBuf { under(&self.data_dir, "module-registry.json") }
    pub fn approved_grants_file(&self) -> PathBuf { under(&self.data_dir, "approved-grants.json") }
    pub fn logs_dir(&self) -> PathBuf { under(&self.data_dir, "logs") }
    pub fn sqlite_dir(&self) -> PathBuf { under(&self.data_dir, "sqlite") }
    pub fn ssh_dir(&self) -> PathBuf { under(&self.data_dir, "ssh") }
    pub fn shared_dir(&self) -> PathBuf { under(&self.data_dir, "shared") }
    /// User-installed plugins: `<data>/plugins/<id>/manifest.json` (+ prebuilt artifact).
    pub fn plugins_dir(&self) -> PathBuf { under(&self.data_dir, "plugins") }
    /// Kernel-owned plugin preferences (enabled state, root override).
    pub fn plugin_registry_file(&self) -> PathBuf { under(&self.data_dir, "plugins.json") }

    /// esbuild native binary used by the `build` scope grant (developer tool, not needed at runtime).
    pub fn build_tool(&self) -> Option<PathBuf> {
        let candidates = [
            under(&self.repo_root, &format!("node_modules/@esbuild/{}/{}", esbuild_platform_pkg(), if cfg!(windows) { "esbuild.exe" } else { "bin/esbuild" })),
            under(&self.repo_root, "node_modules/esbuild/bin/esbuild"),
        ];
        candidates.into_iter().find(|p| p.is_file()).and_then(|p| canonical_string(&p).ok()).map(PathBuf::from)
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
            self.plugins_dir(),
            self.runtime_dir(),
            self.plugin_registry_file(),
        ]
    }
}

/// `Path::join` would write `\\` on Windows, and scope checks compare these paths as strings in the
/// `/`-separated form of `util::canonical_string`.
fn under(base: &Path, rel: &str) -> PathBuf { PathBuf::from(format!("{}/{rel}", base.display())) }

fn esbuild_platform_pkg() -> String {
    let os = match std::env::consts::OS { "macos" => "darwin", "windows" => "win32", o => o };
    let arch = match std::env::consts::ARCH { "aarch64" => "arm64", "x86_64" => "x64", a => a };
    format!("{os}-{arch}")
}

fn find_repo_root(start: &Path) -> Option<PathBuf> {
    let mut cur = Some(start);
    while let Some(p) = cur {
        if p.join("grants").is_dir() || p.join("plugins.lock.json").is_file() {
            return Some(p.to_path_buf());
        }
        cur = p.parent();
    }
    None
}
