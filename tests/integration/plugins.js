// Plugin lifecycle (headless, real kernel): user plugins from the data dir, approvals for calls,
// contracts (provides/requires), cascade disable, panel contributions reaching the layout, and the
// window root chosen through the shell.root contract.
// Run: tests/integration/run-integration.sh tests/integration/plugins.js /tmp/hato-plugins-test
export default {
  id: "__driver", moduleApiVersion: 1,
  async activate(ctx) {
    try {
      const env = ctx.host.env.info();
      const pluginsDir = env.dataDir + "/plugins";
      const write = async (id, manifest, code) => {
        const dir = `${pluginsDir}/${id}`;
        await T("test.exec", { argv: ["mkdir", "-p", `${dir}/dist`] });
        await T("test.exec", { argv: ["sh", "-c", `cat > "${dir}/manifest.json" <<'JSON'\n${JSON.stringify(manifest, null, 2)}\nJSON\ncat > "${dir}/dist/${id}.mjs" <<'JS'\n${code}\nJS`] });
      };
      const list = async () => (await ctx.host.plugins.list());
      const info = async (id) => (await list()).plugins.find((p) => p.id === id);
      const layoutTree = () => T("test.render", { module: "workspace-layout" });
      const hasSlot = (tree, module) => !!find(tree, (n) => n.type === "slot" && n.module === module);

      // ---- built-ins
      let l = await list();
      check("built-ins listed and enabled", l.plugins.filter((p) => p.source === "builtin").every((p) => p.enabled), l.plugins.map((p) => [p.id, p.enabled]));
      check("root is workspace-layout via shell.root", l.root === "workspace-layout", l.root);
      check("providers(shell.root)", JSON.stringify(await ctx.host.plugins.providers("shell.root")) === '["workspace-layout"]');
      let tree = await layoutTree();
      check("layout mounts contributed sidebars", hasSlot(tree, "sidebar") && hasSlot(tree, "left-sidebar"));
      check("layout mounts contributed overlay", hasSlot(tree, "settings"));
      check("layout mounts contributed panels", hasSlot(tree, "explorer") && hasSlot(tree, "ai") && hasSlot(tree, "terminal-panel"));

      // ---- disabling a built-in panel removes it everywhere
      await T("test.pluginDisable", { id: "explorer" });
      check("explorer disabled", (await info("explorer")).enabled === false);
      tree = await until(async () => { const t = await layoutTree(); return hasSlot(t, "explorer") ? null : t; }, 8000);
      check("explorer panel leaves the layout", tree && !hasSlot(tree, "explorer"));
      const right = await T("test.render", { module: "sidebar" });
      check("files button leaves the right sidebar", !find(right, (n) => n.key === "files"), right.children.map((c) => c.key));
      let err = null;
      try { await ctx.modules.call("explorer", "render"); } catch (e) { err = e; }
      check("calls to a disabled plugin fail clearly", err && /disabled/.test(String(err.message)), err && err.message);
      await T("test.pluginEnable", { id: "explorer" });
      tree = await until(async () => { const t = await layoutTree(); return hasSlot(t, "explorer") ? t : null; }, 8000);
      check("explorer re-enabled and back in the layout", !!tree);

      // ---- user plugins: a data service and a panel that needs it (contract) and calls it
      await write("demo-data", { schemaVersion: 2, id: "demo-data", kind: "service", entry: "dist/demo-data.mjs", moduleApiVersion: 1, provides: ["demo.data"], description: "test data" },
        `export default { id: "demo-data", moduleApiVersion: 1, methods: { greet: () => "hello from demo-data" } };`);
      await write("demo-panel", { schemaVersion: 2, id: "demo-panel", kind: "ui", entry: "dist/demo-panel.mjs", moduleApiVersion: 1, requires: ["demo.data"], calls: ["demo-data"],
        contributes: { panels: [{ id: "demo", title: "Demo", dock: { column: 9 }, activity: { side: "right", order: 1, iconSvg: "<svg xmlns='http://www.w3.org/2000/svg'/>" } }] } },
        `let text = "…"; export default { id: "demo-panel", moduleApiVersion: 1,
          async activate(ctx) { text = await ctx.modules.call("demo-data", "greet"); },
          render() { return { type: "label", key: "t", text }; } };`);
      const scan = await T("test.pluginRescan");
      check("rescan finds user plugins", JSON.stringify(scan.added.sort()) === '["demo-data","demo-panel"]', scan);
      check("user plugins start disabled", !(await info("demo-data")).enabled && !(await info("demo-panel")).enabled);
      check("pending approval lists the call", JSON.stringify((await info("demo-panel")).pendingApprovals) === '["call:demo-data"]', (await info("demo-panel")).pendingApprovals);

      await T("test.approvals", { policy: "deny" });
      err = null;
      try { await T("test.pluginEnable", { id: "demo-panel" }); } catch (e) { err = e; }
      check("denied approval keeps plugin disabled", err && !(await info("demo-panel")).enabled, err && err.message);

      await T("test.approvals", { policy: "allow" });
      await T("test.approvalLog", { clear: true });
      await T("test.pluginEnable", { id: "demo-data" });
      const en = await T("test.pluginEnable", { id: "demo-panel" });
      check("approved user panel is active", en.active === true, en);
      const log = await T("test.approvalLog");
      check("only demo-panel needed approval", log.length === 1 && log[0].operation === "plugins.enable" && /call:demo-data/.test(log[0].detail), log);
      const panel = await T("test.render", { module: "demo-panel" });
      check("user panel called the user service", panel.text === "hello from demo-data", panel);
      tree = await until(async () => { const t = await layoutTree(); return hasSlot(t, "demo-panel") ? t : null; }, 8000);
      check("contributed panel appears in the layout", !!tree);
      const right2 = await until(async () => { const r = await T("test.render", { module: "sidebar" }); return find(r, (n) => n.key === "demo") ? r : null; }, 8000);
      check("contributed activity button appears first", right2 && right2.children[0].key === "demo", right2 && right2.children.map((c) => c.key));

      // ---- contracts protect dependents
      err = null;
      try { await T("test.pluginDisable", { id: "demo-data" }); } catch (e) { err = e; }
      check("disabling a required provider is refused", err && err.code === "EDEPENDENTS" && /demo-panel/.test(err.message), err && [err.code, err.message]);
      const dis = await T("test.pluginDisable", { id: "demo-data", cascade: true });
      check("cascade disables dependents", JSON.stringify(dis.disabled.sort()) === '["demo-data","demo-panel"]', dis);
      tree = await until(async () => { const t = await layoutTree(); return hasSlot(t, "demo-panel") ? null : t; }, 8000);
      check("cascaded panel leaves the layout", !!tree);

      // ---- window root through the shell.root contract
      await write("my-shell", { schemaVersion: 2, id: "my-shell", kind: "ui", entry: "dist/my-shell.mjs", moduleApiVersion: 1, provides: ["shell.root"] },
        `export default { id: "my-shell", moduleApiVersion: 1, render() { return { type: "label", key: "t", text: "my shell" }; } };`);
      await T("test.pluginRescan");
      check("disabled root candidate is ignored", (await list()).root === "workspace-layout");
      await T("test.pluginEnable", { id: "my-shell" });
      check("enabled user root wins", (await list()).root === "my-shell");
      await T("test.pluginRoot", { id: "workspace-layout" });
      l = await list();
      check("explicit root override", l.root === "workspace-layout" && l.rootOverride === "workspace-layout", l);
      err = null;
      try { await T("test.pluginRoot", { id: "ai" }); } catch (e) { err = e; }
      check("root must provide shell.root", !!err);
      await T("test.pluginRoot", { id: null });
      await T("test.pluginDisable", { id: "my-shell" });
      check("root falls back to built-in", (await list()).root === "workspace-layout");

      // ---- uninstall removes the folder and approvals
      await T("test.pluginUninstall", { id: "demo-panel" });
      l = await list();
      check("uninstalled plugin is gone", !l.plugins.some((p) => p.id === "demo-panel"));
      const gone = await T("test.exec", { argv: ["test", "-e", `${pluginsDir}/demo-panel`] });
      check("uninstall removed the folder", gone.code !== 0);
      err = null;
      try { await T("test.pluginUninstall", { id: "ai" }); } catch (e) { err = e; }
      check("built-ins cannot be uninstalled", !!err);
    } catch (e) {
      check("no exception", false, String(e && e.stack || e));
    }
    await finish();
  },
};
