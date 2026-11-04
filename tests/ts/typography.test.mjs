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
    events: { on: (key, fn) => listeners.set(key, fn), emit() {} }, ui: { invalidate() {} }, log: { warn() {} },
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
  assert.ok(contribution().sections.find(s => s.key === 'typography').fields[0].options.some(o => o.value === 'JetBrains Mono'));
  assert.deepEqual(contribution().sections.map(s => s.key), ['appearance', 'typography', 'side-panels', 'panel-sharing', 'sidebar-order', 'tables', 'workspace-chrome']);
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

test('appearance reset restores all UI preferences and keeps the top bar visible', async () => {
  const built = await esbuild.build({ entryPoints: ['modules/ui/workspace-layout/src/index.ts'], bundle: true, format: 'esm', write: false });
  const mod = (await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64'))).default;
  const state = new Map(), listeners = new Map(), persisted = new Map(), emitted = [];
  const ctx = { moduleId: 'workspace-layout', state: { get: k => state.get(k), set: (k, v) => state.set(k, v), watch() {} },
    events: { on: (k, fn) => listeners.set(k, fn), emit: (k, v) => emitted.push(k) }, ui: { invalidate() {} }, log: { warn() {} },
    modules: { async call(_, method, args) {
      if (method === 'list') return [];
      if (method === 'updates') return { modules: [], available: [], errors: [] };
      if (method === 'settings.get') return args.key === 'appearance.fontSize' ? '18' : null;
      if (method === 'settings.set') persisted.set(args.key, args.value);
    } } };
  await mod.activate(ctx, { sidebarButtons: { ai: 'hidden' }, sidebarOrder: { 'left-top': ['@spacer:old'] }, tableStyle: { density: 'spacious', stripes: false, dividers: true } });
  assert.equal(state.get('workspace-layout.settings').resetLabel, 'Reset appearance & layout');
  assert.ok(!state.get('workspace-layout.settings').sections.find(s => s.key === 'workspace-chrome').fields.some(f => f.key === 'topBar'));
  await mod.onEvent(ctx, { action: 'toggleBar', value: 'top' });
  assert.equal(mod.methods.getLayout().bars.top.visible, true);
  listeners.get('settings.reset')({ module: 'workspace-layout' }); await tick();
  assert.equal(mod.snapshot().sidebarButtons.files, 'left-top');
  assert.equal(mod.snapshot().sidebarButtons.ai, 'right-top');
  assert.ok(!mod.snapshot().sidebarOrder['left-top'].includes('@spacer:old'));
  assert.equal(mod.snapshot().groupBySpace, true);
  assert.equal(mod.snapshot().panelSharing.files, mod.snapshot().panelSharing.git);
  assert.equal(mod.snapshot().panelSharing.viewer, mod.snapshot().panelSharing['git-changes']);
  assert.equal(mod.snapshot().panelSharing.ai, mod.snapshot().panelSharing.agents);
  assert.deepEqual(mod.snapshot().tableStyle, { density: 'comfortable', stripes: true, dividers: false });
  assert.equal(mod.render().children.find(n => n.type === 'theme').typography.fontSize, 15);
  assert.deepEqual(mod.methods.getLayout().mainSizes, [0.76, 0.24]);
  assert.equal(persisted.get('appearance.theme'), 'classic');
  assert.ok(emitted.includes('workspace-layout.tableStyleChanged'));
  assert.ok([...persisted.keys()].every(k => /^(appearance\.|layout\.|activity-sidebar\.|sidebar-order\.|panel-sharing\.|sidebar-grouping\.|ui-tables\.)/.test(k)));
});
