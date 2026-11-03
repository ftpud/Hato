import type { ModuleContext, SettingsExport, SettingsSection } from "./types";

/** Publish settings and handle edits without giving the menu access to provider internals.
 * Call during activate; generation subscriptions are cleaned up by the runtime on retirement.
 * onChange must persist/apply the value before resolving. getSections supplies confirmed values.
 */
export function exportSettings(
  ctx: ModuleContext,
  getSections: () => SettingsSection[],
  onChange: (section: string, key: string, value: boolean | string) => Promise<void> | void,
  options: { invalidate?: boolean } = {},
) {
  const publish = (error: string | null = null) => {
    const value: SettingsExport = { sections: getSections(), error };
    ctx.state.set(`${ctx.moduleId}.settings`, value);
  };
  let queue = Promise.resolve();
  ctx.events.on("settings.change", (edit: any) => {
    if (edit?.module !== ctx.moduleId) return;
    queue = queue.then(async () => {
      try {
        const section = getSections().find((s) => s.key === edit.section);
        const field = section?.fields.find((f) => f.key === edit.key);
        if (!field) throw new Error("Setting is no longer available");
        if (field.type === "toggle" ? typeof edit.value !== "boolean" :
          typeof edit.value !== "string" || !field.options.some((o) => o.value === edit.value)) {
          throw new Error("Invalid setting value");
        }
        await onChange(section!.key, field.key, edit.value);
        publish();
      } catch (e) { publish(e instanceof Error ? e.message : String(e)); }
      if (options.invalidate !== false) ctx.ui.invalidate();
    });
  });
  publish();
  return publish;
}
