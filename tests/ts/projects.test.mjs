import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as esbuild from 'esbuild';
const walk = n => [n, ...(n.children || []).flatMap(walk)];
test('project filtering reveals matching tasks under collapsed parents and keeps forms out of the list', async () => {
  const built = await esbuild.build({ entryPoints: ['modules/ui/projects-panel/src/index.ts'], bundle: true, format: 'esm', write: false });
  const mod = (await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64'))).default;
  const ctx = { state: { get: () => ({ id: 'project:p:root' }), watch() {} }, events: { on() {} }, ui: { invalidate() {} }, modules: { async call() { return [
    { id: 'p', name: 'App', rootPath: '/workspace/app', kind: 'local', isGit: true, tasks: [{ id: 't', name: 'Fix login', branch: 'task/login', status: 'ready' }, { id: 'b', name: 'Fix billing', branch: 'task/billing', status: 'ready' }], expanded: false },
    { id: 'r', name: 'Remote', rootPath: '/srv/code', host: 'devbox', kind: 'ssh', tasks: [], expanded: false },
  ]; } } };
  await mod.activate(ctx);
  const nodes = () => walk(mod.render());
  const rows = () => nodes().find(n => n.type === 'tree').rows;
  assert.deepEqual(rows().map(n => n.key), ['project:p:root', 'project:r:root']);
  assert.ok(!nodes().some(n => n.key === 'local-path'));
  await mod.onEvent(ctx, { action: 'filter', value: 'app' });
  assert.equal(rows()[0].badge, '2 tasks');
  assert.deepEqual(rows().slice(1).map(row => row.connector), ['branch', 'last']);
  await mod.onEvent(ctx, { action: 'filter', value: 'login' });
  assert.deepEqual(rows().map(n => n.key), ['project:p:root', 'task:t']);
  assert.equal(rows()[1].connector, 'last');
  await mod.onEvent(ctx, { action: 'filter', value: 'devbox' });
  assert.deepEqual(rows().map(n => n.key), ['project:r:root']);
  await mod.onEvent(ctx, { action: 'filter', value: 'missing' });
  assert.equal(rows().length, 0);
  assert.ok(nodes().some(n => n.key === 'empty'));
  await mod.onEvent(ctx, { action: 'showAdd' });
  assert.ok(nodes().some(n => n.type === 'modal' && n.key === 'add-modal'));
  await mod.onEvent(ctx, { action: 'hideAdd' });
  await mod.onEvent(ctx, { action: 'newTask' });
  assert.ok(nodes().some(n => n.type === 'modal' && n.key === 'task-form'));
});
