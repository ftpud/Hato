export interface ReportedUsage { used: number; size: number }
export function reportedUsage(value: any): ReportedUsage | null {
  return value && typeof value.used === "number" && Number.isFinite(value.used) && value.used >= 0
    && typeof value.size === "number" && Number.isFinite(value.size) && value.size >= 0
    ? { used: value.used, size: value.size } : null;
}
export function contextUsage(value: unknown): { value: number | null; tooltip: string } {
  const usage = reportedUsage(value);
  if (!usage || usage.size === 0) return { value: null, tooltip: "Context usage unavailable — the agent has not reported a context capacity." };
  const fraction = usage.used / usage.size;
  return { value: Math.min(1, fraction), tooltip: `${Math.round(fraction * 100)}% context used · ${String(usage.used).replace(/\B(?=(\d{3})+(?!\d))/g, ",")} / ${String(usage.size).replace(/\B(?=(\d{3})+(?!\d))/g, ",")} tokens` };
}
