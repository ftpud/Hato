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

#[test]
fn marketplace_sources_are_not_builtin_plugins_but_installed_artifacts_are_discovered() {
    let temp = tempfile::tempdir().unwrap();
    let host = temp.path().join("host");
    let modules = host.join("Hato-plugins/modules/services");
    let data = temp.path().join("data");
    let source = modules.join("optional-probe");
    std::fs::create_dir_all(&source).unwrap();
    let manifest = json!({"schemaVersion":2,"id":"optional-probe","kind":"service","entry":"src/index.ts","moduleApiVersion":1,"distribution":"marketplace"});
    std::fs::write(source.join("manifest.json"), manifest.to_string()).unwrap();
    let baseline = modules.join("baseline");
    std::fs::create_dir_all(&baseline).unwrap();
    std::fs::write(baseline.join("manifest.json"), json!({"schemaVersion":2,"id":"baseline","kind":"service","entry":"src/index.ts","moduleApiVersion":1}).to_string()).unwrap();
    let args = vec!["hato".into(), "--repo-root".into(), host.display().to_string(), "--data-dir".into(), data.display().to_string(), "--headless".into()];
    let kernel = Kernel::new(Config::from_args(&args).unwrap(), UiBridge::disconnected()).unwrap();
    let before = kernel.discover_all();
    assert_eq!(before.len(), 1);
    assert_eq!(before[0].manifest.id, "baseline");
    let installed = data.join("plugins/optional-probe");
    std::fs::create_dir_all(&installed).unwrap();
    std::fs::write(installed.join("manifest.json"), manifest.to_string()).unwrap();
    let after = kernel.discover_all();
    let plugin = after.iter().find(|d| d.manifest.id == "optional-probe").unwrap();
    assert_eq!(plugin.source, hato_kernel::plugins::Source::User);
    assert!(!kernel.plugins.is_enabled("optional-probe", plugin.source));
    assert!(kernel.grants.install_grant("optional-probe").is_none());
    kernel.shutdown();
}

#[test]
fn manifest_only_seed_changes_refresh_cached_call_permissions() {
    let temp = tempfile::tempdir().unwrap();
    let host = temp.path().join("host");
    let plugins = host.join("Hato-plugins");
    let modules = plugins.join("modules/services");
    let builds = plugins.join("build/modules");
    let data = temp.path().join("data");
    std::fs::create_dir_all(&builds).unwrap();
    for id in ["probe", "storage"] { std::fs::create_dir_all(modules.join(id)).unwrap(); }
    let manifest = |id: &str, calls: Vec<&str>| json!({"schemaVersion":2,"id":id,"kind":"service","entry":"src/index.ts","moduleApiVersion":1,"calls":calls});
    std::fs::write(modules.join("storage/manifest.json"), manifest("storage", vec![]).to_string()).unwrap();
    std::fs::write(builds.join("storage.mjs"), "export default {id:'storage',moduleApiVersion:1,methods:{ping:()=>true}};").unwrap();
    let probe_manifest = modules.join("probe/manifest.json");
    std::fs::write(&probe_manifest, manifest("probe", vec![]).to_string()).unwrap();
    let code = "export default {id:'probe',moduleApiVersion:1,async activate(ctx){await ctx.modules.call('storage','ping',{})},methods:{health:()=>true}};";
    std::fs::write(builds.join("probe.mjs"), code).unwrap();
    let args = vec!["hato".into(), "--repo-root".into(), host.display().to_string(), "--data-dir".into(), data.display().to_string(), "--headless".into()];
    let config = || Config::from_args(&args).unwrap();
    let kernel = Kernel::new(config(), UiBridge::disconnected()).unwrap();
    kernel.boot();
    assert!(kernel.router.active("probe").is_none());
    assert!(kernel.router.last_error("probe").unwrap().contains("not allowed"));
    kernel.shutdown();
    drop(kernel);

    // Reproduce an old registry whose artifact cache identifies the seed only by its JS hash.
    let registry_path = data.join("module-registry.json");
    let mut registry: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&registry_path).unwrap()).unwrap();
    registry["modules"]["probe"].as_object_mut().unwrap().remove("seedManifestHash");
    std::fs::write(&registry_path, registry.to_string()).unwrap();
    std::fs::write(&probe_manifest, manifest("probe", vec!["storage"]).to_string()).unwrap();
    let kernel = Kernel::new(config(), UiBridge::disconnected()).unwrap();
    // Simulate the normal trusted approval for the updated manifest.
    kernel.grants.record_approval("probe", &["call:storage".into()]);
    kernel.boot();
    let active = kernel.router.active("probe").expect("approved calls from the updated manifest must take effect");
    assert_eq!(active.version, 2);
    assert!(active.caps.may_call("storage"));
    let store = kernel.artifacts.lock();
    assert!(store.load("probe", 1).unwrap().1.calls.is_empty(), "the old artifact stays immutable for rollback");
    assert_eq!(store.load("probe", 2).unwrap().0, code, "only the manifest changed");
    drop(store);
    kernel.shutdown();
    drop(kernel);

    let kernel = Kernel::new(config(), UiBridge::disconnected()).unwrap();
    kernel.boot();
    assert_eq!(kernel.router.active("probe").unwrap().version, 2, "unchanged manifests must not create versions on every restart");
    kernel.shutdown();
    drop(kernel);

    // Permission removal must also take effect, even while its old approval remains recorded.
    std::fs::write(&probe_manifest, manifest("probe", vec![]).to_string()).unwrap();
    let kernel = Kernel::new(config(), UiBridge::disconnected()).unwrap();
    kernel.boot();
    assert!(kernel.router.active("probe").is_none());
    assert!(kernel.router.last_error("probe").unwrap().contains("not allowed"));
    assert_eq!(kernel.artifacts.lock().get("probe").unwrap().active, Some(1), "reuse only the matching manifest, including when narrowing permissions");
    kernel.shutdown();
}

#[test]
fn legacy_seed_manifest_migration_preserves_an_active_custom_build() {
    let temp = tempfile::tempdir().unwrap();
    let host = temp.path().join("host");
    let source = host.join("Hato-plugins/modules/services/probe");
    let builds = host.join("Hato-plugins/build/modules");
    let data = temp.path().join("data");
    std::fs::create_dir_all(&source).unwrap();
    std::fs::create_dir_all(&builds).unwrap();
    std::fs::write(source.join("manifest.json"), json!({"schemaVersion":2,"id":"probe","kind":"service","entry":"src/index.ts","moduleApiVersion":1}).to_string()).unwrap();
    let code = |v| format!("export default {{id:'probe',moduleApiVersion:1,methods:{{read:()=>{v}}}}};");
    std::fs::write(builds.join("probe.mjs"), code(1)).unwrap();
    let args = vec!["hato".into(), "--repo-root".into(), host.display().to_string(), "--data-dir".into(), data.display().to_string(), "--headless".into()];
    let config = || Config::from_args(&args).unwrap();
    let kernel = Kernel::new(config(), UiBridge::disconnected()).unwrap();
    kernel.boot();
    let manifest = kernel.router.active("probe").unwrap().manifest.clone();
    {
        let mut store = kernel.artifacts.lock();
        let custom = store.put("probe", &code(2), &manifest, "build").unwrap();
        let record = store.record("probe");
        record.active = Some(custom.version);
        record.seed_manifest_hash = None;
        store.save();
    }
    kernel.shutdown();
    drop(kernel);
    let kernel = Kernel::new(config(), UiBridge::disconnected()).unwrap();
    kernel.boot();
    assert_eq!(kernel.router.active("probe").unwrap().version, 2);
    assert_eq!(kernel.artifacts.lock().get("probe").unwrap().versions.len(), 2);
    kernel.shutdown();
}

#[test]
fn single_module_metadata_matches_discovery_and_stays_fresh() {
    let temp = tempfile::tempdir().unwrap();
    let host = temp.path().join("host");
    let services = host.join("Hato-plugins/modules/services");
    let data = temp.path().join("data");
    let write = |dir: &std::path::Path, id: &str, kind: &str, distribution: &str, description: &str| {
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(dir.join("manifest.json"), json!({"schemaVersion":2,"id":id,"kind":kind,
            "entry":"src/index.ts","moduleApiVersion":1,"distribution":distribution,
            "description":description}).to_string()).unwrap();
    };
    let builtin = services.join("probe");
    let installed = data.join("plugins/probe");
    write(&builtin, "probe", "service", "builtin", "initial");
    let args = vec!["hato".into(),"--repo-root".into(),host.display().to_string(),
        "--data-dir".into(),data.display().to_string(),"--headless".into()];
    let kernel = Kernel::new(Config::from_args(&args).unwrap(), UiBridge::disconnected()).unwrap();
    let matches = |kernel: &Kernel, id: &str| {
        let expected = kernel.discover().into_iter().find(|(m, _)| m.id == id);
        let actual = kernel.source_manifest(id).ok();
        assert_eq!(actual.as_ref().map(|(_, dir)| dir), expected.as_ref().map(|(_, dir)| dir));
        assert_eq!(actual.map(|(m, _)| serde_json::to_value(m).unwrap()),
            expected.map(|(m, _)| serde_json::to_value(m).unwrap()));
    };
    matches(&kernel, "probe");
    write(&builtin, "probe", "service", "builtin", "edited");
    assert_eq!(serde_json::to_value(kernel.source_manifest("probe").unwrap().0).unwrap()["description"], "edited");
    write(&installed, "probe", "service", "marketplace", "installed");
    matches(&kernel, "probe");
    assert_eq!(kernel.source_manifest("probe").unwrap().1, installed);
    let mut dev_cfg = Config::from_args(&args).unwrap();
    dev_cfg.dev_watch = true;
    let dev = Kernel::new(dev_cfg, UiBridge::disconnected()).unwrap();
    matches(&dev, "probe");
    assert_eq!(dev.source_manifest("probe").unwrap().1, builtin);
    write(&services.join("optional"), "optional", "service", "marketplace", "optional");
    matches(&kernel, "optional");
    write(&services.join("wrong-kind"), "wrong-kind", "ui", "builtin", "invalid location");
    matches(&kernel, "wrong-kind");
    assert!(kernel.source_manifest("../probe").is_err());
    assert!(kernel.source_manifest("missing").is_err());
    kernel.router.ensure_slot("probe");
    kernel.router.ensure_slot("other");
    let all = kernel.modules_json();
    assert_eq!(kernel.module_json("probe"), all.as_array().unwrap().iter().find(|m| m["id"] == "probe").unwrap().clone());
    assert_eq!(kernel.module_json("missing"), serde_json::Value::Null);
    kernel.shutdown();
    dev.shutdown();
}
