// Real Settings dependency actions + real process installer, isolated by HATO_LANGUAGE_TOOLS_HOME.
export default {
  id: "__driver", moduleApiVersion: 1,
  async activate(ctx) {
    const call = (id, method, args) => ctx.modules.call(id, method, args || {}, { timeoutMs: 180000 });
    try {
      await T("test.approvals", { policy: "allow" });
      const toolsHome = await T("test.env", { name: "HATO_LANGUAGE_TOOLS_HOME" });
      if (!toolsHome || !toolsHome.startsWith("/tmp/")) throw new Error("Set HATO_LANGUAGE_TOOLS_HOME to an isolated directory under /tmp");
      const repoRoot = ctx.host.env.info().repoRoot;
      const catalogue = JSON.parse(await T("test.readFile", { path: `${repoRoot}/Hato-plugins/catalogue.json` }));
      const ids = ["language-service", "language-java"];
      await T("test.pluginInstallMany", { paths: ids.map(id => `${repoRoot}/Hato-plugins/packages/${id}/${catalogue.packages.find(p => p.id === id).version}/${id}`) });
      for (const id of ids) await T("test.pluginEnable", { id });
      const root = (await T("test.exec", { argv: ["mktemp", "-d", "/tmp/hato-dependency-project-XXXXXX"] })).stdout.trim();
      await T("test.exec", { argv: ["git", "init", "-b", "main"], cwd: root });
      const project = await call("projects", "addLocal", { path: root });
      const workspaceId = `project:${project.id}:root`;
      await call("workspace", "select", { workspaceId });
      const fields = async () => (await T("test.state", { key: "language-service.settings" }))?.sections.find(s => s.key === "jdtls")?.fields;
      await until(async () => (await fields())?.some(f => f.key === "installDependencies"));
      await call("settings", "open", { module: "language-service", section: "jdtls" });
      const settingButton = async key => find(await T("test.render", { module: "settings" }), node => node.action === "settingAction" && node.key === JSON.stringify(["language-service", "jdtls", key]));
      const checkButton = await until(async () => {
        const button = await settingButton("checkDependencies");
        return button && !button.disabled ? button : null;
      });
      check("language settings render a Check dependencies button", !!checkButton && !checkButton.disabled);
      await ev("settings", "settingAction", { key: checkButton.key });
      const checked = await until(async () => (await fields())?.find(f => f.key === "checkDependencies" && !f.disabled && /Ready|Missing dependencies/.test(f.description)), 60000);
      check("Check dependencies reports actual target runtimes", !!checked && checked.description.includes("Python 3"), checked?.description);
      const button = await settingButton("installDependencies");
      check("missing dependencies can be installed from Settings", !!button && !button.disabled);
      await ev("settings", "settingAction", { key: button.key });
      const installed = await until(async () => (await fields())?.find(f => f.key === "checkDependencies" && f.description.startsWith("Ready")), 180000);
      check("Install downloads and verifies JDTLS then reports Ready", !!installed, (await T("test.state", { key: "language-service.settings" }))?.error);
      const configured = await call("persistence", "scoped.resolve", { key: "language-server.jdtls.executable", scopes: [`workspace:${workspaceId}`] });
      check("installer persists a target-side executable for this workspace", configured?.value === toolsHome + "/bin/jdtls", configured);
      const again = await call("language-service", "dependencies.check", { workspaceId, serverId: "jdtls" });
      check("the configured managed launcher passes subsequent checks", again.ready && again.directory === toolsHome, again);
      // Markdown terminal IDs contain several colons, including one in this filename.
      const before = find(await T("test.render", { module: "terminal-panel" }), n => n.type === "terminal")?.pty;
      const run = await call("terminal-panel", "runCode", { workspaceId, path: "docs/setup:local.md", block: 0, code: "sleep 60", language: "sh" });
      check("Markdown shell block gets its own terminal", !!find(await T("test.render", { module: "terminal-panel" }), n => n.action === `close:${run.key}`));
      await ev("terminal-panel", `close:${run.key}`);
      check("Close removes a running Markdown terminal tab", !find(await T("test.render", { module: "terminal-panel" }), n => n.action === `close:${run.key}`));
      const activity = await call("terminals", "activity", { workspaceId, keys: [run.key] });
      check("Close releases the Markdown terminal resource", activity[0]?.cursor === null, activity);
      const main = find(await T("test.render", { module: "terminal-panel" }), n => n.type === "terminal")?.pty;
      check("closing the Markdown terminal preserves the original shell", !before || main === before);
    } catch (error) { check("uncaught", false, String(error) + "\n" + error.stack); }
    await finish();
  },
};
