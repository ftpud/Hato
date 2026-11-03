import type { AppModule, ModuleContext, SettingsExport, SettingsSection, UiNode } from "../../../../sdk/types";
import { errMsg } from "../../../../sdk/runtime";

let open = false;
let selectedCategory = "appearance";
let error: string | null = null;
let providers: string[] = [];
const subscriptions = new Map<string, () => void>();
let refreshVersion = 0;

async function refresh(ctx: ModuleContext) {
  const version = ++refreshVersion;
  try {
    const modules = await ctx.host.modules.list();
    if (version !== refreshVersion) return;
    providers = modules.filter((m) => m.active && m.id !== ctx.moduleId).map((m) => m.id).sort();
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
  const result: Category[] = [{ key: "appearance", title: "Appearance" }];
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
    selectedCategory = typeof prev?.selectedCategory === "string" ? prev.selectedCategory : "appearance";
    ctx.events.on("kernel.modules.changed", () => { void refresh(ctx); });
    await refresh(ctx);
  },
  deactivate() { for (const stop of subscriptions.values()) stop(); subscriptions.clear(); },
  snapshot: () => ({ open, selectedCategory }),
  methods: { async open(ctx, args) {
    open = true;
    if (typeof args?.module === "string" && typeof args?.section === "string") selectedCategory = JSON.stringify([args.module, args.section]);
    ctx.ui.invalidate(); await refresh(ctx);
  } },
  render(ctx): UiNode {
    if (!open) return { type: "column", key: "settings-closed", children: [] };
    const list = categories(ctx);
    const active = list.find(category => category.key === selectedCategory) || list[0];
    selectedCategory = active.key;
    const options: UiNode[] = [
      { type: "label", key: "category-title", text: active.title, weight: "semibold" },
    ];
    if (active.key === "appearance") options.push(
      { type: "label", key: "appearance-hint", text: "Soft blue and white surfaces with indigo accents in light mode.", size: "sm", color: "muted", wrap: true },
      { type: "appearanceControl", key: "appearance" },
    );
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
  onEvent(ctx, event) {
    if (event.action === "close") { open = false; ctx.ui.invalidate(); return; }
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
