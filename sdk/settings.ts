import { parseOrder } from "./settings-order";
import { validControlValue } from "./ui-controls";
import type { ModuleContext, SettingsExport, SettingsSection } from "./types";

/** Publish settings and handle edits without giving the menu access to provider internals.
 * Call during activate; generation subscriptions are cleaned up by the runtime on retirement.
 * onChange must persist/apply the value before resolving. getSections supplies confirmed values.
 */
export function exportSettings(
  ctx: ModuleContext,
  getSections: () => SettingsSection[],
  onChange: (section: string, key: string, value: boolean | string) => Promise<void> | void,
  options: { action?: (section: string, key: string) => Promise<void> | void; invalidate?: boolean; reset?: { label: string; run: () => Promise<void> | void } } = {},
) {
  const publish = (error: string | null = null) => {
    const value: SettingsExport = { sections: getSections(), error, ...(options.reset ? { resetLabel: options.reset.label } : {}) };
    ctx.state.set(`${ctx.moduleId}.settings`, value);
  };
  let queue = Promise.resolve();
  ctx.events.on("settings.change", (edit: any) => {
    if (edit?.module !== ctx.moduleId) return;
    queue = queue.then(async () => {
      try {
        const section = getSections().find((s) => s.key === edit.section);
        const field = section?.fields.find((f) => f.key === edit.key);
        if (!field || field.type === "action") throw new Error("Setting is no longer available");
        if (field.type === "order") parseOrder(edit.value, field.items.map(i => i.id), field.allowSpacers);
        else if (field.type === "color" || field.type === "range") {
          if (!validControlValue(field, edit.value)) throw new Error(field.type === "color" ? "Enter a color as #RRGGBB" : `Choose a value from ${field.min} to ${field.max}`);
        }
        else if (field.type === "toggle" ? typeof edit.value !== "boolean" :
          typeof edit.value !== "string" || (field.type === "select" && !field.options.some((o) => o.value === edit.value))) {
          throw new Error("Invalid setting value");
        }
        await onChange(section!.key, field.key, edit.value);
        publish();
      } catch (e) { publish(e instanceof Error ? e.message : String(e)); }
      if (options.invalidate !== false) ctx.ui.invalidate();
    });
  });
  if (options.action) ctx.events.on("settings.action", (event: any) => {
    if (event?.module !== ctx.moduleId) return;
    // Dispatch immediately: owners can publish busy/disabled state while work is running.
    // Actions do not hold the settings-edit queue while waiting for downloads.
    const run = async () => {
      try {
        const section = getSections().find(s => s.key === event.section);
        const field = section?.fields.find(f => f.key === event.key);
        if (!field || field.type !== "action" || field.disabled) throw new Error("Action is not available");
        await options.action!(section!.key, field.key);
        publish();
      } catch (error) { publish(error instanceof Error ? error.message : String(error)); }
      if (options.invalidate !== false) ctx.ui.invalidate();
    };
    void run();
  });
  if (options.reset) ctx.events.on("settings.reset", (event: any) => {
    if (event?.module !== ctx.moduleId || !options.reset) return;
    queue = queue.then(async () => {
      try { await options.reset!.run(); publish(); }
      catch (e) { publish(e instanceof Error ? e.message : String(e)); }
      if (options.invalidate !== false) ctx.ui.invalidate();
    });
  });
  publish();
  return publish;
}
