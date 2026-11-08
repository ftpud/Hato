// Embeds the application icon in Windows GUI builds: GPUI loads icon resource 1 for its windows, and
// Explorer and the taskbar read the same resource. Regenerate the file with tools/windows/build-icon.py.
use std::{env, fs, path::PathBuf, process::Command};

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed=assets/hato.ico");
    let cfg = |name: &str| env::var(name).unwrap_or_default();
    if cfg("CARGO_CFG_TARGET_OS") != "windows" || env::var_os("CARGO_FEATURE_GUI").is_none() {
        return;
    }
    if cfg("CARGO_CFG_TARGET_ENV") != "gnu" {
        println!("cargo:warning=the application icon is only embedded for the windows-gnu target");
        return;
    }
    let out_dir = PathBuf::from(cfg("OUT_DIR"));
    let (rc, object) = (out_dir.join("hato-icon.rc"), out_dir.join("hato-icon.o"));
    let icon = format!("{}/assets/hato.ico", cfg("CARGO_MANIFEST_DIR")).replace('\\', "/");
    fs::write(&rc, format!("1 ICON \"{icon}\"\n")).expect("write icon resource script");
    // Cross toolchains prefix the tool name; a native MinGW install may not.
    let prefixed = format!("{}-w64-mingw32-windres", cfg("CARGO_CFG_TARGET_ARCH"));
    let status = [prefixed.as_str(), "windres"].iter().find_map(|tool| {
        Command::new(tool).arg("-O").arg("coff").arg("-i").arg(&rc).arg("-o").arg(&object).status().ok()
    });
    assert!(status.is_some_and(|s| s.success()), "windres failed to compile the application icon");
    // A resource object has no symbols, so only a direct link argument keeps it in the executable.
    println!("cargo:rustc-link-arg-bins={}", object.display());
}
