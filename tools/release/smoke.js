export default {
  id: "__driver", moduleApiVersion: 1,
  async activate(ctx) {
    const T = (op, args = {}) => globalThis.__testOp(op, args);
    const modules = await T("test.modules");
    for (const id of ["persistence", "workspace", "module-dev"]) {
      if (!modules.some(m => m.id === id && m.active)) throw new Error(`Packaged module ${id} did not boot`);
    }
    const baseline = modules.find(m => m.id === "workspace-layout");
    if (!baseline?.seedVersion || !baseline.versions.some(v => v.version === baseline.seedVersion && v.sha256 === baseline.active.sha256))
      throw new Error("Packaged module baseline does not match the imported seed");
    // Isolated release smoke data only: exercise the bundled compiler and stage a
    // large module so process-output backpressure cannot ship as a build timeout.
    await T("test.approvals", { policy: "allow" });
    const built = await ctx.modules.call("module-dev", "build", { id: "workspace-layout" }, { timeoutMs: 150000 });
    if (!built.ok || !built.stageId) throw new Error(`Packaged self-configuration build failed: ${built.error || built.diagnostics || "no staged artifact"}`);
    // A new JavaScript plugin must install and load without Node or npm.
    const id = "hato-release-smoke";
    const source = `${ctx.host.env.info().dataDir}/smoke-source/${id}`;
    const manifest = JSON.stringify({ schemaVersion: 2, id, kind: "service", entry: "index.mjs", moduleApiVersion: 1 });
    const code = 'export default { id: "hato-release-smoke", moduleApiVersion: 1, methods: { health: () => ({ ok: true }) } };';
    const written = await T("test.exec", { argv: ["/bin/sh", "-c", 'mkdir -p "$1" && printf "%s" "$2" > "$1/manifest.json" && printf "%s" "$3" > "$1/index.mjs"', "hato-smoke", source, manifest, code] });
    if (written.code !== 0) throw new Error(`Cannot create smoke plugin: ${written.stderr}`);
    await T("test.pluginInstall", { path: source });
    await T("test.pluginEnable", { id });
    const health = await ctx.modules.call(id, "health", {});
    if (!health?.ok) throw new Error("Installed JavaScript plugin did not respond");
    await T("test.pluginUninstall", { id });
    await T("test.done", { ok: true, report: { moduleBuild: built.label, javascriptPlugin: "installed, enabled, called and removed" } });
  },
};
