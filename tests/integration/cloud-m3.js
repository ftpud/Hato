export default {
  id: "__driver",
  moduleApiVersion: 1,
  async activate(ctx) {
    const call = (module, method, args = {}, timeoutMs = 30000) => ctx.modules.call(module, method, args, { timeoutMs });
    const fixture = await T("test.env", { name: "HATO_CLOUD_M3_FIXTURE" });
    const api = async (path, body) => {
      const reply = await ctx.host.net.fetch({
        url: fixture + path, method: body === undefined ? "GET" : "POST",
        headers: { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (reply.status !== 200) throw new Error(reply.body);
      return JSON.parse(reply.body);
    };
    const requireCheck = (name, value, info) => { check(name, value, info); if (!value) throw new Error(name); };
    try {
      await T("test.approvals", { policy: "allow" });
      await T("test.browserCapture");
      const repo = ctx.host.env.info().repoRoot;
      for (const id of ["cloud", "cloud-panel"]) {
        const enable = await T("test.pluginEnable", { id });
        requireCheck(id + " starts", enable.active, enable.error);
        const code = await T("test.readFile", { path: repo + "/Hato-plugins/build/modules/" + id + ".mjs" });
        const stage = await T("test.stage", { id, code });
        const activation = await T("test.activate", { id, stageId: stage.stageId });
        requireCheck(id + " stages and activates", activation.ok, activation);
      }
      for (const id of ["terminals", "files", "git", "persistent-agents", "workflows"]) {
        const enabled = await T("test.pluginEnable", { id });
        requireCheck(id + " starts", enabled.active, enabled.error);
      }
      const data = await api("/fixture");
      await call("cloud", "setServer", { url: data.server });
      await call("cloud", "signIn");
      const browser = await until(() => T("test.browserNext"), 5000);
      requireCheck("desktop opens PKCE browser flow", typeof browser === "string");
      await api("/browser", { url: browser });
      const account = await until(async () => {
        const status = await call("cloud", "status");
        return status.signedIn && !status.signingIn && status;
      }, 10000);
      requireCheck("desktop sign-in registers a device", account?.user?.email === "alice@example.test" && !!account?.device?.fingerprint,
        await call("cloud", "status"));

      const pending = await call("cloud", "pendingEnrollment", { userCode: data.code });
      requireCheck("read pending host enrolment", pending?.fingerprint?.length === 64);
      await call("cloud", "approveEnrollment", { userCode: data.code });
      const host = await until(async () => (await call("cloud", "inventory")).hosts.find(h => h.online), 15000);
      requireCheck("host comes online in Cloud inventory", host, await call("cloud", "inventory"));
      const project = await call("cloud", "addProject", { hostId: host.id, name: "Fixture", path: data.root });
      const workspace = await call("cloud", "openProject", { projectId: project.id });
      requireCheck("workspace uses the Cloud host and project path", workspace?.location === "cloud" &&
        workspace.rootAbsolutePath === data.root && workspace.cloudHostId === host.id && workspace.machineId.startsWith("cloud:"), workspace);

      for (const [id, method] of [["files", "list"], ["git", "status"]]) {
        const result = await call(id, method, { workspaceId: workspace.id, path: "." }).then(() => "", e => String(e.message || e));
        requireCheck(id + " explicitly unavailable over Cloud", /not available over Cloud yet/.test(result), result);
      }
      const entries = await T("test.handles");
      const route = entries.find(item => item.owner === "cloud" && item.kind === "cloud-connection");
      for (const kind of ["exec", "pty"]) {
        const output = await T("test.cloudProgram", { kind, command: "printf m3-transport", connection: route.handle });
        const text = output.filter(frame => frame.kind === "stdout").map(frame => frame.base64).join("");
        requireCheck(kind + " travels through the elected Cloud route", text === "bTMtdHJhbnNwb3J0");
      }

      const terminal = await call("terminals", "attach", { workspaceId: workspace.id, key: "m3" });
      requireCheck("terminal uses the selected Cloud route", terminal.machineId === workspace.machineId && terminal.cwd === data.root, terminal);
      await T("test.ptyWrite", { handle: terminal.pty, text: "printf 'cloud-%s\\n' revealed; pwd\n" });
      const screen = await until(async () => {
        const view = await T("test.ptyScreen", { handle: terminal.pty });
        return view.screen.includes("cloud-revealed") && view.screen.includes(data.root) && view;
      }, 8000);
      requireCheck("native terminal receives relay output", screen, await T("test.ptyScreen", { handle: terminal.pty }));

      const agents = await call("persistent-agents", "list", { workspaceId: workspace.id });
      requireCheck("agent gateway reads the Cloud daemon", Array.isArray(agents?.sessions) || Array.isArray(agents), agents);
      await call("persistence", "acpProfiles.upsert", {
        profile: {
          id: "cloud-fixture", machineId: workspace.machineId, provider: "custom",
          name: "Fixture ACP", executable: data.node,
          args: [repo + "/tests/integration/fixtures/persistent-agent.mjs"], envRefs: {}, enabled: true,
        },
      });
      const agent = await call("persistent-agents", "create", {
        workspaceId: workspace.id, profileId: "cloud-fixture", name: "Cloud fixture agent", mcps: [],
      });
      requireCheck("agent-runner starts a real daemon session", agent.status === "ready", agent);
      const prompt = "ask-permission activity-fixture-private-text";
      await call("persistent-agents", "send", { workspaceId: workspace.id, id: agent.id, text: prompt });
      const report = await until(async () => {
        const { items } = await api("/activity");
        return items.find(item => item.id === host.id + ":" + agent.id && item.state === "attention");
      }, 15000);
      requireCheck("browser activity contains the daemon session after device-code enrolment",
        report?.title === "Cloud fixture agent" && report?.source === "Fixture ACP" &&
        report?.hostId === host.id && report?.kind === "agent" && report?.detail === "Waiting for you", report);
      requireCheck("activity omits the prompt, tool input and workspace path",
        !/activity-fixture-private-text|Fixture action/.test(JSON.stringify(report)) &&
        !JSON.stringify(report).includes(data.root), report);
      await call("persistent-agents", "stop", { workspaceId: workspace.id, id: agent.id });
      const definition = await call("workflows", "create", { workspaceId: workspace.id });
      const workflow = definition.definition || definition;
      workflow.name = "Cloud fixture workflow";
      workflow.blocks = [{ id: "probe", type: "script", label: "Remote script", command: "printf cloud-workflow", position: { x: 0, y: 0 } }];
      workflow.edges = [];
      const saved = await call("workflows", "save", { workspaceId: workspace.id, definition: workflow, expectedRevision: definition.revision ?? workflow.revision });
      const run = await call("workflows", "run", { workspaceId: workspace.id, id: saved.id || saved.definition?.id || workflow.id });
      const result = await until(async () => {
        const runView = await call("workflows", "runDetail", { workspaceId: workspace.id, runId: run.id });
        return runView?.blocks?.some(block => block.output === "cloud-workflow") && runView;
      }, 8000);
      requireCheck("workflow script executes on the Cloud daemon", result);

      const bundle = await T("test.readFile", { path: repo + "/Hato-plugins/build/modules/cloud.mjs" });
      const replacement = await T("test.stage", { id: "cloud", code: bundle + "\n// M3 fixture hot reload" });
      requireCheck("cloud service hot reload activates with a live terminal",
        (await T("test.activate", { id: "cloud", stageId: replacement.stageId })).ok);
      const restored = await until(async () => (await call("cloud", "status")).signedIn, 5000);
      const retained = await call("terminals", "attach", { workspaceId: workspace.id, key: "m3" });
      requireCheck("Cloud sign-in and terminal survive module reload", restored && retained.pty === terminal.pty);

      await api("/revoke", {});
      const expired = await until(async () => (await T("test.ptyScreen", { handle: terminal.pty })).exit, 5000);
      requireCheck("device revocation closes the live terminal", /Cloud connection closed/.test(expired || ""), expired);
      await call("cloud", "refresh").catch(() => {});
      requireCheck("session clears after revocation", !(await call("cloud", "status")).signedIn);
    } catch (e) { check("integration completed", false, e.message || String(e)); }
    await finish();
  },
};
