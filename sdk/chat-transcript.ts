// Chat transcript presentation: turns chat messages into ordinary UI nodes for the native
// `transcript` container (which only handles scrolling, follow-to-bottom and history paging).
// Cards, labels, colors and copy buttons are all module data — restyle them here.
import type { ChatDiff, ChatMessage, UiNode, UiStyle } from "./types";
import { uiIcons } from "./ui-icons";
import { stripProgressMarkers } from "./persistent-agents";

export interface TranscriptOptions {
  thinking?: boolean;
  /** Header label for assistant messages, e.g. "Claude · Sonnet". */
  agentLabel?: string;
  /** Fired with the raw href for non-web links inside rendered markdown. */
  linkAction?: string;
  /** More history exists above (used by historyEdge; never adds a transcript item). */
  hasOlder?: boolean;
  loadingOlder?: boolean;
  historyError?: string | null;
  loadOlderAction?: string;
  /** Workspace root, stripped from diff paths. */
  rootPath?: string;
  /** `${messageKey}:${diffIndex}` of diffs the user expanded past the preview. */
  expandedDiffs?: ReadonlySet<string>;
  /** Fired with `${messageKey}:${diffIndex}` from "Show all lines" / "Show less". */
  diffToggleAction?: string;
}

/** Diff lines shown before "Show all" (per file). */
export const DIFF_PREVIEW_LINES = 12;
const DIFF_TINT = { add: "#2ea04324", del: "#f8514924" };

export const ROLE_LABELS: Record<string, string> = { user: "YOU", plan: "PLAN", error: "ERROR", system: "SYSTEM" };
const EDGE: Record<string, string> = { user: "primary", assistant: "agentEdge", error: "danger" };

/** Keep tool summaries on one visual row even when an agent supplies multiline titles. */
export const singleLine = (text: string) => text.split(/\s+/).filter(Boolean).join(" ");

const copyButton = (key: string, text: string, tooltip: string, size = 22): UiNode => ({
  type: "button", key, text: "", iconSvg: uiIcons.copy, iconSize: 14, copyText: text, action: "", variant: "ghost", small: true, tooltip,
  style: { width: size + 4, height: 22, padding: 0, noShrink: true },
});

function markdown(key: string, text: string, linkAction?: string, style?: UiStyle): UiNode {
  return { type: "markdown", key, text, inline: true, lineHeight: 18, paragraphGap: 0.3, linkAction, style };
}

export function messageNode(m: ChatMessage, opts: TranscriptOptions = {}): UiNode {
  if (m.role === "system" && /^Turn ended(?::|$)/.test(m.text)) {
    return { type: "divider", key: m.key, tooltip: m.text };
  }
  if (m.role === "thought") {
    return { type: "column", key: m.key, gap: 2, style: { borderLeft: 2, borderColor: "border", paddingX: 12, paddingY: 4, color: "muted", fontSize: 14 }, children: [
      { type: "label", key: "kind", text: "REASONING", size: "xs" },
      { type: "label", key: "body", text: m.text.replace(/\*\*([^]*?)\*\*/g, "$1").replace(/\*([^*\n]+)\*/g, "$1").replace(/\r\n?/g, "\n").replace(/\n[ \t]*\n+/g, "\n").trim(), wrap: true, selectable: true, color: "muted", style: { italic: true, fontWeight: 400, color: "muted", lineHeight: 18 } },
    ] };
  }
  if (m.role === "tool") {
    const title = m.title || "Tool";
    const copied = m.text ? `${title}\n${m.text}` : title;
    const head: UiNode[] = [
      { type: "label", key: "kind", text: "TOOLS", size: "xs" },
      { type: "label", key: "summary", text: singleLine(title), grow: true },
      ...(m.status ? [{ type: "label", key: "status", text: singleLine(m.status), size: "xs", style: { maxWidth: 72 } } as UiNode] : []),
      copyButton("copy", copied, "Copy tool output"),
    ];
    if (!m.diffs?.length) return { type: "row", key: m.key, gap: 8, align: "center", style: { height: 28, noShrink: true, paddingX: 12, radius: 7, borderWidth: 1, borderColor: "border", color: "muted", fontSize: 14 }, children: head };
    return { type: "column", key: m.key, gap: 0, style: { noShrink: true, radius: 7, borderWidth: 1, borderColor: "border", color: "muted", fontSize: 14, clip: true }, children: [
      { type: "row", key: "head", gap: 8, align: "center", style: { height: 28, paddingX: 12 }, children: head },
      ...m.diffs.map((d, i) => diffNode(m.key, d, i, opts)),
    ] };
  }
  const label = m.role === "assistant" ? (opts.agentLabel || "AGENT") : ROLE_LABELS[m.role] || "SYSTEM";
  const body: UiNode[] = [];
  if (m.text) {
    body.push(m.role === "assistant" || m.role === "plan"
      ? markdown("text", m.text, opts.linkAction)
      : { type: "label", key: "text", text: m.text, wrap: true, selectable: true, style: { lineHeight: 18 } });
  }
  for (const [i, image] of (m.images || []).entries()) body.push({ type: "image", key: `image-${i}`, image, width: 200, height: 140 });
  return { type: "row", key: m.key, align: "stretch", style: { radius: 9, borderWidth: 1, borderColor: "border", noShrink: true }, children: [
    { type: "column", key: "edge", style: { width: 2, background: EDGE[m.role] || "border" }, children: [] },
    { type: "column", key: "card", grow: true, children: [
      { type: "row", key: "header", gap: 8, align: "center", style: { paddingX: 12, paddingY: 2, background: "surface", borderBottom: 1, borderColor: "border" }, children: [
        { type: "label", key: "role", text: label.toUpperCase(), size: "xs", color: "muted", grow: true },
        copyButton("copy", m.text, "Copy message"),
      ] },
      { type: "column", key: "body", gap: 4, style: { paddingX: 12, paddingY: 4, lineHeight: 18, background: m.role === "user" ? "selection" : "answer", color: "text" }, children: body },
    ] },
  ] };
}

/** One edited file inside a tool card: path + counts, then tinted hunk lines (preview, expandable). */
function diffNode(messageKey: string, d: ChatDiff, index: number, opts: TranscriptOptions): UiNode {
  const id = `${messageKey}:${index}`;
  const root = opts.rootPath?.replace(/\/+$/, "");
  const rel = root && d.path.startsWith(root + "/") ? d.path.slice(root.length + 1) : d.path;
  const slash = rel.lastIndexOf("/");
  const open = !!opts.expandedDiffs?.has(id);
  const shown = open ? d.lines : d.lines.slice(0, DIFF_PREVIEW_LINES);
  const hidden = d.lines.length - shown.length;
  const line = (text: string, j: number): UiNode => {
    const kind = text[0];
    const hunk = text.startsWith("@@");
    return { type: "label", key: `l${j}`, text: (hunk ? text : text.replace(/\t/g, "  ")) || " ", mono: true,
      color: hunk ? "faint" : kind === "+" ? "success" : kind === "-" ? "danger" : "muted",
      style: { fontSize: 11.5, lineHeight: 16, paddingX: 10, ...(kind === "+" && !hunk ? { background: DIFF_TINT.add } : kind === "-" && !hunk ? { background: DIFF_TINT.del } : {}) } } as UiNode;
  };
  const more: UiNode[] = hidden > 0 || open && d.lines.length > DIFF_PREVIEW_LINES
    ? [{ type: "button", key: "more", variant: "ghost", small: true, action: opts.diffToggleAction || "", value: id, disabled: !opts.diffToggleAction,
        text: open ? "Show less" : `Show ${hidden} more line${hidden === 1 ? "" : "s"}`, style: { fullWidth: true, height: 22, fontSize: 11.5 } } as UiNode]
    : [];
  return { type: "column", key: `diff-${index}`, gap: 0, style: { borderTop: 1, borderColor: "border" }, children: [
    { type: "row", key: "file", gap: 6, align: "center", tooltip: d.path, style: { height: 24, paddingX: 12 }, children: [
      { type: "label", key: "name", text: slash >= 0 ? rel.slice(slash + 1) : rel, size: "xs", color: "text", style: { noShrink: true } },
      ...(slash > 0 ? [{ type: "label", key: "dir", text: rel.slice(0, slash), size: "xs", color: "faint", grow: true } as UiNode] : [{ type: "spacer", key: "sp" } as UiNode]),
      ...(d.newFile ? [{ type: "label", key: "new", text: "new", size: "xs", color: "faint" } as UiNode] : []),
      { type: "label", key: "add", text: `+${d.added}`, size: "xs", color: "success", mono: true },
      { type: "label", key: "del", text: `−${d.removed}`, size: "xs", color: "danger", mono: true },
    ] },
    { type: "column", key: "lines", gap: 0, style: { paddingY: 3, background: "surface", clip: true }, children: [
      ...shown.map(line),
      ...(d.truncated && open ? [{ type: "label", key: "cut", text: "… diff too long to show in full", size: "xs", color: "faint", style: { paddingX: 10 } } as UiNode] : []),
    ] },
    ...more,
  ] };
}

/** Overlay pinned to the top edge of a transcript while older history loads or fails.
 *  Deliberately not a transcript item: the native transcript detects prepends (and anchors the
 *  reading position) by its first item, which must stay a real message. Older pages load by
 *  themselves when the transcript nears the top (`loadOlderAction`). Place it in a relative
 *  container next to the transcript. */
export function historyEdge(opts: Pick<TranscriptOptions, "hasOlder" | "loadingOlder" | "historyError" | "loadOlderAction">): UiNode | null {
  if (!opts.hasOlder) return null;
  const loading = !!opts.loadingOlder, failed = !loading && !!opts.historyError;
  if (!loading && !failed) return null;
  return { type: "row", key: "history-edge", gap: 6, align: "center", presence: { enter: { opacity: 0, durationMs: 120 }, exit: { opacity: 0, durationMs: 160 } },
    style: { position: "absolute", top: 6, left: 0, right: 0, justify: "center" }, children: [
      { type: "row", key: "pill", gap: 6, align: "center", action: failed ? opts.loadOlderAction : undefined, tooltip: opts.historyError || undefined,
        hoverStyle: failed ? { background: "hover" } : undefined,
        style: { height: 24, paddingX: 10, radius: 12, background: "panel", borderWidth: 1, borderColor: "border" }, children: [
          ...(loading ? [{ type: "spinner", key: "spin", size: 11, color: "muted", thickness: 1.5 } as UiNode] : []),
          { type: "label", key: "text", size: "xs", color: failed ? "danger" : "muted", text: loading ? "Loading older messages…" : "Couldn’t load older messages · Retry" },
        ] } as UiNode,
    ] } as UiNode;
}

/** Items for a `transcript` node: one node per message (history state: see historyEdge). */
/** A report_progress tool call, whatever prefix the provider gives MCP tool titles. */
export const isProgressReport = (m: ChatMessage) => m.role === "tool" && /report[_.\s-]?progress/i.test(m.title || "");

export function transcriptItems(messages: ChatMessage[], opts: TranscriptOptions = {}): UiNode[] {
  const items: UiNode[] = [];
  // Permission decisions are logged, not shown; this also hides ones saved before that change.
  // report_progress calls feed the sidebar's progress bars and never appear in the chat.
  for (const raw of messages) {
    if ((raw.role === "system" && /^Permission for "/.test(raw.text || "")) || isProgressReport(raw)) continue;
    // Agents without Hato's tools report progress as an HTML comment in their reply.
    const m = raw.role === "assistant" && raw.text?.includes("<!--") ? { ...raw, text: stripProgressMarkers(raw.text) } : raw;
    if (m !== raw && !m.text && !m.images?.length) continue;
    items.push(messageNode(m, opts));
  }
  if (opts.thinking) items.push({ type: "row", key: "thinking", gap: 8, align: "center",
    style: { paddingX: 12, paddingY: 8 }, children: [
      { type: "spinner", key: "animation", size: 12, color: "muted", thickness: 1.5 } as UiNode,
      { type: "label", key: "label", text: "Thinking…", size: "sm", color: "muted" },
    ] });
  return items;
}

/** Key of the newest user message: the transcript re-follows the bottom when it changes. */
export const followKey = (messages: ChatMessage[]) => [...messages].reverse().find((m) => m.role === "user")?.key;
