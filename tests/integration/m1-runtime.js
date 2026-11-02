// M1 runtime smoke test: QuickJS worker, RPC routing, SQLite primitive, persistence migrations.
const results = [];
function check(name, cond, info) { results.push({ name, ok: !!cond, info: info === undefined ? null : info }); }
export default {
  id: "__driver", moduleApiVersion: 1,
  async activate(ctx) {
    try {
      const v = await ctx.modules.call("persistence", "schemaVersion");
      check("persistence migrated", v >= 2, v);
      await ctx.modules.call("persistence", "settings.set", { key: "t", value: { a: 1 } });
      const s = await ctx.modules.call("persistence", "settings.get", { key: "t" });
      check("settings roundtrip", s && s.a === 1, s);
      let denied = null;
      try { await ctx.host.db.openNamespace("persistence"); } catch (e) { denied = e.code; }
      check("driver cannot open persistence db", denied === "EPERM", denied);
      let noMethod = null;
      try { await ctx.modules.call("persistence", "nope"); } catch (e) { noMethod = e.code; }
      check("unknown method error", noMethod === "ENOMETHOD", noMethod);
      let unavailable = null;
      try { await ctx.modules.call("projects", "tree", {}, { timeoutMs: 1000 }); } catch (e) { unavailable = e.code + ":" + e.message; }
      check("unbuilt module unavailable", unavailable !== null, unavailable);
      const t0 = Date.now(); await new Promise((r) => setTimeout(r, 50)); check("timers", Date.now() - t0 >= 45, Date.now() - t0);
    } catch (e) { check("exception", false, e.message + "\n" + e.stack); }
    const ok = results.every((r) => r.ok);
    await callTest(ctx, "test.done", { ok, report: results });
  },
};
// The prelude exposes only the SDK; test ops go through the same async host bridge.
function callTest(ctx, op, args) { return globalThis.__testOp(op, args); }
