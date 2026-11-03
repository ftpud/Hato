// M5 + M7 + remote M8 against a real SSH server (sshd on 127.0.0.1:2222, key auth).
// Env: HATO_T_SSH_USER, HATO_T_SSH_KEY, HATO_T_REMOTE_REPO, HATO_T_SSHD_PIDFILE, HATO_T_SSHD_CONFIG, HATO_T_ACP
export default {
  id: "__driver", moduleApiVersion: 1,
  async activate(ctx) {
    try { await run(ctx); } catch (e) { check("uncaught", false, e.message + "\n" + e.stack); }
    await finish();
  },
};

async function ancestry(pid) {
  const chain = [];
  let p = String(pid);
  for (let i = 0; i < 12 && p && p !== "0" && p !== "1"; i++) {
    const r = await T("test.exec", { argv: ["ps", "-o", "ppid=,comm=", "-p", p], cwd: "/" });
    const m = /^\s*(\d+)\s+(.*)$/.exec(r.stdout.trim());
    if (!m) break;
    chain.push(m[2].trim());
    p = m[1];
  }
  return chain;
}

async function run(ctx) {
  const user = await T("test.env", { name: "HATO_T_SSH_USER" });
  const key = await T("test.env", { name: "HATO_T_SSH_KEY" });
  const R = await T("test.env", { name: "HATO_T_REMOTE_REPO" });
  const exe = await T("test.env", { name: "HATO_T_ACP" });
  const call = (m, f, a, o) => ctx.modules.call(m, f, a || {}, o);
  await T("test.approvals", { policy: "allow" });

  // ---- M5: SSH project through the panel's Add SSH form
  await ev("projects-panel", "showSsh");
  await ev("projects-panel", "addSsh", { inputs: { "ssh-host": "127.0.0.1", "ssh-user": user, "ssh-port": "2222", "ssh-path": R, "ssh-key": key, "ssh-name": "Remote Gamma" } });
  const tree = await until(async () => { const t = await call("projects", "tree"); const p = t.find((x) => x.kind === "ssh"); return p && p.isGit !== null ? t : null; }, 30000);
  const pr = tree && tree.find((x) => x.kind === "ssh");
  check("SSH project registered (Git detected remotely)", pr && pr.isGit === true && pr.rootPath === R, pr);
  const log0 = await T("test.approvalLog");
  check("unknown host key required native trust approval", log0.some((l) => l.operation === "ssh.trustHostKey"), log0.map((l) => l.operation));
  const persisted = await call("persistence", "ssh.list");
  check("SSH profile stores key path only (no key material)", persisted.length === 1 && persisted[0].authRef === key, persisted);
  const wsR = `project:${pr.id}:root`;
  await ev("projects-panel", "selectWorkspace", { rowKey: wsR });
  const sel = await until(async () => { const s = await T("test.state", { key: "workspace.selected" }); return s && s.id === wsR ? s : null; });
  check("SSH workspace descriptor bound to remote machine", sel && sel.machineId.startsWith("ssh:") && sel.location === "ssh", sel);

  // SFTP explorer + remote viewer
  const ex = await until(async () => { const r = await T("test.render", { module: "explorer" }); const f = find(r, (n) => n.type === "tree"); return f && f.rows.some((e) => e.key === "src") ? f : null; }, 20000);
  check("remote explorer lists via SFTP", !!ex, ex);
  const op = await call("files", "open", { workspaceId: wsR, relativePath: "src/main.rs" });
  const doc = await T("test.document", { handle: op.document });
  check("remote file opened in native viewer", doc.language === "rust" && doc.head.includes("gamma"), doc);
  let esc = null;
  try { await call("files", "open", { workspaceId: wsR, relativePath: "escape-link/hosts" }); } catch (e) { esc = e.message; }
  check("remote symlink escape rejected (SFTP realpath)", esc && /outside the granted root/.test(esc), esc);

  // remote PTY
  const tp = await until(async () => { const r = await T("test.render", { module: "terminal-panel" }); const t = find(r, (n) => n.type === "terminal"); return t && t.pty ? t.pty : null; }, 20000);
  await T("test.ptyWrite", { handle: tp, text: "echo VIA=${SSH_CONNECTION%% *}; pwd; tput cols\r" });
  const scr = await until(async () => { const i = await T("test.ptyScreen", { handle: tp }); return /VIA=127\.0\.0\.1/.test(i.screen) && i.screen.replace(/\n/g, "").includes(R) ? i : null; }, 15000);
  check("remote PTY is an SSH session in the remote root", !!scr && scr.machineId.startsWith("ssh:"), (await T("test.ptyScreen", { handle: tp })).screen.slice(-500));

  // remote Git task (worktree created ON the remote machine)
  const task = await call("git-tasks", "create", { projectId: pr.id, name: "Remote feature" }, { timeoutMs: 120000 });
  check("remote worktree under remote app state dir", /\/\.local\/state\/hato\/worktrees\//.test(task.worktreePath) && task.machineId.startsWith("ssh:"), task);
  const wl = await T("test.exec", { argv: ["git", "worktree", "list", "--porcelain"], cwd: R });
  check("git worktree list on remote repo confirms it", wl.stdout.includes(task.worktreePath), wl.stdout);
  const tf = await call("files", "list", { workspaceId: `task:${task.id}`, relativeDir: "." });
  check("task workspace browses remote worktree", tf.root === task.worktreePath && tf.entries.some((e) => e.name === "src"), tf.root);

  // ---- M7: remote ACP over SSH stdio in the remote root
  await call("acp", "saveProfile", { profile: { id: "test-agent", machineId: "*", provider: "codex", name: "Test codex", executable: exe, args: [], envRefs: {}, enabled: true } });
  await T("test.approvalLog", { clear: true });
  const conv = await call("ai-sessions", "create", { workspaceId: wsR, profileId: "test-agent" });
  const st = await call("ai-sessions", "connect", { conversationId: conv.id }, { timeoutMs: 300000 });
  check("remote ACP session established on SSH machine", st.status === "ready" && st.machineId === sel.machineId && st.cwd === R, { status: st.status, machineId: st.machineId, cwd: st.cwd, error: st.error });
  const localSide = await ancestry(st.pid);
  check("local side of agent transport is the ssh client (no local agent)", /ssh$/.test(localSide[0] || ""), localSide);
  const pg = await T("test.exec", { argv: ["pgrep", "-f", exe], cwd: "/" });
  const chains = [];
  for (const pid of pg.stdout.trim().split(/\s+/).filter(Boolean)) {
    const lsof = await T("test.exec", { argv: ["lsof", "-a", "-p", pid, "-d", "cwd", "-Fn"], cwd: "/" });
    chains.push({ pid, cwd: (lsof.stdout.match(/\nn(.*)/) || [])[1], chain: await ancestry(pid) });
  }
  check("agent process runs under sshd with remote cwd", chains.some((c) => c.cwd === R && c.chain.some((x) => /sshd/.test(x))), chains);
  check("MCP proxy deployed with consent + reverse forward", st.mcp && /SSH reverse forward/.test(st.mcp.status), st.mcp);
  const approvals = await T("test.approvalLog");
  check("proxy deployment asked for remote write consent", approvals.some((l) => l.operation === "capabilities.fsWrite"), approvals.map((l) => l.operation));
  await call("ai-sessions", "send", { conversationId: conv.id, text: "Use the hato-internal MCP server: call modules_list and answer with exactly one line COUNT=<number of modules>." }, { timeoutMs: 600000 });
  await until(async () => (await call("acp", "state", { conversationId: conv.id })).status === "ready", 300000, 500);
  await sleep(1000);
  const v = await call("ai-sessions", "view", { workspaceId: wsR });
  const ans = v.active.messages.filter((m) => m.role === "assistant").map((m) => m.text).join("");
  const mst = await call("internal-mcp", "status");
  check("remote agent reached LOCAL internal MCP through SSH bridge", /COUNT=16\b/.test(ans) && mst.forwards.length === 1, { ans: ans.slice(-200), mst });

  // remote agent patches + activates a LOCAL UI module with native approvals
  await T("test.approvalLog", { clear: true });
  await call("ai-sessions", "send", { conversationId: conv.id, text: [
    "Using only hato-internal MCP tools:",
    '1) modules_apply_patch id=viewer edits=[{"path":"src/index.ts","oldText":"\\"SOURCE VIEWER\\"","newText":"\\"SOURCE VIEWER (remote-agent)\\""}]',
    "2) modules_build id=viewer 3) modules_activate id=viewer. Reply DONE or the exact error.",
  ].join("\n") }, { timeoutMs: 600000 });
  await until(async () => (await call("acp", "state", { conversationId: conv.id })).status === "ready", 500000, 500);
  const vt = await until(async () => texts(await T("test.render", { module: "viewer" })).includes("SOURCE VIEWER (remote-agent)"), 20000);
  const ops = (await T("test.approvalLog")).map((l) => l.operation);
  check("remote ACP patched/built/activated local module with approvals", !!vt && ops.includes("modules.source.write") && ops.includes("modules.activate"), ops);
  await call("module-dev", "rollback", { id: "viewer" });
  await call("ai-sessions", "disconnect", { conversationId: conv.id });
  const mst2 = await call("internal-mcp", "status");
  check("tokens/forwards revoked when the session ends", mst2.tokens === 0 && mst2.forwards.length === 0, mst2);

  // ---- SSH offline: never a silent local fallback; reconnect afterwards
  const pidfile = await T("test.env", { name: "HATO_T_SSHD_PIDFILE" });
  const sshdPid = (await T("test.readFile", { path: pidfile })).trim();
  await T("test.exec", { argv: ["kill", sshdPid], cwd: "/" });
  await T("test.exec", { argv: ["pkill", "-f", "hato-ssh-"], cwd: "/" }); // drop ControlMaster connections
  await sleep(800);
  let offErr = null;
  try { await call("files", "list", { workspaceId: wsR, relativeDir: "." }); } catch (e) { offErr = e.message; }
  check("SSH offline -> explicit error, no local listing", offErr && /SSH|ssh|connect|refused/i.test(offErr), offErr);
  let runErr = null;
  try { await call("terminals", "restart", { workspaceId: wsR, key: "main" }); } catch (e) { runErr = e.message; }
  check("SSH offline -> terminal does not fall back to local shell", !!runErr, runErr);
  const t2 = await call("projects", "tree");
  check("offline SSH project records retained", t2.some((p) => p.id === pr.id) && t2.find((p) => p.id === pr.id).tasks.length === 1);
  await T("test.exec", { argv: ["/usr/sbin/sshd", "-f", await T("test.env", { name: "HATO_T_SSHD_CONFIG" })], cwd: "/" });
  await sleep(800);
  const back = await until(async () => { try { const r = await call("files", "list", { workspaceId: wsR, relativeDir: "." }); return r.entries.length > 0; } catch { return false; } }, 20000, 500);
  check("reconnects after SSH comes back", !!back);
}
