// Isolated repository; real OS notifications, with no panel polling.
export default {
  id: "__driver", moduleApiVersion: 1,
  async activate(ctx) {
    const call = (m, f, a) => ctx.modules.call(m, f, a || {});
    let root;
    try {
      await T("test.approvals", { policy: "allow" });
      root = (await T("test.exec", { argv: ["mktemp", "-d", "/tmp/hato-watch-XXXXXX"] })).stdout.trim();
      const exec = argv => T("test.exec", { argv, cwd: root });
      await exec(["git", "init", "-b", "main"]);
      await exec(["git", "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "initial"]);
      await call("projects", "addLocal", { path: root });
      const p = (await call("projects", "tree")).find(p => p.rootPath === root || p.rootPath === "/private" + root);
      const workspaceId = `project:${p.id}:root`;
      await call("workspace", "select", { workspaceId });
      await ev("workspace-layout", "dock", { value: "git" });
      const render = m => T("test.render", { module: m });
      const has = async name => !!find(await render("explorer"), n => n.type === "tree" && n.rows.some(r => r.key === name));
      await until(async () => find(await render("explorer"), n => n.type === "tree"));
      await exec(["touch", "created.txt"]);
      check("new file appears automatically", await until(() => has("created.txt")));
      await exec(["mkdir", "nested"]);
      check("new directory appears automatically", await until(() => has("nested")));
      await ev("explorer", "expand", { rowKey: "nested" });
      await exec(["touch", "nested/child.txt"]);
      check("new file in expanded folder appears", await until(() => has("nested/child.txt")));
      await exec(["mv", "created.txt", "renamed.txt"]);
      check("renames appear automatically", await until(async () => await has("renamed.txt") && !await has("created.txt")));
      await exec(["rm", "renamed.txt"]);
      check("deleted file disappears automatically", await until(async () => !await has("renamed.txt")));
      await exec(["git", "add", "nested/child.txt"]);
      check("Git panel refreshes on file and index changes", await until(async () => find(await render("git-panel"), n => n.type === "tree" && n.rows.some(r => r.key === "nested/child.txt"))));
      await exec(["git", "symbolic-ref", "HEAD", "refs/heads/renamed-branch"]);
      check("Git panel updates branch from metadata notification", await until(async () => find(await render("git-panel"), n => n.key === "branch" && /renamed-branch/.test(n.text))));
      await ev("explorer", "filter", { value: "searched-new.txt" });
      await exec(["touch", "nested/searched-new.txt"]);
      check("active file search invalidates on notification", await until(() => has("nested/searched-new.txt")));
      // Its HEAD lives outside the tree; a root-only watch cannot detect this update.
      const linked = root + "-linked";
      await exec(["git", "worktree", "add", "--detach", linked, "main"]);
      await call("projects", "addLocal", { path: linked });
      const lp = (await call("projects", "tree")).find(p => p.rootPath === linked || p.rootPath === "/private" + linked);
      await call("workspace", "select", { workspaceId: `project:${lp.id}:root` });
      await until(async () => find(await render("git-panel"), n => n.key === "branch" && /detached/.test(n.text)));
      await T("test.exec", { argv: ["git", "symbolic-ref", "HEAD", "refs/heads/linked-updated"], cwd: linked });
      check("linked checkout metadata outside root refreshes Git", await until(async () => find(await render("git-panel"), n => n.key === "branch" && /linked-updated/.test(n.text))));
    } catch (e) { check("uncaught", false, String(e) + "\n" + e.stack); }
    // Fixtures intentionally remain under /tmp for inspection; no user files are touched.
    await finish();
  },
};
