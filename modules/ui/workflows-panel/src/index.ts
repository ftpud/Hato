// Workflows panel: a library of collapsible workflow cards with live compact previews (running
// blocks pulse, active connections carry a spark), run controls and answers, plus the designer
// (an OS window, or inline in the panel). Everything that runs lives in the daemon's workflow
// runtime, reached through the `workflows` gateway.
import type { AppModule, ModuleContext, UiNode } from "../../../../sdk/types";
import { errMsg } from "../../../../sdk/runtime";
import { blockingIssues, isStartBlock, isAgentBlock, normalizeDefinition, type WorkflowEdgeType } from "../../../../sdk/workflows";
import { CARD } from "./style";
import { S, ACTIVE, btn, call, latestRun, muted, shownRunId } from "./state";
import { addBlock, block, changed, connect, designer, duplicateBlock, edge, mutate, openDraft, redoDraft, removeBlock, renameBlockId, saveDraft, setField, undoDraft, loadProviderChoices } from "./designer";
import { tickTransfers, clearTransfers } from "./transfers";
import { chatStatus } from "./runs";
import { definitionOf, library } from "./library";

let animationTimer: ReturnType<typeof setInterval> | null = null;
let timer: ReturnType<typeof setInterval> | null = null, tick = 0, polling = false;

// ---------------------------------------------------------------- loading

async function setup(ctx: ModuleContext) {
  const mine = ++S.epoch;
  Object.assign(S, { catalog: null, list: [], recent: [], error: null });
  S.details.clear();
  ctx.ui.invalidate();
  if (!S.ws || (!S.visible && !S.designerOpen)) return;
  try {
    const [c, l, r] = await Promise.all([call(ctx, "catalog"), call(ctx, "list"), call(ctx, "runs")]);
    if (mine !== S.epoch) return;
    Object.assign(S, { catalog: c, list: l, recent: r });
    if (c.templates?.length && !c.templates.some((t: any) => t.id === S.newTemplate)) S.newTemplate = c.templates.find((t: any) => t.id === "multi-agent-setup")?.id || c.templates[0].id;
    // Open the first workflow on first use so its preview is visible.
    if (!S.open.size && l[0]) S.open.add(l[0].id);
    await refreshDetails(ctx);
    if (S.designerOpen && S.selection?.kind === "block") void loadProviderChoices(ctx, S.selection.id);
  } catch (e) { if (mine === S.epoch) S.error = errMsg(e); }
  ctx.ui.invalidate();
}
async function refreshList(ctx: ModuleContext) { S.list = await call(ctx, "list"); }
async function refreshRuns(ctx: ModuleContext) { S.recent = await call(ctx, "runs"); }
/** Load definitions of shown cards and details of the runs they display (active ones every poll). */
async function refreshDetails(ctx: ModuleContext) {
  for (const w of S.list) {
    const open = S.open.has(w.id) || S.maximized === w.id || (S.designerOpen && S.selectedId === w.id);
    const live = !!latestRun(w.id) && ACTIVE.has(latestRun(w.id)!.status);
    if (!open && !live) continue;
    if (open && !definitionOf(w.id)) S.defs.set(w.id, (await call(ctx, "get", { id: w.id })).definition);
    const id = shownRunId(w.id); if (!id) continue;
    const cached = S.details.get(id);
    if (!cached || ACTIVE.has(cached.status) || cached.status !== S.recent.find(r => r.id === id)?.status || cached.blocks.some(b => b.sessionId && cached.definition.blocks.find(d => d.id === b.blockId)?.type === "chatbox")) S.details.set(id, await call(ctx, "runDetail", { runId: id }));
  }
}
function schedule(ctx: ModuleContext) {
  const want = !!S.ws && (S.visible || S.designerOpen);
  if (want && !animationTimer) animationTimer = setInterval(() => { if (tickTransfers()) ctx.ui.invalidate(); }, 80);
  if (!want && animationTimer) { clearInterval(animationTimer); animationTimer = null; clearTransfers(); }
  if (want && !timer) timer = setInterval(() => { void poll(ctx); }, 1200);
  if (!want && timer) { clearInterval(timer); timer = null; }
}
async function poll(ctx: ModuleContext) {
  if (polling || !S.ws || !S.catalog) return; polling = true;
  const mine = S.epoch;
  try {
    tick++;
    const live = S.recent.some(r => ACTIVE.has(r.status));
    if (live || tick % 4 === 0) await refreshRuns(ctx);
    await refreshDetails(ctx);
    if (mine === S.epoch) ctx.ui.invalidate();
  } catch { /* transient daemon errors surface on the next explicit action */ }
  finally { polling = false; }
}

// ---------------------------------------------------------------- actions

async function act(ctx: ModuleContext, fn: () => Promise<void>) {
  const mine = S.epoch;
  S.busy = true; S.error = null; S.notice = null; ctx.ui.invalidate();
  try { await fn(); } catch (e) { if (mine === S.epoch) S.error = errMsg(e); }
  finally { if (mine === S.epoch) { S.busy = false; ctx.ui.invalidate(); } }
}
async function startRun(ctx: ModuleContext, wf: string, startBlockId: string | undefined, input: string) {
  if (S.selectedId === wf && S.dirty) await saveDraft(ctx);
  const def = definitionOf(wf) || (await call(ctx, "get", { id: wf })).definition;
  const r = await call(ctx, "run", { id: wf, input, startBlockId: startBlockId || undefined });
  S.cardRun.set(wf, r.id); S.open.add(wf); S.starting = null; S.quick = null; S.defs.set(wf, def);
  S.startText.delete(`${wf}:${startBlockId || ""}`);
  await refreshRuns(ctx); await refreshDetails(ctx);
}
const runWorkflow = (runId: string) => S.recent.find(r => r.id === runId)?.workflowId || S.details.get(runId)?.workflowId;
async function reloadRun(ctx: ModuleContext, runId: string) { S.details.set(runId, await call(ctx, "runDetail", { runId })); await refreshRuns(ctx); }
const split2 = (v: string) => { const i = v.indexOf(":"); return [v.slice(0, i), v.slice(i + 1)] as const; };

const workspaceDrafts = new Map<string, any>();
function draftState() {
  return { selectedId: S.selectedId, draft: S.draft, revision: S.revision, dirty: S.dirty,
    issues: S.issues, undo: S.undo, redo: S.redo, selection: S.selection };
}
function snapshot() {
  return { workspaceDrafts: [...workspaceDrafts], ...draftState(), workspaceId: S.ws?.id, selectedId: S.selectedId, draft: S.draft, revision: S.revision, dirty: S.dirty, issues: S.issues, mode: S.mode,
    designerOpen: S.designerOpen, designerInline: S.designerInline, designerSize: S.designerSize, open: [...S.open], logOpen: [...S.logOpen], maximized: S.maximized, cardRun: [...S.cardRun], filter: S.filter };
}

const mod: AppModule = {
  id: "workflows-panel", moduleApiVersion: 1,
  async activate(ctx, prev: any) {
    S.ws = ctx.state.get("workspace.selected") || null;
    S.visible = !!(ctx.state.get("workspace-layout.panels") as any)?.workflows;
    for (const [id, draft] of prev?.workspaceDrafts || []) workspaceDrafts.set(id, draft);
    if (prev && prev.workspaceId === S.ws?.id) {
      Object.assign(S, { selectedId: prev.selectedId, draft: prev.draft, revision: prev.revision, dirty: !!prev.dirty, issues: prev.issues || [], mode: prev.mode || "follow",
        designerOpen: !!prev.designerOpen, designerInline: !!prev.designerInline, designerSize: prev.designerSize || S.designerSize, maximized: prev.maximized || null, filter: prev.filter || "" });
      S.undo = prev.undo || []; S.redo = prev.redo || []; S.selection = prev.selection || null;
      S.logOpen = new Set(prev.logOpen || []); S.open = new Set(prev.open || []); S.cardRun = new Map(prev.cardRun || []);
    }
    ctx.state.watch("workspace.selected", (next: any) => {
      if (next?.id === S.ws?.id) return;
      if (S.ws?.id) workspaceDrafts.set(S.ws.id, draftState());
      S.ws = next; S.open.clear(); S.cardRun.clear(); S.cardBlock.clear(); S.defs.clear(); S.maximized = null;
      Object.assign(S, { selectedId: null, draft: null, revision: null, dirty: false, issues: [], undo: [], redo: [], selection: null,
        starting: null, quick: null, confirm: null, importOpen: false, busy: false, designerInline: false,
        ...(workspaceDrafts.get(next?.id) || {}) });
      S.lastSnapshot = { at: 0, field: "" };
      S.startText.clear(); S.chatDrafts.clear(); S.answers.clear();
      S.designerOpen = false; void setup(ctx); schedule(ctx);
    });
    ctx.state.watch("workspace-layout.panels", (panels: any) => { const was = S.visible; S.visible = !!panels?.workflows; schedule(ctx); if (S.visible && !was && !S.catalog) void setup(ctx); });
    ctx.events.on("workflows.changed", (e: any) => {
      if (e?.workspaceId !== S.ws?.id) return;
      void (async () => {
        try {
          await refreshList(ctx); await refreshRuns(ctx);
          if (e.workflowId) { S.defs.delete(e.workflowId); if (e.workflowId === S.selectedId && !S.dirty) await openDraft(ctx, e.workflowId); }
          await refreshDetails(ctx);
        } catch (err) { if (e.workspaceId === S.ws?.id) S.error = errMsg(err); }
        ctx.ui.invalidate();
      })();
    });
    schedule(ctx);
    if (S.visible || S.designerOpen) await setup(ctx);
  },
  deactivate() { S.epoch++; if (animationTimer) clearInterval(animationTimer); animationTimer = null; clearTransfers(); if (timer) clearInterval(timer); timer = null; },
  snapshot,
  render(): UiNode {
    const inline = S.designerInline && S.designerOpen;
    const extra: UiNode[] = [];
    if (S.confirm && !(S.confirm.kind === "block" && S.designerOpen)) {
      const c = S.confirm;
      const what = c.kind === "workflow" ? `Delete workflow "${S.list.find(w => w.id === c.id)?.name || c.id}"? Its runs remain until deleted.` : c.kind === "run" ? "Delete this run and the background agent sessions it created?" : `Delete block "${block(c.id)?.label || c.id}" and its connections?`;
      extra.push({ type: "modal", key: "confirm", title: "Confirm", closeAction: "confirmNo", width: 380, children: [
        { type: "label", key: "c", text: what, wrap: true },
        { type: "row", key: "cb", gap: 6, children: [{ type: "spacer", key: "s" }, btn("no", "Cancel", "confirmNo"), btn("yes", "Delete", "confirmYes", { variant: "danger" })] },
      ] } as UiNode);
    }
    if (S.importOpen) extra.push({ type: "modal", key: "import", title: "Import workflow JSON", closeAction: "importClose", width: 560, children: [
      muted("i", "Paste a workflow definition (Hato or HatoPad format). It is saved as a new workflow.", { size: "sm" }),
      { type: "textInput", key: "import-text", value: S.importText, changeAction: "importText", multiline: true, rows: 14, placeholder: "{\"name\": …, \"blocks\": […], \"edges\": […]}" } as UiNode,
      { type: "row", key: "ib", gap: 6, children: [{ type: "spacer", key: "s" }, btn("c", "Cancel", "importClose"), btn("go", "Import", "importGo", { variant: "primary", disabled: !S.importText.trim() })] },
    ] } as UiNode);
    if (S.designerOpen && !S.designerInline && S.draft)
      extra.push({ type: "window", key: "designer-window", titlebar: false, title: `Workflow designer — ${S.draft.name}`, width: S.designerSize.width, height: S.designerSize.height, closeAction: "designerClosed", children: [designer()] } as UiNode);
    const maximized = !!S.maximized && !inline;
    return { type: "column", key: "root", gap: 10, padding: inline ? 0 : 10, grow: true, scroll: !inline && !maximized, children: [...(inline ? [designer()] : library()), ...extra] };
  },
  async onEvent(ctx, ev) {
    const v: any = ev.value, a = ev.action, value = typeof v === "string" ? v : "", key = String(ev.key || "");
    try {
      switch (a) {
        // ---- library
        case "refresh": await act(ctx, () => setup(ctx)); return;
        case "toggleActivity": if (S.logOpen.has(value)) S.logOpen.delete(value); else S.logOpen.add(value); ctx.ui.invalidate(); return;
        case "filter": S.filter = value; ctx.ui.invalidate(); return;
        case "template": S.newTemplate = value || "blank"; return;
        case "create": await act(ctx, async () => {
          const r = await call(ctx, "create", { templateId: S.newTemplate });
          await refreshList(ctx); S.open.add(r.id); S.defs.set(r.id, r.definition); S.notice = `Created "${r.definition.name}"`;
        }); return;
        case "toggleCard": if (S.open.has(value)) { S.open.delete(value); if (S.maximized === value) S.maximized = null; } else S.open.add(value);
          await act(ctx, () => refreshDetails(ctx)); return;
        case "maximize": S.maximized = S.maximized === value ? null : value; if (S.maximized) S.open.add(value); await act(ctx, () => refreshDetails(ctx)); return;
        case "cardRun": { const wf = key.slice("runsel:".length); S.cardRun.set(wf, value); S.cardBlock.delete(wf); await act(ctx, () => refreshDetails(ctx)); return; }
        case "previewSelect": { const wf = key.slice(key.indexOf(":") + 1); if (key.startsWith("narrow:")) S.open.add(wf);
          S.cardBlock.get(wf) === v?.key ? S.cardBlock.delete(wf) : S.cardBlock.set(wf, v?.key); await act(ctx, () => refreshDetails(ctx)); return; }
        case "newRun": S.starting = S.starting === value ? null : value; ctx.ui.invalidate(); return;
        case "quickStart": { const [wf, b] = split2(value); S.quick = S.quick?.wf === wf && S.quick.block === b ? null : { wf, block: b }; ctx.ui.invalidate(); return; }
        case "startText": { const m = key.match(/^start:([^:]+):(?:([^:]+):text|input)$/); if (m) S.startText.set(`${m[1]}:${m[2] || ""}`, value); return; }
        case "startButton": { const [wf, b] = split2(value); await act(ctx, () => startRun(ctx, wf, b, "")); return; }
        case "startInput": {
          const ref = value || key.replace(/^start:/, "").replace(/:text$|:input$/, "") + (key.endsWith(":input") ? ":" : "");
          const [wf, b] = split2(ref.includes(":") ? ref : `${ref}:`);
          const inputKey = b ? `start:${wf}:${b}:text` : `start:${wf}:input`;
          const textValue = String(ev.inputs?.[inputKey] ?? S.startText.get(`${wf}:${b}`) ?? "");
          if (b && definitionOf(wf)?.blocks.find(x => x.id === b)?.type === "start_input" && !textValue.trim()) { S.error = "Type what this run should do first."; ctx.ui.invalidate(); return; }
          await act(ctx, () => startRun(ctx, wf, b || undefined, textValue));
          return;
        }
        case "rerun": { const d = S.details.get(value), wf = runWorkflow(value); if (!d || !wf) return; await act(ctx, () => startRun(ctx, wf, d.startBlockId, d.input)); return; }
        case "cancelRun": if (value) await act(ctx, async () => { await call(ctx, "cancel", { runId: value }); await reloadRun(ctx, value); }); return;
        case "importOpen": S.importOpen = true; S.importText = ""; ctx.ui.invalidate(); return;
        case "importClose": S.importOpen = false; ctx.ui.invalidate(); return;
        case "importText": S.importText = value; return;
        case "importGo": await act(ctx, async () => {
          const parsed = normalizeDefinition(JSON.parse(ev.inputs?.["import-text"] ?? S.importText));
          const r = await call(ctx, "create", { templateId: "blank", name: parsed.name, definition: parsed });
          S.importOpen = false; await refreshList(ctx); S.open.add(r.id); S.defs.set(r.id, r.definition);
        }); return;
        case "confirmWorkflow": S.confirm = { kind: "workflow", id: value }; ctx.ui.invalidate(); return;
        case "confirmRun": S.confirm = { kind: "run", id: value }; ctx.ui.invalidate(); return;
        case "confirmBlock": if (block(value)) S.confirm = { kind: "block", id: value, wf: S.draft?.id }; ctx.ui.invalidate(); return;
        case "confirmNo": S.confirm = null; ctx.ui.invalidate(); return;
        case "confirmYes": {
          const c = S.confirm; S.confirm = null; if (!c) return;
          if (c.kind === "block") { if (c.wf !== S.draft?.id) return; removeBlock(c.id); ctx.ui.invalidate(); return; }
          await act(ctx, async () => {
            if (c.kind === "workflow") {
              await call(ctx, "remove", { id: c.id });
              S.open.delete(c.id); S.defs.delete(c.id); if (S.maximized === c.id) S.maximized = null;
              if (S.selectedId === c.id) Object.assign(S, { selectedId: null, draft: null, dirty: false, designerOpen: false });
              await refreshList(ctx);
            } else {
              const wf = runWorkflow(c.id);
              await call(ctx, "removeRun", { runId: c.id }); S.details.delete(c.id); if (wf && S.cardRun.get(wf) === c.id) S.cardRun.delete(wf);
              await refreshRuns(ctx); await refreshDetails(ctx);
            }
          });
          return;
        }
        // ---- run interaction
        case "answerText": { const id = key.split(":").pop()!; S.answers.set(id, value); return; }
        case "answer": await act(ctx, async () => { await call(ctx, "answer", { runId: v.runId, blockId: v.blockId, pauseId: v.pauseId, answer: v.answer }); await reloadRun(ctx, v.runId); }); return;
        case "answerSubmit": {
          const ref = key.startsWith("answer:") ? key : value;
          const [, runId, pauseId] = ref.split(":");
          const st = S.details.get(runId)?.blocks.find(s => s.pauseId === pauseId); if (!st) return;
          const textValue = String(ev.inputs?.[`answer:${runId}:${pauseId}`] ?? S.answers.get(pauseId) ?? "");
          await act(ctx, async () => { await call(ctx, "answer", { runId, blockId: st.blockId, pauseId, answer: textValue }); S.answers.delete(pauseId); await reloadRun(ctx, runId); });
          return;
        }
        case "chatText": S.chatDrafts.set(key, value); return;
        case "chatSend": {
          const ref = key.startsWith("chat:") ? key : value;
          const [, runId, blockId] = ref.split(":");
          const current = S.details.get(runId)?.blocks.find(b => b.blockId === blockId);
          if (current && chatStatus(current).busy) { S.notice = "The agent is still working. Your draft is kept here."; ctx.ui.invalidate(); return; }
          const textValue = String(ev.inputs?.[ref] ?? S.chatDrafts.get(ref) ?? "").trim(); if (!textValue) return;
          await act(ctx, async () => { await call(ctx, "chat", { runId, blockId, text: textValue }); S.chatDrafts.delete(ref); await reloadRun(ctx, runId); });
          return;
        }
        case "openChat": ctx.events.emit("workflows-panel.openChat", { workspaceId: S.ws?.id, id: value }); return;
        case "reviewPermission": await act(ctx, async () => { await call(ctx, "reviewPermission", { sessionId: v.sessionId, permissionId: v.permissionId }, 600_000); await refreshDetails(ctx); }); return;
        // ---- designer lifecycle
        case "openDesigner": {
          const wf = value || ev.rowKey || S.selectedId; if (!wf) return;
          if (S.dirty && S.selectedId !== wf) { S.error = "Save the open designer's changes first."; ctx.ui.invalidate(); return; }
          await act(ctx, async () => { if (S.selectedId !== wf || !S.draft) await openDraft(ctx, wf); S.designerOpen = true; schedule(ctx); await refreshDetails(ctx); });
          return;
        }
        case "closeDesigner": if (S.confirm?.kind === "block") S.confirm = null; S.designerOpen = false; S.designerInline = false; schedule(ctx); ctx.ui.invalidate(); return;
        case "designerClosed": if (S.confirm?.kind === "block") S.confirm = null; S.designerOpen = false; if (v && Number.isFinite(v.width)) S.designerSize = { width: Math.max(800, v.width), height: Math.max(500, v.height) }; schedule(ctx); ctx.ui.invalidate(); return;
        case "toPanel": S.designerInline = true; ctx.events.emit("workflows-panel.reveal", {}); ctx.ui.invalidate(); return;
        case "toWindow": S.designerInline = false; ctx.ui.invalidate(); return;
        case "designerRun": { const wf = S.selectedId; if (!wf || !S.draft) return; const first = S.draft.blocks.find(isStartBlock);
          if (blockingIssues(S.issues).length) return;
          if (first?.type === "start_input") { S.open.add(wf); S.starting = wf; S.designerInline = false; S.notice = "Type the run input in the Workflows panel."; ctx.events.emit("workflows-panel.reveal", {}); ctx.ui.invalidate(); return; }
          await act(ctx, () => startRun(ctx, wf, first?.id, "")); return; }
        case "askText": S.askText = value; return;
        case "configure": await act(ctx, async () => {
          if (S.dirty) await saveDraft(ctx);
          const request = String(ev.inputs?.["ask-designer"] ?? S.askText).trim();
          const r = await call(ctx, "configure", { workflowId: S.draft?.id, request });
          S.askText = ""; S.notice = "The configurator is working in the AI chat; this workflow reloads when it saves.";
          ctx.events.emit("workflows-panel.openChat", { workspaceId: r.workspaceId, id: r.id });
        }); return;
        // ---- designer editing
        case "save": await act(ctx, async () => { await saveDraft(ctx); await refreshList(ctx); }); return;
        case "undo": undoDraft(); ctx.ui.invalidate(); return;
        case "redo": redoDraft(); ctx.ui.invalidate(); return;
        case "mode": S.mode = value as WorkflowEdgeType; ctx.ui.invalidate(); return;
        case "addBlock": if (value) addBlock(value); ctx.ui.invalidate(); if (S.selection?.kind === "block") await loadProviderChoices(ctx, S.selection.id); return;
        case "moveBlock": { const b = block(v?.key); if (!b) return; const x = Math.max(0, Math.round(v.x / CARD.snap) * CARD.snap), y = Math.max(0, Math.round(v.y / CARD.snap) * CARD.snap);
          if (b.position.x !== x || b.position.y !== y) mutate(() => { b.position = { x, y }; }); ctx.ui.invalidate(); return; }
        case "selectBlock": S.selection = { kind: "block", id: v?.key }; ctx.ui.invalidate(); await loadProviderChoices(ctx, v?.key); return;
        case "loadProviderChoices": await loadProviderChoices(ctx, value, true); return;
        case "selectEdge": S.selection = { kind: "edge", id: v?.key }; ctx.ui.invalidate(); return;
        case "clearSelection": S.selection = null; ctx.ui.invalidate(); return;
        case "connect": if (v?.from && v?.to) connect(v.from, v.to); ctx.ui.invalidate(); return;
        case "duplicateBlock": duplicateBlock(value); ctx.ui.invalidate(); return;
        case "deleteEdge": mutate(d => { d.edges = d.edges.filter(e => e.id !== value); }); S.selection = null; ctx.ui.invalidate(); return;
        case "renameId": { const old = key.slice(3); const next = String(ev.inputs?.[key] ?? value).trim(); if (next && next !== old) renameBlockId(old, next); ctx.ui.invalidate(); return; }
        case "field": case "fieldBool": {
          const [, id, f] = key.split(":"); const b = block(id); if (!b) return;
          mutate(() => {
            setField(b, f, a === "fieldBool" ? v === true || value === "true" : value);
            if (f === "profileId") { delete b.model; delete b.reasoning; delete b.provider; }
            if (f === "model") delete b.reasoning;
          }, `${id}:${f}`);
          if (isAgentBlock(b) && ["profileId", "model"].includes(f)) await loadProviderChoices(ctx, id);
          if (["profileId", "model", "reasoning", "agentFile", "skillId", "join"].includes(f) || a === "fieldBool") ctx.ui.invalidate();
          return;
        }
        case "appName": { const id = key.split(":")[1]; const b = block(id); if (!b) return; mutate(() => { b.app = { ...(b.app || { name: "" }), name: value }; }, `${id}:app`); return; }
        case "appAct": { const [, id, actName] = key.split(":") as [string, string, any]; const b = block(id); if (!b) return;
          mutate(() => { const all = ["start", "status", "kill", "tail"] as const; const cur = new Set(b.app?.actions?.length ? b.app.actions : all); if (cur.has(actName)) cur.delete(actName); else cur.add(actName); b.app = { ...(b.app || { name: b.id }), actions: all.filter(x => cur.has(x)) }; });
          ctx.ui.invalidate(); return; }
        case "mcpServer": { const id = key.split(":")[1]; const b = block(id); if (!b) return; mutate(() => { b.mcp = { serverId: value }; }); ctx.ui.invalidate(); return; }
        case "edgeField": { const [, id, f] = key.split(":"); const e = edge(id); if (!e) return;
          mutate(() => { if (f === "timeoutMs") { const n = Number(value); if (Number.isFinite(n) && n > 0) e.timeoutMs = Math.round(n * 1000); else delete e.timeoutMs; } else if (f === "type") { e.type = value as WorkflowEdgeType; if (value !== "path") delete e.label; else e.label ||= "route-1"; } else setField(e, f, value); }, `${id}:${f}`);
          if (f === "type") ctx.ui.invalidate(); return; }
        case "edgeLoop": { const id = key.split(":")[1]; const e = edge(id); if (!e) return; mutate(() => { if (e.loop) delete e.loop; else e.loop = true; }); ctx.ui.invalidate(); return; }
        case "wfName": mutate(d => { d.name = value; }, "wf:name"); return;
        case "wfDesc": mutate(d => { if (value) d.description = value; else delete d.description; }, "wf:desc"); return;
        case "wfSetting": mutate(d => { const n = Number(value); d.settings = { ...(d.settings || {}) }; if (value.trim() && Number.isInteger(n) && n > 0) d.settings.maxLoopCount = n; else delete d.settings.maxLoopCount; }, "wf:loops"); return;
        case "noop": return;
      }
    } catch (e) { S.error = errMsg(e); S.busy = false; ctx.ui.invalidate(); }
    void changed;
  },
};
export default mod;
