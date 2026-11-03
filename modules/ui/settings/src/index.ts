import type { AppModule, ModuleContext, PluginInfo, SettingsExport, SettingsSection, UiNode } from "../../../../sdk/types";
import { errMsg } from "../../../../sdk/runtime";

let open = false;
let selectedCategory = "";
let error: string | null = null;
let providers: string[] = [];
const subscriptions = new Map<string, () => void>();
let refreshVersion = 0;
// Plugins page state.
let plugins: PluginInfo[] = [];
let rootPlugin: string | null = null;
let rootOverride: string | null = null;
let pluginBusy: string | null = null;
let pluginStatus: { level: "info" | "error" | "success" | "warn"; text: string } | null = null;
/** Plugin whose disable failed because others depend on it (offer a cascade). */
let pendingCascade: { id: string; dependents: string } | null = null;

async function refresh(ctx: ModuleContext) {
  const version = ++refreshVersion;
  try {
    const modules = await ctx.host.modules.list();
    if (version !== refreshVersion) return;
    providers = modules.filter((m) => m.active && m.id !== ctx.moduleId).map((m) => m.id).sort();
    const list = await ctx.host.plugins.list();
    if (version !== refreshVersion) return;
    plugins = list.plugins; rootPlugin = list.root; rootOverride = list.rootOverride;
    for (const [id, stop] of subscriptions) if (!providers.includes(id)) { stop(); subscriptions.delete(id); }
    for (const id of providers) if (!subscriptions.has(id)) {
      subscriptions.set(id, ctx.state.watch(`${id}.settings`, () => ctx.ui.invalidate()));
    }
    error = null;
  } catch (e) { if (version === refreshVersion) error = errMsg(e); }
  ctx.ui.invalidate();
}

interface Category { key: string; title: string; module?: string; section?: SettingsSection; error?: string | null }
function categories(ctx: ModuleContext): Category[] {
  const result: Category[] = [{ key: "plugins", title: "Plugins" }];
  const seen = new Set<string>();
  for (const module of providers) {
    const contribution = ctx.state.get<SettingsExport>(`${module}.settings`);
    if (!Array.isArray(contribution?.sections)) continue;
    for (const section of contribution.sections) {
      if (!section || typeof section.key !== "string" || !Array.isArray(section.fields)) continue;
      const key = JSON.stringify([module, section.key]);
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({ key, title: section.title || section.key, module, section, error: contribution.error });
    }
  }
  return result;
}
const mod: AppModule = {
  id: "settings", moduleApiVersion: 1,
  async activate(ctx, prev) {
    open = !!prev?.open;
    selectedCategory = typeof prev?.selectedCategory === "string" ? prev.selectedCategory : "";
    // Refresh disk discovery when the plugin/settings UI loads, including newly built panels.
    // This uses the existing plugin manager; no window restart or new native permission is needed.
    if(ctx.host.plugins.rescan)await ctx.host.plugins.rescan();
    ctx.events.on("kernel.modules.changed", () => { void refresh(ctx); });
    await refresh(ctx);
  },
  deactivate() { for (const stop of subscriptions.values()) stop(); subscriptions.clear(); },
  snapshot: () => ({ open, selectedCategory }),
  methods: { async open(ctx, args) {
    open = true;
    if (typeof args?.module === "string" && typeof args?.section === "string") selectedCategory = JSON.stringify([args.module, args.section]);
    else if (args?.category === "plugins") selectedCategory = args.category;
    ctx.ui.invalidate(); await refresh(ctx);
  } },
  render(ctx): UiNode {
    if (!open) return { type: "column", key: "settings-closed", children: [] };
    const list = categories(ctx);
    // Default to the first module-contributed category (e.g. Appearance), else Plugins.
    const active = list.find(category => category.key === selectedCategory) || list[1] || list[0];
    selectedCategory = active.key;
    const options: UiNode[] = [
      { type: "label", key: "category-title", text: active.title, weight: "semibold" },
    ];
    if (active.key === "plugins") options.push(...pluginsPage());
    if (active.error) options.push({ type: "status", key: "category-error", text: active.error, level: "error" });
    if (active.section?.description) options.push({ type: "label", key: "category-description", text: active.section.description, size: "sm", color: "muted", wrap: true });
    for (const field of active.section?.fields || []) {
      if (!field || typeof field.key !== "string") continue;
      const fieldKey = JSON.stringify([active.module, active.section!.key, field.key]);
      if (field.type === "toggle") options.push({ type: "toggle", key: fieldKey, label: field.label, checked: field.value, action: "change" });
      else if (field.type === "select" && Array.isArray(field.options)) options.push(
        { type: "label", key: `${fieldKey}:label`, text: field.label, size: "sm", weight: "medium" },
        { type: "select", key: fieldKey, value: field.value, options: field.options, action: "change", grow: false },
      );
      if (field.description) options.push({ type: "label", key: `${fieldKey}:description`, text: field.description, size: "xs", color: "muted", wrap: true });
    }
    return { type: "modal", key: "settings-modal", title: "Settings", closeAction: "close", children: [
      ...(error ? [{ type: "status", key: "error", text: error, level: "error" } as UiNode] : []),
      { type: "row", key: "settings-content", height: 380, gap: 12, align: "stretch", children: [
        { type: "column", key: "categories", width: 170, gap: 4, scroll: true, borderSide: "right", children: list.map(category => ({
          type: "choice", key: category.key, text: category.title, selected: active.key === category.key,
          description: category.error ? "Needs attention" : undefined, action: "selectCategory", value: category.key,
        })) },
        { type: "column", key: `options:${active.key}`, gap: 10, grow: true, scroll: true, children: options },
      ] },
    ] };
  },
  async onEvent(ctx, event) {
    if (event.action === "close") { open = false; ctx.ui.invalidate(); return; }
    if (event.action === "plugin:toggle" && event.key.startsWith("enabled:")) { await togglePlugin(ctx, event.key.slice(8), !!event.value); return; }
    if (event.action.startsWith("plugin:")) { await pluginAction(ctx, event.action.slice(7), event.value); return; }
    if (event.action === "selectCategory") {
      if (categories(ctx).some(category => category.key === event.value)) selectedCategory = String(event.value);
      ctx.ui.invalidate(); return;
    }
    if (event.action !== "change") return;
    try {
      const [module, section, key] = JSON.parse(event.key);
      const category = categories(ctx).find(category => category.module === module && category.section?.key === section);
      if (!category || !category.section!.fields.some(field => field.key === key)) return;
      ctx.events.emit("settings.change", { module, section, key, value: event.value });
    } catch (e) { error = errMsg(e); ctx.ui.invalidate(); }
  },
};
export default mod;

// ---- Plugins page ---------------------------------------------------------------------------------

function pluginRow(p: PluginInfo): UiNode {
  const status = !p.enabled ? "disabled" : p.active ? p.active : p.lastError ? "failed" : "loading";
  const facts = [p.kind, p.source === "user" ? "user plugin" : "built-in", p.runsOn !== "ui" ? `runs on: ${p.runsOn}` : null,
    p.provides.length ? `provides ${p.provides.join(", ")}` : null, p.requires.length ? `needs ${p.requires.join(", ")}` : null].filter(Boolean).join(" · ");
  const isRootProvider = p.provides.includes("shell.root");
  const busy = pluginBusy !== null;
  return { type: "column", key: `plugin:${p.id}`, gap: 4, padding: 8, border: true, children: [
    { type: "row", key: "head", gap: 8, align: "center", children: [
      { type: "column", key: "title", grow: true, gap: 2, children: [
        { type: "label", key: "name", text: p.name === p.id ? p.id : `${p.name}  (${p.id})`, weight: "semibold", size: "sm" },
        { type: "label", key: "facts", text: facts, size: "xs", color: "muted" },
      ] },
      { type: "label", key: "status", text: status, size: "xs", color: !p.enabled ? "muted" : p.active ? "success" : "danger", mono: true },
      { type: "switch", key: `enabled:${p.id}`, label: "", checked: p.enabled, action: "plugin:toggle", disabled: busy || p.id === "settings",
        tooltip: p.id === "settings" ? "Settings cannot disable itself" : p.enabled ? "Disable plugin" : p.pendingApprovals.length ? "Enable (asks to approve its permissions)" : "Enable plugin" } as UiNode,
    ] },
    ...(p.description ? [{ type: "label", key: "desc", text: p.description, size: "xs", color: "muted", wrap: true } as UiNode] : []),
    ...(p.pendingApprovals.length && !p.enabled ? [{ type: "label", key: "perm", text: `Needs approval: ${p.pendingApprovals.join(", ")}`, size: "xs", color: "warning", wrap: true } as UiNode] : []),
    ...(p.enabled && p.lastError && !p.active ? [{ type: "label", key: "err", text: p.lastError, size: "xs", color: "danger", wrap: true } as UiNode] : []),
    ...(isRootProvider || p.source === "user" ? [{ type: "row", key: "actions", gap: 6, children: [
      ...(isRootProvider ? [{ type: "button", key: "root", text: rootPlugin === p.id ? (rootOverride === p.id ? "Window root (pinned)" : "Window root") : "Use as window root",
        action: "plugin:setRoot", value: p.id, small: true, disabled: busy || !p.enabled || rootOverride === p.id } as UiNode] : []),
      ...(rootOverride === p.id ? [{ type: "button", key: "unpin", text: "Automatic root", action: "plugin:setRoot", value: null, small: true, disabled: busy } as UiNode] : []),
      ...(p.source === "user" ? [{ type: "button", key: "uninstall", text: "Uninstall", action: "plugin:uninstall", value: p.id, small: true, variant: "danger", disabled: busy } as UiNode] : []),
    ] } as UiNode] : []),
  ] };
}

function pluginsPage(): UiNode[] {
  const user = plugins.filter((p) => p.source === "user");
  const builtin = plugins.filter((p) => p.source === "builtin");
  return [
    { type: "label", key: "plugins-hint", text: "Everything in Hato is a plugin. Disable built-ins you do not need, or install your own: a folder with manifest.json and a built dist/<id>.mjs. New plugins stay disabled until you enable them and approve their permissions.", size: "sm", color: "muted", wrap: true },
    { type: "row", key: "plugin-tools", gap: 6, children: [
      { type: "button", key: "install", text: "Install from folder…", action: "plugin:install", small: true, variant: "primary", disabled: pluginBusy !== null },
      { type: "button", key: "rescan", text: "Rescan plugins folder", action: "plugin:rescan", small: true, disabled: pluginBusy !== null },
    ] },
    ...(pluginBusy ? [{ type: "progress", key: "plugin-busy", indeterminate: true, label: pluginBusy } as UiNode] : []),
    ...(pluginStatus ? [{ type: "status", key: "plugin-status", text: pluginStatus.text, level: pluginStatus.level } as UiNode] : []),
    ...(pendingCascade ? [{ type: "row", key: "cascade", gap: 6, align: "center", children: [
      { type: "label", key: "t", text: `Also disable: ${pendingCascade.dependents}?`, size: "sm", grow: true, wrap: true },
      { type: "button", key: "yes", text: "Disable all", action: "plugin:cascade", value: pendingCascade.id, small: true, variant: "danger" },
      { type: "button", key: "no", text: "Cancel", action: "plugin:cancelCascade", small: true },
    ] } as UiNode] : []),
    ...(user.length ? [{ type: "label", key: "user-h", text: "Your plugins", weight: "semibold", size: "sm" } as UiNode, ...user.map(pluginRow)] : []),
    { type: "label", key: "builtin-h", text: "Built-in plugins", weight: "semibold", size: "sm" },
    ...builtin.map(pluginRow),
  ];
}

async function pluginAction(ctx: ModuleContext, action: string, value: any) {
  const run = async (label: string, fn: () => Promise<string | null>) => {
    pluginBusy = label; pluginStatus = null; ctx.ui.invalidate();
    try { const text = await fn(); if (text) pluginStatus = { level: "success", text }; }
    catch (e: any) {
      if (e?.code === "EDEPENDENTS") pendingCascade = { id: String(value), dependents: errMsg(e).replace(/^.*?:\s*/, "") };
      else pluginStatus = { level: "error", text: errMsg(e) };
    } finally { pluginBusy = null; await refresh(ctx); }
  };
  switch (action) {
    case "setRoot": return run("Changing window root…", async () => { await ctx.host.plugins.setRoot(typeof value === "string" ? value : null); return null; });
    case "uninstall": return run(`Uninstalling ${value}…`, async () => { await ctx.host.plugins.uninstall(String(value)); return `Uninstalled ${value}`; });
    case "rescan": return run("Scanning plugins folder…", async () => { const r = await ctx.host.plugins.rescan(); return r.added.length ? `Found ${r.added.join(", ")}` : "No new plugins"; });
    case "install": return run("Installing plugin…", async () => {
      const path = await ctx.host.ui.pickFolder();
      if (!path) return null;
      const r = await ctx.host.plugins.install(path);
      return `Installed ${r.id}. Enable it below to load it.`;
    });
    case "cascade": { const id = String(value); pendingCascade = null; return run(`Disabling ${id}…`, async () => { const r = await ctx.host.plugins.disable(id, { cascade: true }); return `Disabled ${r.disabled.join(", ")}`; }); }
    case "cancelCascade": pendingCascade = null; ctx.ui.invalidate(); return;
  }
}

async function togglePlugin(ctx: ModuleContext, id: string, enabled: boolean) {
  pluginBusy = `${enabled ? "Enabling" : "Disabling"} ${id}…`; pluginStatus = null; pendingCascade = null; ctx.ui.invalidate();
  try {
    if (enabled) {
      const r = await ctx.host.plugins.enable(id);
      pluginStatus = r.active ? { level: "success", text: `${id} enabled` } : { level: "warn", text: `${id} enabled but not running: ${r.error || "unknown error"}` };
    } else {
      const r = await ctx.host.plugins.disable(id);
      pluginStatus = { level: "success", text: `Disabled ${r.disabled.join(", ")}` };
    }
  } catch (e: any) {
    if (e?.code === "EDEPENDENTS") pendingCascade = { id, dependents: errMsg(e).replace(/^.*?:\s*/, "") };
    else pluginStatus = { level: "error", text: errMsg(e) };
  } finally { pluginBusy = null; await refresh(ctx); }
}
