// M2–M4 + hot-swap: local projects, tree, files/viewer, PTY, git tasks, UI/service swaps, failure safety.
// Env: HATO_T_REPO_A (git repo, --root), HATO_T_REPO_B (git repo), HATO_T_PLAIN (non-git dir)
export default {
  id: "__driver", moduleApiVersion: 1,
  async activate(ctx) {
    try { await run(ctx); } catch (e) { check("uncaught", false, e.message + "\n" + e.stack); }
    await finish();
  },
};

async function run(ctx) {
  const A = await T("test.env", { name: "HATO_T_REPO_A" });
  const B = await T("test.env", { name: "HATO_T_REPO_B" });
  const P = await T("test.env", { name: "HATO_T_PLAIN" });
  const call = (m, f, a, o) => ctx.modules.call(m, f, a || {}, o);

  // ---- M2: initial project from --root, add two more, tree model, persistence
  let tree = await until(async () => { const t = await call("projects", "tree"); return t.length >= 1 && t[0].isGit !== null ? t : null; });
  check("initial --root project registered", tree && tree.some((p) => p.rootPath === A), tree);
  await ev("projects-panel", "addLocalPath", { inputs: { "local-path": B } });
  await ev("projects-panel", "addLocalPath", { inputs: { "local-path": P } });
  tree = await until(async () => { const t = await call("projects", "tree"); return t.length === 3 && t.every((p) => p.isGit !== null) ? t : null; });
  check("three projects (2 git + 1 non-git)", tree && tree.filter((p) => p.isGit).length === 2 && tree.filter((p) => p.isGit === false).length === 1, tree);
  await ev("projects-panel", "addLocalPath", { inputs: { "local-path": B } });
  check("duplicate add is idempotent", (await call("projects", "tree")).length === 3);
  let denied = null;
  try { await call("projects", "addLocal", { path: "/" }); } catch (e) { denied = e.message; }
  check("filesystem root cannot be a project", denied && /cannot be granted/.test(denied), denied);

  const pa = tree.find((p) => p.rootPath === A);
  const wsA = `project:${pa.id}:root`;
  await ev("projects-panel", "selectWorkspace", { rowKey: wsA });
  const sel = await until(async () => { const s = await T("test.state", { key: "workspace.selected" }); return s && s.id === wsA ? s : null; });
  check("select workspace via tree row", sel && sel.rootAbsolutePath === A, sel);
  let panel = await T("test.render", { module: "projects-panel" });
  let treeNode = find(panel, (n) => n.type === "tree");
  check("tree row selected", treeNode.rows.find((r) => r.key === wsA).selected === true);
  check("New Git Task offered for git project", !!find(panel, (n) => n.key === "new-task"));

  // ---- M3: explorer/viewer
  await until(async () => find(await T("test.render", { module: "explorer" }), (n) => n.type === "tree" && n.rows.some((row) => row.key === "src")));
  let ex = await T("test.render", { module: "explorer" });
  let fl = find(ex, (n) => n.type === "tree");
  check("explorer tree lists root folders, including .git", fl && fl.rows.some((e) => e.key === "src" && e.expandable) && fl.rows.some((e) => e.key === ".git"), fl && fl.rows);
  await ev("explorer", "open", { rowKey: "src" });
  ex = await until(async () => { const r = await T("test.render", { module: "explorer" }); const f = find(r, (n) => n.type === "tree"); return f && f.rows.some((e) => e.key === "src/main.rs") ? r : null; });
  check("navigate into src/", !!ex);
  await ev("explorer", "open", { rowKey: "src/main.rs" });
  const vw = await until(async () => { const r = await T("test.render", { module: "viewer" }); const c = find(r, (n) => n.type === "codeViewer"); return c && c.document ? r : null; });
  const cv = vw && find(vw, (n) => n.type === "codeViewer");
  const doc = cv && (await T("test.document", { handle: cv.document }));
  check("viewer opens native rust document", doc && doc.language === "rust" && doc.head.includes("fn main"), doc);
  await ev("explorer", "collapseAll");
  await ev("explorer", "open", { rowKey: "logo.bin" });
  const bin = await until(async () => { const r = await T("test.render", { module: "viewer" }); return find(r, (n) => n.key === "bin") ? r : null; });
  check("binary file handled sensibly", !!bin);
  let esc = null;
  try { await call("files", "list", { workspaceId: wsA, relativeDir: "../.." }); } catch (e) { esc = e.message; }
  check("files: traversal outside root rejected", esc && /escapes/.test(esc), esc);
  esc = null;
  try { await call("files", "open", { workspaceId: wsA, relativePath: "escape-link/passwd" }); } catch (e) { esc = e.message; }
  check("files: symlink escape rejected by kernel", esc && /outside the granted root|symlink/.test(esc), esc);

  // ---- M3: PTY
  const tp = await until(async () => { const r = await T("test.render", { module: "terminal-panel" }); const t = find(r, (n) => n.type === "terminal"); return t && t.pty ? t.pty : null; }, 15000);
  check("terminal attached for workspace", !!tp);
  await T("test.ptyWrite", { handle: tp, text: "echo HATO_$((40+2)); pwd; printf '\\033[31mred\\033[0m\\n'\r" });
  const scr = await until(async () => { const i = await T("test.ptyScreen", { handle: tp }); return i.screen.includes("HATO_42") && i.screen.includes(A) ? i : null; }, 10000);
  check("real PTY runs commands in workspace root", !!scr, scr ? scr.screen.slice(-400) : (await T("test.ptyScreen", { handle: tp })).screen.slice(-600));
  await call("terminals", "attach", { workspaceId: wsA, key: "main" }).then((r) => check("terminal reattaches same handle", r.pty === tp && r.reattached, r));
  await T("test.ptyWrite", { handle: tp, text: "sleep 30 &\r" }); // a long-running job that must survive swaps

  // ---- M4: Git tasks (clean + dirty parent)
  await ev("projects-panel", "newTask");
  await ev("projects-panel", "createTask", { inputs: { "task-name": "Fix login bug" } });
  let t1 = await until(async () => { const t = await call("projects", "tree"); const p = t.find((x) => x.id === pa.id); return p.tasks.length === 1 ? p.tasks[0] : null; }, 20000);
  check("task 1 created", t1 && /^task\/fix-login-bug-[0-9a-f]{8}$/.test(t1.branch), t1);
  check("worktree outside checkout", t1 && !t1.worktreePath.startsWith(A + "/"), t1);
  await T("test.exec", { argv: ["sh", "-c", "echo dirty > dirty.txt"], cwd: A });
  const r2 = await call("git-tasks", "create", { projectId: pa.id, name: "Second task!" }, { timeoutMs: 60000 });
  check("dirty parent produces warning", r2.warning && /uncommitted/.test(r2.warning), r2);
  const wl = await T("test.exec", { argv: ["git", "worktree", "list", "--porcelain"], cwd: A });
  check("git worktree list confirms both", wl.stdout.includes(t1.worktreePath) && wl.stdout.includes(r2.worktreePath), wl.stdout);
  const sel2 = await T("test.state", { key: "workspace.selected" });
  check("new task becomes selected workspace", sel2 && sel2.id === `task:${r2.id}` && sel2.rootAbsolutePath === r2.worktreePath, sel2);
  const tp2 = await until(async () => { const r = await T("test.render", { module: "terminal-panel" }); const t = find(r, (n) => n.type === "terminal"); return t && t.pty && t.pty !== tp ? t.pty : null; }, 15000);
  await T("test.ptyWrite", { handle: tp2, text: "pwd; git branch --show-current\r" });
  const scr2 = await until(async () => { const i = await T("test.ptyScreen", { handle: tp2 }); const flat = i.screen.replace(/\n/g, ""); return flat.includes(r2.worktreePath) && flat.includes(r2.branch) ? i : null; }, 10000);
  check("task terminal cwd = worktree, on task branch", !!scr2, (await T("test.ptyScreen", { handle: tp2 })).screen.slice(-500));
  let ngErr = null;
  const pp = tree.find((p) => p.rootPath === P);
  try { await call("git-tasks", "create", { projectId: pp.id, name: "x" }); } catch (e) { ngErr = e.message; }
  check("non-git project rejects tasks", ngErr && /not a Git/.test(ngErr), ngErr);
  // per-workspace view state is independent
  await call("workspace", "select", { workspaceId: wsA });
  const vA = await call("workspace", "view.get", { workspaceId: wsA });
  check("root workspace view keeps previewPath", vA.previewPath === "logo.bin", vA);

  // ---- Hot swap: projects-panel UI (0002) without restart; PTY survives
  const ppSrc = await T("test.readFile", { path: (await T("test.env", { name: "HATO_T_BUILD" })) + "/projects-panel.mjs" });
  const v2 = ppSrc.replace('placeholder: "Filter projects"', 'placeholder: "Filter projects (v2)"');
  const st = await T("test.stage", { id: "projects-panel", code: v2 });
  const act = await T("test.activate", { id: "projects-panel", stageId: st.stageId });
  check("projects-panel swapped to new version", act.ok && act.version === st.version, act);
  panel = await T("test.render", { module: "projects-panel" });
  check("new UI visible", find(panel, n => n.key === "project-filter")?.placeholder === "Filter projects (v2)", texts(panel).slice(0, 5));
  check("selection survives swap", find(panel, (n) => n.type === "tree").rows.find((r) => r.key === wsA).selected);
  const tsrc = await T("test.readFile", { path: (await T("test.env", { name: "HATO_T_BUILD" })) + "/terminal-panel.mjs" });
  const ts = await T("test.stage", { id: "terminal-panel", code: tsrc.replace('"Restart shell"', '"Restart shell (v2)"') });
  await T("test.activate", { id: "terminal-panel", stageId: ts.stageId });
  const tsrc2 = await T("test.readFile", { path: (await T("test.env", { name: "HATO_T_BUILD" })) + "/terminals.mjs" });
  const ts2 = await T("test.stage", { id: "terminals", code: tsrc2 + "\n// v2\n" });
  await T("test.activate", { id: "terminals", stageId: ts2.stageId });
  await T("test.ptyWrite", { handle: tp, text: "jobs; echo STILL_$((1+1))\r" });
  const alive = await until(async () => { const i = await T("test.ptyScreen", { handle: tp }); return i.screen.includes("STILL_2") && /sleep 30/.test(i.screen) && !i.exit ? i : null; }, 10000);
  check("PTY + background job survive terminal-panel and terminals swaps", !!alive, (await T("test.ptyScreen", { handle: tp })).screen.slice(-500));
  const rt = await call("terminals", "attach", { workspaceId: wsA, key: "main" });
  check("swapped terminals service reattaches same PTY", rt.pty === tp, rt);

  // ---- Service swap: projects sort order (desc) keeps records
  const before = (await call("projects", "tree")).map((p) => p.name);
  const psrc = await T("test.readFile", { path: (await T("test.env", { name: "HATO_T_BUILD" })) + "/projects.mjs" });
  const desc = psrc.replace("a.name.toLowerCase().localeCompare(b.name.toLowerCase())", "b.name.toLowerCase().localeCompare(a.name.toLowerCase())");
  check("service patch applies", desc !== psrc);
  const ps = await T("test.stage", { id: "projects", code: desc });
  await T("test.activate", { id: "projects", stageId: ps.stageId });
  const after = (await call("projects", "tree")).map((p) => p.name);
  check("projects service swapped: order reversed, records retained", JSON.stringify(after) === JSON.stringify([...before].reverse()), { before, after });

  // ---- Failure safety
  let bad = null;
  try { await T("test.stage", { id: "projects-panel", code: "export default {{ syntax error" }); } catch (e) { bad = e.message; }
  check("invalid artifact fails staging", bad && /failed to evaluate|parse/.test(bad), bad);
  const throwing = ppSrc.replace("async activate(ctx, prev) {", "async activate(ctx, prev) { throw new Error('boom on activate');");
  const st3 = await T("test.stage", { id: "projects-panel", code: throwing });
  let actErr = null;
  try { await T("test.activate", { id: "projects-panel", stageId: st3.stageId }); } catch (e) { actErr = e.message; }
  check("activation failure keeps previous version", actErr && /remains active/.test(actErr), actErr);
  panel = await T("test.render", { module: "projects-panel" });
  check("previous UI still rendering after failed activation", find(panel, n => n.key === "project-filter")?.placeholder === "Filter projects (v2)");
  const rb = await T("test.rollback", { id: "projects-panel" });
  panel = await T("test.render", { module: "projects-panel" });
  check("rollback restores original UI", rb.ok && find(panel, n => n.key === "project-filter")?.placeholder === "Filter projects", rb);
  const mods = await T("test.modules");
  const ppm = mods.find((m) => m.id === "projects-panel");
  check("old generations retired (no stale listeners)", ppm.generations.filter((g) => g.status === "active").length === 1 && ppm.generations.filter((g) => g.status === "active")[0].subscriptions <= 2, ppm.generations);
  check("failed version recorded", ppm.versions.some((v) => v.status === "failed"), ppm.versions.map((v) => [v.version, v.status]));
}
