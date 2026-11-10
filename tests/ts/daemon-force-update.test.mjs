import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as esbuild from 'esbuild';
let generation = 0;
const load = async path => import('data:text/javascript;base64,' + Buffer.from((await esbuild.build({ entryPoints: [path], bundle: true, format: 'esm', write: false })).outputFiles[0].text).toString('base64') + '#' + generation++);

test('remote runtime force update re-pushes every daemon plugin the desktop has, even busy ones', async () => {
  const mod = (await load('Hato-plugins/modules/services/remote-runtime/src/index.ts')).default;
  const pushes = [], events = [];
  const ctx = {
    events: { emit: (topic, value) => events.push([topic, value]) }, log: { warn() {} },
    modules: { call: async (_m, method) => method === 'resolve' ? { id: 'ws', machineId: 'local', location: 'local' } : null },
    host: {
      plugins: { list: async () => ({ plugins: [
        { id: 'agent-runner', enabled: true, kind: 'service', runsOn: 'either' },
        { id: 'workflow-runner', enabled: true, kind: 'service', runsOn: 'either' },
        { id: 'helper', enabled: true, kind: 'service', runsOn: 'workspace' },
        { id: 'removed-here', enabled: false, kind: 'service', runsOn: 'either' },
      ] }) },
      daemon: { ensure: async () => ({}), request: async (_t, op, args) => {
        if (op === 'plugins.list') return { plugins: [{ id: 'agent-runner', enabled: true }, { id: 'workflow-runner', enabled: true }, { id: 'removed-here', enabled: true }] };
        if (op === 'plugins.push') { pushes.push(args.id); return { reloaded: args.id !== 'helper', active: 'v2', error: null }; }
        throw new Error(op);
      } },
    },
  };
  const r = await mod.methods.forceUpdate(ctx, { workspaceId: 'ws' });
  assert.deepEqual(pushes, ['agent-runner', 'workflow-runner', 'helper']);
  assert.deepEqual(r.plugins.filter(p => p.reloaded).map(p => p.id), ['agent-runner', 'workflow-runner']);
  assert.ok(events.some(([topic, value]) => topic === 'remote-runtime.updated' && value.plugins.includes('agent-runner')));
});

test('agent runtime update replaces the runner and reconnects agents that were connected', async () => {
  const mod = (await load('Hato-plugins/modules/services/persistent-agents/src/index.ts')).default;
  const ops = [];
  const rows = [
    { id: 'live', name: 'Live', workspaceId: 'ws', machineId: 'local', status: 'busy', mcps: [] },
    { id: 'idle', name: 'Stopped', workspaceId: 'ws', machineId: 'local', status: 'stopped', mcps: [] },
  ];
  const ctx = {
    events: { emit() {} }, log: { warn() {} },
    modules: { call: async (_m, method) => method === 'resolve' ? { id: 'ws', machineId: 'local', location: 'local' } : method === 'settings.get' ? [] : null },
    host: { daemon: {
      ensure: async () => ({ bin: '/hatod', dir: '/d' }), status: async () => null,
      request: async (_t, op, args) => {
        ops.push([op, args?.id || args?.method]);
        if (op === 'plugins.list') return { plugins: [{ id: 'internal-remote-mcp', active: true }, { id: 'agent-runner', active: true }] };
        if (op === 'plugins.push') return { active: 'v2', reloaded: true };
        if (args.method === 'list') return rows;
        if (args.method === 'view') return { session: rows.find(r => r.id === args.args.id), permissions: [] };
        if (args.method === 'reconnect') return { ok: true };
        throw new Error(args.method);
      },
    } },
  };
  const r = await mod.methods.updateRuntime(ctx, { workspaceId: 'ws' });
  assert.deepEqual(r.pushed.map(p => p.id), ['internal-remote-mcp', 'agent-runner']);
  assert.deepEqual(r.reconnected, ['live']);
  const pushIndex = ops.findIndex(([op, id]) => op === 'plugins.push' && id === 'agent-runner');
  const reconnectIndex = ops.findIndex(([, method]) => method === 'reconnect');
  assert.ok(pushIndex >= 0 && reconnectIndex > pushIndex);
});
