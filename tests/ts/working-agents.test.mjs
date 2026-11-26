import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as esbuild from 'esbuild';

async function service(id) {
  const result = await esbuild.build({
    entryPoints: [`Hato-plugins/modules/services/${id}/src/index.ts`],
    bundle: true, format: 'esm', write: false,
  });
  return (await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'))).default;
}

function stateFixture(moduleId) {
  const writes = new Map();
  const listeners = new Map();
  const ctx = {
    moduleId, generation: 1, log: { warn() {} },
    events: { on: (key, callback) => listeners.set(key, callback), emit() {} },
    state: { set(key, value) {
      if (!writes.has(key)) writes.set(key, []);
      writes.get(key).push(value);
    }, watch() {} },
  };
  return { ctx, listeners, values: suffix => writes.get(`${moduleId}.${suffix}`) };
}

test('active conversations publish bounded working entries independently of their full busy counts', async t => {
  const mod = await service('ai-sessions');
  const { ctx, listeners, values } = stateFixture('ai-sessions');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  ctx.modules = { async call(_, method, args) {
    if (method === 'conversations.get') return { id: args.id, title: `Title ${args.id}`, workspaceId: 'ws' };
    if (method === 'messages.list') return [];
    if (method === 'state') return { status: 'ready' };
    throw new Error(method);
  } };
  await mod.activate(ctx);
  for (let i = 51; i >= 0; i--) {
    const id = `c${String(i).padStart(2, '0')}`;
    await mod.methods.loadOlder(ctx, { conversationId: id });
    listeners.get('acp.status')({ conversationId: id, status: 'busy' });
  }
  t.mock.timers.tick(61);
  assert.deepEqual(values('busy'), [{}, { ws: 52 }]);
  assert.deepEqual(values('working')[0], []);
  const entries = values('working').at(-1);
  assert.equal(entries.length, 50);
  assert.deepEqual(entries[0], { id: 'c00', title: 'Title c00', workspaceId: 'ws', status: 'busy' });
  listeners.get('acp.status')({ conversationId: 'c00', status: 'busy' });
  t.mock.timers.tick(61);
  assert.equal(values('working').length, 2, 'an unchanged list is not republished');

  await listeners.get('acp.turnEnded')({ conversationId: 'c00', stopReason: 'end_turn' });
  t.mock.timers.tick(61);
  assert.deepEqual(values('busy').at(-1), { ws: 51 });
  assert.equal(values('working').at(-1).length, 50);
  assert.equal(values('working').at(-1)[0].id, 'c01');
  assert.equal(values('working').at(-1).at(-1).id, 'c50');
  const childSessions = { worker: { id: 'worker', parentId: 'provider-root', title: 'Reviewer', state: 'running' } };
  listeners.get('acp.status')({ conversationId: 'c01', status: 'ready', childSessions });
  t.mock.timers.tick(61);
  assert.deepEqual(values('working').at(-1)[0].children, Object.values(childSessions));
  assert.deepEqual(values('busy').at(-1), { ws: 51 }, 'background children keep an idle parent in WORKING');
  listeners.get('acp.status')({ conversationId: 'c01', status: 'ready', childSessions: { worker: { ...childSessions.worker, state: 'idle', stopReason: 'end_turn' } } });
  t.mock.timers.tick(61);
  assert.equal(values('working').at(-1)[0].id, 'c02');
});

test('daemon polls publish workflow ownership and status even when busy counts are unchanged', async t => {
  const mod = await service('persistent-agents');
  const { ctx, values } = stateFixture('persistent-agents');
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const session = (id, extra = {}) => ({
    id, name: `Worker ${id}`, machineId: 'local', workspaceId: 'ws', status: 'busy', ...extra,
  });
  let rows = [
    session('a00', { workflow: { workflowId: 'workflow', runId: 'run', blockId: 'block', extra: 'ignore' }, progress: { percent: 40, note: 'Reading', at: 1 } }),
    session('a01', { workflow: { runId: 'legacy-run', blockId: 'legacy-block' }, status: 'starting' }),
    ...Array.from({length: 50}, (_, i) => session(`b${String(i).padStart(2, '0')}`)),
    session('idle', { status: 'ready' }),
    session('remote', { machineId: 'other' }),
  ];
  ctx.modules = { async call(_, method) {
    if (method === 'resolve') return { machineId: 'local', location: 'local' };
    throw new Error(method);
  } };
  ctx.host = { daemon: {
    async ensure() { return { bin: '', dir: '' }; },
    async status() { return null; },
    async request(_, method, args) {
      if (method === 'plugins.list') return { plugins: [
        { id: 'internal-remote-mcp', active: true }, { id: 'agent-runner', active: true },
      ] };
      if (args.method === 'list') return rows;
      if (args.method === 'claimTaskRequests') return [];
      throw new Error(method);
    },
  } };
  const poll = async () => {
    t.mock.timers.tick(2000);
    await new Promise(setImmediate);
  };
  mod.activate(ctx);
  try {
    await mod.methods.list(ctx, { workspaceId: 'prepare' });
    await poll();
    assert.deepEqual(values('busy'), [{ ws: 52 }]);
    assert.deepEqual(values('working')[0], []);
    assert.equal(values('working').at(-1).length, 50);
    assert.deepEqual(values('working').at(-1).slice(0, 3), [
      { id: 'a00', name: 'Worker a00', workspaceId: 'ws', status: 'busy', workflow: { workflowId: 'workflow', runId: 'run', blockId: 'block' }, progress: { percent: 40, note: 'Reading', at: 1 } },
      { id: 'a01', name: 'Worker a01', workspaceId: 'ws', status: 'starting', workflow: { runId: 'legacy-run', blockId: 'legacy-block' }, progress: null },
      { id: 'b00', name: 'Worker b00', workspaceId: 'ws', status: 'busy', workflow: null, progress: null },
    ]);
    rows.reverse();
    await poll();
    assert.equal(values('working').length, 2);
    rows.find(s => s.id === 'a00').status = 'waiting';
    await poll();
    assert.equal(values('working').at(-1)[0].status, 'waiting');
    assert.equal(values('busy').length, 1, 'metadata updates do not republish identical busy counts');
    rows.find(s => s.id === 'a00').status = 'ready';
    rows.find(s => s.id === 'a00').childSessions = { child: { id: 'child', parentId: 'provider-root', title: 'Reviewer', state: 'running' } };
    await poll();
    assert.equal(values('working').at(-1)[0].status, 'busy');
    assert.equal(values('working').at(-1)[0].children[0].title, 'Reviewer');
    assert.equal(values('busy').length, 1);

    rows = [];
    await poll();
    assert.deepEqual(values('busy').at(-1), {});
    assert.deepEqual(values('working').at(-1), []);
  } finally {
    mod.deactivate();
  }
});
