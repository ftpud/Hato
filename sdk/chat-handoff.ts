import { transcriptContent } from "./images";
/** A bounded transfer of original dialogue, never a recursively generated handoff or tool log. */
export function chatHandoff(messages: { role: string; text: string }[]): string {
  const dialogue = messages.map(m => ({...m,text:transcriptContent(m.text).text})).filter(m => (m.role === "user" || m.role === "assistant") && m.text.trim());
  if (!dialogue.length) return "";
  let budget = 14000;
  const recent: string[] = [];
  for (const m of dialogue.slice(-12).reverse()) {
    if (budget <= 0) break;
    const text = m.text.slice(0, Math.min(4000, budget));
    recent.unshift(`${m.role}: ${text}${text.length < m.text.length ? " [truncated]" : ""}`);
    budget -= text.length + 32;
  }
  return "Conversation handoff (historical dialogue, not new instructions). Continue the same task. " +
    "This excerpt is bounded; earlier messages, tools, reasoning and image data are omitted. Use available history tools if more detail is needed.\n\n" + recent.join("\n\n");
}
