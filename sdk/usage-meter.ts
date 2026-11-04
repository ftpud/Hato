// Compact bar widget showing how much of an agent plan's usage windows (5-hour, weekly) is left.
// Data comes from the acp service (`acp.limits` state, `acp.limits` method). Each provider gets its
// own tiny UI module built from this factory so it can be placed, moved or hidden independently.
import type { AppModule, ModuleContext, UiNode } from "./types";
import { exportSettings } from "./settings";
import { resetText, type LimitProvider, type LimitsSnapshot, type LimitWindow } from "./usage-limits";

const INTERVALS = [{ value: "0", label: "Manual only" }, { value: "5", label: "Every 5 minutes" }, { value: "15", label: "Every 15 minutes" },
  { value: "30", label: "Every 30 minutes" }, { value: "60", label: "Every hour" }];
const BAR_WIDTH = 28;

export function usageMeter(id: string, provider: LimitProvider, title: string): AppModule {
  let snap: LimitsSnapshot | null = null;
  let ws: any = null;
  let minutes = "15";
  let show: "left" | "used" = "left";
  let timer: ReturnType<typeof setTimeout> | null = null;
  let error: string | null = null;

  const refresh = async (ctx: ModuleContext, force: boolean) => {
    if (!ws?.id) return;
    const maxAgeMs = force ? 0 : Math.max(1, Number(minutes) || 15) * 60000;
    try { error = null; const r = await ctx.modules.call("acp", "limits", { provider, workspaceId: ws.id, force, maxAgeMs }, { timeoutMs: 300000 }); if (r) snap = r; }
    catch (e: any) { error = e?.message || String(e); }
    ctx.ui.invalidate();
  };
  const schedule = (ctx: ModuleContext) => {
    if (timer) clearTimeout(timer);
    timer = null;
    const m = Number(minutes);
    if (m > 0) timer = setTimeout(() => { void refresh(ctx, false).finally(() => schedule(ctx)); }, m * 60000);
  };

  const levelColor = (left: number) => left <= 10 ? "danger" : left <= 30 ? "warning" : "success";
  const meter = (w: LimitWindow): UiNode => {
    const left = Math.max(0, Math.min(100, 100 - w.usedPercent));
    const shown = show === "left" ? left : Math.min(100, w.usedPercent);
    const fill = Math.round(BAR_WIDTH * left / 100);
    return { type: "row", key: `w-${w.id}`, gap: 4, align: "center", style: { noShrink: true }, children: [
      { type: "label", key: "n", text: w.label, size: "xs", color: "muted" },
      { type: "row", key: "track", width: BAR_WIDTH, height: 6, style: { background: "border", radius: 3, width: BAR_WIDTH, height: 6, noShrink: true }, children: fill > 0 ? [
        { type: "column", key: "fill", width: fill, height: 6, style: { background: levelColor(left), radius: 3, width: fill, height: 6 }, children: [] },
      ] : [] },
      { type: "label", key: "v", text: `${Math.round(shown)}%`, size: "xs", mono: true, color: left <= 10 ? "danger" : "default" },
    ] };
  };
  const tooltip = () => {
    const lines = [`${title} plan usage (${show === "left" ? "remaining" : "used"})`];
    if (snap?.plan) lines.push(snap.plan);
    for (const w of snap?.windows || []) lines.push(`${w.label}: ${Math.round(Math.max(0, 100 - w.usedPercent))}% left · ${Math.round(w.usedPercent)}% used${resetText(w) ? ` · ${resetText(w)}` : ""}`);
    if (snap?.error || error) lines.push(`⚠ ${snap?.error || error}`);
    if (snap?.updatedAt) lines.push(`Updated ${new Date(snap.updatedAt).toLocaleTimeString()} (${snap.source === "session" ? "live session" : "usage check"})`);
    lines.push(snap?.loading ? "Checking…" : "Click to refresh");
    return lines.join("\n");
  };

  return {
    id, moduleApiVersion: 1,
    async activate(ctx) {
      const savedMinutes = await ctx.modules.call("persistence", "settings.get", { key: `${id}.refreshMinutes` });
      minutes = INTERVALS.some(o => o.value === String(savedMinutes)) ? String(savedMinutes) : "15";
      const savedShow = await ctx.modules.call("persistence", "settings.get", { key: `${id}.show` });
      show = savedShow === "used" ? "used" : "left";
      exportSettings(ctx, () => [{ key: id, title: `${title} usage meter`, group: "Agents", fields: [
        { key: "refreshMinutes", label: "Refresh", type: "select", value: minutes, options: INTERVALS,
          description: `Checks run the adapter's local ${provider === "claude" ? "/usage" : "/status"} command in a short hidden ACP session; no model request is made. Live Claude chats also update the meter.` },
        { key: "show", label: "Show", type: "select", value: show, options: [{ value: "left", label: "Remaining" }, { value: "used", label: "Used" }] },
      ] }], async (_s, key, value) => {
        await ctx.modules.call("persistence", "settings.set", { key: `${id}.${key}`, value });
        if (key === "refreshMinutes") { minutes = String(value); schedule(ctx); } else show = value === "used" ? "used" : "left";
      });
      snap = (ctx.state.get("acp.limits") as any)?.[provider] || null;
      ctx.state.watch("acp.limits", (v: any) => { snap = v?.[provider] || null; ctx.ui.invalidate(); });
      ws = ctx.state.get("workspace.selected") || null;
      ctx.state.watch("workspace.selected", (v: any) => { const first = !ws?.id && v?.id; ws = v; if (first && Number(minutes) > 0) void refresh(ctx, false); });
      if (Number(minutes) > 0) void refresh(ctx, false);
      schedule(ctx);
    },
    deactivate() { if (timer) clearTimeout(timer); timer = null; },
    render(): UiNode {
      const windows = (snap?.windows || []).slice(0, 2);
      const problem = !windows.length && (snap?.error || error);
      return { type: "row", key: "meter", gap: 8, align: "center", tooltip: tooltip(), style: { wrap: false }, children: [
        { type: "button", key: "name", text: title, action: "refresh", small: true, variant: "ghost", height: 22, tooltip: tooltip(), disabled: !ws?.id },
        ...(snap?.loading && !windows.length ? [{ type: "label", key: "busy", text: "…", size: "xs", color: "muted" } as UiNode]
          : problem ? [{ type: "label", key: "na", text: "n/a", size: "xs", color: "muted", tooltip: tooltip() } as UiNode]
          : !windows.length ? [{ type: "label", key: "none", text: ws?.id ? "—" : "no workspace", size: "xs", color: "muted" } as UiNode]
          : windows.map(meter)),
      ] };
    },
    async onEvent(ctx, ev) { if (ev.action === "refresh") await refresh(ctx, true); },
  };
}
