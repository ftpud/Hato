// Designer: edits a draft on the native canvas. Drag blocks, drag from a block's port onto another
// block to connect it with the selected connection type, click blocks/connection labels to edit.
import type { ModuleContext, UiNode, CanvasItem, CanvasEdge } from "../../../../sdk/types";
import { blockProfile, providerChoiceKey } from "../../../../sdk/workflow-provider-options";
import { uiIcons } from "../../../../sdk/ui-icons";
import {
  WORKFLOW_BLOCKS, blockInfo, blockingIssues, edgeType, isAgentBlock, isStartBlock, newBlockId, newEdgeId, validateWorkflow,
  type WorkflowBlock, type WorkflowDefinition, type WorkflowEdge, type WorkflowEdgeType,
} from "../../../../sdk/workflows";
import { transferEdges } from "./transfers";
import { CARD, blockColor, blockIcon, edgeStyle, statusColor, statusText } from "./style";
import { S, ACTIVE, btn, call, field, icon, input, muted, shownRun, text } from "./state";
import { blockStatus, blockRunView, statusLabel } from "./runs";

// ---------------------------------------------------------------- draft editing

export const block = (id: string) => S.draft?.blocks.find(b => b.id === id);
export const edge = (id: string) => S.draft?.edges.find(e => e.id === id);
export const designerRun = () => S.selectedId ? shownRun(S.selectedId) : undefined;

export async function openDraft(ctx: ModuleContext, id: string) {
  const r = await call(ctx, "get", { id });
  Object.assign(S, { selectedId: id, draft: r.definition, revision: r.revision, issues: r.issues || [], dirty: false, undo: [], redo: [], selection: null, lastSnapshot: { at: 0, field: "" }, confirm: null });
  S.defs.set(id, r.definition);
}
function snapshot(fieldKey = "") {
  if (!S.draft) return;
  const t = Date.now();
  // Consecutive keystrokes in one field form a single undo step.
  if (!S.redo.length && fieldKey && fieldKey === S.lastSnapshot.field && t - S.lastSnapshot.at < 1500) { S.lastSnapshot.at = t; return; }
  S.lastSnapshot = { at: t, field: fieldKey };
  S.undo.push(JSON.stringify(S.draft)); if (S.undo.length > 80) S.undo.shift(); S.redo = [];
}
export function changed() { S.dirty = true; if (S.draft) S.issues = validateWorkflow(S.draft, S.catalog ? { profiles: S.catalog.profiles, mcps: S.catalog.mcps } : undefined); }
export function mutate(fn: (d: WorkflowDefinition) => void, fieldKey = "") { if (!S.draft) return; snapshot(fieldKey); fn(S.draft); changed(); }
export function undoDraft() { if (S.draft && S.undo.length) { S.redo.push(JSON.stringify(S.draft)); S.draft = JSON.parse(S.undo.pop()!); changed(); S.selection = null; S.lastSnapshot = { at: 0, field: "" }; } }
export function redoDraft() { if (S.draft && S.redo.length) { S.undo.push(JSON.stringify(S.draft)); S.draft = JSON.parse(S.redo.pop()!); changed(); S.selection = null; S.lastSnapshot = { at: 0, field: "" }; } }

export function addBlock(type: string) {
  const d = S.draft; if (!d) return;
  const info = blockInfo(type); if (!info) return;
  const id = newBlockId(d, type);
  const sel = S.selection?.kind === "block" ? block(S.selection.id) : undefined;
  const pos = sel ? { x: sel.position.x + CARD.width + 60, y: sel.position.y } : { x: 40 + (d.blocks.length % 4) * (CARD.width + 50), y: 40 + Math.floor(d.blocks.length / 4) * (CARD.height + 70) };
  const b: WorkflowBlock = { id, type: info.type, label: info.label, prompt: "", position: { x: Math.round(pos.x / CARD.snap) * CARD.snap, y: Math.round(pos.y / CARD.snap) * CARD.snap } };
  if (type === "timer") b.seconds = 60;
  if (type === "script") b.command = "git status --short";
  if (type === "run_app") { b.command = "npm run dev"; b.app = { name: id, actions: ["start", "status", "kill", "tail"] }; }
  if (type === "ai" || type === "user_prompt" || type === "yes_no_prompt") b.prompt = "{{input}}";
  if (type === "start_button") b.prompt = "Describe what this run should do.";
  if (type === "skill") b.description = "When to use these instructions.";
  if (type === "mcp") b.mcp = { serverId: S.catalog?.mcps?.[0]?.id || "" };
  mutate(dd => { dd.blocks.push(b); });
  // "Add next": connect from the selected block in the current mode.
  if (sel && (S.mode !== "use" || isAgentBlock(sel)) && !isStartBlock(b)) connect(sel.id, id);
  S.selection = { kind: "block", id };
}
export function connect(from: string, to: string) {
  const d = S.draft; if (!d || from === to) return;
  const a = block(from), b = block(to); if (!a || !b) return;
  let type: WorkflowEdgeType = S.mode;
  // Capability and tool-only targets are always used; non-agents cannot use.
  if (["terminal_control", "task_controls", "mcp", "skill", "meeting"].includes(b.type) && isAgentBlock(a)) type = "use";
  if (type === "use" && !isAgentBlock(a)) type = "follow";
  if (type === "path" && a.type !== "ai" && a.type !== "yes_no_prompt") type = "follow";
  let label: string | undefined;
  if (type === "path") {
    const used = d.edges.filter(e => e.from === from && edgeType(e) === "path").map(e => e.label);
    label = a.type === "yes_no_prompt" ? (used.includes("yes") ? "no" : "yes") : (() => { for (let i = 1; ; i++) if (!used.includes(`route-${i}`)) return `route-${i}`; })();
  }
  if (d.edges.some(e => e.from === from && e.to === to && edgeType(e) === type && (e.label || "") === (label || ""))) return;
  const e: WorkflowEdge = { id: newEdgeId(d, from, to), from, to, type, ...(label ? { label } : {}) };
  mutate(dd => { dd.edges.push(e); });
  S.selection = { kind: "edge", id: e.id };
}
export function removeBlock(id: string) { mutate(d => { d.blocks = d.blocks.filter(b => b.id !== id); d.edges = d.edges.filter(e => e.from !== id && e.to !== id); }); S.selection = null; }
export function duplicateBlock(id: string) {
  const b = block(id), d = S.draft; if (!b || !d) return;
  const copy: WorkflowBlock = JSON.parse(JSON.stringify(b));
  copy.id = newBlockId(d, b.type); copy.label = `${b.label} copy`; copy.position = { x: b.position.x + 36, y: b.position.y + 36 };
  if (copy.app) copy.app.name = copy.id;
  mutate(dd => { dd.blocks.push(copy); }); S.selection = { kind: "block", id: copy.id };
}
export function renameBlockId(oldId: string, next: string) {
  const d = S.draft;
  if (!d || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(next) || d.blocks.some(b => b.id === next)) throw new Error("IDs use letters, digits, _ or - and must be unique");
  mutate(dd => {
    for (const b of dd.blocks) { if (b.id === oldId) b.id = next; b.prompt = b.prompt.split(`blocks.${oldId}.output`).join(`blocks.${next}.output`); }
    for (const e of dd.edges) { if (e.from === oldId) e.from = next; if (e.to === oldId) e.to = next; }
  });
  S.selection = { kind: "block", id: next };
}
export async function saveDraft(ctx: ModuleContext) {
  if (!S.draft) return;
  const r = await call(ctx, "save", { definition: S.draft, expectedRevision: S.revision });
  Object.assign(S, { revision: r.revision, draft: r.definition, issues: r.issues || [], dirty: false, notice: "Saved" });
  S.defs.set(r.id, r.definition);
}
export function setField(target: any, f: string, raw: any) {
  const numeric = ["seconds", "timeoutSeconds", "timeoutMs", "maxLoopCount", "maxSteps"].includes(f);
  const value = numeric ? (String(raw).trim() === "" ? undefined : Number(raw)) : raw;
  if (value === undefined || (value === "" && f !== "prompt" && f !== "label")) delete target[f];
  else if (!numeric || Number.isFinite(value)) target[f] = value;
}

export async function loadProviderChoices(ctx: ModuleContext, id: string, refresh = false) {
  const b = block(id); if (!b || !isAgentBlock(b)) return;
  const profileId = blockProfile(b, S.catalog); if (!profileId) return;
  const key = providerChoiceKey(S.ws?.id || "", profileId, b.model || "");
  if (S.providerLoading.has(key) || (!refresh && S.providerChoices.has(key))) return;
  S.providerLoading.add(key); S.providerErrors.delete(key); ctx.ui.invalidate();
  try { S.providerChoices.set(key, await call(ctx, "providerOptions", { profileId, model: b.model || "", refresh })); }
  catch (error) { S.providerErrors.set(key, error instanceof Error ? error.message : String(error)); }
  finally { S.providerLoading.delete(key); ctx.ui.invalidate(); }
}

// ---------------------------------------------------------------- canvas

function cardFor(b: WorkflowBlock): CanvasItem {
  const color = blockColor[b.type] || "#888888";
  const st = designerRun()?.blocks.find(s => s.blockId === b.id);
  const status = blockStatus(b, st);
  const selected = S.selection?.kind === "block" && S.selection.id === b.id;
  const issue = S.issues.find(i => i.blockId === b.id && i.severity !== "warning");
  const c = S.catalog;
  const detail = b.type === "script" || b.type === "run_app" ? (b.command || "").split("\n")[0]
    : b.type === "timer" ? `${b.seconds ?? 0} s` : b.type === "skill" && b.skillId ? b.skillId
    : b.type === "mcp" ? (c?.mcps?.find((m: any) => m.id === b.mcp?.serverId)?.name || b.mcp?.serverId || "")
    : isAgentBlock(b) ? `${c?.profiles?.find((p: any) => p.id === b.profileId)?.name || b.provider || "Default provider"}${b.model ? ` · ${b.model}` : ""}`
    : (b.prompt || b.description || "").replace(/\s+/g, " ");
  const running = status === "running", waiting = st && ["awaiting_user_input", "awaiting_permission"].includes(status);
  return {
    key: b.id, x: b.position.x, y: b.position.y, width: CARD.width, height: CARD.height, port: true,
    ...(running ? { pulse: "primary" } : waiting ? { pulse: "warning" } : {}),
    style: { background: "background", borderColor: selected ? "primary" : issue ? "danger" : "border", borderWidth: selected ? 2 : 1, radius: 8, shadow: selected ? "md" : "sm" },
    children: [
      { type: "row", key: "head", gap: 4, style: { background: color, paddingX: 8, paddingY: 3 }, children: [
        { type: "button", key: "ic", text: "", iconSvg: blockIcon[b.type] || blockIcon.workflow, iconSize: 13, action: "", small: true, variant: "ghost", style: { color: "#ffffff" } } as UiNode,
        { type: "label", key: "type", text: blockInfo(b.type)?.label || b.type, size: "xs", weight: "semibold", color: "#ffffff", grow: true },
        ...(st && status !== "idle" ? [{ type: "label", key: "status", text: statusText[status] || status, size: "xs", weight: "bold", color: "#ffffff" } as UiNode] : []),
      ] },
      { type: "column", key: "body", gap: 2, style: { paddingX: 8, paddingY: 5 }, children: [
        { type: "label", key: "name", text: b.label || b.id, size: "sm", weight: "semibold" },
        { type: "label", key: "detail", text: detail.length > 60 ? detail.slice(0, 59) + "…" : detail || " ", size: "xs", color: "muted" },
        ...(st && (status === "failed" || waiting) ? [{ type: "label", key: "state", text: status === "failed" ? `⚠ ${(st.error || "").slice(0, 56)}` : status === "awaiting_permission" ? "Waiting for permission" : "Waiting for your answer", size: "xs", color: statusColor(status) } as UiNode] : []),
      ] },
    ],
  };
}
function edgesFor(): CanvasEdge[] {
  const d = S.draft; if (!d) return [];
  return transferEdges(d.edges.map(e => {
    const t = edgeType(e), st = edgeStyle[t], selected = S.selection?.kind === "edge" && S.selection.id === e.id;
    const target = block(e.to), use = t === "use";
    return { key: e.id, from: e.from, to: e.to, fromSide: use ? "bottom" : "right", toSide: use ? (target && isAgentBlock(target) ? "left" : "top") : "left",
      color: selected ? "primary" : st.color, width: selected ? 3 : 1.6, dashed: st.dashed, label: t === "path" ? e.label || "path" : e.loop ? "loop" : t };
  }), designerRun());
}
function toolbar(): UiNode {
  const d = S.draft!, blocking = blockingIssues(S.issues).length, run = designerRun();
  return { type: "row", key: "designer-toolbar", gap: 4, padding: 6, bg: "panel", wrap: true, children: [
    ...(!S.designerInline ? [{ type: "row", key: "window-drag", windowDrag: true, width: 24, height: 28, tooltip: "Drag to move designer window",
      children: [muted("grip", "⠿", { size: "md" })] } as UiNode] : []),
    { type: "textInput", key: `wf-name:${d.id}`, value: d.name, changeAction: "wfName", placeholder: "Workflow name", width: 220 },
    { type: "select", key: "add-block", placeholder: "Add block…", value: null, action: "addBlock", options: WORKFLOW_BLOCKS.map(b => ({ value: b.type, label: b.label })) } as UiNode,
    muted("mode-label", "Connect:", { wrap: false }),
    ...(["follow", "use", "path"] as WorkflowEdgeType[]).map(m => btn(`mode-${m}`, edgeStyle[m].name, "mode", { value: m, variant: S.mode === m ? "primary" : "ghost",
      tooltip: m === "follow" ? "Run the target with this block's output" : m === "use" ? "The target becomes a tool of this AI Agent or Chatbox" : "A named route chosen by an AI Agent or Yes/No Prompt" })),
    icon("undo", blockIcon.undo, "undo", "Undo", { disabled: !S.undo.length }),
    icon("redo", blockIcon.redo, "redo", "Redo", { disabled: !S.redo.length }),
    { type: "spacer", key: "sp" },
    text("issues", blocking ? `${blocking} issue${blocking > 1 ? "s" : ""}` : S.issues.length ? `${S.issues.length} warning${S.issues.length > 1 ? "s" : ""}` : "Valid", { size: "xs", color: blocking ? "danger" : S.issues.length ? "warning" : "success", wrap: false }),
    btn("save", S.dirty ? "Save •" : "Saved", "save", { iconSvg: blockIcon.save, variant: S.dirty ? "primary" : "ghost", disabled: S.busy || !S.dirty }),
    btn("run-designer", "Run", "designerRun", { iconSvg: blockIcon.play, disabled: S.busy || blocking > 0, tooltip: blocking ? "Fix the listed issues first" : "Save and run from the first start block" }),
    ...(run && ACTIVE.has(run.status) ? [btn("cancel-designer", "Stop", "cancelRun", { iconSvg: blockIcon.stop, variant: "danger", value: run.id })] : []),
    S.designerInline ? icon("to-window", blockIcon.window, "toWindow", "Open the designer in its own window") : icon("to-panel", uiIcons.collapse, "toPanel", "Show the designer inside the panel"),
    icon("close-designer", uiIcons.x, "closeDesigner", "Close the designer"),
  ] };
}

// ---------------------------------------------------------------- inspector

function blockInspector(b: WorkflowBlock): UiNode[] {
  const k = (f: string) => `f:${b.id}:${f}`, info = blockInfo(b.type), c = S.catalog;
  const out: UiNode[] = [
    { type: "row", key: "bh", gap: 6, children: [
      { type: "button", key: "bi", text: "", iconSvg: blockIcon[b.type], action: "", small: true, variant: "ghost", style: { color: blockColor[b.type] } } as UiNode,
      text("bt", info?.label || b.type, { weight: "semibold", grow: true, size: "md" }),
      icon("dup", uiIcons.copy, "duplicateBlock", "Duplicate block", { value: b.id }),
      icon("del", uiIcons.trash, "confirmBlock", "Delete block", { value: b.id }),
    ] },
    muted("summary", info?.summary || ""),
    field("label", "Name", input(k("label"), b.label, "field")),
    field("id", "ID (used in {{blocks.ID.output}})", input(`id:${b.id}`, b.id, "", { submitAction: "renameId", placeholder: "Press Enter to rename" })),
  ];
  const promptTitle: Record<string, string> = { ai: "Prompt template ({{input}}, {{blocks.ID.output}})", chatbox: "Session guidance", start_button: "Run input", text: "Text", markdown: "Markdown template (empty: pass the input)", user_prompt: "Question", yes_no_prompt: "Question", skill: "Instructions (or link a skill below)" };
  if (promptTitle[b.type]) out.push(field("prompt", promptTitle[b.type], input(k("prompt"), b.prompt, "field", { multiline: true, rows: isAgentBlock(b) ? 10 : 6 })));
  if (b.type === "skill" || b.type === "meeting" || isAgentBlock(b)) out.push(field("desc", b.type === "skill" ? "When to use (shown to agents)" : "Description (shown to callers)", input(k("description"), b.description, "field", { multiline: true, rows: 2 })));
  if (isAgentBlock(b)) {
    out.push(field("prov", "Provider", { type: "select", key: k("profileId"), value: b.profileId || "", action: "field",
      options: [{ value: "", label: b.provider ? `By name: ${b.provider}` : "Workflow default" }, ...(c?.profiles || []).map((p: any) => ({ value: p.id, label: `${p.name} (${p.provider})` }))] } as UiNode));
    const choiceKey = providerChoiceKey(S.ws?.id || "", blockProfile(b, c), b.model || "");
    const choices = S.providerChoices.get(choiceKey), loading = S.providerLoading.has(choiceKey);
    const options = (items: { value: string; label: string }[], selected?: string) => [{ value: "", label: "Provider default" }, ...items,
      ...(selected && !items.some(o => o.value === selected) ? [{ value: selected, label: `Saved: ${selected}` }] : [])];
    out.push(field("model", "Model", { type: "select", key: k("model"), value: b.model || "", action: "field", disabled: loading || (!choices?.models.length && !b.model),
      options: options(choices?.models || [], b.model), placeholder: loading ? "Loading models…" : "Provider default" } as UiNode));
    out.push(field("reasoning", "Reasoning effort", { type: "select", key: k("reasoning"), value: b.reasoning || "", action: "field", disabled: loading || (!choices?.reasoning.length && !b.reasoning),
      options: options(choices?.reasoning || [], b.reasoning), tooltip: choices && !choices.reasoning.length ? "This provider/model does not advertise reasoning options" : "Reasoning choices reported by the selected provider and model" } as UiNode));
    out.push(btn("provider-options", loading ? "Reading provider options…" : "Refresh provider choices", "loadProviderChoices", { value: b.id, disabled: loading, iconSvg: uiIcons.refresh, variant: "ghost" }));
    if (choices?.reasoning.length && choices.reasoningReady === false) out.push(muted("reasoning-runtime", "Reasoning can be saved now. Stop ready background agents to activate the updated runtime before running with a reasoning override.", { color: "warning" }));
    if (S.providerErrors.has(choiceKey)) out.push({ type: "status", key: "provider-error", level: "error", text: S.providerErrors.get(choiceKey)! });
    out.push(field("agent", "Agent instructions", { type: "select", key: k("agentFile"), value: b.agentFile || "", action: "field",
      options: [{ value: "", label: "None" }, ...(c?.agentFiles || []).map((f: any) => ({ value: f.path, label: f.path }))] } as UiNode));
    out.push({ type: "switch", key: k("autopilot"), label: "Autopilot (approve tool permissions automatically)", checked: !!b.autopilot, action: "fieldBool" } as UiNode);
  }
  if (b.type === "script" || b.type === "run_app") out.push(field("cmd", "Shell command (runs in the workspace root)", input(k("command"), b.command, "field", { multiline: true, rows: 5 })));
  if (b.type === "script") out.push(field("timeout", "Timeout (seconds, default 1800)", input(k("timeoutSeconds"), b.timeoutSeconds, "field")));
  if (b.type === "run_app") {
    out.push(field("app", "App name", input(`app:${b.id}:name`, b.app?.name, "appName")));
    out.push(muted("app-actions", "Allowed actions for connected agents"));
    out.push({ type: "row", key: "acts", gap: 6, wrap: true, children: (["start", "status", "kill", "tail"] as const).map(a => ({ type: "toggle", key: `act:${b.id}:${a}`, label: a, checked: !b.app?.actions?.length || b.app.actions.includes(a), action: "appAct", value: a } as UiNode)) });
  }
  if (b.type === "timer") out.push(field("secs", "Seconds", input(k("seconds"), b.seconds, "field")));
  if (b.type === "skill") out.push(field("skill", "Existing workspace skill", { type: "select", key: k("skillId"), value: b.skillId || "", action: "field",
    options: [{ value: "", label: "Custom instructions" }, ...(c?.skills || []).map((s: any) => ({ value: s.path, label: s.name }))] } as UiNode));
  if (b.type === "mcp") out.push(field("mcp", "MCP server", { type: "select", key: `mcp:${b.id}`, value: b.mcp?.serverId || "", action: "mcpServer", options: (c?.mcps || []).map((m: any) => ({ value: m.id, label: m.name })) } as UiNode));
  if (S.draft!.edges.filter(e => e.to === b.id && edgeType(e) !== "use").length > 1)
    out.push(field("join", "When several connections arrive", { type: "select", key: k("join"), value: b.join || "all", action: "field", options: [{ value: "all", label: "Wait for all active branches" }, { value: "any", label: "Run on the first one" }] } as UiNode));
  S.issues.filter(i => i.blockId === b.id).forEach((i, n) => out.push({ type: "status", key: `iss-${n}`, level: i.severity === "warning" ? "warn" : "error", text: i.message }));
  const run = designerRun(), st = run?.blocks.find(s => s.blockId === b.id);
  if (run && st && (st.status !== "idle" || st.log?.length || st.meeting)) out.push({ type: "divider", key: "rd" }, ...blockRunView(run, b, st, "insp"));
  return out;
}
function edgeInspector(e: WorkflowEdge): UiNode[] {
  const a = block(e.from), b = block(e.to), t = edgeType(e);
  return [
    { type: "row", key: "eh", gap: 6, children: [text("et", "Connection", { weight: "semibold", grow: true, size: "md" }), icon("edel", uiIcons.trash, "deleteEdge", "Delete connection", { value: e.id })] },
    text("ends", `${a?.label || e.from} → ${b?.label || e.to}`),
    field("type", "Type", { type: "select", key: `e:${e.id}:type`, value: t, action: "edgeField", options: [{ value: "follow", label: "Follow: run with the output" }, { value: "use", label: "Use: tool of the source agent" }, { value: "path", label: "Path: named route" }] } as UiNode),
    ...(t === "path" ? [field("route", "Route name", input(`e:${e.id}:label`, e.label, "edgeField"))] : []),
    ...(t === "use" ? [field("tmo", "Tool call timeout (seconds, default 300)", input(`e:${e.id}:timeoutMs`, e.timeoutMs ? e.timeoutMs / 1000 : undefined, "edgeField"))] : []),
    ...(t !== "use" ? [{ type: "switch", key: `e:${e.id}:loop`, label: "Loop (intentionally returns to an earlier block)", checked: !!e.loop, action: "edgeLoop" } as UiNode] : []),
    ...S.issues.filter(i => i.edgeId === e.id).map((i, n) => ({ type: "status", key: `iss-${n}`, level: i.severity === "warning" ? "warn" : "error", text: i.message } as UiNode)),
  ];
}
function workflowInspector(): UiNode[] {
  const d = S.draft!;
  return [
    text("wt", "Workflow", { weight: "semibold", size: "md" }),
    muted("help", "Add blocks from the menu. Drag a block to move it; drag from its round port onto another block to connect them with the selected connection type. Click a block or a connection label to edit it."),
    field("desc", "Description", input(`wf-desc:${d.id}`, d.description, "wfDesc", { multiline: true, rows: 3 })),
    field("loops", "Loop limit (default 100)", input(`wf-loops:${d.id}`, d.settings?.maxLoopCount, "wfSetting", { placeholder: "100" })),
    field("ask", "Ask AI to change this workflow", input("ask-designer", S.askText, "askText", { multiline: true, rows: 3, placeholder: "e.g. Add a reviewer agent that checks the script output" })),
    btn("ask-go", "Ask the configurator", "configure", { iconSvg: blockIcon.sparkles, disabled: S.busy || !S.askText.trim(), tooltip: "Starts a background agent with workflow editing tools and opens it in the AI chat" }),
    ...(S.dirty ? [muted("ask-note", "Unsaved changes are saved first: the configurator edits the saved workflow.", { color: "warning" })] : []),
    { type: "divider", key: "d1" },
    text("it", S.issues.length ? "Issues" : "No issues", { weight: "medium" }),
    ...S.issues.slice(0, 30).map((i, n) => ({ type: "status", key: `wi-${n}`, level: i.severity === "warning" ? "warn" : "error", text: i.message } as UiNode)),
  ];
}

export function designer(): UiNode {
  const d = S.draft;
  if (!d) return text("no-draft", "Select a workflow to design.");
  const sel = S.selection?.kind === "block" ? block(S.selection.id) : undefined, se = S.selection?.kind === "edge" ? edge(S.selection.id) : undefined;
  const run = designerRun();
  return { type: "column", key: "designer", grow: true, children: [
    toolbar(),
    ...(S.confirm?.kind === "block" ? [{ type: "row", key: "delete-block-confirmation", gap: 8, padding: 8, bg: "panel", children: [
      text("question", `Delete block "${block(S.confirm.id)?.label || S.confirm.id}" and its connections?`, { grow: true }),
      btn("cancel-delete", "Cancel", "confirmNo"),
      btn("confirm-delete", "Delete", "confirmYes", { variant: "danger" }),
    ] } as UiNode] : []),
    ...(S.error ? [{ type: "status", key: "d-error", level: "error", text: S.error } as UiNode] : []),
    ...(run ? [{ type: "row", key: "d-run", gap: 6, padding: 4, children: [
      muted("d-run-l", `Showing run ${new Date(run.createdAt).toLocaleString()} · ${statusLabel(run.status)}${run.error ? ` · ${run.error}` : ""}`, { color: statusColor(run.status), grow: true }),
    ] } as UiNode] : []),
    { type: "split", key: "designer-split", direction: "horizontal", sizes: [1, 0], fixed: [null, 360], resizable: false, grow: true, children: [
      { type: "canvas", key: `canvas:${d.id}`, grid: CARD.grid, items: d.blocks.map(cardFor), edges: edgesFor(), grow: true,
        moveAction: "moveBlock", selectAction: "selectBlock", connectAction: "connect", edgeAction: "selectEdge", clickAction: "clearSelection" } as UiNode,
      { type: "column", key: "insp-wrap", borderSide: "left", grow: true, children: [
        { type: "column", key: `inspector:${S.selection?.kind || "wf"}:${(S.selection as any)?.id || ""}`, gap: 10, padding: 12, scroll: true, grow: true,
          children: sel ? blockInspector(sel) : se ? edgeInspector(se) : workflowInspector() },
      ] },
    ] } as UiNode,
  ] };
}
