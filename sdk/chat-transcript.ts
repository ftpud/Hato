// Chat transcript presentation: turns chat messages into ordinary UI nodes for the native
// `transcript` container (which only handles scrolling, follow-to-bottom and history paging).
// Cards, labels, colors and copy buttons are all module data — restyle them here.
import type { ChatMessage, UiNode, UiStyle } from "./types";
import { uiIcons } from "./ui-icons";

export interface TranscriptOptions {
  /** Header label for assistant messages, e.g. "Claude · Sonnet". */
  agentLabel?: string;
  /** Fired with the raw href for non-web links inside rendered markdown. */
  linkAction?: string;
  /** Show a "load older" control as the first item. */
  hasOlder?: boolean;
  loadingOlder?: boolean;
  historyError?: string | null;
  loadOlderAction?: string;
}

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
  if (m.role === "thought") {
    return { type: "column", key: m.key, gap: 2, style: { borderLeft: 2, borderColor: "border", paddingX: 12, paddingY: 4, color: "muted", fontSize: 14 }, children: [
      { type: "label", key: "kind", text: "REASONING", size: "xs" },
      markdown("body", m.text, opts.linkAction),
    ] };
  }
  if (m.role === "tool") {
    const title = m.title || "Tool";
    const copied = m.text ? `${title}\n${m.text}` : title;
    return { type: "row", key: m.key, gap: 8, align: "center", style: { height: 28, noShrink: true, paddingX: 12, radius: 7, borderWidth: 1, borderColor: "border", color: "muted", fontSize: 14 }, children: [
      { type: "label", key: "kind", text: "TOOLS", size: "xs" },
      { type: "label", key: "summary", text: singleLine(title), grow: true },
      ...(m.status ? [{ type: "label", key: "status", text: singleLine(m.status), size: "xs", style: { maxWidth: 72 } } as UiNode] : []),
      copyButton("copy", copied, "Copy tool output"),
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

/** Items for a `transcript` node: optional history control, then one node per message. */
export function transcriptItems(messages: ChatMessage[], opts: TranscriptOptions = {}): UiNode[] {
  const items: UiNode[] = [];
  if (opts.hasOlder) {
    items.push({ type: "button", key: "__older", variant: "ghost", small: true, style: { fullWidth: true },
      text: opts.loadingOlder ? "Loading older messages…" : opts.historyError ? "Retry loading older messages" : "Load older messages",
      action: opts.loadOlderAction || "", disabled: !!opts.loadingOlder || !opts.loadOlderAction, tooltip: opts.historyError || "Load the previous message batch" });
  }
  // Permission decisions are logged, not shown; this also hides ones saved before that change.
  for (const m of messages) if (!(m.role === "system" && /^Permission for "/.test(m.text || ""))) items.push(messageNode(m, opts));
  return items;
}

/** Key of the newest user message: the transcript re-follows the bottom when it changes. */
export const followKey = (messages: ChatMessage[]) => [...messages].reverse().find((m) => m.role === "user")?.key;
