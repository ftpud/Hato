import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as esbuild from 'esbuild';
let generation = 0;
const load = async path => import('data:text/javascript;base64,' + Buffer.from((await esbuild.build({ entryPoints: [path], bundle: true, format: 'esm', write: false })).outputFiles[0].text).toString('base64') + '#' + generation++);
const configOptions = [
  { id: 'model-id', category: 'model', options: [{ name: 'Group', options: [{ value: 'a', name: 'Model A' }, { value: 'b', name: 'Model B' }] }] },
  { id: 'effort', category: 'thought_level', options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }] },
];

test('workflow choices flatten advertised model/reasoning groups and preserve unsupported defaults', async () => {
  const { advertisedChoices, blockProfile } = await load('sdk/workflow-provider-options.ts');
  const choices = advertisedChoices({ configOptions });
  assert.deepEqual(choices.models, [{ value: 'a', label: 'Model A' }, { value: 'b', label: 'Model B' }]);
  assert.equal(choices.reasoningId, 'effort');
  assert.deepEqual(choices.reasoning.map(o => o.value), ['low', 'high']);
  assert.deepEqual(advertisedChoices({ models: { availableModels: [{ modelId: 'legacy' }] } }).reasoning, []);
  assert.equal(blockProfile({}, { defaultProfileId: 'codex', profiles: [{ id: 'claude' }] }), 'codex');
});

test('model discovery reuses existing metadata and removes only its own prompt-free probes', async () => {
  const mod = (await load('modules/services/workflows/src/index.ts')).default;
  const W = await load('sdk/workflows.ts');
  const requests = [], profile = { id: 'provider', executable: 'test-adapter', args: [], name: 'Provider' };
  const ctx = { modules: { call: async (_id, method) => {
    if (method === 'resolve') return { id: 'ws', projectId: 'p', machineId: 'local', location: 'local', rootAbsolutePath: '/workspace' };
    if (method === 'catalog') return { profiles: [profile] };
    return null;
  } }, host: { daemon: { ensure: async () => ({ bin: '/hatod', dir: '/daemon' }), request: async (_target, op, args) => {
    if (op === 'plugins.list') return { plugins: ['agent-runner','internal-remote-mcp','workflow-runner'].map(id => ({ id, active: true })) };
    if (args.method === 'health') return { reasoning: true, version: W.WORKFLOW_RUNNER_VERSION };
    requests.push(args);
    if (args.method === 'list') return [{ id: 'user-session', status: 'ready', workspaceId: 'ws', model: '', profile, configOptions }];
    if (args.method === 'create') return { configOptions };
    if (args.method === 'remove') return null;
    throw new Error(args.method);
  } } } };
  await mod.methods.providerOptions(ctx, { workspaceId: 'ws', profileId: 'provider' });
  assert.ok(!requests.some(r => r.method === 'create'));
  await mod.methods.providerOptions(ctx, { workspaceId: 'ws', profileId: 'provider', refresh: true });
  const created = requests.find(r => r.method === 'create').args.spec;
  assert.deepEqual(created.mcps, []); assert.deepEqual(created.skills, []);
  assert.equal(requests.find(r => r.method === 'remove').args.id, created.id);
  assert.ok(!requests.some(r => r.method === 'send'));
  assert.ok(!requests.some(r => r.method === 'remove' && r.args.id === 'user-session'));
});

test('agent startup applies the selected model before model-specific reasoning', async () => {
  const mod = (await load('modules/services/agent-runner/src/index.ts')).default;
  const listeners = new Map(), requests = [];
  const ctx = { modules: { call: async () => null }, log: { error() {}, info() {} }, host: {
    env: { info: () => ({ platform: 'linux' }) },
    db: { openNamespace: async () => 'db', query: async () => [], exec: async () => ({ changes: 1 }) },
    capabilities: { request: async () => ({ grant: 'grant' }), release: async () => {} }, resources: { release: async () => {} },
    streams: { listen: async (handle, opts, onData) => { if (opts.channel === 'stdout') listeners.set(handle, onData); return { close: async () => {} }; } },
    process: { spawn: async () => ({ handle: 'process' }), closeStdin: async () => {}, write: async (handle, data) => {
      const request = JSON.parse(data); requests.push(request);
      let result;
      if (request.method === 'initialize') result = { protocolVersion: 1, agentCapabilities: { loadSession: true } };
      else if (request.method === 'session/new') result = { sessionId: 'provider-session', configOptions: structuredClone(configOptions) };
      else if (request.method === 'session/set_config_option') result = { configOptions: structuredClone(configOptions) };
      else throw new Error(request.method);
      queueMicrotask(() => listeners.get(handle)(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n'));
    } },
  } };
  await mod.activate(ctx);
  const session = await mod.methods.create(ctx, { spec: { id: 'test', name: 'Test', workspaceId: 'ws', root: '/workspace', profile: { executable: 'test', args: [] }, model: 'b', reasoning: 'high', agentFile: null, skills: [], mcps: [], workspaceMcp: false } });
  assert.equal(session.model, 'b'); assert.equal(session.reasoning, 'high');
  assert.deepEqual(requests.filter(r => r.method === 'session/set_config_option').map(r => [r.params.configId, r.params.value]), [['model-id', 'b'], ['effort', 'high']]);
  await mod.methods.stop(ctx, { id: 'test' });
  await assert.rejects(mod.methods.create(ctx, { spec: { id: 'invalid', name: 'Invalid', root: '/workspace', profile: { executable: 'test', args: [] }, model: 'b', reasoning: 'unsupported', agentFile: null, skills: [], mcps: [] } }), /does not advertise reasoning/);
});
