import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as esbuild from 'esbuild';
import { pluginsHost } from './plugin-fixture.mjs';
const load = async path => {
  const b = await esbuild.build({ entryPoints: [path], bundle: true, format: 'esm', write: false });
  return import('data:text/javascript;base64,' + Buffer.from(b.outputFiles[0].text).toString('base64'));
};
const { moduleVersions } = await load('Hato-plugins/modules/ui/workspace-layout/src/module-versions.ts');
const version = (version, origin, status = 'ok') => ({ version, origin, status });

test('selector uses the exact imported seed and only successfully activated custom builds', () => {
  const m = { seedVersion: 2, versions: [version(1, 'seed'), version(2, 'build'), version(3, 'build'), version(4, 'seed'), version(5, 'build', 'untested'), version(6, 'build', 'failed')] };
  assert.deepEqual(moduleVersions(m), { bundled: 2, updated: 3 });
  assert.deepEqual(moduleVersions({ ...m, active: { version: 2 }, previous: [] }), { bundled: 2, updated: 3 }, 'switching back does not lose the saved update');
  assert.deepEqual(moduleVersions({ ...m, seedVersion: null }), { bundled: undefined, updated: 3 });
});

test('older kernels use healthy seed history and do not invent an updated build', () => {
  assert.deepEqual(moduleVersions({ versions: [version(1, 'seed'), version(2, 'seed'), version(3, 'build', 'untested')] }), { bundled: 2, updated: undefined });
  assert.deepEqual(moduleVersions({ versions: [] }), { bundled: undefined, updated: undefined });
});

test('Modules switches both directions without compiling and retains the active build on denial', async t => {
  const mod = (await load('Hato-plugins/modules/ui/workspace-layout/src/index.ts')).default;
  t.after(() => mod.deactivate());
  const m = { id: 'files', kind: 'service', seedVersion: 1, active: { version: 2, label: 'files@0002' }, previous: [1], versions: [version(1, 'seed'), version(2, 'build')], lastError: null };
  const calls = []; let deny = false;
  const ctx = { host: { env: { info: () => ({ repoRoot: '/runtime', dataDir: '/data' }) }, plugins: pluginsHost() },
    state: { get() { return null; }, set() {}, watch() {} }, events: { on() { return () => {}; } }, ui: { invalidate() {} }, log: { warn() {} },
    modules: { async call(_, method, args) {
      calls.push(method);
      if (method === 'settings.get' || method === 'settings.set') return null;
      if (method === 'list') return [m];
      if (method === 'updates') return { modules: [], available: [], errors: [] };
      if (method === 'rollback') {
        if (deny) throw new Error('Native approval denied');
        m.active = { version: args.toVersion, label: `files@000${args.toVersion}` }; m.previous = [];
        return { ok: true, label: m.active.label };
      }
      throw new Error(`Unexpected call: ${method}`);
    } } };
  await mod.activate(ctx, { showModules: true });
  const walk = n => [n, ...(n.children || []).flatMap(walk)];
  let selector = walk(mod.render()).find(n => n.key === 'module-version:files');
  assert.equal(selector.value, 'updated');
  await mod.onEvent(ctx, { key: selector.key, action: 'moduleVersion', value: 'bundled' });
  assert.equal(m.active.version, 1);
  assert.equal(walk(mod.render()).find(n => n.key === selector.key).value, 'bundled');
  await mod.onEvent(ctx, { key: selector.key, action: 'moduleVersion', value: 'updated' });
  assert.equal(m.active.version, 2);
  deny = true;
  await mod.onEvent(ctx, { key: selector.key, action: 'moduleVersion', value: 'bundled' });
  assert.equal(m.active.version, 2);
  assert.ok(walk(mod.render()).some(n => n.text?.includes('Native approval denied')));
  const before = calls.length;
  await mod.onEvent(ctx, { key: 'module-version:workspace-layout', action: 'moduleVersion', value: 'bundled' });
  assert.equal(calls.length, before, 'recovery controls cannot be replaced by their old bundled UI');
  assert.ok(!calls.includes('build') && !calls.includes('buildAndActivate'));
});
