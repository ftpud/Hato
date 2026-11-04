// Shared panel state. One mutable object so the library, run and designer views can be split
// across files; it is snapshotted on module reload.
import type { ModuleContext, UiNode } from "../../../../sdk/types";
import type { ProviderChoices } from "../../../../sdk/workflow-provider-options";
import type { WorkflowBlockState, WorkflowDefinition, WorkflowEdgeType, WorkflowIssue, WorkflowRun } from "../../../../sdk/workflows";

export type Selection = { kind: "block"; id: string } | { kind: "edge"; id: string } | null;
export interface Summary { id: string; name: string; description?: string; revision: number; updatedAt: string; blocks: number }
export interface RunSummary { id: string; workflowId: string; workflowName: string; status: string; createdAt: string; completedAt?: string; error?: string; input?: string }
export type RunDetail = WorkflowRun & { blocks: (WorkflowBlockState & { outputChars?: number })[] };

export const S = {
  ws: null as any, catalog: null as any, list: [] as Summary[], visible: false, epoch: 0,
  // library
  filter: "", newTemplate: "blank",
  defs: new Map<string, WorkflowDefinition>(),
  recent: [] as RunSummary[],
  details: new Map<string, RunDetail>(),
  open: new Set<string>(), maximized: null as string | null,
  cardRun: new Map<string, string>(), cardBlock: new Map<string, string>(),
  logOpen: new Set<string>(),
  starting: null as string | null, quick: null as { wf: string; block: string } | null,
  startText: new Map<string, string>(), chatDrafts: new Map<string, string>(), answers: new Map<string, string>(),
  providerChoices: new Map<string, ProviderChoices>(), providerLoading: new Set<string>(), providerErrors: new Map<string, string>(),
  // designer
  selectedId: null as string | null, draft: null as WorkflowDefinition | null, revision: null as number | null, dirty: false, issues: [] as WorkflowIssue[],
  undo: [] as string[], redo: [] as string[], lastSnapshot: { at: 0, field: "" },
  selection: null as Selection, mode: "follow" as WorkflowEdgeType,
  designerOpen: false, designerInline: false, designerSize: { width: 1280, height: 820 }, askText: "",
  // chrome
  importText: "", importOpen: false, error: null as string | null, notice: null as string | null, busy: false,
  confirm: null as { kind: "workflow" | "run" | "block"; id: string; wf?: string } | null,
};

// Discard replies after switching workspace or deactivating the module. In particular, a
// delayed get/save must never install a draft in a different workspace.
export async function call(ctx: ModuleContext, method: string, args: any = {}, timeoutMs = 240_000) {
  const epoch = S.epoch;
  const result = await ctx.modules.call<any>("workflows", method, { workspaceId: S.ws?.id, ...args }, { timeoutMs });
  if (epoch !== S.epoch) throw new Error("Workflow workspace changed");
  return result;
}

export const ACTIVE = new Set(["running", "waiting"]);
export const runsOf = (wf: string) => S.recent.filter(r => r.workflowId === wf);
export const latestRun = (wf: string) => runsOf(wf)[0];
/** The run a card (and the designer for that workflow) shows: the chosen one, else the newest. */
export function shownRunId(wf: string) {
  const chosen = S.cardRun.get(wf);
  return chosen && S.recent.some(r => r.id === chosen) ? chosen : latestRun(wf)?.id;
}
export const shownRun = (wf: string) => { const id = shownRunId(wf); return id ? S.details.get(id) : undefined; };

// ---------------------------------------------------------------- small node helpers

export const text = (key: string, value: string, extra: any = {}): UiNode => ({ type: "label", key, text: value, size: "sm", wrap: true, ...extra });
export const muted = (key: string, value: string, extra: any = {}): UiNode => text(key, value, { color: "muted", size: "xs", ...extra });
export const btn = (key: string, label: string, action: string, extra: any = {}): UiNode => ({ type: "button", key, text: label, action, small: true, ...extra });
export const icon = (key: string, svgIcon: string, action: string, tooltip: string, extra: any = {}): UiNode =>
  ({ type: "button", key, text: "", iconSvg: svgIcon, iconSize: 15, action, small: true, variant: "ghost", tooltip, ...extra });
export const field = (key: string, title: string, node: UiNode): UiNode =>
  ({ type: "column", key, gap: 3, children: [{ type: "label", key: "t", text: title, size: "xs", color: "muted", weight: "medium" }, node] });
export const input = (key: string, value: string | number | undefined, action: string, extra: any = {}): UiNode =>
  ({ type: "textInput", key, value: value === undefined ? "" : String(value), changeAction: action, ...extra });
export const card = (key: string, children: UiNode[], extra: any = {}): UiNode =>
  ({ type: "column", key, gap: 8, ...extra, style: { background: "panel", borderColor: "border", borderWidth: 1, radius: 10, padding: 10, ...(extra.style || {}) }, children } as UiNode);
