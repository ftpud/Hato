// Real kernel process/stream primitives and real servers, in an isolated local workspace.
// HATO_T_TS_SERVER is required. HATO_T_JDTLS optionally adds Java (set JAVA_HOME for its JDK).
export default {
  id: "__driver", moduleApiVersion: 1,
  async activate(ctx) {
    const call = (m, method, args) => ctx.modules.call(m, method, args || {}, { timeoutMs: 160000 });
    try {
      await T("test.approvals", { policy: "allow" });
      const languageIds = ["language-service", "language-java", "language-typescript", "language-sap", "language-tools", "language-status"];
      const before = await ctx.host.plugins.list();
      check("language plugins are absent before marketplace installation", languageIds.every(id => !before.plugins.some(p => p.id === id)));
      const repoRoot = ctx.host.env.info().repoRoot;
      const catalogue = JSON.parse(await T("test.readFile", { path: `${repoRoot}/Hato-plugins/catalogue.json` }));
      await T("test.pluginInstallMany", { paths: languageIds.map(id => {
        const pkg = catalogue.packages.find(p => p.modules.includes(id));
        return `${repoRoot}/Hato-plugins/packages/${pkg.id}/${pkg.version}/${id}`;
      }) });
      const installed = await ctx.host.plugins.list();
      check("marketplace installation creates disabled user plugins", languageIds.every(id => installed.plugins.some(p => p.id === id && p.source === "user" && !p.enabled)));
      const approvals = await T("test.approvalLog");
      check("marketplace installation requests language-service permissions", approvals.some(a => a.operation === "plugins.install" && a.detail.includes("language-service: process.scope") && a.detail.includes("language-service: call:workspace")));
      for (const id of languageIds) await T("test.pluginEnable", { id });
      const enabled = await ctx.host.plugins.list();
      check("language packages enable as user plugins", languageIds.every(id => enabled.plugins.some(p => p.id === id && p.source === "user" && p.enabled && p.active)));
      const exportedTools=await T("test.state",{key:"language-service.mcp"});
      check("language service publishes its own scoped MCP tool namespace",["project_get","project_update","server_restart","index_rebuild","workspace_symbols","server_logs"].every(name=>exportedTools?.tools?.some(tool=>tool.name===name)));
      const mcpSettings=await until(async()=>{
        const settings=await T("test.state",{key:"internal-mcp.settings"});
        return settings?.sections?.find(section=>section.key==="mcp:language-service");
      });
      check("new language MCP tools are discovered and remain opt-in",mcpSettings?.fields?.length===6&&mcpSettings.fields.every(field=>field.value===false));
      const executable = await T("test.env", { name: "HATO_T_TS_SERVER" });
      if (!executable) throw new Error("Set HATO_T_TS_SERVER to a real typescript-language-server launcher");
      const root = (await T("test.exec", { argv: ["mktemp", "-d", "/tmp/hato-language-kernel-XXXXXX"] })).stdout.trim();
      await T("test.exec", { argv: ["git", "init", "-b", "main"], cwd: root });
      const grant = await ctx.host.capabilities.request({ kind: "fs", root, write: true, target: { kind: "local" } });
      const write = (name, text) => ctx.host.fs.writeAtomic(grant.grant, name, text);
      await write("tsconfig.json", JSON.stringify({ compilerOptions: { target: "ES2020", module: "commonjs" }, include: ["*.ts"] }));
      await write("target.ts", "export const target = 42;\n");
      const text = 'import { target } from "./target";\nconsole.log(target);\n';
      await write("main.ts", text);
      await write("model.cds", "namespace demo;\nentity Books { key ID: UUID; title: String; }\n");
      await write("production.mtaext", "_schema-version: '3.1'\nID: demo.prod\nextends: demo\n");
      await call("projects", "addLocal", { path: root });
      const project = (await call("projects", "tree")).find(p => p.rootPath === root || p.rootPath === "/private" + root);
      const workspaceId = `project:${project.id}:root`;
      await call("workspace", "select", { workspaceId });
      await call("persistence", "scoped.set", { scope: `workspace:${workspaceId}`, key: "language-server.typescript-language-server.executable", value: executable });
      for (const [path, language, lexical] of [["model.cds", "text", true], ["production.mtaext", "yaml", false], ["main.ts", "typescript", false]]) {
        await call("workspace", "view.patch", { workspaceId, patch: { previewPath: path } });
        const editor = await until(async () => {
          const node = find(await T("test.render", { module: "viewer" }), n => n.type === "codeViewer" && n.document);
          return node?.language === language ? node : null;
        });
        check(`${path} selects plugin highlighting`, !!editor && (!lexical || editor.syntaxRules.length > 0));
      }
      const editor = find(await T("test.render", { module: "viewer" }), n => n.type === "codeViewer");
      const args = { ...editor.definitionArgs, document: editor.document, text, position: { line: 1, character: 14 } };
      const links = await call("viewer", "editor.definitions", args);
      check("real kernel LSP returns a cross-file definition", links.some(l => l.targetUri.endsWith("/target.ts")), links);
      if (links[0]) {
        await ev("viewer", "openDefinition", { value: { document: editor.document, uri: links[0].targetUri, selection: links[0].targetSelectionRange } });
        check("definition activation opens and reveals the target", !!await until(async () => {
          const node = find(await T("test.render", { module: "viewer" }), n => n.type === "codeViewer");
          return node?.definitionArgs?.path === "target.ts" && node.reveal?.line === 0;
        }));
      }
      const sshKey = await T("test.env", { name: "HATO_T_SSH_KEY" });
      if (sshKey) {
        const remote = await call("projects", "addSsh", { host: "127.0.0.1", port: Number(await T("test.env", { name: "HATO_T_SSH_PORT" })),
          user: await T("test.env", { name: "HATO_T_SSH_USER" }), identityFile: sshKey, remotePath: project.rootPath, name: "Language SSH smoke" });
        const remoteWorkspaceId = `project:${remote.id}:root`;
        await call("persistence", "scoped.set", { scope: `workspace:${remoteWorkspaceId}`, key: "language-server.typescript-language-server.executable", value: executable });
        const remoteLinks = await call("language-service", "definitions", { workspaceId: remoteWorkspaceId, path: "main.ts", text, position: { line: 1, character: 14 } });
        check("real SSH process and streams return a remote cross-file definition", remoteLinks.some(l => l.targetUri.endsWith("/target.ts")), remoteLinks);
      }
      const jdtls = await T("test.env", { name: "HATO_T_JDTLS" });
      if (jdtls) {
        const javaText = "class Main {\n  static int target = 1;\n  int value = target;\n  void run() {}\n}\n";
        await write("Main.java", javaText);
        await write("Other.java", "class Other {}\n");
        await call("persistence", "scoped.set", { scope: `workspace:${workspaceId}`, key: "language-server.jdtls.executable", value: jdtls });
        await call("language-service", "project.set", { workspaceId, serverId: "jdtls", config: { enabled: true, values: { sourcePaths: ["."], outputPath: "bin" } } });
        await call("workspace", "view.patch", { workspaceId, patch: { previewPath: "Main.java" } });
        const javaEditor = await until(async () => {
          const node = find(await T("test.render", { module: "viewer" }), n => n.type === "codeViewer");
          return node?.definitionArgs?.path === "Main.java" && node;
        });
        check("Java editor exposes hover and completion module callbacks", javaEditor?.hoverMethod === "editor.hover" && javaEditor?.completionMethod === "editor.completions");
        const autoStatus = await until(async () => {
          const result = await call("language-service", "project.get", { workspaceId, serverId: "jdtls" });
          return result.status.capabilities?.definitionProvider && result;
        }, 120000, 250);
        check("opening Java starts JDTLS before a navigation request", !!autoStatus, autoStatus);
        const java = await call("language-service", "definitions", { workspaceId, path: "Main.java", text: javaText, position: { line: 2, character: 15 } });
        check("real kernel JDTLS returns a Java definition", java.some(l => l.targetUri.endsWith("/Main.java") && l.targetSelectionRange.start.line === 1), java);
        const projectSymbols=await until(async()=>{
          const symbols=await call("language-service","workspaceSymbols",{workspaceId,serverId:"jdtls",query:"Other"});
          return symbols.some(s=>s.path==="Other.java")&&symbols;
        },30000,500);
        check("Java project search finds an unopened source file",!!projectSymbols,projectSymbols);
        const statusNode=await T("test.render",{module:"language-status"});
        check("global bottom bar exposes language and project-symbol controls",!!find(statusNode,n=>n.action==="symbols"));
        const projectSettings = await call("language-service", "project.get", { workspaceId, serverId: "jdtls" });
        check("Java project source folders and active server status are visible", projectSettings.config.values.sourcePaths[0] === "." && !!projectSettings.status.capabilities.documentSymbolProvider, projectSettings);
        const hover = await call("viewer", "editor.hover", { ...javaEditor.definitionArgs, document: javaEditor.document, text: javaText, position: { line: 2, character: 15 } });
        check("Java hover returns context through the viewer", !!hover?.contents, hover);
        const symbols = await call("language-service", "symbols", { workspaceId, path: "Main.java", text: javaText });
        check("Java method picker includes methods", symbols.some(s => s.name.includes("run")), symbols);
        await ev("language-status", "symbols");
        await ev("language-tools", "languageSymbolScope", {value:"file"});
        await ev("language-tools", "languageSymbols");
        check("global dialog shows the method picker", !!await until(async () => find(await T("test.render", { module: "language-tools" }), n => n.action === "languageSymbol" && n.text.includes("run"))));
        await ev("language-tools", "languageClose");
        await ev("language-status", "open");
        check("global dialog shows Java project configuration", !!await until(async()=>find(await T("test.render", { module: "language-tools" }), n => n.key === "project-enabled")));
        await ev("language-tools", "languageBrowse:sourcePaths");
        check("Java source folders can be browsed on the workspace", !!find(await T("test.render", { module: "language-tools" }), n => n.action === "languageChooseDir"));
        await ev("language-tools", "languageClose");
      }
    } catch (error) { check("uncaught", false, String(error) + "\n" + error.stack); }
    await finish();
  },
};
