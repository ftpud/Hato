import type { AppModule, ModuleContext, SettingsExport, UiNode } from "../../../../sdk/types";
import { errMsg } from "../../../../sdk/runtime";

let open = false;
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

const mod: AppModule = {
  id: "settings", moduleApiVersion: 1,
  async activate(ctx, prev) {
    open = !!prev?.open;
    ctx.events.on("kernel.modules.changed", () => { void refresh(ctx); });
    await refresh(ctx);
  },
  deactivate() { for (const stop of subscriptions.values()) stop(); subscriptions.clear(); },
  snapshot: () => ({ open }),
  methods: { async open(ctx) { open = true; ctx.ui.invalidate(); await refresh(ctx); } },
  render(ctx): UiNode {
    if (!open) return { type: "column", key: "settings-closed", children: [] };
    const children: UiNode[] = [
      { type: "label", key: "appearance-title", text: "Appearance", weight: "bold" },
      { type: "label", key: "appearance-hint", text: "Soft blue and white surfaces with indigo accents in light mode.", size: "sm", color: "muted", wrap: true },
      { type: "appearanceControl", key: "appearance" },
    ];
    if (error) children.push({ type: "status", key: "error", text: error, level: "error" });
    for (const id of providers) {
      const contribution = ctx.state.get<SettingsExport>(`${id}.settings`) as SettingsExport | undefined;
      if (!contribution || !Array.isArray(contribution.sections)) continue;
      if (contribution.error) children.push({ type: "status", key: `${id}:error`, text: `${id}: ${contribution.error}`, level: "error" });
      for (const section of contribution.sections) {
        if (!section || typeof section.key !== "string" || !Array.isArray(section.fields)) continue;
        const key = JSON.stringify([id, section.key]);
        children.push({ type: "divider", key: `${key}:divider` });
        children.push({ type: "label", key: `${key}:title`, text: section.title, weight: "bold" });
        children.push({ type: "label", key: `${key}:owner`, text: id, size: "xs", color: "muted" });
        for (const field of section.fields) {
          if (!field || typeof field.key !== "string") continue;
          const fieldKey = JSON.stringify([id, section.key, field.key]);
          if (field.type === "toggle") children.push({ type: "toggle", key: fieldKey, label: field.label, checked: field.value, action: "change" });
          else if (field.type === "select" && Array.isArray(field.options)) children.push({ type: "select", key: fieldKey, label: field.label, value: field.value, options: field.options, action: "change" });
          if (field.description) children.push({ type: "label", key: `${fieldKey}:description`, text: field.description, size: "xs", color: "muted", wrap: true });
        }
      }
    }
    return { type: "modal", key: "settings-modal", title: "Settings", closeAction: "close", children };
  },
  onEvent(ctx, event) {
    if (event.action === "close") { open = false; ctx.ui.invalidate(); return; }
    if (event.action !== "change") return;
    try {
      const [module, section, key] = JSON.parse(event.key);
      if (!providers.includes(module)) return;
      ctx.events.emit("settings.change", { module, section, key, value: event.value });
    } catch (e) { error = errMsg(e); ctx.ui.invalidate(); }
  },
};
export default mod;
