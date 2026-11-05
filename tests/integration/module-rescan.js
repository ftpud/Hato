// Real QuickJS heap/CPU limits and native compiler output; catches large-bundle rescan regressions.
export default {
  id: '__driver', moduleApiVersion: 1,
  async activate(ctx) {
    const T = (op, args = {}) => globalThis.__testOp(op, args);
    await T('test.approvals', { policy: 'allow' });
    for (let pass = 0; pass < 2; pass++) {
      const result = await ctx.modules.call('module-dev', 'scanUpdates', { full: true }, { timeoutMs: 300000 });
      const layout = result.modules.find(m => m.id === 'workspace-layout');
      if (!layout?.builtHash || layout.status === 'build-error') throw new Error(`Large module rescan failed: ${layout?.diagnostics || 'missing result'}`);
      if (layout.builtHash !== layout.activeHash) throw new Error('Large module hash differs from the supplied seed');
      const logs = await T('test.logs', { id: 'module-dev' });
      if (logs.some(l => /out of memory|interrupted/i.test(l.msg))) throw new Error('Rescan exceeded QuickJS memory/CPU limits');
    }
    await T('test.done', { ok: true, report: { fullRescans: 2, largeModule: 'hash matches active seed', runtimeLimits: 'normal QuickJS limits' } });
  },
};
