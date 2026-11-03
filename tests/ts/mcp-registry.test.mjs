import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import * as esbuild from 'esbuild';
Object.defineProperty(globalThis.crypto, 'randomHex', { value: n => randomBytes(n).toString('hex'), configurable: true });
async function load(path) {
  const result = await esbuild.build({ entryPoints: [path], bundle: true, format: 'esm', write: false });
  return import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'));
}
const tick = () => new Promise(resolve => setImmediate(resolve));
function harness() {
  const state = new Map(), watches = new Map(), events = new Map(), settings = new Map();
  let active = ['provider'], fail = false, generation = 1;
  const context = (id, providerGeneration = generation) => ({ moduleId: id, generation: providerGeneration,
    host: { modules: { list: async () => active.map(id => ({ id, active: { generation } })) } },
    state: { get: key => state.get(key), set(key, value) { assert.ok(key.startsWith(id + '.')); state.set(key, value); for (const fn of watches.get(key) || []) fn(value); },
      watch(key, fn) { const set = watches.get(key) || new Set(); set.add(fn); watches.set(key, set); return () => set.delete(fn); } },
    events: { on(topic, fn) { const set = events.get(topic) || new Set(); set.add(fn); events.set(topic, set); return () => set.delete(fn); },
      emit(topic, value) { assert.ok(topic.startsWith(id + '.')); for (const fn of events.get(topic) || []) queueMicrotask(() => fn(value)); } },
    modules: { async call(_, method, args) { if (method === 'settings.get') return settings.get(args.key); if (fail) throw new Error('Save failed'); settings.set(args.key, args.value); } },
    ui: { invalidate() {} }, log: { warn() {} },
  });
  return { context, state, settings, generation: value => { generation = value; }, inactive: () => { active = []; }, fail: () => { fail = true; },
    async permission(name, value) { context('settings').events.emit('settings.change', { module: 'internal-mcp', section: 'mcp:provider', key: name, value }); await tick(); await tick(); } };
}
test('module MCP registration is discovered, denied by default, permission checked on every call, and workspace scope is trusted', async () => {
  const { McpRegistry } = await load('modules/services/internal-mcp/src/registry.ts');
  const { exportMcpTools } = await load('sdk/mcp.ts');
  const h = harness(); let changed = 0, executions = 0;
  const registry = new McpRegistry(h.context('internal-mcp'), [{ name: 'modules_list', description: 'Modules', inputSchema: { type: 'object' } }], () => changed++);
  await registry.start();
  exportMcpTools(h.context('provider'), 'Example', [{ name: 'echo', description: 'Scoped echo', inputSchema: { type: 'object' }, handler(args, scope) { executions++; return { args, scope }; } }]);
  assert.ok(!registry.list().some(t => t.name === 'provider__echo'));
  assert.equal(registry.list()[0].name, 'modules_list');
  const scope = { workspaceId: 'trusted', conversationId: 'conversation', machineId: 'local' };
  await assert.rejects(async () => registry.call('provider__echo', {}, scope), /denied/);
  await h.permission('provider__echo', true);
  const response = await registry.call('provider__echo', { workspaceId: 'spoofed' }, scope);
  assert.deepEqual(response.scope, scope);
  assert.equal(response.args.workspaceId, 'spoofed');
  assert.equal(executions, 1);
  assert.ok(changed >= 2);
  assert.equal(h.settings.get('internal-mcp.permissions')['["provider","echo"]'], true);
  await h.permission('provider__echo', false);
  await assert.rejects(async () => registry.call('provider__echo', {}, scope), /denied/);
  assert.equal(executions, 1);
  registry.stop();
});
test('permission save failures keep confirmed policy; inactive providers disappear and cannot be called', async () => {
  const { McpRegistry } = await load('modules/services/internal-mcp/src/registry.ts');
  const h = harness();
  h.state.set('provider.mcp', { generation: 1, title: 'Example', tools: [{ name: 'echo', description: 'Echo', inputSchema: { type: 'object' } }] });
  const registry = new McpRegistry(h.context('internal-mcp'), [], () => {});
  await registry.start();
  h.fail(); await h.permission('provider__echo', true);
  assert.equal(registry.allowed('provider__echo'), false);
  assert.equal(h.state.get('internal-mcp.settings').error, 'Save failed');
  h.inactive(); await registry.refresh();
  assert.equal(registry.list().length, 0);
  assert.equal(h.state.get('internal-mcp.settings').sections.length, 0);
  registry.stop();
});

test('only the active provider generation handles a command during a hot swap', async () => {
  const { McpRegistry } = await load('modules/services/internal-mcp/src/registry.ts');
  const { exportMcpTools } = await load('sdk/mcp.ts');
  const h = harness(), executions = [];
  const registry = new McpRegistry(h.context('internal-mcp'), [], () => {});
  await registry.start();
  const definition = generation => [{ name: 'echo', description: 'Echo', inputSchema: { type: 'object' }, handler() { executions.push(generation); return generation; } }];
  exportMcpTools(h.context('provider', 1), 'Example', definition(1));
  await h.permission('provider__echo', true);
  exportMcpTools(h.context('provider', 2), 'Example', definition(2));
  const scope = { workspaceId: 'ws', machineId: 'local', conversationId: 'c' };
  assert.equal(await registry.call('provider__echo', {}, scope), 1);
  h.generation(2); await registry.refresh();
  assert.equal(await registry.call('provider__echo', {}, scope), 2);
  assert.deepEqual(executions, [1, 2]);
  registry.stop();
});
