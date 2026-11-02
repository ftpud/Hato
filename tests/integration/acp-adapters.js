// ACP adapter install/update window: version detection, approval gate, direct-call refusal.
export default {
  id: "__driver", moduleApiVersion: 1,
  async activate(ctx) {
    try {
      const call = (m, f, a, o) => ctx.modules.call(m, f, a || {}, o);
      const t = await until(async () => { const x = await call("projects", "tree"); return x.length ? x : null; });
      const ws = `project:${t[0].id}:root`;
      await call("workspace", "select", { workspaceId: ws });
      await until(async () => find(await T("test.render", { module: "ai" }), (n) => n.key === "adapters"));
      await ev("ai", "openAdapters");
      const ui = await T("test.render", { module: "ai" });
      const modal = find(ui, (n) => n.type === "modal" && n.key === "adapters-modal");
      check("adapter window lists claude + codex", modal && find(modal, (n) => n.key === "ad-claude") && find(modal, (n) => n.key === "ad-codex"), texts(modal));
      const list = await call("ai-sessions", "adapters", { workspaceId: ws }, { timeoutMs: 300000 });
      check("latest versions read from npm registry", list.every((a) => /^\d+\.\d+\.\d+/.test(a.latest || "")), list);
      console.log("ADAPTERS " + JSON.stringify(list.map((a) => [a.id, a.installed, a.latest, a.path])));
      await T("test.approvals", { policy: "deny" });
      await T("test.approvalLog", { clear: true });
      await ev("ai", "installAdapter", { value: "claude" });
      const log = await T("test.approvalLog");
      const after = find(await T("test.render", { module: "ai" }), (n) => n.key === "msg");
      check("install asks for confirmation showing the npm command", log.some((l) => /npm install -g @agentclientprotocol\/claude-agent-acp@latest/.test(l.detail)), log);
      check("cancel -> nothing installed, message shown", after && /cancelled/.test(after.text), after);
      let direct = null;
      try { await call("acp", "installAdapter", { workspaceId: ws, adapterId: "codex" }); } catch (e) { direct = e.message; }
      check("direct installAdapter call (bypassing approval) refused", direct && /through ai-sessions/.test(direct), direct);
      await ev("ai", "closeAdapters");
      check("window closes", !find(await T("test.render", { module: "ai" }), (n) => n.key === "adapters-modal"));
    } catch (e) { check("uncaught", false, e.message + "\n" + e.stack); }
    await finish();
  },
};
