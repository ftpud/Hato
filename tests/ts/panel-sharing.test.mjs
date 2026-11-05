import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as esbuild from 'esbuild';
import { builtinPanelDefs, pluginsHost } from './plugin-fixture.mjs';
const built = await esbuild.build({ stdin: { contents: 'export * from "./modules/ui/workspace-layout/src/model"; export * from "./modules/ui/workspace-layout/src/panel-sharing"; export * from "./modules/ui/workspace-layout/src/defaults";', resolveDir: process.cwd() }, bundle: true, format: 'esm', write: false });
const M = await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64'));
M.setPanels(builtinPanelDefs());
const shares = { viewer: 'space-1', 'git-changes': 'space-1' };
const all = l => [...l.columns.flatMap(c => c.panels), ...l.bottom.panels, ...Object.keys(l.floating), ...Object.keys(l.detached), ...l.hidden].sort();

test('shared panels replace each other in the same column slot without losing layout sizes', () => {
  const original = M.defaultLayout();
  const viewer = M.locate(original, 'viewer');
  const diff = M.showPanel(original, 'git-changes', shares);
  assert.equal(M.locate(diff, 'viewer').kind, 'hidden');
  assert.deepEqual(M.locate(diff, 'git-changes'), viewer);
  assert.deepEqual(diff.columns.map(c => [c.size, c.sizes]), original.columns.map(c => [c.size, c.sizes]));
  assert.equal(M.visibleIn(diff, 'git-changes'), true);
  const back = M.showPanel(diff, 'viewer', shares);
  assert.deepEqual(M.locate(back, 'viewer'), viewer);
  assert.equal(M.visibleIn(back, 'git-changes'), false);
  assert.deepEqual(all(back), Object.keys(M.PANELS).sort());
  assert.equal(M.locate(original, 'git-changes').kind, 'hidden', 'input state remains unchanged');
});

test('shared spaces retain bottom, floating and detached geometry', () => {
  for (const kind of ['bottom', 'floating', 'detached']) {
    const initial = M.moveTo(M.defaultLayout(), 'viewer', kind);
    const next = M.showPanel(initial, 'git-changes', shares);
    assert.equal(M.locate(next, 'git-changes').kind, kind);
    if (kind !== 'bottom') assert.deepEqual(next[kind]['git-changes'], initial[kind].viewer);
    const back = M.showPanel(next, 'viewer', shares);
    assert.equal(M.locate(back, 'viewer').kind, kind);
    assert.deepEqual(all(back), Object.keys(M.PANELS).sort());
  }
});

test('independent panels stay visible; reconciled groups show at most one member', () => {
  const initial = M.showPanel(M.defaultLayout(), 'git-changes', {});
  assert.equal(M.visibleIn(initial, 'viewer'), true);
  assert.equal(M.visibleIn(initial, 'git-changes'), true);
  const next = M.enforcePanelSharing(initial, shares);
  assert.equal(['viewer', 'git-changes'].filter(id => M.visibleIn(next, id)).length, 1);
  assert.deepEqual(all(next), Object.keys(M.PANELS).sort());
  assert.deepEqual(M.normalizePanelSharing({ viewer: 'space-1', invalid: 'bad', other: null }), { viewer: 'space-1' });
});

test('Panel sharing settings persist and file opens replace the active diff panel', async t => {
  const bundle = await esbuild.build({ entryPoints: ['modules/ui/workspace-layout/src/index.ts'], bundle: true, format: 'esm', write: false });
  const mod = (await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'))).default;
  t.after(() => mod.deactivate());
  const values = new Map([['workspace.selected', { id: 'ws' }]]), listeners = new Map(), saved = new Map([['panel-sharing.v1', {}]]);
  const ctx = { moduleId: 'workspace-layout', host: { env: { info: () => ({ repoRoot: '/runtime', dataDir: '/data' }) }, plugins: pluginsHost() },
    state: { get: k => values.get(k), set: (k, v) => values.set(k, v), watch() {} },
    events: { on(k, fn) { listeners.set(k, fn); return () => listeners.delete(k); }, emit(k, e) { listeners.get(k)?.(e); } },
    ui: { invalidate() {} }, log: { warn() {} }, modules: { async call(_id, method, args) {
      if (method === 'settings.get') return saved.get(args.key);
      if (method === 'settings.set') { saved.set(args.key, args.value); return; }
      if (method === 'list') return [];
      if (method === 'updates') return { modules: [], available: [], errors: [] };
    } },
  };
  await mod.activate(ctx);
  const section = values.get('workspace-layout.settings').sections.find(s => s.key === 'panel-sharing');
  assert.ok(section.fields.some(f => f.key === 'viewer'), 'pinned source viewer can share space');
  for (const key of ['viewer', 'git-changes']) {
    ctx.events.emit('settings.change', { module: 'workspace-layout', section: 'panel-sharing', key, value: 'space-1' });
    await new Promise(r => setImmediate(r));
  }
  assert.deepEqual(saved.get('panel-sharing.v1'), shares);
  ctx.events.emit('sidebar.togglePanel', { id: 'git-changes' });
  assert.equal(values.get('workspace-layout.panels')['git-changes'], true);
  assert.equal(values.get('workspace-layout.panels').viewer, false);
  ctx.events.emit('workspace.viewChanged', { workspaceId: 'other', changed: ['previewPath'], previewPath: 'x.ts' });
  assert.equal(values.get('workspace-layout.panels').viewer, false);
  ctx.events.emit('workspace.viewChanged', { workspaceId: 'ws', changed: ['previewPath'], previewPath: 'x.ts' });
  assert.equal(values.get('workspace-layout.panels').viewer, true);
  assert.equal(values.get('workspace-layout.panels')['git-changes'], false);
  const snapshot = mod.snapshot(); mod.deactivate(); await mod.activate(ctx, snapshot);
  assert.deepEqual(mod.snapshot().panelSharing, shares);
});

test('default groups switch related panels in place and keep navigation, assistants and terminal separate', () => {
  const sharing = M.defaultPanelSharing();
  let layout = M.enforcePanelSharing(M.defaultLayout(), sharing);
  for (const [initial, replacement] of [['viewer', 'workflows'], ['files', 'git'], ['ai', 'agents']]) {
    const slot = M.locate(layout, initial);
    layout = M.showPanel(layout, replacement, sharing);
    assert.deepEqual(M.locate(layout, replacement), slot);
    assert.equal(M.visibleIn(layout, initial), false);
    assert.equal(M.visibleIn(layout, 'terminal'), true);
  }
  for (const group of new Set(Object.values(sharing))) assert.equal(Object.keys(sharing).filter(id => sharing[id] === group && M.visibleIn(layout, id)).length, 1);
  assert.deepEqual(all(layout), Object.keys(M.PANELS).sort());
  const positions = M.defaultSidebarButtons(), order = M.defaultSidebarOrder();
  const ids = Object.values(order).flat().filter(id => !id.startsWith('@spacer:'));
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(ids.sort(), Object.keys(positions).sort());
  for (const [position, items] of Object.entries(order)) for (const id of items.filter(id => !id.startsWith('@spacer:'))) assert.equal(positions[id], position);
  assert.ok(M.BAR_ITEMS.toolbarGap.spacer);
  assert.ok(M.BAR_ITEMS.toolbarSpace.grow);
  assert.ok(M.defaultLayout().bars.top.items.includes('toolbarGap'));
  assert.ok(M.defaultLayout().bars.bottom.items.includes('toolbarSpace'));
});
