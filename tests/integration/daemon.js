// Remote runtime (Tier 2) over real SSH: daemon install/start, terminals and processes that
// survive their connection, buffered output, per-module key scoping, plugin push + remote calls,
// and the line bridge. Remote = a throwaway sshd (see docs/TESTING.md).
// Env: HATO_T_SSH_USER, HATO_T_SSH_KEY, HATO_T_REMOTE_REPO, HATO_REMOTE_DAEMON_DIR (isolated daemon home)
export default {
  id: "__driver", moduleApiVersion: 1,
  async activate(ctx) {
    const h = ctx.host;
    let daemonDir = null, bin = null;
    try {
      await T("test.approvals", { policy: "allow" }); // host-key trust prompt
      const user = await T("test.env", { name: "HATO_T_SSH_USER" });
      const key = await T("test.env", { name: "HATO_T_SSH_KEY" });
      const root = await T("test.env", { name: "HATO_T_REMOTE_REPO" });
      const ssh = await h.ssh.connect({ profileId: "daemon-test", host: "127.0.0.1", port: 2222, user, identityFile: key });
      const target = { kind: "ssh", connection: ssh.connection };
      const exec = { kind: "ssh", connection: ssh.connection, machineId: ssh.machineId };

      // ---- install + start
      const st = await h.daemon.ensure(target);
      daemonDir = st.dir; bin = st.bin;
      check("daemon installed and running", st.status && st.status.pid > 0 && /\/bin\/hato-/.test(st.bin), st);
      const expectedDir = await T("test.env", { name: "HATO_REMOTE_DAEMON_DIR" });
      check("daemon home is isolated for the test", !!expectedDir && st.dir.replace(/^\/private/, "") === expectedDir.replace(/^\/private/, ""), st.dir);
      const again = await h.daemon.ensure(target);
      check("ensure is idempotent (same daemon)", again.status.pid === st.status.pid);

      // ---- terminal survives its connection
      const ptyGrant = await h.capabilities.request({ kind: "pty", root, target: exec });
      const open = () => h.pty.open(ptyGrant.grant, { target: exec, cwd: root, columns: 100, rows: 30, persist: { key: "t1" } });
      const screen = async (handle) => (await T("test.ptyScreen", { handle })).screen;
      let p1 = await open();
      await until(async () => /\S/.test(await screen(p1.handle)), 8000);
      await h.pty.write(p1.handle, "export HATO_PERSIST=yes; echo marker-$((40+2))\r");
      check("persistent terminal runs commands", !!(await until(async () => /marker-42/.test(await screen(p1.handle)), 8000)));
      await h.pty.close(p1.handle); // ends the local ssh viewer only
      let res = await until(async () => { const r = await h.daemon.request(target, "resources.list"); return r.ptys.find((p) => p.key === "t1" && !p.attached) ? r : null; }, 8000);
      check("daemon keeps the shell after the viewer closed", !!res, res);
      const p2 = await open();
      await h.pty.write(p2.handle, "echo $HATO_PERSIST-again\r");
      check("reattach reaches the same shell (state kept)", !!(await until(async () => /yes-again/.test(await screen(p2.handle)), 8000)), await screen(p2.handle));

      // ---- process survives; output while detached is delivered on reattach
      const procGrant = await h.capabilities.request({ kind: "process", root, target: exec });
      // Native watcher over SSH uses the uploaded helper, with no remote utility dependency.
      const temp = await h.process.run(procGrant.grant, { target: exec, executable: "mktemp", cwd: root, args: ["-d", "/tmp/hato-watch-XXXXXX"] });
      const watchRoot = temp.stdout.trim();
      const watchGrant = await h.capabilities.request({ kind: "fs", root: watchRoot, target: exec });
      const watching = await h.fs.watch(watchGrant.grant, ".");
      let notifications = "";
      const watchSub = await h.streams.listen(watching.handle, { channel: "stdout" }, c => { notifications += c; });
      try {
        check("SSH filesystem watch becomes ready", await until(() => notifications.includes("ready")));
        notifications = "";
        await h.process.run(procGrant.grant, { target: exec, executable: "touch", cwd: root, args: [watchRoot + "/created.txt"] });
        check("SSH watcher reports new files", await until(() => notifications.includes("changed")));
      } finally {
        await watchSub.close();
        await h.resources.release(watching.handle);
        await h.capabilities.release(watchGrant.grant);
        await h.process.run(procGrant.grant, { target: exec, executable: "rm", cwd: root, args: ["-rf", watchRoot] });
      }
      const spawn = () => h.process.spawn(procGrant.grant, { target: exec, executable: "sh", cwd: root, persist: { key: "p1" },
        args: ["-c", "(sleep 1.5; echo late-line) & while read x; do echo got-$x; done"] });
      const collect = async (handle) => {
        let out = "";
        const sub = await h.streams.listen(handle, { channel: "stdout" }, (c) => { out += c; });
        return { get: () => out, stop: () => sub.close() };
      };
      let a = await spawn();
      let o = await collect(a.handle);
      await h.process.write(a.handle, "one\n");
      check("persistent process answers", !!(await until(() => /got-one/.test(o.get()), 8000)), o.get());
      await o.stop();
      await h.process.terminate(a.handle);
      await sleep(2000); // "late-line" is printed while nobody is attached
      const b = await spawn();
      const o2 = await collect(b.handle);
      check("output produced while detached is delivered on reattach", !!(await until(() => /late-line/.test(o2.get()), 8000)), o2.get());
      await h.process.write(b.handle, "two\n");
      check("reattached process keeps its state", !!(await until(() => /got-two/.test(o2.get()), 8000)), o2.get());
      check("no output replayed twice", !/got-one/.test(o2.get()), o2.get());

      // ---- keys are scoped per module; other ops are not exposed
      res = await h.daemon.request(target, "resources.list");
      check("resource keys are unscoped for their owner", res.ptys.some((p) => p.key === "t1") && res.procs.some((p) => p.key === "p1"), res);
      let err = null;
      try { await h.daemon.request(target, "shutdown"); } catch (e) { err = e; }
      check("daemon shutdown is not a module op", err && err.code === "EPERM", err && err.code);
      await h.daemon.request(target, "proc.kill", { key: "p1" });
      await h.daemon.request(target, "pty.kill", { key: "t1" });
      await o2.stop();
      res = await until(async () => { const r = await h.daemon.request(target, "resources.list"); return !r.ptys.some((p) => p.key === "t1") ? r : null; }, 8000);
      check("pty.kill removes the shell", !!res);

      // ---- plugins: push an approved local plugin and call it remotely
      const env = h.env.info();
      const pdir = `${env.dataDir}/plugins/echo-svc`;
      await T("test.exec", { argv: ["mkdir", "-p", `${pdir}/dist`] });
      await T("test.exec", { argv: ["sh", "-c", `cat > ${pdir}/manifest.json <<'J'
{"schemaVersion":2,"id":"echo-svc","kind":"service","entry":"dist/echo-svc.mjs","moduleApiVersion":1,"runsOn":"either"}
J
cat > ${pdir}/dist/echo-svc.mjs <<'J'
export default { id: "echo-svc", moduleApiVersion: 1, methods: {
  where: (ctx) => ctx.host.env.info().dataDir,
  line: (ctx, a) => "echo:" + a.line,
} };
J`] });
      await T("test.pluginRescan");
      err = null;
      try { await h.daemon.request(target, "plugins.push", { id: "echo-svc" }); } catch (e) { err = e; }
      check("disabled/unapproved local plugins cannot be pushed", !!err, err && err.message);
      await T("test.approvals", { policy: "allow" });
      await T("test.pluginEnable", { id: "echo-svc" });
      const pushed = await h.daemon.request(target, "plugins.push", { id: "echo-svc" });
      check("plugin pushed and active on the daemon", pushed.active === true, pushed);
      const where = await h.daemon.request(target, "modules.call", { target: "echo-svc", method: "where" });
      check("plugin runs in the daemon's kernel", typeof where === "string" && where.replace(/^\/private/, "").startsWith(daemonDir.replace(/^\/private/, "")), [where, daemonDir]);
      const list = await h.daemon.request(target, "plugins.list");
      check("daemon lists the pushed plugin", list.plugins.some((p) => p.id === "echo-svc" && p.enabled));

      // ---- line bridge (what an offline agent's tool shim uses)
      const r = await h.process.run(procGrant.grant, { target: exec, executable: bin, cwd: root, args: ["daemon", "bridge", "--dir", daemonDir, "--plugin", "echo-svc", "--method", "line"] }, { stdin: "hello\nworld\n", timeoutMs: 20000 });
      check("bridge forwards lines to the plugin", r.stdout.trim() === "echo:hello\necho:world", r);
      // ---- full module flow: SSH project → auto daemon → daemon-held terminal → panel
      const call = (m, f, a, o) => ctx.modules.call(m, f, a || {}, o);
      await ev("projects-panel", "showSsh");
      await ev("projects-panel", "addSsh", { inputs: { "ssh-host": "127.0.0.1", "ssh-user": user, "ssh-port": "2222", "ssh-path": root, "ssh-key": key, "ssh-name": "Daemon Remote" } });
      const tree = await until(async () => { const t = await call("projects", "tree"); return t.find((x) => x.kind === "ssh") ? t : null; }, 30000);
      const pr = tree.find((x) => x.kind === "ssh");
      const wsR = `project:${pr.id}:root`;
      await ev("projects-panel", "selectWorkspace", { rowKey: wsR });
      const rs = await until(async () => { const r = await call("remote-runtime", "status", { workspaceId: wsR }); return r.running ? r : null; }, 30000);
      check("remote-runtime starts the daemon for the selected SSH workspace", !!rs, rs);
      const scope = `machine:${rs.machineId}`, settingKey = "integration.sync";
      await call("persistence", "scoped.set", { scope, key: settingKey, value: "desktop" });
      await call("remote-runtime", "ensure", { workspaceId: wsR });
      const remoteSetting = await h.daemon.request(target, "modules.call", { target: "persistence", method: "scoped.get", args: { scope, key: settingKey } });
      check("machine settings sync to daemon", remoteSetting?.value === "desktop", remoteSetting);
      await h.daemon.request(target, "modules.call", { target: "persistence", method: "scoped.set", args: { scope, key: settingKey, value: "remote" } });
      await call("remote-runtime", "sync", { workspaceId: wsR });
      check("newer daemon settings sync back", (await call("persistence", "scoped.get", { scope, key: settingKey }))?.value === "remote");
      let conflict = false;
      try { await call("persistence", "scoped.set", { scope, key: settingKey, value: "stale", expectedRev: 0 }); } catch (e) { conflict = String(e).includes("ECONFLICT"); }
      check("settings expectedRev rejects stale edits", conflict);
      const att = await call("terminals", "attach", { workspaceId: wsR, key: "main" });
      await T("test.ptyWrite", { handle: att.pty, text: "export FLOW=kept\r" });
      const held = await until(async () => { const r = await call("remote-runtime", "status", { workspaceId: wsR }); return r.resources.ptys.find((p) => p.key.startsWith("terminals/")) ? r : null; }, 10000);
      check("terminals service keeps SSH shells in the daemon", !!held, held && held.resources);
      const panel = await until(async () => { const r = await T("test.render", { module: "remote-panel" }); return find(r, (n) => typeof n.key === "string" && n.key.startsWith("pty:terminals/")) ? r : null; }, 10000);
      check("remote panel lists daemon-held terminals", !!panel, JSON.stringify(await T("test.render", { module: "remote-panel" })).slice(0, 1500));
      // A module reload (or app restart) reattaches to the same remote shell.
      await call("terminals", "close", { workspaceId: wsR, key: "other" });
      const staged = await T("test.stage", { id: "terminals", code: await T("test.readFile", { path: (await T("test.env", { name: "HATO_T_BUILD" })) + "/terminals.mjs" }) }).catch(() => null);
      if (staged) await T("test.activate", { id: "terminals", stageId: staged.stageId });
      await h.pty.close(att.pty).catch(() => {}); // drop the local viewer
      const re = await call("terminals", "attach", { workspaceId: wsR, key: "main" });
      await T("test.ptyWrite", { handle: re.pty, text: "echo flow-$FLOW\r" });
      check("terminal reattaches to the same daemon shell", !!(await until(async () => /flow-kept/.test((await T("test.ptyScreen", { handle: re.pty })).screen), 10000)));
    } catch (e) {
      check("no exception", false, `${e && e.code}: ${e && e.message}\n${e && e.stack}`);
    } finally {
      if (bin && daemonDir) await T("test.exec", { argv: [bin, "daemon", "stop", "--dir", daemonDir] }).catch(() => {});
    }
    await finish();
  },
};
