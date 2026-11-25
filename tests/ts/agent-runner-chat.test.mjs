import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as esbuild from 'esbuild';
let generation = 0;
const load = async path => import('data:text/javascript;base64,' + Buffer.from((await esbuild.build({ entryPoints: [path], bundle: true, format: 'esm', write: false })).outputFiles[0].text).toString('base64') + '#' + generation++);
const configOptions = [
  { id: 'model-id', category: 'model', options: [{ value: 'a', name: 'Model A' }] },
  { id: 'mode', category: 'mode', options: [{ value: 'plan', name: 'Plan' }, { value: 'code', name: 'Code' }] },
  { id: 'fast', name: 'Fast', type: 'boolean', currentValue: false },
];

function harness({ canLoad = true, resume = false, load = false, replay = false, systemPrompt = false } = {}) {
  const listeners = new Map(), requests = [], dbWrites = [], events = [];
  const ctx = { modules: { call: async () => null }, log: { error() {}, info() {}, warn() {} }, events: { emit: (...a) => events.push(a) }, host: {
    env: { info: () => ({ platform: 'linux' }) },
    db: { openNamespace: async () => 'db', query: async (_db, sql) => {
      if (sql.startsWith('PRAGMA')) return [{ name: 'images_json' }, { name: 'tool_call_id' }];
      if (sql.startsWith('SELECT seq,role,turn,provider_message_id')) {
        const row = [...dbWrites].reverse().find(w => w.sql.startsWith('INSERT INTO messages') && ['assistant', 'thought'].includes(w.args[1]));
        return row ? [{ seq: row.args.length + 1, role: row.args[1], turn: row.args[5], provider_message_id: row.args[8], provider_session_id: row.args[9] }] : [];
      }
      return sql.startsWith('SELECT seq FROM messages') && dbWrites.some(w => w.sql.startsWith('INSERT INTO messages') && w.args[7] === 'call-1') ? [{ seq: 42 }] : [];
    }, exec: async (_db, sql, args) => { dbWrites.push({ sql, args }); return { changes: 1 }; } },
    capabilities: { request: async () => ({ grant: 'grant' }), release: async () => {} }, resources: { release: async () => {} },
    streams: { listen: async (handle, opts, onData) => { if (opts.channel === 'stdout') listeners.set(handle, onData); return { close: async () => {} }; } },
    process: { run: async () => ({ code: 0, stdout: '__HATO_EXEC__=/usr/local/bin/test\n__HATO_PATH__=/usr/local/bin:/usr/bin\n', stderr: '' }), spawn: async () => ({ handle: 'process' }), closeStdin: async () => {}, write: async (handle, data) => {
      const request = JSON.parse(data); requests.push(request);
      if (request.id === undefined) return;
      if ('result' in request || 'error' in request) return;
      let result;
      if (request.method === 'initialize') result = { protocolVersion: 1, agentCapabilities: { loadSession: canLoad, promptCapabilities: { image: true }, mcpCapabilities: { http: true }, sessionCapabilities: { resume: resume ? {} : undefined, systemPrompt: systemPrompt ? {} : undefined } } };
      else if (request.method === 'session/new') result = { sessionId: 'provider-session', configOptions: structuredClone(configOptions) };
      else if (request.method === 'session/set_config_option') result = { configOptions: structuredClone(configOptions) };
      else if (request.method === 'session/prompt') return;
      else if ((request.method === 'session/load' && load) || (request.method === 'session/resume' && resume)) {
        if (replay && request.method === 'session/load') listeners.get(handle)(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: request.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', messageId: 'saved-message', content: { type: 'text', text: 'Saved reply' } } } }) + '\n');
        result = { configOptions: structuredClone(configOptions) };
      }
      else if (request.method === 'session/load') { queueMicrotask(() => listeners.get(handle)(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32002, message: 'Resource not found', data: { sessionId: request.params.sessionId } } }) + '\n')); return; }
      else throw new Error(request.method);
      queueMicrotask(() => listeners.get(handle)(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n'));
    } },
  } };
  return { ctx, listeners, requests, dbWrites, events };
}
const spec = extra => ({ id: 'chat', name: 'Chat', workspaceId: 'ws', root: '/workspace', profile: { name: 'Fixture', executable: 'test', args: [] }, model: '', agentFile: null, skills: [], mcps: [], workspaceMcp: false, ...extra });

const workflow = { runId: 'run', blockId: 'block' };
const adapter = provider => ({ id: provider, provider, name: provider, executable: 'test', args: [] });
const meta = { caller: 'workflow-runner' };

for (const provider of ['claude', 'codex']) {
  test(`${provider} reconnect resumes the same provider session with the complete MCP set`, async () => {
    const mod = (await load('Hato-plugins/modules/services/agent-runner/src/index.ts')).default;
    const { ctx, requests, listeners } = harness({ resume: true });
    await mod.activate(ctx);
    const extra = { id: 'fixture', name: 'fixture', command: 'node', args: [], env: [] };
    const config = spec({ profile: adapter(provider), workflow });
    await mod.methods.create(ctx, { spec: config });
    await mod.methods.send(ctx, { id: config.id, text: 'previous' });
    const prompt = requests.find(r => r.method === 'session/prompt');
    const update = mcps => mod.methods.update(ctx, { id: config.id, patch: { ...config, mcps } }, meta);
    await assert.rejects(update([extra]), /finish its turn/);
    assert.equal(requests.some(r => r.method === 'session/cancel'), false);
    listeners.get('process')(JSON.stringify({ jsonrpc: '2.0', id: prompt.id, result: { stopReason: 'end_turn' } }) + '\n');
    await new Promise(setImmediate);
    await update([extra]);
    await update([]);
    assert.equal(requests.filter(r => r.method === 'session/new').length, 1);
    assert.deepEqual(requests.filter(r => r.method === 'session/resume').map(r => [r.params.sessionId, r.params.mcpServers]), [
      ['provider-session', [{ name: extra.name, command: extra.command, args: [], env: [] }]], ['provider-session', []],
    ]);
  });
}

test('Copilot background reconnect continues to use session/load', async () => {
  const mod = (await load('Hato-plugins/modules/services/agent-runner/src/index.ts')).default;
  const { ctx, requests } = harness({ resume: true, load: true });
  await mod.activate(ctx);
  await mod.methods.create(ctx, { spec: spec({ profile: adapter('copilot') }) });
  await mod.methods.reconnect(ctx, { id: 'chat' });
  assert.ok(requests.some(r => r.method === 'session/load'));
  assert.ok(!requests.some(r => r.method === 'session/resume'));
  await mod.methods.stop(ctx, { id: 'chat' });
});

test('a provider without session load keeps its existing workflow conversation', async () => {
  const mod = (await load('Hato-plugins/modules/services/agent-runner/src/index.ts')).default;
  const { ctx, requests, listeners } = harness({ canLoad: false });
  await mod.activate(ctx);
  const config = spec({ profile: adapter('codex'), workflow });
  await mod.methods.create(ctx, { spec: config });
  await mod.methods.send(ctx, { id: config.id, text: 'previous' });
  const prompt = requests.find(r => r.method === 'session/prompt');
  listeners.get('process')(JSON.stringify({ jsonrpc: '2.0', id: prompt.id, result: { stopReason: 'end_turn' } }) + '\n');
  await new Promise(setImmediate);
  await assert.rejects(mod.methods.update(ctx, { id: config.id, patch: { ...config, mcps: [{ id: 'extra', name: 'extra' }] } }, meta), /cannot resume/);
  assert.equal(requests.filter(r => r.method === 'initialize').length, 1);
  assert.deepEqual((await mod.methods.list())[0].mcps, []);
  assert.equal((await mod.methods.list())[0].sessionId, 'provider-session');
});

test('a rejected MCP transport restores the previous workflow endpoint', async () => {
  const mod = (await load('Hato-plugins/modules/services/agent-runner/src/index.ts')).default;
  const { ctx, requests } = harness({ resume: true });
  await mod.activate(ctx);
  const old = { id: 'hato-workflow', name: 'hato-workflow', command: 'node', args: ['old'], env: [] };
  const config = spec({ profile: adapter('codex'), workflow, mcps: [old] });
  await mod.methods.create(ctx, { spec: config });
  const mcps = [{ ...old, args: ['replacement'] }, { id: 'sse', name: 'sse', type: 'sse', url: 'https://example.invalid/mcp' }];
  await assert.rejects(mod.methods.update(ctx, { id: config.id, patch: { ...config, mcps } }, meta), /cannot connect to SSE/);
  const restored = (await mod.methods.list())[0];
  assert.equal(restored.status, 'ready');
  assert.equal(restored.sessionId, 'provider-session');
  assert.deepEqual(restored.mcps, [old]);
  assert.deepEqual(requests.find(r => r.method === 'session/resume').params.mcpServers, [{ name: old.name, command: old.command, args: old.args, env: [] }]);
});

test('only opted-in workflow Claude sessions negotiate autonomous turns and keep tool-card titles', async () => {
  for (const [provider, scope, enabled, expected] of [
    ['claude', workflow, undefined, true], ['claude', workflow, false, false],
    ['claude', undefined, true, false], ['codex', workflow, true, false],
  ]) {
    const mod = (await load('Hato-plugins/modules/services/agent-runner/src/index.ts')).default;
    const { ctx, listeners, requests, events, dbWrites } = harness();
    await mod.activate(ctx);
    await mod.methods.create(ctx, { spec: spec({ profile: adapter(provider), workflow: scope, trackAutonomousClaudeTurns: enabled }) });
    const caps = requests.find(r => r.method === 'initialize').params.clientCapabilities;
    assert.equal(caps._meta?.jetbrains.air.capabilities.includes('asyncTasks') ?? false, expected);
    if (!expected) continue;
    const update = value => listeners.get('process')(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'provider-session', update: value } }) + '\n');
    const spawn = id => update({ sessionUpdate: 'async_task_spawned', asyncTaskId: id, taskType: 'turn' });
    const finish = id => update({ sessionUpdate: 'async_task_state_update', asyncTaskId: id, state: 'completed' });
    await mod.methods.send(ctx, { id: 'chat', text: 'user turn' });
    spawn('overlap'); finish('overlap');
    const prompt = requests.find(r => r.method === 'session/prompt');
    listeners.get('process')([
      { jsonrpc: '2.0', id: prompt.id, result: { stopReason: 'end_turn' } },
      { jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'provider-session',
        update: { sessionUpdate: 'async_task_spawned', asyncTaskId: 'wakeup', taskType: 'turn' } } },
    ].map(value => JSON.stringify(value)).join('\n') + '\n');
    await new Promise(setImmediate);
    assert.equal((await mod.methods.list())[0].status, 'busy');
    for (const [toolCallId, title] of [['read', 'Read src/main.ts'], ['search', 'grep parser src']]) {
      update({ sessionUpdate: 'tool_call', toolCallId, title, status: 'in_progress' });
      update({ sessionUpdate: 'tool_call_update', toolCallId, status: 'completed' });
    }
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Wakeup result' } });
    finish('wakeup');
    await new Promise(setImmediate);
    assert.equal((await mod.methods.list())[0].status, 'ready');
    assert.deepEqual(events.filter(([name]) => name === 'agent-runner.providerTurn').map(([, event]) => [event.phase, event.turnId, event.output]),
      [['started', 'wakeup', undefined], ['finished', 'wakeup', 'Wakeup result']]);
    const titles = dbWrites.filter(w => w.sql.startsWith('INSERT INTO messages') && w.args[1] === 'tool').map(w => w.args[3]);
    assert.ok(titles.every(title => ['Read src/main.ts', 'grep parser src'].includes(title)));
    assert.deepEqual([...new Set(titles)], ['Read src/main.ts', 'grep parser src']);
  }
});

test('reconnect replaces a live Claude process and applies the latest subscription preference', async () => {
  const mod = (await load('Hato-plugins/modules/services/agent-runner/src/index.ts')).default;
  const { ctx } = harness();
  const launches = [], released = [];
  ctx.host.process.spawn = async (_grant, options) => { launches.push(options); return { handle: 'process' }; };
  ctx.host.resources.release = async handle => { released.push(handle); };
  await mod.activate(ctx);
  await mod.methods.create(ctx, { spec: spec({ profile: { provider: 'claude', executable: 'test', args: [] }, claudeSubscription: false }) });
  assert.deepEqual(launches[0].envRemove, []);
  await mod.methods.reconnect(ctx, { id: 'chat', claudeSubscription: true });
  assert.equal(launches.length, 2);
  assert.deepEqual(released, ['process']);
  assert.deepEqual(launches[1].envRemove, ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']);
  assert.equal((await mod.methods.list())[0].claudeSubscription, true);
  await mod.methods.reconnect(ctx, { id: 'chat', claudeSubscription: false });
  assert.deepEqual(launches[2].envRemove, []);
  await mod.methods.stop(ctx, { id: 'chat' });
});

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


test('background instructions use systemPrompt append and stay out of user messages when supported', async () => {
  const mod = (await load('Hato-plugins/modules/services/agent-runner/src/index.ts')).default;
  const { ctx, requests } = harness({ resume: true, systemPrompt: true });
  ctx.host.fs = { read: async () => ({ text: 'Trusted workspace instructions', binary: false, truncated: false }) };
  await mod.activate(ctx);
  const publicSession = await mod.methods.create(ctx, { spec: spec({ agentFile: 'AGENTS.md' }) });
  assert.equal(publicSession.systemPrompt, undefined, 'trusted instruction text stays inside the runner');
  const created = requests.find(r => r.method === 'session/new').params.systemPrompt;
  assert.equal(created.mode, 'append');
  assert.match(created.content[0].text, /Trusted workspace instructions/);
  assert.match(created.content[0].text, /report_progress|hato-progress/);
  await mod.methods.reconnect(ctx, { id: 'chat' });
  assert.deepEqual(requests.find(r => r.method === 'session/resume').params.systemPrompt, created);
  await mod.methods.send(ctx, { id: 'chat', text: 'Do the work' });
  const prompt = requests.find(r => r.method === 'session/prompt').params.prompt;
  assert.deepEqual(prompt, [{ type: 'text', text: 'Do the work' }]);
  await mod.methods.stop(ctx, { id: 'chat' });
});

test('background runner advertises boolean config, preserves structured cost and suppresses replayed transcript rows', async () => {
  const mod = (await load('Hato-plugins/modules/services/agent-runner/src/index.ts')).default;
  const { ctx, listeners, requests, dbWrites } = harness({ load: true, replay: true });
  await mod.activate(ctx);
  await mod.methods.create(ctx, { spec: spec({ settings: { fast: true } }) });
  assert.deepEqual(requests.find(r => r.method === 'initialize').params.clientCapabilities.session, { configOptions: { boolean: {} } });
  assert.deepEqual(requests.find(r => r.method === 'session/set_config_option').params, { sessionId: 'provider-session', configId: 'fast', type: 'boolean', value: true });

  const update = value => listeners.get('process')(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'provider-session', update: value } }) + '\n');
  update({ sessionUpdate: 'usage_update', used: 100, size: 1000, cost: { amount: 0.5, currency: 'USD' } });
  update({ sessionUpdate: 'agent_message_chunk', messageId: 'live-1', content: { type: 'text', text: 'one' } });
  update({ sessionUpdate: 'agent_message_chunk', messageId: 'live-1', content: { type: 'text', text: ' two' } });
  update({ sessionUpdate: 'agent_message_chunk', messageId: 'live-2', content: { type: 'text', text: 'three' } });
  await new Promise(setImmediate);
  assert.deepEqual((await mod.methods.list())[0].usage, { used: 100, size: 1000, cost: { amount: 0.5, currency: 'USD' } });
  const assistantInserts = () => dbWrites.filter(w => w.sql.startsWith('INSERT INTO messages') && w.args[1] === 'assistant');
  assert.equal(assistantInserts().length, 2);
  assert.deepEqual(assistantInserts().map(w => [w.args[8], w.args[2]]), [['live-1', 'one'], ['live-2', 'three']]);
  assert.ok(dbWrites.some(w => w.sql.startsWith('UPDATE messages SET text=text||?') && w.args[0] === ' two'));

  await mod.methods.reconnect(ctx, { id: 'chat' });
  assert.equal(assistantInserts().length, 2, 'session/load replay must not duplicate the persisted reply');
  await mod.methods.stop(ctx, { id: 'chat' });
});

test('background runner keeps provider slash commands for the composer', async () => {
  const mod = (await load('Hato-plugins/modules/services/agent-runner/src/index.ts')).default;
  const { ctx, listeners } = harness();
  await mod.activate(ctx);
  await mod.methods.create(ctx, { spec: spec() });
  const update = value => listeners.get('process')(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'provider-session', update: value } }) + '\n');
  update({ sessionUpdate: 'available_commands_update', availableCommands: [
    { name: 'review', description: 'Review changes', input: { hint: 'path' } },
    { name: 'bad name' }, { description: 'missing name' }, { name: 'compact' },
  ] });
  await new Promise(setImmediate);
  assert.deepEqual((await mod.methods.list())[0].commands, [
    { name: 'review', description: 'Review changes', input: { hint: 'path' } }, { name: 'compact' },
  ]);
  await mod.methods.stop(ctx, { id: 'chat' });
});

test('a provider slash command sent mid-turn waits for the turn instead of interrupting it', async () => {
  const mod = (await load('Hato-plugins/modules/services/agent-runner/src/index.ts')).default;
  const { ctx, listeners, requests } = harness();
  await mod.activate(ctx);
  await mod.methods.create(ctx, { spec: spec() });
  listeners.get('process')(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'provider-session', update: { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'compact' }] } } }) + '\n');
  await mod.methods.send(ctx, { id: 'chat', text: 'Long task' });
  assert.deepEqual(await mod.methods.send(ctx, { id: 'chat', text: '/compact', steer: true }), { queued: true });
  assert.equal(requests.some(r => r.method === 'session/cancel'), false, 'a command must not stop the running turn');
  // Ordinary follow-ups keep the interrupt fallback on providers without steering.
  assert.deepEqual(await mod.methods.send(ctx, { id: 'chat', text: 'actually stop', steer: true }), { queued: true });
  assert.equal(requests.filter(r => r.method === 'session/cancel').length, 1);
  await mod.methods.stop(ctx, { id: 'chat' });
});

test('reconnect swaps in reissued desktop MCP endpoints and leaves other servers untouched', async () => {
  const mod = (await load('Hato-plugins/modules/services/agent-runner/src/index.ts')).default;
  const { ctx, requests } = harness({ resume: true });
  await mod.activate(ctx);
  const desktop = token => ({ id: 'internal-local-mcp', name: 'internal-local-mcp', command: 'node', args: ['/proxy.mjs'], env: [{ name: 'HATO_MCP_TOKEN', value: token }] });
  const other = { id: 'other', name: 'other', command: 'node', args: ['/other.mjs'], env: [] };
  await mod.methods.create(ctx, { spec: spec({ mcps: [desktop('old'), other] }) });
  await mod.methods.reconnect(ctx, { id: 'chat', endpoints: [desktop('new'), { ...other, command: 'evil' }] });
  const servers = requests.filter(r => r.method === 'session/resume').at(-1).params.mcpServers;
  assert.deepEqual(servers.map(s => [s.name, s.command, s.env[0]?.value ?? null]), [['internal-local-mcp', 'node', 'new'], ['other', 'node', null]]);
  await mod.methods.stop(ctx, { id: 'chat' });
});

test('background transcript projection keeps distinct ACP messageId boundaries', async () => {
  const mod = (await load('Hato-plugins/modules/services/agent-runner/src/index.ts')).default;
  const { ctx } = harness();
  const baseQuery = ctx.host.db.query;
  ctx.host.db.query = async (db, sql, args) => sql.startsWith('SELECT * FROM messages') ? [
    { seq: 3, role: 'assistant', text: 'two', turn: 7, provider_message_id: 'm2' },
    { seq: 2, role: 'assistant', text: ' plus', turn: 7, provider_message_id: 'm1' },
    { seq: 1, role: 'assistant', text: 'one', turn: 7, provider_message_id: 'm1' },
  ] : baseQuery(db, sql, args);
  await mod.activate(ctx);
  await mod.methods.create(ctx, { spec: spec() });
  const view = await mod.methods.view(ctx, { id: 'chat' });
  assert.deepEqual(view.messages.map(message => message.text), ['one plus', 'two']);
  await mod.methods.stop(ctx, { id: 'chat' });
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
  assert.equal(updates.at(-1).args[2], 'completed');
  assert.equal(updates.at(-1).args[3], 42);
  await mod.methods.stop(ctx, { id: 'chat' });
});

test('provider switches transfer bounded original dialogue once', async () => {
  const mod = (await load('Hato-plugins/modules/services/agent-runner/src/index.ts')).default;
  const { ctx, requests, listeners } = harness();
  const baseQuery = ctx.host.db.query;
  ctx.host.db.query = async (db, sql, args) => sql.startsWith('SELECT role,text FROM messages') ? [{ role: 'assistant', text: 'The parser is ready' }, { role: 'user', text: 'Build a release tool' }] : baseQuery(db, sql, args);
  await mod.activate(ctx);
  await mod.methods.create(ctx, { spec: spec({ profile: { id: 'old', name: 'Old', executable: 'test', args: [] } }) });
  await mod.methods.update(ctx, { id: 'chat', patch: { name: 'New', profile: { id: 'new', name: 'New', executable: 'test', args: [] }, skills: [], mcps: [], agentFile: null } }, { caller: 'daemon-client' });
  await mod.methods.send(ctx, { id: 'chat', text: 'Continue' });
  const first = requests.filter(r => r.method === 'session/prompt').at(-1);
  assert.match(first.params.prompt[0].text, /Conversation handoff/);
  assert.match(first.params.prompt[0].text, /parser is ready/);
  listeners.get('process')(JSON.stringify({ jsonrpc: '2.0', id: first.id, result: { stopReason: 'end_turn' } }) + '\n');
  await new Promise(setImmediate);
  await mod.methods.send(ctx, { id: 'chat', text: 'Next' });
  const second = requests.filter(r => r.method === 'session/prompt').at(-1);
  assert.equal(second.params.prompt[0].text, 'Next');
  await mod.methods.stop(ctx, { id: 'chat' });
});

test('create allowlists agent configuration and resets caller-supplied runtime context', async () => {
  const mod = (await load('Hato-plugins/modules/services/agent-runner/src/index.ts')).default;
  const { ctx, dbWrites } = harness();
  await mod.activate(ctx);
  await mod.methods.create(ctx, { spec: spec({ contextSent: true, systemPrompt: 'Caller forged instructions', systemPromptSent: true, sentDigests: { forged: 'digest' }, handoffPending: true, sessionId: 'forged', unexpected: 'injected' }) });
  const initial = JSON.parse(dbWrites.find(w => w.sql.startsWith('INSERT INTO sessions')).args[1]);
  assert.equal(initial.contextSent, false); assert.equal(initial.systemPrompt, null); assert.equal(initial.systemPromptSent, false);
  for (const field of ['sentDigests', 'handoffPending', 'unexpected']) assert.equal(Object.hasOwn(initial, field), false);
  assert.equal(initial.sessionId, null);
  await mod.methods.stop(ctx, { id: 'chat' });
});

test('background system instruction delivery is independent of dialogue delivery and refreshes changed files',async()=>{
 const mod=(await load('Hato-plugins/modules/services/agent-runner/src/index.ts')).default;
 const {ctx,requests,dbWrites}=harness({resume:true,systemPrompt:true});
 let instructions='Original trusted instructions';ctx.host.fs={read:async()=>({text:instructions})};
 await mod.activate(ctx);await mod.methods.create(ctx,{spec:spec({agentFile:'AGENTS.md'})});
 let saved=JSON.parse(dbWrites.filter(w=>w.sql.startsWith('INSERT INTO sessions')).at(-1).args[1]);
 assert.equal(saved.systemPromptSent,true);assert.equal(saved.contextSent,false);
 instructions='Updated trusted instructions';await mod.methods.send(ctx,{id:'chat',text:'Current request'});
 assert.match(requests.find(r=>r.method==='session/resume').params.systemPrompt.content[0].text,/Updated trusted instructions/);
 assert.deepEqual(requests.find(r=>r.method==='session/prompt').params.prompt,[{type:'text',text:'Current request'}]);
 saved=JSON.parse(dbWrites.filter(w=>w.sql.startsWith('INSERT INTO sessions')).at(-1).args[1]);assert.equal(saved.contextSent,true);
 await mod.methods.stop(ctx,{id:'chat'});
});

test('fallback progress instructions refresh when Workspace MCP changes without losing dialogue state',async()=>{
 const mod=(await load('Hato-plugins/modules/services/agent-runner/src/index.ts')).default;
 const {ctx,requests,listeners}=harness({resume:true});
 ctx.modules.call=async(_,method)=>method==='endpoint'?{id:'tools',name:'tools',type:'http',url:'http://fixture.invalid/mcp'}:null;
 await mod.activate(ctx);const config=spec({profile:adapter('codex')});await mod.methods.create(ctx,{spec:config});
 await mod.methods.send(ctx,{id:'chat',text:'First'});
 const first=requests.find(r=>r.method==='session/prompt');listeners.get('process')(JSON.stringify({jsonrpc:'2.0',id:first.id,result:{stopReason:'end_turn'}})+'\n');await new Promise(setImmediate);
 await mod.methods.update(ctx,{id:'chat',patch:{...config,workspaceMcp:true}},{caller:'daemon-client'});
 await mod.methods.send(ctx,{id:'chat',text:'Second'});
 const second=requests.filter(r=>r.method==='session/prompt').at(-1);
 assert.match(second.params.prompt[0].text,/report_progress tool/);assert.match(second.params.prompt[0].text,/Second/);
 assert.equal((await mod.methods.list())[0].contextSent,true);
 await mod.methods.stop(ctx,{id:'chat'});
});
