// Deterministic ACP provider for the progress smoke test: replies with Hato progress markers.
// The reply says whether the prompt carried Hato's marker instruction, reports 40%, stays busy
// long enough for the driver to look at the sidebar, then reports 100% and ends the turn.
import readline from 'node:readline';
const session = 'progress-session';
const send = v => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...v }) + '\n');
const chunk = text => send({ method: 'session/update', params: { sessionId: session, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });
for await (const line of readline.createInterface({ input: process.stdin })) {
  const r = JSON.parse(line);
  if (!r.method) continue;
  if (r.method === 'initialize') send({ id: r.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
  else if (['session/new', 'session/load'].includes(r.method)) send({ id: r.id, result: { sessionId: session } });
  else if (r.method === 'session/cancel') send({ id: r.id, result: {} });
  else if (r.method === 'session/prompt') {
    const text = r.params.prompt.map(b => b.text || '').join('\n');
    const told = /hato-progress/.test(text);
    chunk(`instruction:${told ? 'yes' : 'no'}\n`);
    // Split the marker across two chunks, as a real stream may.
    chunk('Working on it.\n<!-- hato-prog');
    chunk('ress 40 | Smoke step -->\n');
    setTimeout(() => {
      chunk('<!-- hato-progress 100 | Done -->\nFinished.');
      send({ id: r.id, result: { stopReason: 'end_turn' } });
    }, 4000);
  } else send({ id: r.id, error: { code: -32601, message: 'unsupported' } });
}
