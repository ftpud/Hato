//! Runtime paths and opt-in development reload against an independent plugin checkout.
use hato_kernel::{bridge::UiBridge, config::Config, kernel::Kernel};
use serde_json::json;
use std::time::{Duration, Instant};

#[test]
fn development_checkout_reloads_and_preserves_snapshot() {
    let temp = tempfile::tempdir().unwrap();
    let host = temp.path().join("host");
    let plugins = host.join("Hato-plugins");
    let source = plugins.join("modules/services/probe");
    let builds = plugins.join("build/modules");
    std::fs::create_dir_all(&source).unwrap();
    std::fs::create_dir_all(&builds).unwrap();
    std::fs::create_dir_all(host.join("grants")).unwrap();
    std::fs::write(source.join("manifest.json"), r#"{"schemaVersion":2,"id":"probe","kind":"service","entry":"src/index.ts","moduleApiVersion":1}"#).unwrap();
    let code = |version| format!("let count=0;export default {{id:'probe',moduleApiVersion:1,activate(ctx,prev){{count=prev?.count||0}},snapshot:()=>({{count}}),methods:{{bump:()=>++count,read:()=>({{version:{version},count}})}}}};");
    std::fs::write(builds.join("probe.mjs"), code(1)).unwrap();
    let args = vec!["hato".into(),"--repo-root".into(),host.display().to_string(),"--data-dir".into(),temp.path().join("data").display().to_string(),"--headless".into(),"--dev-watch".into()];
    let cfg = Config::from_args(&args).unwrap();
    assert_eq!(cfg.modules_dir(), source.parent().unwrap().parent().unwrap().canonicalize().unwrap());
    assert_eq!(cfg.seed_dir(), builds.canonicalize().unwrap());
    let kernel = Kernel::new(cfg, UiBridge::disconnected()).unwrap();
    kernel.boot();
    let invoke = |method| kernel.router.invoke_blocking("probe", json!({"kind":"call","method":method,"args":{},"caller":"test"}), Duration::from_secs(3)).unwrap();
    assert_eq!(invoke("bump"), json!(1));
    kernel.start_dev_watch();
    std::thread::sleep(Duration::from_millis(850));
    std::fs::write(builds.join("probe.mjs"), code(2)).unwrap();
    let start = Instant::now();
    let updated = loop {
        let state = invoke("read");
        if state["version"] == 2 { break state; }
        assert!(start.elapsed() < Duration::from_secs(8), "changed checkout bundle was not activated");
        std::thread::sleep(Duration::from_millis(50));
    };
    assert_eq!(updated["count"], 1);
    kernel.shutdown();
}
