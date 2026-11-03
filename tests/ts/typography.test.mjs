import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as esbuild from 'esbuild';
const tick = () => new Promise(resolve => setImmediate(resolve));
test('font preferences restore, apply immediately, persist, and keep the confirmed font after a failed save', async () => {
  const built = await esbuild.build({ entryPoints: ['modules/ui/workspace-layout/src/index.ts'], bundle: true, format: 'esm', write: false });
  const mod = (await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64'))).default;
  const state = new Map(), listeners = new Map(), calls = [];
  let fail = false;
  const ctx = { moduleId: 'workspace-layout', state: { get: key => state.get(key), set: (key, value) => state.set(key, value), watch() {} },
    events: { on: (key, fn) => listeners.set(key, fn) }, ui: { invalidate() {} }, log: { warn() {} },
    modules: { async call(_, method, args) {
      if (method === 'list') return [];
      if (method === 'updates') return { modules: [], available: [], errors: [] };
      if (method === 'settings.get') return args.key === 'appearance.fontFamily' ? 'Menlo' : null;
      if (method === 'settings.set') { if (fail) throw new Error('Save failed'); calls.push(args); }
    } } };
  await mod.activate(ctx);
  const typography = () => mod.render().children.find(n => n.type === 'theme').typography;
  assert.equal(typography().fontFamily, 'Menlo');
  assert.equal(typography().fontSize, 15);
  assert.equal(typography().fontWeight, 400);
  const contribution = () => state.get('workspace-layout.settings');
  assert.ok(contribution().sections[0].fields[0].options.some(o => o.value === 'JetBrains Mono'));
  listeners.get('settings.change')({ module: 'workspace-layout', section: 'typography', key: 'fontFamily', value: 'JetBrains Mono' });
  await tick();
  assert.equal(typography().fontFamily, 'JetBrains Mono');
  assert.equal(typography().monoFontFamily, 'JetBrains Mono');
  assert.deepEqual(calls.at(-1), { key: 'appearance.fontFamily', value: 'JetBrains Mono' });
  listeners.get('settings.change')({ module: 'workspace-layout', section: 'typography', key: 'fontSize', value: '16' });
  await tick();
  assert.equal(typography().fontSize, 16);
  assert.equal(typography().monoFontSize, 13);
  assert.deepEqual(calls.at(-1), { key: 'appearance.fontSize', value: '16' });
  fail = true;
  listeners.get('settings.change')({ module: 'workspace-layout', section: 'typography', key: 'fontFamily', value: 'system' });
  await tick();
  assert.equal(typography().fontFamily, 'JetBrains Mono');
  assert.equal(contribution().error, 'Save failed');
  listeners.get('settings.change')({ module: 'workspace-layout', section: 'typography', key: 'fontFamily', value: 'unknown-font' });
  await tick();
  assert.match(contribution().error, /Invalid/);
});
