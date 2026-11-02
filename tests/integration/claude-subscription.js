// Claude subscription switch: default ON strips API-key vars from the agent env; OFF passes them through.
export default {
  id: "__driver", moduleApiVersion: 1,
  async activate(ctx) {
    try {
      const call = (m, f, a, o) => ctx.modules.call(m, f, a || {}, o);
      const exe = await T("test.env", { name: "HATO_T_ACP" });
      check("test runs with ANTHROPIC_API_KEY present in the kernel env", !!(await T("test.env", { name: "ANTHROPIC_API_KEY" })));
      await call("acp", "saveProfile", { profile: { id: "claude", machineId: "*", provider: "claude", name: "Claude (claude-agent-acp)", executable: exe, args: [], envRefs: {}, enabled: true } });
      const t = await until(async () => { const x = await call("projects", "tree"); return x.length ? x : null; });
      const ws = `project:${t[0].id}:root`;
      await call("workspace", "select", { workspaceId: ws });
      check("subscription mode enabled by default", (await call("acp", "authSettings")).claudeSubscription === true);
      const conv = await call("ai-sessions", "create", { workspaceId: ws, profileId: "claude" });
      const ui = await until(async () => { const u = await T("test.render", { module: "ai" }); return find(u, (n) => n.key === "claude-sub") ? u : null; });
      check("AI panel shows the switch (checked)", ui && find(ui, (n) => n.key === "claude-sub").checked === true);
      const turn = async (text) => {
        await call("ai-sessions", "send", { conversationId: conv.id, text }, { timeoutMs: 300000 });
        await until(async () => (await call("acp", "state", { conversationId: conv.id })).status === "ready", 180000, 300);
        await sleep(800);
        return (await call("ai-sessions", "view", { workspaceId: ws })).active.messages;
      };
      let msgs = await turn("Reply with exactly HATO_SUB and nothing else.");
      const st = await call("acp", "state", { conversationId: conv.id });
      const envDump = await T("test.exec", { argv: ["ps", "eww", "-o", "command=", "-p", String(st.pid)], cwd: "/" });
      check("agent env has no ANTHROPIC_API_KEY", envDump.stdout.length > 0 && !/ANTHROPIC_API_KEY=/.test(envDump.stdout), envDump.stdout.slice(0, 200));
      check("prompt answered via subscription", msgs.some((m) => m.role === "assistant" && /HATO_SUB/.test(m.text)), msgs.slice(-3));
      // Switch OFF -> reconnect -> key passed through (API account has no credit => billing error proves it)
      await ev("ai", "toggleClaudeSub", { value: false });
      check("switch persisted off", (await call("acp", "authSettings")).claudeSubscription === false);
      await call("ai-sessions", "disconnect", { conversationId: conv.id });
      msgs = await turn("Reply with exactly HATO_API and nothing else.");
      const st2 = await call("acp", "state", { conversationId: conv.id });
      const env2 = await T("test.exec", { argv: ["ps", "eww", "-o", "command=", "-p", String(st2.pid)], cwd: "/" });
      check("switch off: agent env includes ANTHROPIC_API_KEY", /ANTHROPIC_API_KEY=/.test(env2.stdout));
      check("switch off: API account used (billing error surfaced)", msgs.some((m) => /credit balance|billing/i.test(m.text)), msgs.slice(-2));
      await ev("ai", "toggleClaudeSub", { value: true });
      await call("ai-sessions", "disconnect", { conversationId: conv.id });
    } catch (e) { check("uncaught", false, e.message + "\n" + e.stack); }
    await finish();
  },
};
