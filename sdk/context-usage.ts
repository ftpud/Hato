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

/** Context usage pie as inline SVG: a filled sector for known usage, a dashed ring when unknown. */
export function usagePieSvg(value: number | null): string {
  const v = value !== null && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : null;
  const track = "currentColor";
  const fill = v !== null && v >= 0.9 ? "#d95050" : v !== null && v >= 0.75 ? "#bd8120" : "#6f7cf6";
  let body: string;
  if (v === null) body = `<circle cx='9' cy='9' r='7' fill='none' stroke='${track}' stroke-opacity='0.5' stroke-width='2' stroke-dasharray='2 2'/>`;
  else {
    const angle = v * Math.PI * 2;
    const x = (9 + 7 * Math.sin(angle)).toFixed(3), y = (9 - 7 * Math.cos(angle)).toFixed(3);
    const sector = v >= 1 ? `<circle cx='9' cy='9' r='7' fill='${fill}'/>` : v <= 0 ? "" : `<path d='M9 9 L9 2 A7 7 0 ${v > 0.5 ? 1 : 0} 1 ${x} ${y} Z' fill='${fill}'/>`;
    body = `<circle cx='9' cy='9' r='7' fill='${track}' fill-opacity='0.2'/>${sector}`;
  }
  return `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 18 18'>${body}</svg>`;
}
