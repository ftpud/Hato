// File tree and search using only an isolated local fixture workspace.
export default {
  id: "__driver", moduleApiVersion: 1,
  async activate(ctx) {
    try {
      const root = await T("test.env", { name: "HATO_T_TREE_ROOT" });
      const project = await until(async () => (await ctx.modules.call("projects", "tree")).find(p => p.rootPath === root));
      await ctx.modules.call("workspace", "select", { workspaceId: `project:${project.id}:root` });
      const render = () => T("test.render", { module: "explorer" });
      let tree = await until(async () => find(await render(), n => n.type === "tree" && n.rows.some(r => r.key === "src")));
      check("file tree lists folders before files with typed icons", tree.rows[0].expandable && tree.rows.some(r => r.key === "README.md" && r.icon === "text"));
      await ev("explorer", "expand", { rowKey: "src" });
      tree = await until(async () => find(await render(), n => n.type === "tree" && n.rows.some(r => r.key === "src/nested")));
      check("folder expansion lists children without leaving the tree", !!tree);
      await ev("explorer", "filter", { value: "main.rs" });
      tree = await until(async () => find(await render(), n => n.type === "tree" && n.rows.some(r => r.key === "src/nested/main.rs")));
      check("filter finds files inside unexpanded folders and preserves ancestors", ["src", "src/nested", "src/nested/main.rs"].every(path => tree.rows.some(r => r.key === path)));
      await ev("explorer", "open", { rowKey: "src/nested/main.rs" });
      const viewer = await until(async () => find(await T("test.render", { module: "viewer" }), n => n.type === "codeViewer" && n.document));
      const doc = await T("test.document", { handle: viewer.document });
      check("filtered file opens in source viewer", doc.language === "rust" && doc.head.includes("fn main"));
      await ev("explorer", "reveal");
      tree = find(await render(), n => n.type === "tree");
      check("reveal clears the filter and expands selected file ancestors", tree.rows.some(r => r.key === "src/nested/main.rs" && r.selected) && find(await render(), n => n.key === "file-filter").value === "");
      await ev("explorer", "collapseAll");
      tree = find(await render(), n => n.type === "tree");
      check("collapse all keeps root files visible", !tree.rows.some(r => r.key === "src/nested") && tree.rows.some(r => r.key === "README.md"));
      await ev("explorer", "filter", { value: "nothing-matches-xyz" });
      check("unmatched filter has an empty state", !!(await until(async () => find(await render(), n => n.key === "empty" && n.text === "No matching files."))));
    } catch (e) { check("uncaught", false, e.message + "\n" + e.stack); }
    await finish();
  },
};
