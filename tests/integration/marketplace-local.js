// Actual Settings install flow against the published catalogue, with unpublished local packages.
// Uses an isolated data directory, prepared local artifacts, and public GitHub catalogue reads.
export default {
  id: "__driver", moduleApiVersion: 1,
  async activate(ctx) {
    try {
      await T("test.approvals", { policy: "allow" });
      // Use a selected workspace, as in the normal app, before enabling package dependencies.
      const root = (await T("test.exec", { argv: ["mktemp", "-d", "/tmp/hato-marketplace-project-XXXXXX"] })).stdout.trim();
      await T("test.exec", { argv: ["git", "init", "-b", "main"], cwd: root });
      const project = await ctx.modules.call("projects", "addLocal", { path: root });
      await ctx.modules.call("workspace", "select", { workspaceId: `project:${project.id}:root` });
      await T("test.pluginEnable", { id: "terminal-panel" });
      const original = (await ctx.host.plugins.list()).plugins;
      check("language packages start uninstalled", !original.some(p => p.id.startsWith("language-")));
      await ctx.modules.call("settings", "open", { category: "plugins" });
      await ev("settings", "plugin:marketTab", { value: "marketplace" });
      const rows = async () => find(await T("test.render", { module: "settings" }), node => node.type === "tree" && node.key === "plugin-tree")?.rows || [];
      check("unpublished language packages are offered", (await rows()).some(row => row.key === "package:language-sap"));
      await ev("settings", "plugin:marketInstall", { value: "language-sap" });
      const completed = await until(async () => {
        const tree = await T("test.render", { module: "settings" });
        return find(tree, node => node.key === "plugin-status" && (node.level === "error" || node.level === "success"));
      }, 90000);
      check("Install succeeds through the real Settings flow", completed?.level === "success", completed?.text);
      const after = (await ctx.host.plugins.list()).plugins;
      check("local artifact becomes an enabled user plugin", after.some(p => p.id === "language-sap" && p.source === "user" && p.enabled && p.active));
      const remaining = await rows();
      check("other unpublished marketplace entries remain visible", ["language-java", "language-typescript", "language-service"].every(id => remaining.some(row => row.key === "package:" + id)));
      check("system plugins are preserved", original.every(p => after.some(next => next.id === p.id && next.source === p.source && next.active === p.active)));
      const approvals = await T("test.approvalLog");
      check("local install uses normal native approval", approvals.some(a => a.operation === "plugins.install" && a.detail.includes("SAP")));
    } catch (error) { check("uncaught", false, String(error) + "\n" + error.stack); }
    await finish();
  },
};
