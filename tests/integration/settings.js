// Concatenate lib.js before this driver and run with --headless-script.
export default {
  id: "__driver", moduleApiVersion: 1,
  async activate(ctx) {
    try {
      const layout = await T("test.render", { module: "workspace-layout" });
      const overlay = find(layout, (n) => n.key === "settings-overlay");
      check("Settings overlay reserves no workspace height", overlay && overlay.height === 0 && !!find(overlay, (n) => n.key === "settings-slot"));
      check("Settings button is on the top bar", !!find(layout, (n) => n.key === "baritem:top:settings"));
      await ev("workspace-layout", "openSettings");
      let menu = await T("test.render", { module: "settings" });
      check("Settings opens with appearance control", menu.type === "modal" && !!find(menu, (n) => n.type === "appearanceControl"));
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
        check("menu shows confirmed value", find(menu, (n) => n.type === "toggle")?.checked === next);
      }
      await ev("settings", "close");
      check("Settings closes", (await T("test.render", { module: "settings" })).key === "settings-closed");
    } catch (e) { check("uncaught", false, String(e)); }
    await finish();
  },
};
