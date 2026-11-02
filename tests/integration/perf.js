// Measures in-app module rebuild (esbuild via build grant) + stage + hot-swap latency, and RPC round trips.
export default {
  id: "__driver", moduleApiVersion: 1,
  async activate(ctx) {
    await T("test.approvals", { policy: "allow" });
    const call = (m, f, a, o) => ctx.modules.call(m, f, a || {}, o);
    const out = {};
    for (const id of ["projects-panel", "projects", "ai"]) {
      const t0 = Date.now();
      const r = await call("module-dev", "buildAndActivate", { id }, { timeoutMs: 120000 });
      out[id] = { ok: r.ok, buildMs: r.build && r.build.buildMs, swapMs: r.swapMs, totalMs: Date.now() - t0, label: r.label, error: r.error };
    }
    const n = 200; let t0 = Date.now();
    for (let i = 0; i < n; i++) await call("persistence", "settings.get", { key: "x" });
    out.rpcRoundTripMs = (Date.now() - t0) / n;
    t0 = Date.now();
    for (let i = 0; i < 50; i++) await T("test.render", { module: "projects-panel" });
    out.renderMs = (Date.now() - t0) / 50;
    check("all rebuilds ok", Object.values(out).filter((v) => typeof v === "object").every((v) => v.ok), out);
    console.log("PERF " + JSON.stringify(out));
    results.push({ name: "perf", ok: true, info: out });
    await finish();
  },
};
