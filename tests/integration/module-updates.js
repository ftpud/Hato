// Modules menu: automatic detection of modules whose source changed since the active build.
export default {
  id: "__driver", moduleApiVersion: 1,
  async activate(ctx) {
    try {
      const call = (m, f, a, o) => ctx.modules.call(m, f, a || {}, o);
      const ROOT = await T("test.env", { name: "HATO_T_REPO_ROOT" });
      const first = await until(async () => { const u = await call("module-dev", "updates"); return u.modules.length >= 16 ? u : null; }, 30000, 300);
      check("initial scan: every module matches its source", first && first.available.length === 0 && first.errors.length === 0, first && first.modules.filter((m) => m.status !== "current").map((m) => [m.id, m.status, (m.diagnostics || "").slice(0, 200)]));
      const hdr0 = find(await T("test.render", { module: "workspace-layout" }), (n) => n.key === "mods");
      check("header shows plain Modules button", hdr0 && hdr0.text === "Modules", hdr0 && hdr0.text);
      // Edit explorer source -> detected automatically by the background poll
      await T("test.exec", { argv: ["python3", "-c", "from pathlib import Path; import sys; p=Path(sys.argv[1]); p.write_text(p.read_text().replace('placeholder: \"Filter files\"', 'placeholder: \"Filter files v2\"'))", ROOT + "/modules/ui/explorer/src/index.ts"], cwd: "/" });
      const det = await until(async () => { const u = await call("module-dev", "updates"); return u.available.includes("explorer") ? u : null; }, 15000, 300);
      check("source edit detected automatically (no click)", det && det.available.length === 1, det && det.available);
      const hdr1 = await until(async () => { const h = find(await T("test.render", { module: "workspace-layout" }), (n) => n.key === "mods"); return h && /1 update/.test(h.text) ? h : null; }, 5000);
      check("header button announces the update", !!hdr1, hdr1);
      // Broken source in another module -> build-error, not an update
      await T("test.exec", { argv: ["sh", "-c", 'printf "\\nconst x: = ;\\n" >> "$0"', ROOT + "/modules/ui/viewer/src/index.ts"], cwd: "/" });
      const bad = await until(async () => { const u = await call("module-dev", "updates"); return u.errors.includes("viewer") ? u : null; }, 15000, 300);
      check("broken source reported as build error", !!bad, bad && bad.errors);
      // Modules window: updates sorted first, with Update button
      await ev("workspace-layout", "toggleModules");
      const modal = await until(async () => { const m = find(await T("test.render", { module: "workspace-layout" }), (n) => n.key === "modules-modal"); return m && find(m, (n) => n.key === "upd-all") ? m : null; });
      const list = find(modal, (n) => n.key === "list");
      check("updated module listed first with an Update button", list.children[0].key === "m-explorer" && find(list.children[0], (n) => n.key === "b").text === "Update", list.children.slice(0, 3).map((r) => r.key));
      const sum = await until(async () => { const m = find(await T("test.render", { module: "workspace-layout" }), (n) => n.key === "upd-sum"); return m && /explorer/.test(m.text) ? m : null; }, 15000);
      check("summary bar names it", !!sum);
      // Activate all -> applied, then up to date
      await T("test.approvals", { policy: "allow" });
      await ev("workspace-layout", "activateAll");
      const ex = find(await T("test.render", { module: "explorer" }), (n) => n.key === "file-filter");
      check("Activate all updates applied the change live", ex && ex.placeholder === "Filter files v2", ex);
      const after = await call("module-dev", "updates");
      check("explorer now up to date; viewer still flagged as error, not activated", !after.available.includes("explorer") && after.errors.includes("viewer"), after);
    } catch (e) { check("uncaught", false, e.message + "\n" + e.stack); }
    await finish();
  },
};
