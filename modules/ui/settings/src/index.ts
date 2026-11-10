import { marketNodes, marketTab, refreshMarket, installPackage } from './marketplace';
import type { AppModule, ModuleContext, PluginInfo, SettingsExport, SettingsSection, SettingField, UiNode } from "../../../../sdk/types";
import { parseOrder, SPACER_PREFIX } from "../../../../sdk/settings-order";
import { uiTable, normalizeTableStyle } from "../../../../sdk/ui-table";
import { errMsg } from "../../../../sdk/runtime";

let open = false;
let selectedCategory = "";
let query = "";
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
function categoryGroup(category: Category): string {
  if (category.section?.group) return category.section.group;
  if (category.key === "plugins") return "Advanced";
  if (["appearance", "typography", "tables"].includes(category.section?.key || "")) return "Appearance";
  if (["side-panels", "sidebar-order", "panel-sharing", "workspace-chrome"].includes(category.section?.key || "")) return "Workspace";
  if (["viewer", "git-changes", "git-panel"].includes(category.module || "")) return "Editor & Git";
  if ((category.module || "").includes("mcp")) return "AI & tools";
  return "Tools & runtime";
}
function orderEditor(field: Extract<SettingField, { type: "order" }>, key: string): UiNode {
  let items: string[];
  try { items = parseOrder(field.value, field.items.map(i => i.id), field.allowSpacers); } catch { items = field.items.map(i => i.id); }
  const button = (id: string, text: string, operation: string, index = -1, disabled = false): UiNode => ({ type: "button", key: id, text, action: `order:${operation}`, value: { field: key, index }, small: true, variant: "ghost", disabled });
  return { type: "column", key, gap: 5, border: true, padding: 10, children: [
    { type: "row", key: "heading", gap: 6, children: [{ type: "label", key: "title", text: field.label, weight: "semibold", grow: true }, ...(field.allowSpacers ? [button("add", "+ Spacer", "add")] : [])] },
    ...items.map((id, index): UiNode => ({ type: "row", key: id, gap: 5, padding: 4, children: [
      { type: "label", key: "name", text: id.startsWith(SPACER_PREFIX) ? "— Spacer —" : field.items.find(i => i.id === id)?.label || id, color: id.startsWith(SPACER_PREFIX) ? "muted" : "default", grow: true, size: "sm" },
      button("up", "↑", "up", index, index === 0), button("down", "↓", "down", index, index === items.length - 1),
      ...(id.startsWith(SPACER_PREFIX) ? [button("remove", "×", "remove", index)] : []),
    ] })),
    ...(!items.length ? [{ type: "label", key: "empty", text: "No buttons here. Choose positions on the Side panels page.", color: "muted", wrap: true, size: "xs" } as UiNode] : []),
  ] };
}
const mod: AppModule = {
  id: "settings", moduleApiVersion: 1,
  async activate(ctx, prev) {
    open = !!prev?.open; query = prev?.query || "";
    ctx.events.on("workspace-layout.tableStyleChanged", () => ctx.ui.invalidate());
    selectedCategory = typeof prev?.selectedCategory === "string" ? prev.selectedCategory : "";
    // Refresh disk discovery when the plugin/settings UI loads, including newly built panels.
    // This uses the existing plugin manager; no window restart or new native permission is needed.
    if(ctx.host.plugins.rescan)await ctx.host.plugins.rescan();
    ctx.events.on("kernel.modules.changed", () => { void refresh(ctx); });
    await refresh(ctx);
  },
  deactivate() { for (const stop of subscriptions.values()) stop(); subscriptions.clear(); },
  snapshot: () => ({ open, selectedCategory, query }),
  methods: { async open(ctx, args) {
    open = true;
    if (typeof args?.module === "string" && typeof args?.section === "string") selectedCategory = JSON.stringify([args.module, args.section]);
    else if (args?.category === "plugins") selectedCategory = args.category;
    if (args?.category || args?.module) query = "";
    ctx.ui.invalidate(); await refresh(ctx);
  } },
  render(ctx): UiNode {
    if (!open) return { type: "column", key: "settings-closed", children: [] };
    const all = categories(ctx), needle = query.trim().toLowerCase();
    const list = all.filter(c => !needle || [c.title, c.section?.description, ...(c.section?.fields || []).flatMap(f => [f.label, f.description])].join(" ").toLowerCase().includes(needle));
    if (!list.length) return { type: "modal", key: "settings-modal", title: "Settings", width: 960, closeAction: "close", children: [
      { type: "textInput", key: "settings-search", value: query, changeAction: "search", placeholder: "Search settings…" },
      { type: "label", key: "none", text: "No matching settings.", color: "muted" },
    ] };
    // Default to the first module-contributed category (e.g. Appearance), else Plugins.
    const active = list.find(category => category.key === selectedCategory) || list.find(c => c.section?.key === "appearance") || list.find(c => c.key !== "plugins") || list[0];
    selectedCategory = active.key;
    const options: UiNode[] = [
      { type: "label", key: "category-title", text: active.title, weight: "semibold" },
    ];
    if (active.key === "plugins") options.push(...pluginsPage());
    if (active.error) options.push({ type: "status", key: "category-error", text: active.error, level: "error" });
    if (active.section?.description) options.push({ type: "label", key: "category-description", text: active.section.description, size: "sm", color: "muted", wrap: true });
    const tableRows: Parameters<typeof uiTable>[1] = [];
    for (const field of active.section?.fields || []) {
      if (!field || typeof field.key !== "string") continue;
      const fieldKey = JSON.stringify([active.module, active.section!.key, field.key]);
      if (field.type === "order") { options.push(orderEditor(field, fieldKey)); continue; }
      const control: UiNode = field.type === "toggle"
        ? { type: "toggle", key: fieldKey, label: active.section?.layout === "table" ? "" : field.label, checked: field.value, action: "change" }
        : { type: "select", key: fieldKey, value: field.value, options: field.options, action: "change", buttonStyle: { height: 32, fullWidth: true } };
      if (active.section?.layout === "table") tableRows.push({ key: fieldKey, label: field.label, description: field.description, control });
      else options.push({ type: "column", key: `${fieldKey}:field`, gap: 5, padding: 10, border: true, children: [
        ...(field.type === "select" ? [{ type: "label", key: "label", text: field.label, size: "sm", weight: "medium" } as UiNode] : []), control,
        ...(field.description ? [{ type: "label", key: "description", text: field.description, size: "xs", color: "muted", wrap: true } as UiNode] : []),
      ] });
    }
    if (tableRows.length) options.push(uiTable("preferences-table", tableRows, normalizeTableStyle(ctx.state.get("workspace-layout.tableStyle"))));
    const resetLabel = active.module ? ctx.state.get<SettingsExport>(`${active.module}.settings`)?.resetLabel : null;
    if (resetLabel) options.push({ type: "column", key: "reset-preferences", gap: 6, padding: 10, border: true, children: [
      { type: "label", key: "description", text: "Restore default appearance, typography, panel placement, sharing, sidebar buttons, spacers and table styling. Workflows, chats and provider settings are preserved.", size: "sm", color: "muted", wrap: true },
      { type: "button", key: "reset", text: resetLabel, action: "resetPreferences", value: active.module, variant: "danger", small: true },
    ] });
    const groups = ["Appearance", "Workspace", "Editor & Git", "AI & tools", "Tools & runtime", "Advanced"];
    const navigation: UiNode[] = [];
    for (const group of [...groups, ...new Set(list.map(categoryGroup).filter(g => !groups.includes(g)))]) {
      const entries = list.filter(c => categoryGroup(c) === group); if (!entries.length) continue;
      navigation.push({ type: "label", key: `group:${group}`, text: group.toUpperCase(), size: "xs", color: "muted", weight: "semibold", padding: 6 });
      navigation.push(...entries.map((category): UiNode => ({ type: "choice", key: category.key, text: category.title, selected: active.key === category.key,
        description: category.error ? "Needs attention" : undefined, action: "selectCategory", value: category.key })));
    }
    return { type: "modal", key: "settings-modal", title: "Settings", width: 960, closeAction: "close", children: [
      ...(error ? [{ type: "status", key: "error", text: error, level: "error" } as UiNode] : []),
      { type: "textInput", key: "settings-search", value: query, changeAction: "search", placeholder: "Search settings…" },
      { type: "row", key: "settings-content", height: 520, gap: 12, align: "stretch", children: [
        { type: "column", key: "categories", width: 200, gap: 4, scroll: true, borderSide: "right", children: navigation },
        { type: "column", key: `options:${active.key}`, gap: 10, grow: true, scroll: true, children: options },
      ] },
    ] };
  },
  async onEvent(ctx, event) {
    if (event.action === "resetPreferences") {
      const module = String(event.value || "");
      if (providers.includes(module) && ctx.state.get<SettingsExport>(`${module}.settings`)?.resetLabel) ctx.events.emit("settings.reset", { module });
      return;
    }
    if (event.action === "search") { query = String(event.value || ""); ctx.ui.invalidate(); return; }
    if (event.action.startsWith("order:")) {
      try {
        const payload: any = event.value; if (!payload || typeof payload.field !== "string") return;
        const [module, section, key] = JSON.parse(payload.field);
        const field = categories(ctx).find(c => c.module === module && c.section?.key === section)?.section?.fields.find(f => f.key === key);
        if (field?.type !== "order") return;
        const items = parseOrder(field.value, field.items.map(i => i.id), field.allowSpacers), index = Number(payload.index);
        const action = event.action.slice(6);
        if (action === "add" && field.allowSpacers) items.push(SPACER_PREFIX + crypto.randomUUID());
        else if (action === "remove" && items[index]?.startsWith(SPACER_PREFIX)) items.splice(index, 1);
        else if (action === "up" && index > 0 && index < items.length) [items[index - 1], items[index]] = [items[index], items[index - 1]];
        else if (action === "down" && index >= 0 && index + 1 < items.length) [items[index + 1], items[index]] = [items[index], items[index + 1]];
        else return;
        parseOrder(JSON.stringify(items), field.items.map(i => i.id), field.allowSpacers);
        ctx.events.emit("settings.change", { module, section, key, value: JSON.stringify(items) });
      } catch (e) { error = errMsg(e); ctx.ui.invalidate(); }
      return;
    }
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
    ...marketNodes(plugins, pluginBusy !== null),
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
    case "marketTab": marketTab(String(value)); ctx.ui.invalidate(); return;
    case "marketRefresh": return run("Checking marketplace…", async () => { await refreshMarket(ctx); return "Marketplace is up to date"; });
    case "marketInstall": return run("Installing package…", () => installPackage(ctx, String(value), plugins));
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
