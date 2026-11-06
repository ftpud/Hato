// Windows desktop with a project in WSL: the real hato.exe, driving a real distribution.
// Run through tests/integration/run-windows.sh (from WSL). Env: HATO_T_DISTRO, HATO_T_ROOT.
export default {
  id: "__driver", moduleApiVersion: 1,
  async activate(ctx) {
    try { await run(ctx); } catch (e) { check("uncaught", false, e.message + "\n" + e.stack); }
    await finish();
  },
};

const failure = async (fn) => { try { await fn(); return null; } catch (e) { return e.message || String(e); } };

async function run(ctx) {
  const distro = await T("test.env", { name: "HATO_T_DISTRO" });
  const R = await T("test.env", { name: "HATO_T_ROOT" });
  const call = (m, f, a, o) => ctx.modules.call(m, f, a || {}, o);
  await T("test.approvals", { policy: "allow" });
  const env = ctx.host.env.info();
  check("runs as a native Windows process", env.platform === "windows", env.platform);
  check("kernel paths are plain and /-separated", /^[A-Za-z]:\//.test(env.dataDir) && /^[A-Za-z]:\//.test(env.repoRoot) && !env.repoRoot.includes("\\"), [env.dataDir, env.repoRoot]);

  // ---- no native Windows projects
  check("a Windows folder is refused as a project", /wsl\.localhost/.test(await failure(() => call("projects", "addLocal", { path: "C:\\Windows" })) || ""));
  check("first launch from a Windows cwd registers nothing", (await call("persistence", "projects.list")).length === 0);

  // ---- the panel's WSL form
  const distros = await call("projects", "wslDistributions");
  check("WSL distributions listed", distros.includes(distro), distros);
  await ev("projects-panel", "showAdd");
  await ev("projects-panel", "showWsl");
  await ev("projects-panel", "wslDistro", { value: distro });
  await ev("projects-panel", "addWsl", { inputs: { "wsl-path": R, "wsl-name": "WSL Project" } });
  const tree = await until(async () => { const t = await call("projects", "tree"); const p = t.find((x) => x.name === "WSL Project"); return p && p.isGit !== null ? t : null; }, 60000);
  const pr = tree && tree.find((x) => x.name === "WSL Project");
  check("WSL project registered with Git detected in Linux", pr && pr.kind === "ssh" && pr.transport === "wsl" && pr.isGit === true && pr.rootPath === R, pr);
  const missing = await failure(() => call("projects", "addWsl", { distro: "NoSuchDistro", remotePath: "/tmp" }, { timeoutMs: 60000 }));
  check("an unknown distribution reports wsl.exe's message readably", /distribution/i.test(missing || "") && !(missing || "").includes("\0"), missing);
  const unc = await call("projects", "addLocal", { path: `\\\\wsl.localhost\\${distro}${R.replace(/\//g, "\\")}` }, { timeoutMs: 60000 });
  check("a \\\\wsl.localhost folder maps to the same project", unc && unc.id === pr.id, unc);

  const ws = `project:${pr.id}:root`;
  await ev("projects-panel", "selectWorkspace", { rowKey: ws });
  const sel = await until(async () => { const s = await T("test.state", { key: "workspace.selected" }); return s && s.id === ws ? s : null; });
  check("workspace descriptor keeps the transport", sel && sel.ssh && sel.ssh.transport === "wsl" && sel.location === "ssh", sel);

  // ---- files: SFTP in the distribution; Unicode, spaces and binary content survive
  const listed = await call("files", "list", { workspaceId: ws, relativeDir: "." });
  check("files listed in Linux", listed.root === R && listed.entries.some((e) => e.name === "файл с пробелом.txt") && listed.entries.some((e) => e.name === "src"), listed.entries);
  const opened = await call("files", "open", { workspaceId: ws, relativePath: "src/main.rs" });
  const doc = await T("test.document", { handle: opened.document });
  check("file opened in the viewer", doc.head.includes("hato-wsl"), doc);
  const esc = await failure(() => call("files", "open", { workspaceId: ws, relativePath: "escape-link/passwd" }));
  check("symlink escape refused", /outside the granted root/.test(esc || ""), esc);

  // ---- process channel: argv quoting, exit codes, cancellation
  const g = await ctx.host.capabilities.request({ kind: "process", root: R, target: await target(ctx, sel) });
  const tgt = await target(ctx, sel);
  const quoted = await ctx.host.process.run(g.grant, { target: tgt, executable: "printf", args: ["%s|", "a b", 'c"d', "$HOME", "%PATH%", "x\\y", "é"], cwd: R }, { timeoutMs: 30000 });
  check("arguments reach Linux intact", quoted.stdout === 'a b|c"d|$HOME|%PATH%|x\\y|é|', quoted);
  const failed = await ctx.host.process.run(g.grant, { target: tgt, executable: "sh", args: ["-c", "exit 37"], cwd: R }, { timeoutMs: 30000 });
  check("exit codes pass through", failed.code === 37, failed);
  const big = await ctx.host.process.run(g.grant, { target: tgt, executable: "sh", args: ["-c", "head -c 6291456 /dev/zero | tr '\\0' x; printf done >&2"], cwd: R }, { timeoutMs: 60000, limitBytes: 8 * 1024 * 1024 });
  check("large output drains", big.stdout.length === 6291456 && big.stderr === "done", [big.stdout.length, big.stderr]);
  const sleeper = await ctx.host.process.spawn(g.grant, { target: tgt, executable: "sh", args: ["-c", "echo $$ > .hato-sleeper; exec sleep 300"], cwd: R });
  await until(async () => (await ctx.host.process.run(g.grant, { target: tgt, executable: "test", args: ["-s", ".hato-sleeper"], cwd: R }, { timeoutMs: 15000 })).code === 0, 15000, 300);
  await ctx.host.process.terminate(sleeper.handle);
  const gone = await until(async () => (await ctx.host.process.run(g.grant, { target: tgt, executable: "sh", args: ["-c", 'kill -0 "$(cat .hato-sleeper)" 2>/dev/null; [ $? -ne 0 ]'], cwd: R }, { timeoutMs: 15000 })).code === 0, 15000, 300);
  check("terminating ends the Linux process", !!gone);

  // ---- Git service and a task worktree
  const status = await call("git", "status", { workspaceId: ws }, { timeoutMs: 30000 }).catch((e) => ({ error: e.message }));
  check("Git status comes from Linux", status && !status.error, status);
  const task = await call("git-tasks", "create", { projectId: pr.id, name: "From Windows" }, { timeoutMs: 120000 });
  check("task worktree created in Linux", /\/\.local\/state\/hato\/worktrees\//.test(task.worktreePath), task);

  // ---- terminal through ConPTY
  const tp = await until(async () => { const r = await T("test.render", { module: "terminal-panel" }); const t = find(r, (n) => n.type === "terminal"); return t && t.pty ? t.pty : null; }, 60000);
  check("terminal opened", !!tp);
  if (tp) {
    await T("test.ptyWrite", { handle: tp, text: "echo KERNEL=$(uname -s); pwd\r" });
    const scr = await until(async () => { const i = await T("test.ptyScreen", { handle: tp }); return /KERNEL=Linux/.test(i.screen) ? i : null; }, 30000);
    check("terminal is a shell in Linux", !!scr, (await T("test.ptyScreen", { handle: tp })).screen.slice(-500));
  }

  // ---- Linux daemon in the distribution
  const c = await ctx.host.ssh.connect({ profileId: sel.ssh.profileId, host: sel.ssh.host, port: 22, user: sel.ssh.user, transport: "wsl" });
  const dt = { kind: "ssh", connection: c.connection };
  const d = await ctx.host.daemon.ensure(dt);
  check("Linux daemon installed and started in WSL", d.status && d.status.os === "linux", d);
  const p = await ctx.host.pty.open((await ctx.host.capabilities.request({ kind: "pty", root: R, target: tgt })).grant, { cwd: R, columns: 90, rows: 24, persist: { key: "win-e2e" } });
  await T("test.ptyWrite", { handle: p.handle, text: "echo PERSIST=$((6*7))\r" });
  check("daemon-held terminal works", !!await until(async () => /PERSIST=42/.test((await T("test.ptyScreen", { handle: p.handle })).screen), 30000));
  const resized = async (handle) => {
    await ctx.host.pty.resize(handle, 133, 40);
    await sleep(800); // the relay polls the terminal size
    await T("test.ptyWrite", { handle, text: "stty size\r" });
    return !!await until(async () => /40 133/.test((await T("test.ptyScreen", { handle })).screen), 15000);
  };
  check("resize reaches a daemon-held terminal", await resized(p.handle), (await T("test.ptyScreen", { handle: p.handle })).screen.slice(-300));
  await ctx.host.daemon.request(dt, "pty.kill", { key: "win-e2e" }).catch(() => {});
  const plain = await ctx.host.pty.open((await ctx.host.capabilities.request({ kind: "pty", root: R, target: tgt })).grant, { cwd: R, columns: 90, rows: 24 });
  check("resize reaches a direct terminal", await resized(plain.handle), (await T("test.ptyScreen", { handle: plain.handle })).screen.slice(-300));
  await T("test.ptyWrite", { handle: plain.handle, text: "printf 'Ü\\344\\270\\255=%s\\n' ok\r" });
  check("terminal keeps UTF-8", !!await until(async () => /Ü中\s*=ok/.test((await T("test.ptyScreen", { handle: plain.handle })).screen), 15000), (await T("test.ptyScreen", { handle: plain.handle })).screen.slice(-300));
  await ctx.host.pty.close(plain.handle);

  // ---- services on the workspace machine: agents and workflows reach Linux this way
  const rr = await call("remote-runtime", "ensure", { workspaceId: ws }, { timeoutMs: 120000 });
  check("remote runtime starts in WSL and takes pushed services", rr && !rr.error, rr);
  const daemonStatus = await ctx.host.daemon.request(dt, "plugins.list", {});
  check("the persistence service runs in the Linux daemon", (daemonStatus.plugins || []).some((x) => x.id === "persistence"), daemonStatus);

  // ---- file watching in Linux: the daemon binary's `watch`, over the WSL channel
  const wg = await ctx.host.capabilities.request({ kind: "fs", root: R, target: tgt });
  const watch = await ctx.host.fs.watch(wg.grant, ".", { recursive: true });
  const seen = [];
  const sub = await ctx.host.streams.listen(watch.handle, { channel: "stdout" }, (chunk) => seen.push(chunk));
  check("file watcher ready", !!await until(() => seen.join("").includes("ready"), 20000), seen);
  await ctx.host.process.run(g.grant, { target: tgt, executable: "sh", args: ["-c", "echo x > watched.txt"], cwd: R }, { timeoutMs: 15000 });
  check("Linux file change reaches Windows", !!await until(() => seen.join("").includes("changed"), 20000), seen);
  await sub.close();
  await ctx.host.resources.release(watch.handle);

  // ---- loopback forward: Linux 127.0.0.1 reaches this Windows process through the relay
  const fwd = await T("test.forwardProbe", { connection: c.connection });
  const probe = await ctx.host.process.run(g.grant, { target: tgt, executable: "bash", args: ["-c", `exec 3<>/dev/tcp/127.0.0.1/${fwd.remotePort}; printf 'ping\\n' >&3; head -n1 <&3`], cwd: R }, { timeoutMs: 30000 });
  check("Linux loopback reaches the Windows listener", probe.stdout.trim() === "pong:ping", probe);
  await T("test.forwardClose", { port: fwd.remotePort, connection: c.connection });

  // ---- SSH project, through the OpenSSH client of the default distribution
  const sshUser = await T("test.env", { name: "HATO_T_SSH_USER" });
  if (sshUser) {
    await ev("projects-panel", "showSsh");
    await ev("projects-panel", "addSsh", { inputs: { "ssh-host": "127.0.0.1", "ssh-user": sshUser, "ssh-port": await T("test.env", { name: "HATO_T_SSH_PORT" }), "ssh-path": R, "ssh-key": await T("test.env", { name: "HATO_T_SSH_KEY" }), "ssh-name": "SSH Project" } });
    const st = await until(async () => { const t = await call("projects", "tree"); const x = t.find((y) => y.name === "SSH Project"); return x && x.isGit !== null ? x : null; }, 60000);
    check("SSH project registered through WSL's client", st && st.transport === "ssh" && st.isGit === true, st || texts(await T("test.render", { module: "projects-panel" })).join(" | ").slice(-400));
    check("unknown host key went through native approval", (await T("test.approvalLog")).some((l) => l.operation === "ssh.trustHostKey"));
    if (st) {
      const sd = await call("workspace", "resolve", { workspaceId: `project:${st.id}:root` });
      const sc = await ctx.host.ssh.connect({ profileId: sd.ssh.profileId, host: sd.ssh.host, port: sd.ssh.port, user: sd.ssh.user, identityFile: sd.ssh.identityFile, transport: "ssh" });
      const stgt = { kind: "ssh", connection: sc.connection, machineId: sc.machineId };
      const sg = await ctx.host.capabilities.request({ kind: "process", root: R, target: stgt });
      const via = await ctx.host.process.run(sg.grant, { target: stgt, executable: "sh", args: ["-c", 'printf "%s|%s" "${SSH_CONNECTION%% *}" "$1"', "x", 'a "b" $c'], cwd: R }, { timeoutMs: 30000 });
      check("commands run over the multiplexed SSH channel", via.stdout === '127.0.0.1|a "b" $c', via);
      const pg = await ctx.host.capabilities.request({ kind: "pty", root: R, target: stgt });
      const sp = await ctx.host.pty.open(pg.grant, { cwd: R, columns: 100, rows: 30 });
      await T("test.ptyWrite", { handle: sp.handle, text: "echo VIA=${SSH_CONNECTION%% *}\r" });
      check("SSH terminal", !!await until(async () => /VIA=127\.0\.0\.1/.test((await T("test.ptyScreen", { handle: sp.handle })).screen), 30000), (await T("test.ptyScreen", { handle: sp.handle })).screen.slice(-300));
      await ctx.host.pty.close(sp.handle);
      const sf = await T("test.forwardProbe", { connection: sc.connection });
      const sprobe = await ctx.host.process.run(sg.grant, { target: stgt, executable: "bash", args: ["-c", `exec 3<>/dev/tcp/127.0.0.1/${sf.remotePort}; printf 'ping\\n' >&3; head -n1 <&3`], cwd: R }, { timeoutMs: 30000 });
      check("remote loopback reaches Windows through ssh -R and the WSL relay", sprobe.stdout.trim() === "pong:ping", sprobe);
      await T("test.forwardClose", { port: sf.remotePort, connection: sc.connection });
      await ctx.host.ssh.disconnect(sc.connection);
    }
  } else check("sshd available for the SSH checks (skipped)", true);

  // ---- module hot reload with the bundled esbuild.exe, keeping workspace state
  const built = await call("module-dev", "build", { id: "projects-panel" }, { timeoutMs: 150000 });
  check("in-app module build runs esbuild.exe", built.ok && built.stageId, built.error || built.diagnostics);
  if (built.ok && built.stageId) {
    const before = await T("test.state", { key: "workspace.selected" });
    await T("test.activate", { id: "projects-panel", stageId: built.stageId, force: true });
    const after = await T("test.state", { key: "workspace.selected" });
    check("hot reload keeps the selected workspace", before && after && before.id === after.id);
    check("terminal survives the reload", !tp || /Linux/.test((await T("test.ptyScreen", { handle: tp })).screen));
  }

  // ---- scope enforcement on this machine's own paths
  const shared = env.sharedDir;
  const sg = await ctx.host.capabilities.request({ kind: "fs", root: shared, target: { kind: "local" }, write: true });
  await ctx.host.fs.writeAtomic(sg.grant, "日本語 dir/a b.txt".replace("日本語 dir/", ""), "ok");
  check("local write under a Windows root", (await ctx.host.fs.read(sg.grant, "a b.txt")).text === "ok");
  for (const bad of ["..\\x", "../x", "C:\\Windows\\win.ini", "C:/Windows/win.ini", "a b.txt:stream", "CON", "NUL.txt", "x\\..\\..\\y"]) {
    const e = await failure(() => ctx.host.fs.read(sg.grant, bad));
    check(`local path refused: ${bad}`, e && /outside|escapes|not allowed|denied/i.test(e), e);
  }
  const prot = await failure(() => ctx.host.capabilities.request({ kind: "fs", root: env.dataDir + "/sqlite", target: { kind: "local" } }));
  check("kernel state cannot be granted", /protected/.test(prot || ""), prot);
  const drive = await failure(() => ctx.host.capabilities.request({ kind: "fs", root: "C:\\", target: { kind: "local" } }));
  check("a drive root cannot be granted", /filesystem root/.test(drive || ""), drive);
  const dm = await failure(() => ctx.host.daemon.ensure({ kind: "local" }));
  check("no local daemon on Windows, with a clear reason", /Linux machine/.test(dm || ""), dm);
}

async function target(ctx, desc) {
  const c = await ctx.host.ssh.connect({ profileId: desc.ssh.profileId, host: desc.ssh.host, port: desc.ssh.port, user: desc.ssh.user, transport: "wsl" });
  return { kind: "ssh", connection: c.connection, machineId: c.machineId };
}
