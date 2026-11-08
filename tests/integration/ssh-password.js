// Password logins against a real sshd (see ssh-password.sh): the host is trusted first, wrong and
// cancelled passwords, no prompt without a gesture, and no trace of the password afterwards.
export default {
  id: "__driver", moduleApiVersion: 1,
  async activate(ctx) {
    try { await run(ctx); } catch (e) { check("uncaught", false, e.message + "\n" + e.stack); }
    await finish();
  },
};

async function run(ctx) {
  const env = async (name) => T("test.env", { name });
  const [password, port, user, root, data, keyOnlyPort] = await Promise.all(["HATO_T_PW", "HATO_T_PW_PORT", "HATO_T_PW_USER", "HATO_T_PW_ROOT", "HATO_T_PW_DATA", "HATO_T_PW_KEYONLY_PORT"].map(env));
  const call = (m, f, a, o) => ctx.modules.call(m, f, a || {}, o);
  const form = { "ssh-host": "127.0.0.1", "ssh-user": user, "ssh-port": port, "ssh-path": root, "ssh-name": "Pw" };
  const panelError = async () => find(await T("test.render", { module: "projects-panel" }), (n) => n.key === "add-error")?.text || "";
  const log = () => T("test.approvalLog", { clear: true });
  const ops = (entries) => entries.map((e) => e.operation);
  const project = async (id) => (await call("projects", "tree")).find((p) => p.id === id);

  await ev("projects-panel", "showSsh");
  await ev("projects-panel", "sshAuth", { value: "password" });

  // Cancelled at the prompt: nothing is registered, and the host was trusted first.
  await T("test.approvals", { policy: "allow" });
  await ev("projects-panel", "addSsh", { inputs: form });
  let entries = await log();
  check("the host key is approved before any password prompt", ops(entries).join() === "ssh.trustHostKey,ssh.password", ops(entries));
  check("the prompt names the destination", entries[1]?.title === `Password for ${user}@127.0.0.1`, entries[1]);
  check("a cancelled prompt reports it", /cancelled/.test(await panelError()), await panelError());
  check("a cancelled prompt registers nothing", !(await call("projects", "tree")).some((p) => p.kind === "ssh"));

  // Wrong password: three prompts, then a clear error.
  await T("test.approvals", { policy: "allow", secret: "wrong" });
  await ev("projects-panel", "addSsh", { inputs: form });
  entries = await log();
  check("a wrong password is asked again, three times", ops(entries).filter((o) => o === "ssh.password").length === 3, ops(entries));
  check("retries say the password was refused", /not accepted/.test(entries.at(-1)?.detail || ""), entries.at(-1));
  check("too many wrong passwords report it", /rejected 3 times/.test(await panelError()), await panelError());

  // The right password, with characters a shell would mangle.
  await T("test.approvals", { policy: "allow", secret: password });
  await ev("projects-panel", "addSsh", { inputs: form });
  const pr = await until(async () => { const p = (await call("projects", "tree")).find((x) => x.name === "Pw"); return p && p.isGit !== null ? p : null; }, 30000);
  check("password project registered, Git detected over the master", pr?.isGit === true && pr.auth === "password" && !pr.offline, pr);
  check("the dialog closes after adding", !find(await T("test.render", { module: "projects-panel" }), (n) => n.key === "add-modal"));

  // Everything multiplexes over the master: no further prompts.
  await log();
  const ws = `project:${pr.id}:root`;
  await ev("projects-panel", "selectWorkspace", { rowKey: ws });
  const desc = await call("workspace", "resolve", { workspaceId: ws });
  check("the descriptor carries the choice, no key", desc.ssh.auth === "password" && !desc.ssh.identityFile, desc.ssh);
  const listing = await call("files", "list", { workspaceId: ws, path: "." });
  check("files work over the password master", JSON.stringify(listing).includes("hello.txt"), listing);
  check("a live master never prompts again", !ops(await log()).includes("ssh.password"));

  // A server without password logins is refused without asking.
  await ev("projects-panel", "showSsh");
  await ev("projects-panel", "addSsh", { inputs: { ...form, "ssh-port": keyOnlyPort, "ssh-name": "KeyOnly" } });
  entries = await log();
  check("a key-only server never gets a prompt", !ops(entries).includes("ssh.password"), ops(entries));
  check("a key-only server says so", /does not accept password/.test(await panelError()), await panelError());
  await ev("projects-panel", "hideAdd");

  // After losing the connection, background work must not prompt; a click does.
  await T("test.exec", { argv: ["pkill", "-f", `ssh -M -N .* -p ${port} `], cwd: "/" });
  await until(async () => { await call("projects", "refresh", { projectId: pr.id }); return (await project(pr.id))?.needsPassword; }, 15000, 300);
  check("background work reports a lock", (await project(pr.id))?.needsPassword === true, await project(pr.id));
  check("background work never prompts", !ops(await log()).includes("ssh.password"));
  await ev("projects-panel", "selectWorkspace", { rowKey: ws });
  const back = await until(async () => { const p = await project(pr.id); return p && !p.offline ? p : null; }, 15000);
  check("clicking the project prompts and reconnects", back && ops(await log()).includes("ssh.password"), back);

  // Nothing Hato stores or runs holds the password.
  const scan = await T("test.exec", { argv: ["grep", "-rlaF", "--", password, data], cwd: "/" });
  check("the password is nowhere in the data directory", scan.stdout.trim() === "", scan.stdout);
  const processes = await T("test.exec", { argv: ["sh", "-c", 'for p in /proc/[0-9]*; do tr "\\0" " " < $p/cmdline 2>/dev/null; echo; done'], cwd: "/" });
  check("the password is on no command line", !processes.stdout.split("\n").some((l) => l.includes(password) && !l.includes("HATO_T_PW") && !l.includes("grep")));
}
