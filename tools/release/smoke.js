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
    // Production has no editable sources or seed bundles inside the app package.
    // Its first-run installer supplies the persistent runtime from the pinned repository.
    await T("test.approvals", { policy: "allow" });
    const paths = (await ctx.modules.call("module-dev", "describe", {id:"workspace-layout"})).runtime;
    if (!paths.modulesRoot.startsWith(ctx.host.env.info().dataDir + '/runtime/'))
      throw new Error('Release did not boot from the persistent plugin runtime');
    // A new JavaScript plugin must install and load without Node or npm.
    const id = "hato-release-smoke";
    const source = `${ctx.host.env.info().dataDir}/smoke-source/${id}`;
    const manifest = JSON.stringify({ schemaVersion: 2, id, kind: "service", entry: "index.mjs", moduleApiVersion: 1 });
    const code = 'export default { id: "hato-release-smoke", moduleApiVersion: 1, methods: { health: () => ({ ok: true }) } };';
    await T("test.writeFile", { path: `${source}/manifest.json`, text: manifest });
    await T("test.writeFile", { path: `${source}/index.mjs`, text: code });
    await T("test.pluginInstall", { path: source });
    await T("test.pluginEnable", { id });
    const health = await ctx.modules.call(id, "health", {});
    if (!health?.ok) throw new Error("Installed JavaScript plugin did not respond");
    await T("test.pluginUninstall", { id });
    await T("test.done", { ok: true, report: { runtime: paths.modulesRoot, javascriptPlugin: "installed, enabled, called and removed" } });
  },
};
