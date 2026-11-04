// Run only against a disposable repository supplied in HATO_T_BRANCH_ROOT.
export default {
  id: "__driver", moduleApiVersion: 1,
  async activate(ctx) {
    try {
      const root = await T("test.env", { name: "HATO_T_BRANCH_ROOT" });
      if (!root || !root.includes("hato-branch-integration-")) throw new Error("Use a disposable branch integration fixture");
      await T("test.approvals", { policy: "allow" });
      const project = (await ctx.modules.call("projects", "tree")).find(p => p.rootPath === root);
      if (!project) throw new Error("The disposable project was not registered");
      await ctx.modules.call("workspace", "select", { workspaceId: `project:${project.id}:root` });
      const branch = async () => (await T("test.exec", { argv: ["git", "branch", "--show-current"], cwd: root })).stdout.trim();
      const render = () => T("test.render", { module: "git-branch" });
      const event = (action, value = null, inputs = {}) => T("test.event", { module: "git-branch", event: { action, value, inputs, key: "branch-menu" } });
      const ready = await until(async () => { const tree = await render(); return tree.tooltip?.includes("Current branch: main") ? tree : null; });
      check("branch widget boots with selected workspace HEAD", !!ready, ready?.tooltip);
      const layout = await T("test.render", { module: "workspace-layout" });
      check("top panel mounts the contributed Git widget", !!find(layout, n => n.type === "slot" && n.module === "git-branch"));
      await event("toggle", true); await event("filter", "FEATURE");
      let menu = await render();
      check("search filters branches ignoring case", find(menu, n => n.key === "branches")?.children?.length === 1);
      await event("checkout", "refs/heads/feature/welcome");
      check("checkout updates real HEAD", await branch() === "feature/welcome");
      menu = await render();
      check("checkout updates badge and dismisses menu", menu.tooltip.includes("Current branch: feature/welcome") && !menu.open);
      await event("toggle", true); await event("showCreate");
      await event("createBranch", null, { "new-branch-name": "feature/from-menu" });
      check("create-and-checkout operates through scoped Git service", await branch() === "feature/from-menu");
      const changes = await until(async () => { const tree = await T("test.render", { module: "git-panel" }); return find(tree, n => n.key === "changes") ? tree : null; });
      const rows = find(changes, n => n.key === "changes");
      check("Git changes uses two-line rows with sufficient spacing", rows?.rowHeight === 52 && rows.rowGap === 3);
      const explorerEvent = (action, value = null) => T("test.event", { module: "explorer", event: { action, value, inputs: {}, key: "file-filter" } });
      await explorerEvent("toggleContent"); await explorerEvent("filter", "needle"); await explorerEvent("submitFilter");
      const explorer = await T("test.render", { module: "explorer" });
      const matches = find(explorer, n => n.key === "files")?.rows || [];
      check("content filtering keeps parent folders and matching files without source-line children", matches.length === 2 && matches[0].key === "src" && matches[0].expandable && matches[1].key === "src/needle.txt" && !matches[1].expandable, matches.map(r => ({ key: r.key, label: r.label })));
    } catch (e) { check("uncaught", false, e.message + "\n" + e.stack); }
    await finish();
  },
};
