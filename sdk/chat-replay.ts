/** Persistence-side replay merge. Local row IDs and local-only messages remain stable. */
export interface ReplayMessage { id: string; kind: string; payload: any; sequence?: number }
const scope = (m: ReplayMessage) => String(m.payload?.providerSessionId || "");
const identity = (m: ReplayMessage) => {
  const id = m.kind === "tool" ? m.payload?.toolCallId : m.payload?.providerMessageId;
  return typeof id === "string" && id ? `${scope(m)}\0${m.kind}\0${id}` : null;
};
const fingerprint = (m: ReplayMessage, outgoing = false) => `${m.kind}\0${outgoing ? m.payload?.outgoingText ?? m.payload?.text ?? "" : m.payload?.text ?? ""}\0${JSON.stringify((m.payload?.images || []).map((i: any) => [i.mimeType, i.data]))}`;
export function reconcileReplay(existing: ReplayMessage[], replay: ReplayMessage[]): ReplayMessage[] {
  const ids = new Map<string, ReplayMessage>();
  const text = new Map<string, ReplayMessage[]>();
  for (const m of existing) {
    const key = identity(m); if (key) ids.set(key, m);
    // Store both displayed and actual submitted text; consume rows, not fingerprint counters.
    for (const fp of new Set([fingerprint(m), fingerprint(m, true)])) {
      const key = `${scope(m)}\0${fp}`, rows = text.get(key) || []; rows.push(m); text.set(key, rows);
    }
  }
  const consumed = new Set<string>();
  const matched = replay.map(m => {
    const key = identity(m), byId = key ? ids.get(key) : undefined;
    const fp = fingerprint(m);
    const candidate = byId && !consumed.has(byId.id) ? byId :
      [ ...(text.get(`${scope(m)}\0${fp}`) || []), ...(scope(m) ? text.get(`\0${fp}`) || [] : []) ].find(row => !consumed.has(row.id));
    if (!candidate) return { message: m, known: false };
    consumed.add(candidate.id);
    // Keep local user text (including original attachments) while attaching provider correlation.
    const payload = { ...candidate.payload, ...(m.payload.providerMessageId ? { providerMessageId: m.payload.providerMessageId } : {}), ...(scope(m) ? { providerSessionId: scope(m) } : {}) };
    return { message: { ...candidate, payload }, known: true };
  });
  const enriched = new Map(matched.filter(m => m.known).map(m => [m.message.id, m.message]));
  const result = existing.map(m => enriched.get(m.id) || m);
  // Insert runs before the next known anchor, or after the previous anchor when there is no next.
  let previous: string | null = null;
  for (let i = 0; i < matched.length;) {
    if (matched[i].known) { previous = matched[i++].message.id; continue; }
    const run: ReplayMessage[] = [];
    while (i < matched.length && !matched[i].known) run.push(matched[i++].message);
    const next = matched[i]?.message.id;
    const at = next ? result.findIndex(m => m.id === next) : previous ? result.findIndex(m => m.id === previous) + 1 : result.length;
    result.splice(at < 0 ? result.length : at, 0, ...run);
    previous = run[run.length - 1]?.id || previous;
  }
  return result.map((m, i) => ({ ...m, sequence: i + 1 }));
}
