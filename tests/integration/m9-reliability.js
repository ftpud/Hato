// M9 reliability: run AFTER m2m4-local.js with the SAME data dir (restart recovery), against a
// disposable repo copy (HATO_T_REPO_ROOT) because it edits a manifest to attempt self-escalation.
export default {
  id: "__driver", moduleApiVersion: 1,
  async activate(ctx) {
    try { await run(ctx); } catch (e) { check("uncaught", false, e.message + "\n" + e.stack); }
    await finish();
  },
};

const PROBE = `
  probe: async (ctx) => {
    const r = {};
    const t = async (k, f) => { try { await f(); r[k] = "ok"; } catch (e) { r[k] = e.code || e.message; } };
    await t("fsGrant", () => ctx.host.capabilities.request({ kind: "fs", root: "/tmp" }));
    await t("modulesList", () => ctx.host.modules.list());
    await t("dbOther", () => ctx.host.db.openNamespace("persistence"));
    await t("stateForeign", async () => ctx.state.set("projects.hijack", 1));
    await t("emitForeign", async () => ctx.events.emit("projects.changed", {}));
    await t("forgedHandle", () => ctx.host.process.write("h_process_00000000000000000000000000000000", "x"));
    await t("callNotAllowed", () => ctx.modules.call("module-dev", "list"));
    return r;
  },
  hang: () => { while (true) {} },`;

async function run(ctx) {
  const call = (m, f, a, o) => ctx.modules.call(m, f, a || {}, o);
  const B = await T("test.env", { name: "HATO_T_BUILD" });
  const ROOT = await T("test.env", { name: "HATO_T_REPO_ROOT" });

  // ---- restart recovery (data dir from the previous run)
  const tree = await call("projects", "tree");
  check("projects/tasks persisted across restart", tree.length === 3 && tree.reduce((n, p) => n + p.tasks.length, 0) === 2, tree.map((p) => [p.name, p.tasks.length]));
  const sel = await until(() => T("test.state", { key: "workspace.selected" }));
  check("selected workspace restored", sel && /^project:.*:root$/.test(sel.id), sel && sel.id);
  check("per-workspace view state restored", sel && sel.view && sel.view.previewPath === "logo.bin", sel && sel.view);
  const ex = await until(async () => { const r = await T("test.render", { module: "explorer" }); return find(r, (n) => n.type === "fileList") ? r : null; });
  check("explorer renders restored workspace", !!ex);
  check("projects service from previous run's active version (registry persisted)", (await T("test.modules")).find((m) => m.id === "projects").active.version >= 2);

  // ---- broker denials (explorer variant exporting a probe method)
  const exSrc = await T("test.readFile", { path: B + "/explorer.mjs" });
  const probeSrc = exSrc.replace("async onEvent(ctx, ev) {", "methods: {" + PROBE + "\n  },\n  async onEvent(ctx, ev) {");
  check("probe variant built", probeSrc !== exSrc);
  let st = await T("test.stage", { id: "explorer", code: probeSrc });
  await T("test.activate", { id: "explorer", stageId: st.stageId });
  const p1 = await call("explorer", "probe");
  check("ungranted capabilities denied", p1.fsGrant === "EPERM" && p1.modulesList === "EPERM" && p1.dbOther === "EPERM", p1);
  check("foreign state namespace / event topic denied", p1.stateForeign === "EPERM" && p1.emitForeign === "EPERM", p1);
  check("forged handle rejected", p1.forgedHandle === "EBADF", p1);
  check("RPC outside install grant denied", p1.callNotAllowed === "EPERM", p1);

  // manifest self-escalation: edit the (static) manifest, restage — caps stay bounded
  const mfPath = ROOT + "/modules/ui/explorer/manifest.json";
  const mf = JSON.parse(await T("test.readFile", { path: mfPath }));
  mf.capabilities = ["fs.scope", "modules.read", "db:persistence"];
  await T("test.exec", { argv: ["sh", "-c", `cat > "$0" <<'X'\n${JSON.stringify(mf, null, 2)}\nX`, mfPath], cwd: "/" });
  st = await T("test.stage", { id: "explorer", code: probeSrc + "\n// escalated manifest\n" });
  await T("test.activate", { id: "explorer", stageId: st.stageId });
  const p2 = await call("explorer", "probe");
  const mods = await T("test.modules");
  check("manifest edit cannot widen capabilities", p2.fsGrant === "EPERM" && p2.modulesList === "EPERM" && p2.dbOther === "EPERM" && mods.find((m) => m.id === "explorer").active.capabilities.length === 0, { p2, caps: mods.find((m) => m.id === "explorer").active.capabilities });

  // ---- hung JS handler is interrupted; UI keeps rendering
  const t0 = Date.now();
  let hung = null;
  try { await call("explorer", "hang", {}, { timeoutMs: 20000 }); } catch (e) { hung = e.message; }
  check("hung handler interrupted by CPU deadline", hung && /interrupted/i.test(hung) && Date.now() - t0 < 15000, { hung, ms: Date.now() - t0 });
  const after = await T("test.render", { module: "explorer" });
  check("module still renders after interrupt", !!find(after, (n) => n.type === "fileList" || n.key === "none"));

  // ---- revoked grant (files variant)
  const fSrc = await T("test.readFile", { path: B + "/files.mjs" });
  const fProbe = fSrc.replace("methods: {", `methods: {
    revokeProbe: async (ctx, a) => { const g = await ctx.host.capabilities.request({ kind: "fs", root: a.root }); await ctx.host.fs.list(g.grant, "."); await ctx.host.capabilities.release(g.grant); try { await ctx.host.fs.list(g.grant, "."); return "still-works"; } catch (e) { return e.code; } },`);
  st = await T("test.stage", { id: "files", code: fProbe });
  await T("test.activate", { id: "files", stageId: st.stageId });
  check("released grant can no longer be used", (await call("files", "revokeProbe", { root: sel.rootAbsolutePath })) === "EBADF");

  // ---- repeated swaps: no duplicated listeners/timers, old generations retired
  for (let i = 0; i < 4; i++) {
    const s = await T("test.stage", { id: "projects-panel", code: (await T("test.readFile", { path: B + "/projects-panel.mjs" })) + `\n// swap ${i}\n` });
    await T("test.activate", { id: "projects-panel", stageId: s.stageId });
  }
  await sleep(6000);
  const pp = (await T("test.modules")).find((m) => m.id === "projects-panel");
  const live = pp.generations.filter((g) => g.status !== "retired" && g.status !== "failed");
  check("repeated swaps leave exactly one live generation", live.length === 1 && live[0].status === "active", pp.generations.map((g) => [g.generation, g.status, g.subscriptions]));
  check("retired generations hold no subscriptions", pp.generations.filter((g) => g.status === "retired").every((g) => g.subscriptions === 0));
  check("active generation has a bounded subscription set", live[0].subscriptions === 2, live[0].subscriptions);

  // ---- persistence service swap reopens the same DB through its stable handle
  const before = await call("persistence", "projects.list");
  const ps = await T("test.stage", { id: "persistence", code: (await T("test.readFile", { path: B + "/persistence.mjs" })) + "\n// v2\n" });
  await T("test.activate", { id: "persistence", stageId: ps.stageId });
  const afterP = await call("persistence", "projects.list");
  check("persistence swap: DB reopened, data intact", afterP.length === before.length && (await call("persistence", "schemaVersion")) === 2);
  const handles = await T("test.handles");
  check("single DB handle retained across generations", handles.filter((h) => h.kind === "db" && h.owner === "persistence").length === 1, handles.filter((h) => h.kind === "db"));
}
