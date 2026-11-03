// Concatenate lib.js before this driver and run with --headless-script.
export default {
  id: "__driver", moduleApiVersion: 1,
  async activate(ctx) {
    try {
      const call = (method, args) => ctx.modules.call("persistence", method, args);
      const scope = "machine:test-scoped", key = "integration.setting";
      const current = await call("scoped.get", { scope, key });
      const rev = current?.rev ?? 0;
      const writes = await Promise.allSettled([1, 2].map(value => call("scoped.set", { scope, key, value, expectedRev: rev })));
      check("scoped CAS permits only one concurrent writer", writes.filter(r => r.status === "fulfilled").length === 1);
      check("scoped CAS reports revision conflict", writes.some(r => r.status === "rejected" && String(r.reason).includes("ECONFLICT")));
      const resolved = await call("scoped.resolve", { scopes: ["workspace:missing", scope, "user"], key });
      check("scoped resolution selects machine fallback", resolved?.scope === scope && resolved.rev === rev + 1, resolved);
      let invalid = false;
      try { await call("scoped.set", { scope, key, value: null, rev: 1.5 }); } catch { invalid = true; }
      check("scoped revisions reject fractions", invalid);
      const layout = await T("test.render", { module: "workspace-layout" });
      const overlay = find(layout, (n) => n.key === "overlay:settings");
      check("Settings overlay reserves no workspace height", overlay && overlay.height === 0 && !!find(overlay, (n) => n.type === "slot" && n.module === "settings"));
      check("Settings button is on the top bar", !!find(layout, (n) => n.key === "baritem:top:settings"));
      await ev("workspace-layout", "openSettings");
      let menu = await T("test.render", { module: "settings" });
      check("Settings opens with an Appearance category", menu.type === "modal" && !!find(menu, (n) => n.type === "choice" && n.text === "Appearance"));
      check("Settings has a Plugins page", !!find(menu, (n) => n.type === "choice" && n.text === "Plugins"));
      // Color mode is a layout-module preference applied through the theme node.
      await ev("settings", "selectCategory", { value: JSON.stringify(["workspace-layout", "appearance"]) });
      menu = await T("test.render", { module: "settings" });
      const modeField = find(menu, (n) => n.type === "select" && /"mode"/.test(n.key));
      check("appearance exports a color mode", !!modeField, menu);
      if (modeField) {
        await ev("settings", "change", { key: modeField.key, value: "light" });
        const themed = await until(async () => {
          const layout = await T("test.render", { module: "workspace-layout" });
          return find(layout, (n) => n.type === "theme" && n.mode === "light");
        });
        check("color mode reaches the theme node", !!themed);
        const saved = await ctx.modules.call("persistence", "settings.get", { key: "appearance.mode" });
        check("color mode persisted", saved === "light", saved);
      }
      await ev("settings", "selectCategory", { value: JSON.stringify(["viewer", "viewer"]) });
      menu = await T("test.render", { module: "settings" });
      const field = find(menu, (n) => n.type === "toggle" && n.label === "Show file metadata");
      check("viewer exports a setting", !!field);
      if (field) {
        const next = !field.checked;
        await ev("settings", "change", { key: field.key, value: next });
        const saved = await until(async () => {
          const value = await ctx.modules.call("persistence", "settings.get", { key: "viewer.showMetadata" });
          return value === next ? { value } : null;
        });
        check("module applies and persists edits", !!saved);
        menu = await T("test.render", { module: "settings" });
        check("menu shows confirmed value", find(menu, (n) => n.type === "toggle" && n.label === "Show file metadata")?.checked === next);
      }
      await ev("settings", "close");
      check("Settings closes", (await T("test.render", { module: "settings" })).key === "settings-closed");
    } catch (e) { check("uncaught", false, String(e)); }
    await finish();
  },
};
