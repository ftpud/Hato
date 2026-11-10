// Plan usage limits (5-hour / weekly windows) reported by ACP adapters. Shared by the acp service
// (parsing) and the usage meter UI modules (presentation). Bundled into each consumer.
//
// Sources, all over ACP:
// * claude-agent-acp: `usage_update._meta["_claude/rateLimit"]` during turns (utilization is a
//   0–1 fraction, resetsAt unix seconds) and the local `/usage` command's Markdown.
// * codex-acp: the local `/status` command's Markdown (`**5h limit:** 73% left (resets 14:00)`).
// Neither command calls the model.

export type LimitProvider = string;
export interface LimitWindow {
  id: string;
  label: string;
  /** Percent of the window used, 0–100 (may exceed 100 when over the limit). */
  usedPercent: number;
  /** Unix milliseconds when the window resets, when known. */
  resetsAt: number | null;
  /** Adapter-formatted reset text, when an exact time is unavailable. */
  resetsText: string | null;
}
export interface LimitsSnapshot {
  provider: LimitProvider;
  windows: LimitWindow[];
  /** Free-form plan or account line (e.g. "Claude max subscription"). */
  plan: string | null;
  updatedAt: number;
  source: "probe" | "session";
  error: string | null;
  loading?: boolean;
}

const clean = (s: string) => s.replace(/\\([\\`*_[\]<>|])/g, "$1").replace(/\*\*/g, "").trim();
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "limit";

/** Claude `/usage` Markdown → windows. Lines look like `**5-hour limit** — **42%** · Resets Nov 4, 3:00 PM PST`. */
export function parseClaudeUsage(markdown: string): { windows: LimitWindow[]; plan: string | null } {
  const windows: LimitWindow[] = [];
  for (const line of markdown.split("\n")) {
    const m = /^\*\*(.+?)\*\*\s+—\s+\*\*(\d+(?:\.\d+)?)%\*\*(?:\s+·\s+Resets\s+(.+))?\s*$/.exec(line.trim());
    if (!m) continue;
    const label = clean(m[1]);
    windows.push({ id: claudeWindowId(label), label: shortLabel(label), usedPercent: Number(m[2]), resetsAt: parseDate(m[3]), resetsText: m[3] ? clean(m[3]) : null });
  }
  const plan = /^>\s*(Claude .+ subscription usage)\s*$/m.exec(markdown);
  return { windows, plan: plan ? clean(plan[1]).replace(/ usage$/, "") : null };
}
function claudeWindowId(label: string) {
  const l = label.toLowerCase();
  if (l.startsWith("5-hour")) return "five_hour";
  if (l === "weekly · all models") return "seven_day";
  return slug(label);
}
function shortLabel(label: string) {
  return label.replace(/^5-hour limit$/i, "5h").replace(/^Weekly · all models$/i, "Wk").replace(/^Weekly · /i, "Wk · ");
}
function parseDate(text: string | undefined): number | null {
  if (!text) return null;
  const t = Date.parse(clean(text).replace(/\s+[A-Z]{2,5}$/, ""));
  return Number.isFinite(t) ? t : null;
}

/** Codex `/status` Markdown → windows. Lines look like `**5h limit:** 73% left (resets 14:00 on 5 Nov)`. */
export function parseCodexStatus(markdown: string): { windows: LimitWindow[]; plan: string | null } {
  const windows: LimitWindow[] = [];
  for (const line of markdown.split("\n")) {
    const m = /^\*\*(.+?):\*\*\s+(\d+(?:\.\d+)?)% left(?:\s+\((?:resets\s+)?([^)]*)\))?/.exec(line.trim());
    if (!m) continue;
    const label = clean(m[1]);
    if (/spend limit/i.test(label)) continue;
    const short = label.replace(/^codex\s+/i, "").replace(/\s*limit$/i, "") || label;
    windows.push({ id: slug(label), label: /^(7d|weekly|week)$/i.test(short) ? "Wk" : short, usedPercent: Math.max(0, 100 - Number(m[2])), resetsAt: null, resetsText: m[3] ? clean(m[3]) : null });
  }
  const account = /^\*\*Account:\*\*\s+(.+)$/m.exec(markdown);
  return { windows, plan: account ? clean(account[1]).replace(/\s*\([^)]*@[^)]*\)\s*$/, "") : null };
}

/** Merge a Claude in-session rate-limit event into a snapshot (only the reported window changes). */
export function applyClaudeRateLimit(prev: LimitsSnapshot | null, info: any, now = Date.now()): LimitsSnapshot | null {
  if (!info || typeof info !== "object" || typeof info.utilization !== "number" || !Number.isFinite(info.utilization)) return prev;
  const type = typeof info.rateLimitType === "string" ? info.rateLimitType : "five_hour";
  const labels: Record<string, string> = { five_hour: "5h", seven_day: "Wk", seven_day_opus: "Wk · Opus", seven_day_sonnet: "Wk · Sonnet", overage: "Extra usage" };
  const win: LimitWindow = { id: type, label: labels[type] || type.replace(/_/g, " "), usedPercent: Math.round(info.utilization * 1000) / 10,
    resetsAt: typeof info.resetsAt === "number" && info.resetsAt > 0 ? info.resetsAt * 1000 : null, resetsText: null };
  const windows = [...(prev?.windows || []).filter(w => w.id !== win.id), win];
  const order = ["five_hour", "seven_day"];
  windows.sort((a, b) => (order.indexOf(a.id) + 1 || 99) - (order.indexOf(b.id) + 1 || 99));
  return { provider: "claude", windows, plan: prev?.plan ?? null, updatedAt: now, source: "session", error: null };
}

/** Human "resets in" text for a window. */
export function resetText(w: LimitWindow, now = Date.now()): string {
  if (w.resetsAt) {
    const mins = Math.max(0, Math.round((w.resetsAt - now) / 60000));
    if (mins < 60) return `resets in ${mins} min`;
    if (mins < 48 * 60) return `resets in ${Math.floor(mins / 60)} h ${mins % 60} min`;
    return `resets in ${Math.round(mins / 1440)} days`;
  }
  return w.resetsText ? `resets ${w.resetsText}` : "";
}
