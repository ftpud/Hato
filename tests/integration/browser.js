// Browser sessions end to end against a real local Chrome/Chromium (or the managed headless shell):
// install the marketplace modules from prepared folders, start a session, read text/elements,
// click/type through agent actions and panel surface input, screenshots, network log, reattach.
// Prepare: BROWSER_PKG=/tmp/hato-browser-pkg with <id>/manifest.json and <id>/dist/<id>.mjs.
export default {
  id: "__driver", moduleApiVersion: 1,
  async activate(ctx) {
    const call = (method, args, timeoutMs = 120000) => ctx.modules.call("browser", method, args || {}, { timeoutMs });
    let id = null;
    try {
      await T("test.approvals", { policy: "allow" });
      const pkg = (await T("test.env", { name: "BROWSER_PKG" })) || "/tmp/hato-browser-pkg";
      await T("test.pluginInstallMany", { paths: [`${pkg}/browser`, `${pkg}/browser-panel`] });
      for (const m of ["browser", "browser-panel"]) await T("test.pluginEnable", { id: m }).catch(() => {});
      const active = await until(async () => (await ctx.host.plugins.list()).plugins.filter(p => (p.id === "browser" || p.id === "browser-panel") && p.active).length === 2, 20000);
      check("browser modules install and activate", active);

      const created = await call("create", { spec: { name: "Test", location: { kind: "local" }, agentAccess: true, keepProfile: false, viewport: { width: 900, height: 600 } } });
      id = created.id;
      const running = await until(async () => { const s = (await call("list")).sessions.find(s => s.id === id); return s.status === "running" ? s : s.status === "error" ? { error: s.error } : null; }, 120000, 250);
      check("session starts", running && running.status === "running", running);
      check("session has a surface", running && typeof running.surface === "string", running && running.surface);

      const html = "<title>T</title><style>body{font:16px sans-serif;margin:40px}</style><input id=i placeholder=Name><button id=b onclick=\"document.title='clicked:'+document.getElementById('i').value\">Go</button><p>Hello visible text</p><p style='display:none'>hidden text</p>";
      await call("navigate", { id, url: "data:text/html," + encodeURIComponent(html) });
      const s1 = await until(async () => { const s = (await call("list")).sessions.find(s => s.id === id); return s.url.startsWith("data:") && s.title === "T" ? s : null; }, 10000);
      check("navigation and title are published", !!s1, s1 && s1.title);

      // Agent-side operations through the service (same code paths as the MCP commands).
      const panelSurface = find(await T("test.render", { module: "browser-panel" }), n => n.type === "surface");
      check("panel renders the session surface", panelSurface && panelSurface.surface === s1.surface, panelSurface);

      const shot = await call("screenshot", { id, quality: "low" });
      check("low screenshot is a JPEG", shot.mimeType === "image/jpeg" && shot.data.startsWith("/9j/"), shot.mimeType);
      const full = await call("screenshot", { id, quality: "full" });
      check("full screenshot is a PNG", full.mimeType === "image/png" && full.data.startsWith("iVBOR"), full.mimeType);

      // Panel input: click into the field, type through key events, click the button.
      const health = await ctx.modules.call("browser", "health", {});
      check("service healthy", health && health.ok);
      const frame = await call("screenshot", { id, quality: "full" });
      check("viewport matches spec", frame.cssWidth === 900 && frame.cssHeight === 600, [frame.cssWidth, frame.cssHeight]);
      const input = { x: 120, y: 52 };
      const mods = { shift: false, ctrl: false, alt: false, meta: false };
      await ev("browser-panel", "ptr", { value: { kind: "down", x: input.x, y: input.y, button: "left", buttons: 1, clickCount: 1, modifiers: mods } });
      await ev("browser-panel", "ptr", { value: { kind: "up", x: input.x, y: input.y, button: "left", buttons: 0, clickCount: 1, modifiers: mods } });
      for (const ch of "Ann") await ev("browser-panel", "key", { value: { kind: "down", key: ch.toLowerCase(), text: ch, modifiers: { ...mods, shift: ch !== ch.toLowerCase() } } });
      await ev("browser-panel", "key", { value: { kind: "paste", text: "a" } });
      await sleep(600);
      const els = await call("elements", { id });
      const button = els.elements.find(e => e.tag === "button");
      check("elements list the button", !!button, els.elements);
      await ev("browser-panel", "ptr", { value: { kind: "down", x: button.x, y: button.y, button: "left", buttons: 1, clickCount: 1, modifiers: mods } });
      await ev("browser-panel", "ptr", { value: { kind: "up", x: button.x, y: button.y, button: "left", buttons: 0, clickCount: 1, modifiers: mods } });
      const title = async () => (await call("evaluate", { id, expression: "document.title" })).value;
      const clicked = await until(async () => { const t = await title(); return t.startsWith("clicked:") ? t : null; }, 5000);
      check("panel pointer and keys reach the page", clicked === "clicked:Anna", clicked);

      const text = await call("text", { id, scope: "page" });
      check("visible text excludes hidden text", text.text.includes("Hello visible text") && !text.text.includes("hidden text"), text.text);
      const vtext = await call("text", { id, scope: "viewport" });
      check("viewport text", vtext.text.includes("Hello visible text"), vtext.text);
      const input2 = els.elements.find(e => e.tag === "input");
      await call("type", { id, ref: input2.ref, text: "Bob", clear: true });
      await call("click", { id, ref: button.ref });
      check("agent type + click by ref", await until(async () => (await title()) === "clicked:Bob", 5000), await title());
      const published = await until(async () => { const s = (await call("list")).sessions.find(s => s.id === id); return s.title === "clicked:Bob" ? s : null; }, 5000);
      check("script-set title is published", !!published);
      check("agent activity is published", published && published.agent && /Click/.test(published.agent.text), published && published.agent);

      const net = await call("navigate", { id, url: "https://example.com/" }).catch(e => ({ error: String(e) }));
      if (!net.error) {
        await sleep(1000);
        const log = await call("network", { id, filter: "example.com" });
        check("network log records the document request", log.requests.some(r => r.type === "Document" && r.status === 200), log.requests.slice(-3));
        const doc = log.requests.find(r => r.type === "Document");
        if (doc) { const body = await call("networkBody", { id, requestId: doc.requestId }); check("response body is readable", /Example Domain/.test(body.body), body.body.slice(0, 80)); }
      } else check("network (skipped: offline)", true, net.error);

      // MCP tool behavior via the published registry contribution.
      const mcp = await T("test.state", { key: "browser.mcp" });
      const names = (mcp && mcp.tools || []).map(t => t.name);
      check("agent commands are published", ["browser_click", "browser_text", "browser_screenshot", "browser_network", "browser_type", "browser_elements"].every(n => names.includes(n)), names);
      const root = await T("test.env", { name: "PWD" });
      const project = await ctx.modules.call("projects", "addLocal", { path: root });
      const workspaceId = `project:${project.id}:root`;
      const { server } = await ctx.modules.call("internal-local-mcp", "endpoint", { workspaceId, conversationId: "browser-integration" });
      const toolName = "browser__browser_screenshot";
      await until(async () => (await T("test.state", { key: "internal-mcp.settings" }))?.sections
        ?.some(section => section.fields?.some(field => field.key === toolName)));
      await ev("settings", "change", { key: JSON.stringify(["internal-mcp", "mcp:browser", toolName]), value: true });
      await until(async () => (await ctx.modules.call("internal-local-mcp", "tools", {})).some(tool => tool.name === toolName));
      const request = { method: "tools/call", params: { name: toolName, arguments: { session: id, quality: "low" } } };
      const result = await T("test.exec", { argv: ["node", `${root}/tests/integration/fixtures/mcp-client.mjs`, JSON.stringify(server), JSON.stringify(request)] });
      if (result.code !== 0) throw new Error(result.stderr || "MCP client failed");
      const response = JSON.parse(result.stdout).result;
      check("desktop MCP returns a native JPEG content block", !response.isError && response.content.some(c => c.type === "image" && c.mimeType === "image/jpeg" && c.data.startsWith("/9j/")));
      await ctx.modules.call("internal-local-mcp", "revoke", { conversationId: "browser-integration" });

    } catch (error) { check("uncaught", false, String(error) + "\n" + (error && error.stack)); }
    try {
      if (id) {
        // Reattach: disconnect without killing, then connect again to the same process and tab.
        await call("stop", { id, kill: false });
        await call("start", { id });
        const s = (await call("list")).sessions.find(s => s.id === id);
        check("reattach keeps the same tab", s.status === "running" && s.tabs.length >= 1 && s.url !== "about:blank", { status: s.status, url: s.url.slice(0, 40), error: s.error });
        await call("remove", { id, deleteProfile: true });
      }
    } catch (error) { check("reattach", false, String(error)); }
    await finish();
  },
};
