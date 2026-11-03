import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as esbuild from 'esbuild';
let generation = 0;
async function session() {
  const result = await esbuild.build({ entryPoints: ['modules/services/ai-sessions/src/index.ts'], bundle: true, format: 'esm', write: false });
  return (await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64') + '#' + (++generation))).default;
}
function fixture(total) {
  const rows = Array.from({ length: total }, (_, index) => ({ id: 'm' + (index + 1), sequence: index + 1, kind: 'user', payload: { text: 'Message ' + (index + 1) } }));
  const listeners = {}, requests = [];
  let intercept;
  const ctx = { events: { on: (topic, fn) => { listeners[topic] = fn; }, emit() {} }, state: { set() {}, get() {}, watch() {} }, log: { warn() {} }, modules: { async call(_, method, args) {
    if (method === 'resolve') return { id: 'ws', machineId: 'local' };
    if (method === 'conversations.list') return [{ id: 'c', title: 'Chat' }];
    if (method === 'view.get') return { activeConversationId: 'c' };
    if (method === 'profiles') return [];
    if (method === 'conversations.get') return { id: 'c', title: 'Chat', workspaceId: 'ws' };
    if (method === 'messages.list') {
      requests.push(args);
      if (intercept && args.beforeSequence) await intercept();
      return rows.filter(row => !args.beforeSequence || row.sequence < args.beforeSequence).slice(-args.limit);
    }
    if (method === 'state') return { status: 'ready' };
    if (method === 'authSettings') return {};
    if (method === 'messages.upsert') return;
    throw new Error(method);
  } } };
  return { ctx, rows, listeners, requests, setIntercept: fn => { intercept = fn; } };
}

test('chat loads the newest page first and pages all older history without gaps or a 400-message cutoff', async () => {
  const mod = await session();
  const f = fixture(520);
  await mod.activate(f.ctx);
  let view = await mod.methods.view(f.ctx, { workspaceId: 'ws' });
  assert.equal(view.active.messages.length, 80);
  assert.equal(view.active.messages[0].key, 'm441');
  assert.equal(view.active.hasOlder, true);
  assert.equal(f.requests[0].limit, 81);
  for (let page = 0; page < 6; page++) await mod.methods.loadOlder(f.ctx, { conversationId: 'c' });
  view = await mod.methods.view(f.ctx, { workspaceId: 'ws' });
  assert.equal(view.active.messages.length, 520);
  assert.equal(view.active.hasOlder, false);
  assert.deepEqual(view.active.messages.map(m => m.key), f.rows.map(m => m.id));
  assert.deepEqual(f.requests.slice(1).map(r => r.beforeSequence), [441, 361, 281, 201, 121, 41]);
  assert.deepEqual(await mod.methods.loadOlder(f.ctx, { conversationId: 'c' }), { loaded: 0, hasOlder: false });
});

test('history requests are deduplicated and concurrent live messages survive prepend', async () => {
  const mod = await session();
  const f = fixture(120);
  await mod.activate(f.ctx);
  await mod.methods.view(f.ctx, { workspaceId: 'ws' });
  let release;
  f.setIntercept(() => new Promise(resolve => { release = resolve; }));
  const first = mod.methods.loadOlder(f.ctx, { conversationId: 'c' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await mod.methods.view(f.ctx, { workspaceId: 'ws' })).active.historyLoading, true);
  assert.deepEqual(await mod.methods.loadOlder(f.ctx, { conversationId: 'c' }), { loaded: 0, hasOlder: true });
  f.listeners['acp.update']({ conversationId: 'c', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Live reply' } } });
  release(); await first;
  const view = await mod.methods.view(f.ctx, { workspaceId: 'ws' });
  assert.equal(view.active.messages.length, 121);
  assert.equal(view.active.messages.at(-1).text, 'Live reply');
  assert.equal(view.active.historyLoading, false);
});

test('failed history requests preserve the cursor and expose an error for retry', async () => {
  const mod = await session();
  const f = fixture(100);
  await mod.activate(f.ctx);
  await mod.methods.view(f.ctx, { workspaceId: 'ws' });
  f.setIntercept(async () => { throw new Error('Read failed'); });
  await assert.rejects(mod.methods.loadOlder(f.ctx, { conversationId: 'c' }), /Read failed/);
  let view = await mod.methods.view(f.ctx, { workspaceId: 'ws' });
  assert.equal(view.active.historyError, 'Read failed');
  assert.equal(view.active.hasOlder, true);
  assert.equal(view.active.historyLoading, false);
  f.setIntercept(null);
  await mod.methods.loadOlder(f.ctx, { conversationId: 'c' });
  view = await mod.methods.view(f.ctx, { workspaceId: 'ws' });
  assert.equal(view.active.messages.length, 100);
  assert.equal(view.active.historyError, null);
  assert.equal(f.requests[1].beforeSequence, f.requests[2].beforeSequence);
});

test('the UI projection is limited to 20 messages and paging stays anchored during live appends', async () => {
  const mod = await session(), f = fixture(120);
  await mod.activate(f.ctx);
  const read = beforeMessageId => mod.methods.view(f.ctx, { workspaceId: 'ws', messageLimit: 20, windowConversationId: 'c', beforeMessageId });
  let view = await read();
  assert.equal(view.active.messages.length, 20);
  assert.equal(view.active.messages[0].key, 'm101');
  assert.equal(view.active.hasLoadedOlder, true);
  view = await read('m101');
  assert.equal(view.active.messages[0].key, 'm81');
  assert.equal(view.active.messages.at(-1).key, 'm100');
  f.listeners['acp.update']({ conversationId: 'c', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Live reply' } } });
  view = await read('m101');
  assert.equal(view.active.messages.length, 20);
  assert.equal(view.active.messages.at(-1).key, 'm100');
  assert.equal(view.active.hasNewer, true);
  await mod.methods.loadOlder(f.ctx, { conversationId: 'c' });
  view = await read('m41');
  assert.equal(view.active.messages.length, 20);
  assert.equal(view.active.messages[0].key, 'm21');
  assert.equal(view.active.messages.at(-1).key, 'm40');
  const latest = await read();
  assert.equal(latest.active.messages.length, 20);
  assert.equal(latest.active.messages.at(-1).text, 'Live reply');
  const unrestricted = await mod.methods.view(f.ctx, { workspaceId: 'ws' });
  assert.equal(unrestricted.active.messages.length, 121);
});
