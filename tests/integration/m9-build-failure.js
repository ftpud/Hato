// Invalid TS source through the real module-dev/esbuild path: diagnostics returned, active version kept.
export default {
  id: "__driver", moduleApiVersion: 1,
  async activate(ctx) {
    try {
      await T("test.approvals", { policy: "allow" });
      const call = (m, f, a, o) => ctx.modules.call(m, f, a || {}, o);
      const before = (await T("test.modules")).find((m) => m.id === "explorer").active.label;
      const p = (await T("test.env", { name: "HATO_T_REPO_ROOT" })) + "/modules/ui/explorer/src/index.ts";
      await T("test.exec", { argv: ["sh", "-c", 'printf "\\nconst broken: = ;\\n" >> "$0"', p], cwd: "/" });
      const r = await call("module-dev", "buildAndActivate", { id: "explorer" }, { timeoutMs: 120000 });
      check("TS syntax error -> build fails with compiler diagnostics", r.ok === false && /ERROR|error/.test(r.diagnostics || "") && /index\.ts/.test(r.diagnostics || ""), r);
      const after = (await T("test.modules")).find((m) => m.id === "explorer").active.label;
      check("active module unchanged after failed build", before === after, { before, after });
      check("previous UI still renders", !!(await T("test.render", { module: "explorer" })));
      let denied = null;
      try { await call("module-dev", "applyPatch", { id: "explorer", patch: "--- a/../../../grants/first-party.json\n+++ b/../../../grants/first-party.json\n@@ -1,1 +1,1 @@\n-{\n+{ \"hacked\": true,\n" }); } catch (e) { denied = e.message; }
      check("diff targeting files outside module source denied", denied && /outside module/.test(denied), denied);
    } catch (e) { check("uncaught", false, e.message + "\n" + e.stack); }
    await finish();
  },
};
