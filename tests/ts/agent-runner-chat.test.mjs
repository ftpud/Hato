import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as esbuild from 'esbuild';
let generation = 0;
const load = async path => import('data:text/javascript;base64,' + Buffer.from((await esbuild.build({ entryPoints: [path], bundle: true, format: 'esm', write: false })).outputFiles[0].text).toString('base64') + '#' + generation++);
const configOptions = [
  { id: 'model-id', category: 'model', options: [{ value: 'a', name: 'Model A' }] },
  { id: 'mode', category: 'mode', options: [{ value: 'plan', name: 'Plan' }, { value: 'code', name: 'Code' }] },
];

function harness() {
  const listeners = new Map(), requests = [], dbWrites = [];
  const ctx = { modules: { call: async () => null }, log: { error() {}, info() {}, warn() {} }, events: { emit() {} }, host: {
    env: { info: () => ({ platform: 'linux' }) },
    db: { openNamespace: async () => 'db', query: async (_db, sql) => sql.startsWith('PRAGMA') ? [{ name: 'images_json' }, { name: 'tool_call_id' }] : sql.startsWith('SELECT seq FROM messages') && dbWrites.some(w => w.sql.startsWith('INSERT INTO messages') && w.args[7] === 'call-1') ? [{ seq: 42 }] : [], exec: async (_db, sql, args) => { dbWrites.push({ sql, args }); return { changes: 1 }; } },
    capabilities: { request: async () => ({ grant: 'grant' }), release: async () => {} }, resources: { release: async () => {} },
    streams: { listen: async (handle, opts, onData) => { if (opts.channel === 'stdout') listeners.set(handle, onData); return { close: async () => {} }; } },
    process: { run: async () => ({ code: 0, stdout: '__HATO_EXEC__=/usr/local/bin/test\n__HATO_PATH__=/usr/local/bin:/usr/bin\n', stderr: '' }), spawn: async () => ({ handle: 'process' }), closeStdin: async () => {}, write: async (handle, data) => {
      const request = JSON.parse(data); requests.push(request);
      if (request.id === undefined) return;
      if ('result' in request || 'error' in request) return;
      let result;
      if (request.method === 'initialize') result = { protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { image: true } } };
      else if (request.method === 'session/new') result = { sessionId: 'provider-session', configOptions: structuredClone(configOptions) };
      else if (request.method === 'session/set_config_option') result = { configOptions: structuredClone(configOptions) };
      else if (request.method === 'session/prompt') return;
      else if (request.method === 'session/load') { queueMicrotask(() => listeners.get(handle)(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32002, message: 'Resource not found', data: { sessionId: request.params.sessionId } } }) + '\n')); return; }
      else throw new Error(request.method);
      queueMicrotask(() => listeners.get(handle)(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n'));
    } },
  } };
  return { ctx, listeners, requests, dbWrites };
}
const spec = extra => ({ id: 'chat', name: 'Chat', workspaceId: 'ws', root: '/workspace', profile: { name: 'Fixture', executable: 'test', args: [] }, model: '', agentFile: null, skills: [], mcps: [], workspaceMcp: false, ...extra });

test('background chats keep provider options, approval policy and pictures like desktop chats', async () => {
  const mod = (await load('Hato-plugins/modules/services/agent-runner/src/index.ts')).default;
  const { ctx, listeners, requests, dbWrites } = harness();
  await mod.activate(ctx);
  // Saved options are reapplied on connect; options the provider stopped advertising are dropped.
  const session = await mod.methods.create(ctx, { spec: spec({ approvalPolicy: 'auto-low', settings: { mode: 'plan', gone: 'x' } }) });
  assert.deepEqual(requests.filter(r => r.method === 'session/set_config_option').map(r => [r.params.configId, r.params.value]), [['mode', 'plan']]);
  assert.deepEqual(session.settings, { mode: 'plan' });
  assert.equal(session.promptImages, true);

  await mod.methods.setConfig(ctx, { id: 'chat', configId: 'mode', value: 'code' });
  assert.equal((await mod.methods.list())[0].settings.mode, 'code');

  // auto-low approves read-only tools and leaves edits for review.
  const ask = (id, kind) => listeners.get('process')(JSON.stringify({ jsonrpc: '2.0', id, method: 'session/request_permission', params: { sessionId: 'provider-session', toolCall: { kind, title: kind }, options: [{ optionId: 'ok', kind: 'allow_once' }, { optionId: 'no', kind: 'reject_once' }] } }) + '\n');
  ask(900, 'read'); ask(901, 'edit');
  await new Promise(setImmediate);
  assert.equal(requests.find(r => r.id === 900 && 'result' in r)?.result.outcome.optionId, 'ok');
  assert.ok(!requests.some(r => r.id === 901 && 'result' in r));
  assert.ok(dbWrites.some(w => w.sql.startsWith('INSERT INTO permissions')));

  await mod.methods.setPolicy(ctx, { id: 'chat', policy: 'autopilot' }, { caller: 'daemon-client' });
  assert.equal((await mod.methods.list())[0].autopilot, true);
  assert.equal(requests.find(r => r.id === 901 && 'result' in r)?.result.outcome.optionId, 'ok');
  await mod.methods.stop(ctx, { id: 'chat' });

  // Pictures are sent as ACP image blocks and stored with the user message.
  const second = harness();
  await mod.activate(second.ctx);
  await mod.methods.create(second.ctx, { spec: spec({ id: 'pics' }) });
  await mod.methods.send(second.ctx, { id: 'pics', text: 'Look', images: [{ name: 'p.png', mimeType: 'image/png', data: 'iVBORw0KGgo=' }] });
  const prompt = second.requests.find(r => r.method === 'session/prompt');
  assert.deepEqual(prompt.params.prompt.map(b => b.type), ['text', 'image']);
  assert.ok(second.dbWrites.some(w => w.sql.startsWith('INSERT INTO messages') && JSON.parse(w.args[6])[0].name === 'p.png'));
  await mod.methods.stop(second.ctx, { id: 'pics' });
});

test('reconnect after a configuration change starts a new provider session when the old one is gone', async () => {
  const mod = (await load('Hato-plugins/modules/services/agent-runner/src/index.ts')).default;
  const { ctx, requests } = harness();
  await mod.activate(ctx);
  await mod.methods.create(ctx, { spec: spec({ id: 'mcp' }) });
  // Enabling an MCP server restarts the agent; the provider never saved the unprompted session.
  const restarted = await mod.methods.update(ctx, { id: 'mcp', patch: { name: 'Chat', profile: { name: 'Fixture', executable: 'test', args: [] }, model: '', agentFile: null, skills: [], mcps: [{ id: 'extra', name: 'extra', command: 'x', args: [], env: [] }], workspaceMcp: false } }, { caller: 'daemon-client' });
  assert.equal(restarted.status, 'ready');
  assert.equal(restarted.error, null);
  assert.ok(requests.some(r => r.method === 'session/load'));
  assert.equal(requests.filter(r => r.method === 'session/new').length, 2);
  await mod.methods.stop(ctx, { id: 'mcp' });
});


test('tool updates persist one row per call, including repeated starts and content-only updates', async () => {
  const mod = (await load('Hato-plugins/modules/services/agent-runner/src/index.ts')).default;
  const { ctx, listeners, dbWrites } = harness();
  await mod.activate(ctx);
  await mod.methods.create(ctx, { spec: spec() });
  for (const update of [
    { sessionUpdate: 'tool_call', title: 'Run tests', status: 'in_progress' },
    { sessionUpdate: 'tool_call', title: 'Run tests', status: 'in_progress' },
    { sessionUpdate: 'tool_call_update', content: [{ type: 'text', text: 'output' }] },
    { sessionUpdate: 'tool_call_update', status: 'completed' },
  ]) listeners.get('process')(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'provider-session', update: { toolCallId: 'call-1', ...update } } }) + '\n');
  await new Promise(setImmediate);
  const inserts = dbWrites.filter(w => w.sql.startsWith('INSERT INTO messages') && w.args[1] === 'tool');
  assert.equal(inserts.length, 1);
  const updates = dbWrites.filter(w => w.sql.startsWith('UPDATE messages SET text=CASE'));
  assert.equal(updates.length, 3);
  assert.equal(updates.at(-1).args[3], 'completed');
  assert.equal(updates.at(-1).args[4], 42);
  await mod.methods.stop(ctx, { id: 'chat' });
});
