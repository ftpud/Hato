// File edits from ACP tool-call content, reduced to capped hunks for chat transcripts.
// Shared by the desktop chat service (ai-sessions) and the background agent runner.
import type { ChatDiff } from "./types";
import { diffHunks } from "./text-diff";

/** File edits in ACP tool content ({type:"diff", path, oldText, newText}) as capped hunks for the transcript. */
export function acpDiffs(content: unknown): ChatDiff[] {
  const blocks: any[] = Array.isArray(content) ? content : content ? [content] : [];
  const out: ChatDiff[] = [];
  for (const block of blocks.slice(0, 20)) {
    if (block?.type !== "diff" || typeof block.path !== "string") continue;
    const before = typeof block.oldText === "string" ? block.oldText : null;
    const after = typeof block.newText === "string" ? block.newText : "";
    // Huge rewrites cost more to diff than they're worth inline; count lines instead.
    if ((before?.length || 0) + after.length > 400_000) { out.push({ path: block.path, lines: [], added: after.split("\n").length, removed: before ? before.split("\n").length : 0, newFile: before === null, truncated: true }); continue; }
    const hunks = diffHunks(before, after, 300);
    out.push({ path: block.path, ...hunks, ...(before === null ? { newFile: true } : {}) });
  }
  return out;
}
