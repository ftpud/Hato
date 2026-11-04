// Run presentation shared by the library cards and the designer: live compact block tree,
// active-connection detection and per-block run details (outputs, answers, chat).
import type { UiNode, CanvasItem, CanvasEdge } from "../../../../sdk/types";
import { edgeType, isAgentBlock, type WorkflowBlock, type WorkflowBlockState, type WorkflowDefinition } from "../../../../sdk/workflows";
import { followKey, transcriptItems } from "../../../../sdk/chat-transcript";
import { transferEdges } from "./transfers";
import { blockColor, blockIcon, edgeStyle, statusColor, statusText } from "./style";
import { S, btn, card, icon, muted, text, type RunDetail } from "./state";

const RUN_LABEL: Record<string, string> = { idle: "Ready", running: "Running", waiting: "Waiting", succeeded: "Succeeded", failed: "Failed", cancelled: "Cancelled" };
export const statusLabel = (s?: string) => RUN_LABEL[s || "idle"] || (s ? s[0].toUpperCase() + s.slice(1) : "Ready");
const PAUSED = new Set(["awaiting_user_input", "awaiting_permission"]);


const BOX = { w: 120, h: 24 };
/** Compress designer spacing independently on each axis, without rearranging any rows. */
function previewLayout(def: WorkflowDefinition) {
  const src = def.blocks;
  if (!src.length) return { pos: new Map<string, { x: number; y: number }>(), height: 60 };
  const axis = (key: "x" | "y", step: number) => {
    const values = [...new Set(src.map(b => b.position[key]))].sort((a, b) => a - b);
    const gaps = values.slice(1).map((v, i) => v - values[i]);
    return { origin: values[0], scale: Math.min(0.6, gaps.length ? step / Math.min(...gaps) : 0.6) };
  };
  const x = axis("x", BOX.w + 16);
  const rows = [...new Set(src.map(b => b.position.y))].sort((a, b) => a - b);
  const rowY = new Map<number, number>();
  let packedY = 8;
  rows.forEach((row, i) => {
    // A small offset on one branch must not leave large empty bands elsewhere.
    // Compress each gap separately, preserving shared rows and vertical ordering.
    if (i) packedY += Math.min(BOX.h + 8, (row - rows[i - 1]) * 0.6);
    rowY.set(row, packedY);
  });
  const pos = new Map(src.map(b => [b.id, {
    x: 8 + (b.position.x - x.origin) * x.scale,
    y: rowY.get(b.position.y)!,
  }]));
  const height = Math.max(...[...pos.values()].map(p => p.y + BOX.h + 8));
  return { pos, height };
}

const dotColor = (s: string) => s === "idle" ? "border" : statusColor(s);
export function preview(key: string, def: WorkflowDefinition, run: RunDetail | undefined, selected: string | undefined, opts: { maxHeight: number }): UiNode {
  const { pos, height } = previewLayout(def);
  const items: CanvasItem[] = def.blocks.map(b => {
    const p = pos.get(b.id)!, s = blockStatus(b, run?.blocks.find(x => x.blockId === b.id));
    const sel = selected === b.id;
    return {
      key: b.id, x: p.x, y: p.y, width: BOX.w, height: BOX.h,
      ...(s === "running" ? { pulse: "primary" } : PAUSED.has(s) ? { pulse: "warning" } : {}),
      style: { background: s === "running" ? "selection" : "background", borderColor: sel ? "primary" : s === "idle" ? "border" : statusColor(s), borderWidth: sel ? 2 : 1, radius: 5, opacity: s === "skipped" || s === "cancelled" ? 0.55 : 1 },
      children: [{ type: "row", key: "r", gap: 5, style: { paddingX: 6, height: BOX.h - 2 }, children: [
        { type: "label", key: "d", text: "●", size: "xs", color: s === "idle" ? blockColor[b.type] || "muted" : dotColor(s) },
        { type: "label", key: "l", text: b.label.length > 15 ? b.label.slice(0, 14) + "…" : b.label, size: "xs", weight: "medium" },
      ] }],
    };
  });
  const edges: CanvasEdge[] = def.edges.filter(e => pos.has(e.from) && pos.has(e.to)).map(e => {
    const t = edgeType(e);
    const a = pos.get(e.from)!, b = pos.get(e.to)!;
    // Attach to facing sides; same-column branches should not loop out to the right.
    const dx = b.x - a.x, dy = b.y - a.y;
    const horizontal = Math.abs(dx) >= BOX.w;
    const fromSide = horizontal ? dx >= 0 ? "right" : "left" : dy >= 0 ? "bottom" : "top";
    const toSide = horizontal ? dx >= 0 ? "left" : "right" : dy >= 0 ? "top" : "bottom";
    const gap = horizontal ? Math.abs(dx) - BOX.w : Math.abs(dy) - BOX.h;
    return { key: e.id, from: e.from, to: e.to, fromSide, toSide, curveOffset: Math.max(2, Math.min(24, gap / 2)), color: t === "use" ? "#8b6fe8" : t === "path" ? "warning" : "border", dashed: t === "use", width: 1.4, arrow: false, sparkColor: t === "use" ? "#a58bff" : "primary" };
  });
  // Give the canvas a bounded parent: its native scroll surface fills available space.
  // The wrapper owns the preview height so it cannot stretch to the workflow card.
  return { type: "column", key: `${key}:frame`, height: Math.min(opts.maxHeight, height + 8),
    style: { background: "background", borderColor: "border", borderWidth: 1, radius: 8 },
    children: [{ type: "canvas", key, items, edges: transferEdges(edges, run), margin: 8, grow: true, selectAction: "previewSelect" } as UiNode],
  } as UiNode;
}

const outputBox = (key: string, value: string, markdown: boolean): UiNode => markdown
  ? { type: "column", key, scroll: true, maxHeight: 320, style: { background: "background", borderColor: "border", borderWidth: 1, radius: 6, padding: 8 }, children: [{ type: "markdown", key: "m", text: value, inline: true } as UiNode] }
  : { type: "column", key, scroll: true, maxHeight: 320, style: { background: "background", borderColor: "border", borderWidth: 1, radius: 6, padding: 8 }, children: [{ type: "label", key: "t", text: value, mono: true, size: "xs", wrap: true, selectable: true } as UiNode] };

export function blockStatus(b: WorkflowBlock, st?: WorkflowBlockState): string {
  if (b.type === "chatbox" && st?.agentActivity) {
    if (["busy", "starting"].includes(st.agentActivity.status)) return "running";
    if (st.agentActivity.status === "waiting") return "awaiting_permission";
  }
  return st?.status || "idle";
}
const PARTICIPANT_COLORS = ["#60a5fa", "#c084fc", "#34d399", "#fbbf24", "#fb7185", "#22d3ee", "#f97316", "#a3e635"];
export function participantColor(run: RunDetail, blockId: string): string {
  const index = run.definition.blocks.filter(isAgentBlock).findIndex(b => b.id === blockId);
  const fallback = [...(blockId || "unknown")].reduce((hash, c) => (hash * 31 + c.charCodeAt(0)) >>> 0, 0);
  return PARTICIPANT_COLORS[(index >= 0 ? index : fallback) % PARTICIPANT_COLORS.length];
}
export function chatStatus(st: WorkflowBlockState) {
  const status = st.agentActivity?.status;
  const fallback = st.status === "running" ? "busy" : st.status === "awaiting_permission" ? "waiting" : st.status === "failed" ? "error" : st.sessionId ? "ready" : "idle";
  const value = status || fallback;
  const labels: Record<string, string> = { busy: "Working", starting: "Connecting", waiting: "Waiting for permission", ready: "Ready", stopped: "Stopped", interrupted: "Interrupted", error: "Error", unavailable: "Status unavailable", idle: "Not started" };
  return { label: labels[value] || value, busy: ["busy", "starting", "waiting"].includes(value),
    color: value === "waiting" ? "warning" : value === "busy" || value === "starting" ? "primary" : value === "error" || value === "interrupted" ? "danger" : "muted",
    detail: st.agentActivity?.text || (value === "busy" ? "Agent is working…" : value === "ready" ? "Ready for a message" : ""),
  };
}
/** A separate card below block content, collapsed until the user opens it. */
export function activityLog(run: RunDetail, st: WorkflowBlockState, prefix: string): UiNode {
  const ref = JSON.stringify([run.id, st.blockId]), open = S.logOpen.has(ref);
  const logs = st.log || [];
  const key = `${prefix}:${run.id}:${st.blockId}:activity-section`;
  return card(key, [
    btn(`${key}:toggle`, `Activity log · ${logs.length}`, "toggleActivity", { value: ref, iconSvg: blockIcon[open ? "chevron-up" : "chevron-down"], variant: "ghost", tooltip: open ? "Collapse activity log" : "Expand activity log" }),
    ...(open ? [{ type: "column", key: `${prefix}:${run.id}:${st.blockId}:activity`, scroll: true, height: 220, gap: 6, children: logs.length ? logs.map((entry, i) => ({
      type: "column", key: `entry-${i}`, gap: 2, children: [
        muted("at", `${new Date(entry.at).toLocaleTimeString()} · ${entry.kind}`, { color: entry.kind === "error" ? "danger" : "muted" }),
        text("entry", entry.text, { selectable: true, mono: true, size: "xs" }),
      ],
    } as UiNode)) : [muted("empty", "No activity recorded yet.")] } as UiNode] : []),
  ], { style: { background: "background" } });
}

/** Details of one block in a run: status, error, question/answer, permission, chat, output. */
export function blockRunView(run: RunDetail, b: WorkflowBlock, st: WorkflowBlockState & { outputChars?: number }, prefix: string, includeActivity = true): UiNode[] {
  const k = (s: string) => `${prefix}:${run.id}:${b.id}:${s}`;
  const chat = b.type === "chatbox" ? chatStatus(st) : null;
  const out: UiNode[] = [{ type: "row", key: k("h"), gap: 6, children: [
    { type: "button", key: "i", text: "", iconSvg: blockIcon[b.type] || blockIcon.workflow, iconSize: 14, action: "", small: true, variant: "ghost", style: { color: blockColor[b.type] } } as UiNode,
    text("n", b.label, { weight: "semibold", grow: true, wrap: false }),
    { type: "row", key: "chip", gap: 4, style: { background: "raised", radius: 10, paddingX: 7, paddingY: 1 }, children: [
      { type: "label", key: "d", text: "●", size: "xs", color: chat?.color || dotColor(st.status) },
      { type: "label", key: "s", text: `${chat?.label || statusText[st.status] || st.status}${st.runs > 1 ? ` ×${st.runs}` : ""}`, size: "xs" },
    ] },
    ...(st.sessionId ? [icon("chat", blockIcon.chat, "openChat", "Open this block's agent session in the AI chat", { value: st.sessionId })] : []),
  ] }];
  if (st.error) out.push({ type: "status", key: k("err"), level: "error", text: st.error });
  if (st.status === "awaiting_user_input" && st.question) {
    out.push(outputBox(k("q"), st.question, true));
    if (b.type === "yes_no_prompt") out.push({ type: "row", key: k("yn"), gap: 6, children: [
      btn("yes", "Yes", "answer", { value: { runId: run.id, blockId: b.id, pauseId: st.pauseId, answer: "yes" }, variant: "primary" }),
      btn("no", "No", "answer", { value: { runId: run.id, blockId: b.id, pauseId: st.pauseId, answer: "no" } }),
    ] });
    else out.push({ type: "row", key: k("ans"), gap: 6, align: "end", children: [
      { type: "textInput", key: `answer:${run.id}:${st.pauseId}`, changeAction: "answerText", submitAction: "answerSubmit", placeholder: "Type your answer, then Enter", grow: true, multiline: true, rows: 2 } as UiNode,
      btn("send", "Send", "answerSubmit", { value: `answer:${run.id}:${st.pauseId}`, variant: "primary" }),
    ] });
  }
  const permissionId = st.agentActivity?.status === "waiting" ? st.agentActivity.permissionId : st.permissionId;
  if ((st.status === "awaiting_permission" || st.agentActivity?.status === "waiting") && st.sessionId && permissionId) out.push(btn(k("perm"), "Review permission", "reviewPermission", { value: { sessionId: st.sessionId, permissionId }, variant: "primary" }));
  if (st.status === "waiting_timer" && st.waitingUntil) out.push(muted(k("timer"), `Fires at ${new Date(st.waitingUntil).toLocaleTimeString()}`, { color: "info" }));
  if (b.type === "chatbox") {
    const agent = chatStatus(st);
    out.push({ type: "row", key: k("agent-status"), gap: 6, children: [
      text("dot", "●", { color: agent.color, wrap: false }), text("status", agent.label, { weight: "semibold", color: agent.color, wrap: false }),
      muted("activity", agent.detail.replace(/\s+/g, " ").trim().slice(0, 100), { grow: true, wrap: false }),
    ] });
    if (agent.busy) out.push({ type: "progress", key: k("agent-busy"), indeterminate: true, height: 3 } as UiNode);
    const ref = JSON.stringify([run.id, b.id]);
    const history = S.chatHistory.get(ref);
    const transcript = history?.messages || (st.agentMessages?.length ? st.agentMessages : (st.chat || []).map(m => ({ key: k(`m-${m.id}`), role: m.role, text: m.text })));
    const hasOlder = (history ? history.before : st.agentHistoryBefore) != null;
    const messages = transcriptItems(transcript, { agentLabel: b.label, hasOlder, loadingOlder: history?.loading, historyError: history?.error, loadOlderAction: "chatHistoryOlder" });
    const older = messages.find(m => m.key === "__older");
    if (older?.type === "button") { older.value = ref; older.key = `__older:${transcript[0]?.key || ""}`; }
    if (messages.length) out.push({ type: "column", key: k("messages"), height: 320, children: [{ type: "transcript", key: `chat-history:${ref}`, scrollbarMode: "scrolling", grow: true, scrollKey: `${run.id}:${b.id}:${st.sessionId || ""}`, followKey: followKey(transcript),
      hasOlder, loadingOlder: history?.loading, loadOlderAction: history?.error ? undefined : "chatHistoryOlder", children: messages }] });
    if (run.status !== "cancelled") out.push({ type: "row", key: k("chat"), gap: 6, align: "end", children: [
      { type: "textInput", key: `chat:${run.id}:${b.id}`, value: S.chatDrafts.get(`chat:${run.id}:${b.id}`) || "", changeAction: "chatText", submitAction: "chatSend", placeholder: `Message ${b.label}`, grow: true, multiline: true, rows: 2 } as UiNode,
      btn("send", "Send", "chatSend", { value: `chat:${run.id}:${b.id}`, variant: "primary", disabled: agent.busy }),
    ] });
  } else if (st.output && b.type !== "meeting") {
    out.push(outputBox(k("out"), st.output, b.type === "markdown" || isAgentBlock(b)));
    out.push({ type: "row", key: k("oa"), gap: 6, children: [
      ...((st.outputChars || 0) > st.output.length ? [muted("trunc", `Preview of ${st.outputChars} characters`, { grow: true })] : [{ type: "spacer", key: "sp" } as UiNode]),
      btn("copy", "Copy output", "", { iconSvg: blockIcon.copy, variant: "ghost", copyText: st.output }),
    ] });
  }
  if (b.type === "meeting" && st.meeting?.messages.length) out.push(
    text(k("transcript-title"), "Meeting transcript", { weight: "semibold" }),
    { type: "column", key: k("transcript"), scroll: true, maxHeight: 280, gap: 6, children: st.meeting.messages.map(m => ({
      type: "column", key: k(`mt-${m.seq}`), gap: 2,
      style: { borderLeft: 3, borderColor: participantColor(run, m.blockId), paddingX: 10, paddingY: 6, background: "background", radius: 4 }, children: [
        muted("author", `${m.author} · ${new Date(m.at).toLocaleTimeString()}`, { color: participantColor(run, m.blockId), weight: "semibold" }),
        text("message", m.text, { selectable: true, ...(m.kind === "status" ? { size: "xs", style: { italic: true } } : {}) }),
      ],
    } as UiNode)) },
  );
  if (includeActivity) out.push(activityLog(run, st, prefix));
  return out;
}

export const pausedBlocks = (run?: RunDetail) => (run?.blocks || []).filter(s => PAUSED.has(s.status));
export { edgeStyle };
