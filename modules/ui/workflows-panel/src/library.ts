// Workflow library: one card per workflow, like HatoPad's run panel. A collapsed card shows its
// name, live status and quick-start buttons (plus a narrow live tree while a run is active); an
// expanded card shows the run selector and controls, the compact block tree, pauses, run errors
// and the selected block's details. A card can be maximized to fill the panel.
import type { UiNode } from "../../../../sdk/types";
import { uiIcons } from "../../../../sdk/ui-icons";
import { isStartBlock, type WorkflowDefinition } from "../../../../sdk/workflows";
import { blockColor, blockIcon, statusColor } from "./style";
import { S, ACTIVE, btn, card, icon, muted, runsOf, shownRun, text, type Summary } from "./state";
import { activityLog, blockRunView, pausedBlocks, preview, statusLabel } from "./runs";

export const definitionOf = (wf: string): WorkflowDefinition | undefined => (S.selectedId === wf && S.draft) || S.defs.get(wf);

function toolbar(): UiNode[] {
  return [
    { type: "row", key: "toolbar", gap: 4, children: [
      { type: "textInput", key: "wf-filter", prefixSvg: uiIcons.search, placeholder: "Filter workflows", value: S.filter, changeAction: "filter", grow: true } as UiNode,
      { type: "select", key: "template", value: S.newTemplate, action: "template", width: 150,
        options: (S.catalog?.templates || [{ id: "blank", name: "Blank workflow" }]).map((t: any) => ({ value: t.id, label: t.name })) } as UiNode,
      icon("new", uiIcons.plus, "create", "Create a workflow from the selected template", { disabled: !S.ws || S.busy }),
      icon("import", uiIcons.files, "importOpen", "Import workflow JSON", { disabled: !S.ws }),
      icon("refresh", uiIcons.refresh, "refresh", "Refresh", { disabled: !S.ws }),
    ] },
    { type: "row", key: "heading", gap: 6, children: [
      text("count", `${S.list.length} workflow${S.list.length === 1 ? "" : "s"}`, { weight: "semibold", grow: true, wrap: false }),
      muted("where", S.ws ? `Runs on the ${S.ws.location === "ssh" ? "remote" : "local"} daemon` : "", { wrap: false }),
    ] },
  ];
}

function statusChip(key: string, status: string): UiNode {
  return { type: "row", key, gap: 4, style: { background: "raised", radius: 10, paddingX: 7, paddingY: 1, noShrink: true }, children: [
    { type: "label", key: "d", text: "●", size: "xs", color: status === "idle" ? "muted" : statusColor(status) },
    { type: "label", key: "s", text: statusLabel(status), size: "xs", weight: "medium" },
  ] };
}

function startControls(w: Summary, def: WorkflowDefinition): UiNode[] {
  const starts = def.blocks.filter(isStartBlock);
  const k = (s: string) => `start:${w.id}:${s}`;
  if (!starts.length) return [{ type: "row", key: k("none"), gap: 6, align: "end", children: [
    { type: "textInput", key: k("input"), value: S.startText.get(`${w.id}:`) || "", changeAction: "startText", submitAction: "startInput", placeholder: "Run input (optional)", grow: true, multiline: true, rows: 2 } as UiNode,
    btn(k("go"), "Run", "startInput", { iconSvg: blockIcon.play, variant: "primary", value: `${w.id}:`, disabled: S.busy }),
  ] }];
  return starts.map(b => b.type === "start_button"
    ? { type: "row", key: k(b.id), gap: 8, style: { background: "background", borderColor: "border", borderWidth: 1, radius: 8, padding: 8 }, children: [
        { type: "column", key: "c", gap: 2, grow: true, children: [text("l", b.label, { weight: "medium" }), muted("p", b.prompt.length > 160 ? b.prompt.slice(0, 159) + "…" : b.prompt)] },
        btn("go", "Start", "startButton", { iconSvg: blockIcon.play, variant: "primary", value: `${w.id}:${b.id}`, disabled: S.busy || !b.prompt.trim() }),
      ] } as UiNode
    : { type: "column", key: k(b.id), gap: 6, style: { background: "background", borderColor: "border", borderWidth: 1, radius: 8, padding: 8 }, children: [
        text("l", b.label, { weight: "medium" }),
        { type: "row", key: "r", gap: 6, align: "end", children: [
          { type: "textInput", key: `start:${w.id}:${b.id}:text`, value: S.startText.get(`${w.id}:${b.id}`) || "", changeAction: "startText", submitAction: "startInput", placeholder: "What should this run do?", grow: true, multiline: true, rows: 2 } as UiNode,
          btn("go", "Start", "startInput", { iconSvg: blockIcon.play, variant: "primary", value: `${w.id}:${b.id}`, disabled: S.busy }),
        ] },
      ] } as UiNode);
}

function workflowCard(w: Summary, maximized: boolean): UiNode {
  const open = maximized || S.open.has(w.id);
  const def = definitionOf(w.id);
  const runs = runsOf(w.id), run = shownRun(w.id);
  const latest = runs[0], live = !!latest && ACTIVE.has(latest.status);
  const status = latest?.status || "idle";
  const graph = run?.definition || def;
  const starts = (def || graph)?.blocks.filter(isStartBlock) || [];
  const header: UiNode = { type: "row", key: "header", gap: 6, children: [
    { type: "button", key: "ic", text: "", iconSvg: blockIcon.workflow, iconSize: 16, action: "toggleCard", value: w.id, small: true, variant: "ghost", style: { color: "primary" }, tooltip: open ? "Collapse" : "Show workflow" } as UiNode,
    { type: "column", key: "title", gap: 0, grow: true, children: [
      text("name", w.name, { weight: "semibold", size: "md", wrap: false }),
      ...(open ? [] : [muted("meta", `${w.blocks} block${w.blocks === 1 ? "" : "s"}${latest ? ` · last run ${new Date(latest.createdAt).toLocaleString()}` : ""}`, { wrap: false })]),
    ] },
    statusChip("status", status),
    ...(!open ? starts.slice(0, 3).map(b => icon(`qs-${b.id}`, b.type === "start_input" ? blockIcon["circle-play"] : blockIcon.play, b.type === "start_input" ? "quickStart" : "startButton", `Start: ${b.label}`, { value: `${w.id}:${b.id}`, disabled: S.busy })) : []),
    icon("design", blockIcon.edit, "openDesigner", "Open in the designer", { value: w.id }),
    ...(open && def ? [icon("json", blockIcon.copy, "", "Copy workflow JSON", { copyText: JSON.stringify(def, null, 2) }), icon("del-wf", uiIcons.trash, "confirmWorkflow", "Delete workflow", { value: w.id })] : []),
    ...(!maximized ? [icon("fold", open ? blockIcon["chevron-up"] : blockIcon["chevron-down"], "toggleCard", open ? "Collapse workflow" : "Show workflow content", { value: w.id })] : []),
    icon("max", maximized ? blockIcon.minimize : blockIcon.maximize, "maximize", maximized ? "Restore item size" : "Expand to panel", { value: w.id }),
  ] };
  const children: UiNode[] = [header];
  if (!open) {
    if (live && run && graph) children.push(preview(`narrow:${w.id}`, graph, run, undefined, { maxHeight: 70 }));
    if (S.quick?.wf === w.id) {
      const b = graph?.blocks.find(x => x.id === S.quick!.block);
      children.push({ type: "row", key: "quick", gap: 6, align: "end", children: [
        { type: "textInput", key: `start:${w.id}:${S.quick.block}:text`, value: S.startText.get(`${w.id}:${S.quick.block}`) || "", changeAction: "startText", submitAction: "startInput", placeholder: b ? `${b.label}: what should this run do?` : "Run input", grow: true, multiline: true, rows: 2 } as UiNode,
        btn("go", "Start", "startInput", { iconSvg: blockIcon.play, variant: "primary", value: `${w.id}:${S.quick.block}`, disabled: S.busy }),
      ] });
    }
    return card(`card:${w.id}`, children, { style: { borderColor: live ? "primary" : "border", paddingY: 8 } });
  }
  if (!graph) { children.push(muted("loading", "Loading workflow…")); return card(`card:${w.id}`, children); }
  const selectedBlock = S.cardBlock.get(w.id);
  if (run) {
    const done = run.blocks.filter(b => b.status === "succeeded").length;
    children.push({ type: "row", key: "meta", gap: 6, wrap: true, children: [
      { type: "select", key: `runsel:${w.id}`, value: run.id, action: "cardRun", grow: true,
        options: runs.map(r => ({ value: r.id, label: `${statusLabel(r.status)} · ${new Date(r.createdAt).toLocaleString()}` })) } as UiNode,
      muted("done", `${done}/${graph.blocks.length} complete`, { wrap: false }),
    ] });
    children.push({ type: "row", key: "controls", gap: 2, children: [
      ...(run.input ? [muted("input", `Prompt: ${run.input.replace(/\s+/g, " ").slice(0, 90)}`, { grow: true, wrap: false })] : [{ type: "spacer", key: "sp" } as UiNode]),
      icon("new-run", blockIcon.play, "newRun", "Choose a starting point for a new run", { value: w.id, variant: S.starting === w.id ? "primary" : "ghost" }),
      ...(!ACTIVE.has(run.status) ? [icon("rerun", blockIcon.rerun, "rerun", "Rerun with the same prompt and start block", { value: run.id, disabled: S.busy })] : []),
      ...(ACTIVE.has(run.status) ? [icon("stop", blockIcon.stop, "cancelRun", "Stop this run", { value: run.id, variant: "danger" })] : [icon("del-run", uiIcons.trash, "confirmRun", "Delete this run and its agent sessions", { value: run.id })]),
    ] });
    if (S.starting === w.id && def) children.push(...startControls(w, def));
  } else {
    children.push(muted("hint", `${graph.blocks.length} blocks · ${graph.blocks.some(b => b.type === "chatbox") ? "Open a Chatbox or choose a starting point" : "Choose a starting point"}`));
    if (def) children.push(...startControls(w, def));
  }
  children.push(preview(`preview:${w.id}`, graph, run, selectedBlock, { maxHeight: maximized ? 420 : 220 }));
  if (run) {
    for (const p of pausedBlocks(run)) {
      const b = graph.blocks.find(x => x.id === p.blockId);
      if (b && p.blockId !== selectedBlock) children.push(card(`pause:${p.blockId}`, blockRunView(run, b, p, "pause"), { style: { background: "background", borderColor: "warning" } }));
    }
    if (run.error) children.push({ type: "status", key: "run-error", level: run.status === "cancelled" ? "warn" : "error", text: run.error });
  }
  const sb = selectedBlock && graph.blocks.find(b => b.id === selectedBlock);
  if (sb) {
    const st = run?.blocks.find(s => s.blockId === sb.id);
    children.push(card(`detail:${sb.id}`, st && run && (sb.type === "chatbox" || st.status !== "idle" || st.log?.length || st.meeting) ? blockRunView(run, sb, st, "detail", false) : [
      { type: "row", key: "h", gap: 6, children: [
        { type: "button", key: "i", text: "", iconSvg: blockIcon[sb.type], iconSize: 14, action: "", small: true, variant: "ghost", style: { color: blockColor[sb.type] } } as UiNode,
        text("n", sb.label, { weight: "semibold", grow: true }), muted("s", run ? "Not run" : "Ready", { wrap: false }),
      ] },
      ...(sb.prompt || sb.command ? [muted("p", (sb.command || sb.prompt).slice(0, 400))] : []),
    ], { style: { background: "background" } }));
    if (run && st) children.push(activityLog(run, st, "detail"));
  }
  // The expanded card must own a bounded scroll viewport. Otherwise its fixed preview
  // and details can push the activity log outside the panel when the root cannot scroll.
  const content = maximized ? [children[0], { type: "column", key: "card-content", scroll: true, grow: true, gap: 8, children: children.slice(1) } as UiNode] : children;
  return card(`card:${w.id}`, content, { style: { borderColor: live ? "primary" : "border" }, ...(maximized ? { grow: true } : {}) });
}

export function library(): UiNode[] {
  const nodes: UiNode[] = [...toolbar()];
  if (!S.ws) { nodes.push(muted("none", "Select a workspace to design and run its workflows.", { size: "sm" })); return nodes; }
  if (S.error) nodes.push({ type: "status", key: "error", level: "error", text: S.error });
  if (S.notice) nodes.push({ type: "status", key: "notice", level: "success", text: S.notice });
  if (S.busy) nodes.push({ type: "progress", key: "busy", indeterminate: true });
  if (!S.catalog && !S.error) nodes.push(muted("loading", "Connecting to the workspace runtime…", { size: "sm" }));
  const q = S.filter.trim().toLowerCase();
  if (S.maximized) {
    const w = S.list.find(x => x.id === S.maximized);
    if (w) return [workflowCard(w, true)];
  }
  const shown = S.list.filter(w => !q || w.name.toLowerCase().includes(q) || (w.description || "").toLowerCase().includes(q));
  for (const w of shown) nodes.push(workflowCard(w, false));
  if (S.catalog && !S.list.length) nodes.push(card("empty", [
    text("t", "No workflows yet", { weight: "semibold" }),
    muted("d", "Pick a template above and press + to create one, or import a HatoPad workflow JSON.", { size: "sm" }),
  ]));
  else if (q && !shown.length) nodes.push(muted("nomatch", "No matching workflows.", { size: "sm" }));
  return nodes;
}
