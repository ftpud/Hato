// M6 + M8 (local): real ACP adapter, workspace-bound cwd, streaming, config options, swaps during a
// live session, internal MCP discovery, agent-driven patch/build/activate with native approvals,
// and Autopilot not bypassing kernel approvals.
// Env: HATO_T_REPO_A, HATO_T_ACP (absolute adapter path), HATO_T_ACP_PROVIDER (codex|claude)
export default {
  id: "__driver", moduleApiVersion: 1,
  async activate(ctx) {
    try { await run(ctx); } catch (e) { check("uncaught", false, e.message + "\n" + e.stack); }
    await finish();
  },
};

async function turn(ctx, convId, text, ms = 240000) {
  const before = (await ctx.modules.call("ai-sessions", "view", { workspaceId: (await T("test.state", { key: "workspace.selected" })).id })).active.messages.length;
  await ctx.modules.call("ai-sessions", "send", { conversationId: convId, text }, { timeoutMs: 600000 });
  await until(async () => { const s = await ctx.modules.call("acp", "state", { conversationId: convId }); return s && s.status === "ready"; }, ms, 500);
  await sleep(1500);
  const v = await ctx.modules.call("ai-sessions", "view", { workspaceId: (await T("test.state", { key: "workspace.selected" })).id });
  return v.active.messages.slice(before);
}

async function run(ctx) {
  const A = await T("test.env", { name: "HATO_T_REPO_A" });
  const exe = await T("test.env", { name: "HATO_T_ACP" });
  const provider = (await T("test.env", { name: "HATO_T_ACP_PROVIDER" })) || "codex";
  const call = (m, f, a, o) => ctx.modules.call(m, f, a || {}, o);
  await T("test.approvals", { policy: "allow" });
  await call("acp", "saveProfile", { profile: { id: "test-agent", machineId: "local", provider, name: `Test ${provider}`, executable: exe, args: [], envRefs: {}, enabled: true } });
  const tree = await until(async () => { const t = await call("projects", "tree"); return t.length ? t : null; });
  const pa = tree.find((p) => p.rootPath === A);
  const wsA = `project:${pa.id}:root`;
  await call("workspace", "select", { workspaceId: wsA });

  // ---- M6: local ACP
  const conv = await call("ai-sessions", "create", { workspaceId: wsA, profileId: "test-agent" });
  const st = await call("ai-sessions", "connect", { conversationId: conv.id }, { timeoutMs: 300000 });
  check("ACP session established locally", st.sessionId && st.machineId === "local" && st.status === "ready", { sessionId: st.sessionId, machineId: st.machineId, status: st.status, error: st.error, agent: st.agentInfo });
  check("agent cwd = workspace root (kernel-verified)", st.cwd === A, st.cwd);
  const lsof = await T("test.exec", { argv: ["lsof", "-a", "-p", String(st.pid), "-d", "cwd", "-Fn"], cwd: "/" });
  check("agent OS process cwd matches workspace root", lsof.stdout.includes("n" + A), lsof.stdout);
  check("negotiated config options advertised", Array.isArray(st.configOptions) && st.configOptions.some((o) => o.category === "model"), st.configOptions && st.configOptions.map((o) => o.id + ":" + o.category));
  check("internal MCP attached to session", st.mcp && /local loopback/.test(st.mcp.status), st.mcp);
  const aiTree = await until(async () => { const t = await T("test.render", { module: "ai" }); const m = find(t, (n) => n.key === "cfg-model"); return m && !m.disabled ? t : null; }, 10000) || await T("test.render", { module: "ai" });
  const model = find(aiTree, (n) => n.key === "cfg-model");
  check("AI panel shows advertised model selector", model && model.options.length > 0 && !model.disabled, model);
  const reasoning = find(aiTree, (n) => n.key === "cfg-reasoning");
  check("reasoning selector present (enabled iff advertised)", reasoning && (st.configOptions.some((o) => o.category === "thought_level") ? !reasoning.disabled : reasoning.disabled), reasoning);
  const modelOpt = st.configOptions.find((o) => o.category === "model");
  const alt = (modelOpt.options || []).find((o) => o.value !== modelOpt.currentValue && /haiku|mini/i.test(o.value + (o.name || ""))) || (modelOpt.options || []).find((o) => o.value !== modelOpt.currentValue) || modelOpt.options[0];
  const st2 = await call("ai-sessions", "setConfig", { conversationId: conv.id, configId: modelOpt.id, value: alt.value });
  check("model selection applied via session/set_config_option", st2.configOptions.find((o) => o.id === modelOpt.id).currentValue === alt.value, alt.value);

  const msgs = await turn(ctx, conv.id, "Reply with exactly the text HATO_PONG and nothing else. Do not use any tools.");
  const reply = msgs.filter((m) => m.role === "assistant").map((m) => m.text).join("");
  check("streamed real agent reply", /HATO_PONG/.test(reply), msgs.map((m) => m.role + ":" + m.text.slice(0, 120)));

  // ---- hot swaps while the session is idle: ai UI and acp service keep the agent process
  const B = await T("test.env", { name: "HATO_T_BUILD" });
  const aiSrc = await T("test.readFile", { path: B + "/ai.mjs" });
  const s1 = await T("test.stage", { id: "ai", code: aiSrc.replace('"AI / ACP"', '"AI / ACP (v2)"') });
  await T("test.activate", { id: "ai", stageId: s1.stageId });
  const acpSrc = await T("test.readFile", { path: B + "/acp.mjs" });
  const s2 = await T("test.stage", { id: "acp", code: acpSrc + "\n// v2\n" });
  const sw = await T("test.activate", { id: "acp", stageId: s2.stageId });
  check("acp service swapped while session idle", sw.ok, sw);
  const st3 = await call("acp", "state", { conversationId: conv.id });
  check("agent process + session preserved across ai/acp swaps", st3 && st3.pid === st.pid && st3.sessionId === st.sessionId && st3.status === "ready", st3 && { pid: st3.pid, status: st3.status });
  const msgs2 = await turn(ctx, conv.id, "Reply with exactly HATO_AGAIN and nothing else.");
  check("same session keeps working after swap", msgs2.some((m) => m.role === "assistant" && /HATO_AGAIN/.test(m.text)), msgs2.map((m) => m.role + ":" + m.text.slice(0, 80)));

  // acp swap during a busy turn is deferred
  await call("ai-sessions", "send", { conversationId: conv.id, text: "Count slowly from 1 to 40, one number per line." }, { timeoutMs: 60000 });
  await until(async () => (await call("acp", "state", { conversationId: conv.id })).status === "busy", 10000, 50);
  const s3 = await T("test.stage", { id: "acp", code: acpSrc + "\n// v3\n" });
  let deferred = null;
  try { await T("test.activate", { id: "acp", stageId: s3.stageId }); } catch (e) { deferred = e.message; }
  check("acp swap deferred while busy", deferred && /deferred/.test(deferred), deferred);
  await call("ai-sessions", "cancel", { conversationId: conv.id });
  const canc = await until(async () => (await call("acp", "state", { conversationId: conv.id })).status === "ready", 60000, 300);
  check("cancel ends the turn", !!canc);

  // ---- M8: agent discovers internal MCP and uses tools
  const msgs3 = await turn(ctx, conv.id, "Use the hato-internal MCP server: call its modules_list tool. Then answer with exactly one line of the form COUNT=<number of modules returned>.");
  const ans = msgs3.filter((m) => m.role === "assistant").map((m) => m.text).join("");
  const mcpStatus = await call("internal-mcp", "status");
  check("agent invoked internal MCP modules_list", mcpStatus.stats.toolCalls > 0 && /COUNT=16\b/.test(ans), { ans: ans.slice(-200), stats: mcpStatus.stats, tools: msgs3.filter((m) => m.role === "tool").map((m) => m.title) });

  // ---- M8: agent patches + builds + activates a UI module with native approvals
  await T("test.approvalLog", { clear: true });
  const msgs4 = await turn(ctx, conv.id, [
    "Using only the hato-internal MCP tools (no shell, no file edits):",
    "1) modules_read_source id=projects-panel path=src/index.ts",
    '2) modules_apply_patch id=projects-panel with edits=[{"path":"src/index.ts","oldText":"text: \\"PROJECTS\\", size: \\"sm\\"","newText":"text: \\"PROJECTS ★ AGENT\\", size: \\"sm\\""}]',
    "3) modules_build id=projects-panel  4) modules_activate id=projects-panel.",
    "Finish with DONE or with the exact error.",
  ].join("\n"), 600000);
  const log = await T("test.approvalLog");
  const ops = log.map((l) => l.operation);
  check("native approvals requested for write, build(stage) and activate", ops.includes("modules.source.write") && ops.includes("modules.stage") && ops.includes("modules.activate"), { ops, msgs: msgs4.map((m) => m.role + ":" + (m.title || m.text).slice(0, 100)) });
  check("approval for write shows kernel-computed diff", log.some((l) => l.operation === "modules.source.write" && /\+.*PROJECTS ★ AGENT/.test(l.detail)), log.map((l) => l.detail.slice(0, 300)));
  const panel = await until(async () => { const p = await T("test.render", { module: "projects-panel" }); return texts(p).includes("PROJECTS ★ AGENT") ? p : null; }, 20000);
  check("agent-built UI module is live without kernel restart", !!panel);
  const rb = await call("module-dev", "rollback", { id: "projects-panel" });
  const after = await T("test.render", { module: "projects-panel" });
  check("rollback restores previous UI", rb.ok && texts(after).includes("PROJECTS"), rb);

  // ---- Autopilot does not bypass kernel approvals
  await call("ai-sessions", "setPolicy", { conversationId: conv.id, policy: "autopilot" });
  await T("test.approvals", { policy: "deny" });
  await T("test.approvalLog", { clear: true });
  const msgs5 = await turn(ctx, conv.id, 'Use hato-internal modules_apply_patch id=projects-panel edits=[{"path":"src/index.ts","oldText":"\\"+ Local\\"","newText":"\\"+ Local!\\""}]. Report the tool result verbatim.', 300000);
  const denyLog = await T("test.approvalLog");
  const src = await T("test.readFile", { path: (await T("test.env", { name: "HATO_T_REPO_ROOT" })) + "/modules/ui/projects-panel/src/index.ts" });
  check("autopilot: kernel still asks; denial prevents write", denyLog.some((l) => l.operation === "modules.source.write") && !src.includes('"+ Local!"'), { ops: denyLog.map((l) => l.operation), reply: msgs5.filter((m) => m.role !== "thought").map((m) => m.text.slice(0, 160)) });
  let outside = null;
  try { await call("module-dev", "applyPatch", { id: "projects-panel", path: "../../../kernel/src/main.rs", content: "x" }); } catch (e) { outside = e.message; }
  check("patch outside module source root denied", outside && /outside module/.test(outside), outside);

  // ---- workspace switch: new conversation in task worktree, separate cwd
  const task = await call("git-tasks", "create", { projectId: pa.id, name: "agent task" }, { timeoutMs: 60000 });
  const convT = await call("ai-sessions", "create", { workspaceId: `task:${task.id}`, profileId: "test-agent" });
  const stT = await call("ai-sessions", "connect", { conversationId: convT.id }, { timeoutMs: 300000 });
  check("task conversation runs in task worktree", stT.cwd === task.worktreePath && stT.pid !== st.pid, { cwd: stT.cwd });
  const rootView = await call("ai-sessions", "view", { workspaceId: wsA });
  check("root workspace keeps its own conversation history", rootView.activeId === conv.id && rootView.active.messages.some((m) => /HATO_PONG/.test(m.text)));
  await call("ai-sessions", "disconnect", { conversationId: convT.id });
  await call("ai-sessions", "disconnect", { conversationId: conv.id });
  const persisted = await call("persistence", "messages.list", { conversationId: conv.id });
  check("transcript persisted to SQLite", persisted.length >= 6, persisted.length);
}
