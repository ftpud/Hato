// Modules panel: a swap vetoed by canSwap is deferred and offers Force, which needs native approval.
const busyModule = (mark) => `export default { id: "claude-usage", moduleApiVersion: 1,
  canSwap: () => ({ ok: false, reason: "fixture is busy" }),
  render: () => ({ type: "label", key: "mark", text: "${mark}" }),
};`;
const mark = async () => find(await T("test.render", { module: "claude-usage" }), (n) => n.key === "mark")?.text;
const modal = async () => T("test.render", { module: "workspace-layout" });
const row = async () => find(await modal(), (n) => n.key === "deferred:claude-usage");

export default {
  id: "__driver", moduleApiVersion: 1,
  async activate(ctx) {
    try {
      const call = (f, a) => ctx.modules.call("module-dev", f, a, { timeoutMs: 120000 });
      await T("test.approvals", { policy: "allow" });
      const v1 = await T("test.stage", { id: "claude-usage", code: busyModule("v1") });
      await T("test.activate", { id: "claude-usage", stageId: v1.stageId });
      check("fixture active", (await mark()) === "v1");

      // Kernel: the veto holds without force, and the stage survives for a retry.
      const v2 = await T("test.stage", { id: "claude-usage", code: busyModule("v2") });
      let refused = null;
      try { await T("test.activate", { id: "claude-usage", stageId: v2.stageId }); } catch (e) { refused = e; }
      check("swap deferred while busy", refused && refused.code === "EDEFERRED" && /fixture is busy/.test(refused.message), refused && { code: refused.code, message: refused.message });
      check("previous version still active", (await mark()) === "v1");
      await T("test.activate", { id: "claude-usage", stageId: v2.stageId, force: true });
      check("force replaces the busy module from the same stage", (await mark()) === "v2");

      // Panel: a busy rebuild shows Force; denying approval keeps both the module and the offer.
      await ev("workspace-layout", "toggleModules");
      check("no Force offered before a deferral", !(await row()));
      await ev("workspace-layout", "rebuild", { value: "claude-usage" });
      const offered = await until(row, 30000, 100);
      check("deferred build offers Force", offered && find(offered, (n) => n.key === "force")?.action === "forceSwap", offered);
      check("reason is shown", offered && /fixture is busy/.test(find(offered, (n) => n.key === "reason")?.text), offered);
      check("deferral is not reported as a failure", !find(await modal(), (n) => n.key === "diag"));

      await T("test.approvalLog", { clear: true });
      await T("test.approvals", { policy: "deny" });
      await ev("workspace-layout", "forceSwap", { value: "claude-usage" });
      check("denied force keeps the module", (await mark()) === "v2");
      check("denied force keeps the offer", !!(await row()));

      await T("test.approvals", { policy: "allow" });
      await ev("workspace-layout", "forceSwap", { value: "claude-usage" });
      const swapped = await until(async () => (await mark()) !== "v2" ? true : null, 10000, 100);
      check("approved force activates the rebuilt source", swapped, await mark());
      check("offer cleared after force", !(await row()));
      const log = await T("test.approvalLog", {});
      const titles = JSON.stringify(log);
      check("native approval names the force and warns", /Force activate claude-usage/.test(titles) && /FORCED/.test(titles), log);

      // Rollback path: restore the busy fixture, then a refused rollback can be forced too.
      const v3 = await T("test.stage", { id: "claude-usage", code: busyModule("v3") });
      await T("test.activate", { id: "claude-usage", stageId: v3.stageId });
      await ev("workspace-layout", "rollback", { value: "claude-usage" });
      const rb = await until(row, 30000, 100);
      check("deferred rollback offers Force", !!rb, rb);
      check("rollback left the busy module active", (await mark()) === "v3");
      await ev("workspace-layout", "forceSwap", { value: "claude-usage" });
      const rolled = await until(async () => (await mark()) !== "v3" ? true : null, 10000, 100);
      check("forced rollback leaves the busy version", rolled, await mark());

      // module-dev is what internal-mcp delegates to: without an explicit force, the veto holds.
      const v4 = await T("test.stage", { id: "claude-usage", code: busyModule("v4") });
      await T("test.activate", { id: "claude-usage", stageId: v4.stageId, force: true });
      const v5 = await T("test.stage", { id: "claude-usage", code: busyModule("v5") });
      let unforced = null;
      try { await call("activate", { id: "claude-usage", stageId: v5.stageId }); } catch (e) { unforced = e; }
      check("module-dev does not force unless asked", unforced && unforced.code === "EDEFERRED", unforced && unforced.code);
    } catch (e) { check("uncaught", false, e.message + "\n" + e.stack); }
    await finish();
  },
};
