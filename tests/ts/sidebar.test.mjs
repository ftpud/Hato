import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as esbuild from 'esbuild';
import { pluginsHost } from './plugin-fixture.mjs';
let generation = 0;
async function load(id, icons) {
  const built = await esbuild.build({ entryPoints: [`Hato-plugins/modules/ui/${id}/src/index.ts`], bundle: true, format: 'esm', write: false, plugins: icons ? [{ name: 'edited-icons', setup(build) { build.onLoad({ filter: /sidebar-icons\.ts$/ }, () => ({ contents: `export const sidebarIcons = ${JSON.stringify(icons)}`, loader: 'ts' })); } }] : [] });
  return (await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64') + '#' + generation++)).default;
}
test('separate sidebar toggles layout panels and reflects collapse, hide and restore state', async () => {
  const layout = await load('workspace-layout'), sidebar = await load('sidebar'), left = await load('left-sidebar');
  const values = new Map(), watches = new Map(), events = new Map();
  const ctx = { host: { env: { info: () => ({ repoRoot: '/runtime', dataDir: '/data' }) }, plugins: pluginsHost() }, state: { get: key => values.get(key), set(key, value) { values.set(key, value); for (const fn of watches.get(key) || []) fn(value); }, watch(key, fn) { watches.set(key, [...(watches.get(key) || []), fn]); } },
    events: { on(key, fn) { events.set(key, fn); return () => {}; }, emit(key, value) { events.get(key)?.(value); } },
    modules: { async call(_, method) { if (method === 'list') return []; if (method === 'updates') return { modules: [], available: [], errors: [] }; } },
    ui: { invalidate() {} }, log: { warn() {} } };
  await layout.activate(ctx, { sidebarButtons: {}, sidebarOrder: {}, panelSharing: {} });
  await sidebar.activate(ctx);
  await left.activate(ctx);
  assert.equal(sidebar.render().border, undefined);
  assert.equal(sidebar.render().surface, undefined);
  assert.equal(left.render().surface, undefined);
  const fileButton = () => left.render().children.find(n => n.key === 'files');
  assert.equal(fileButton().variant, 'primary');
  left.onEvent(ctx, { action: 'toggle', value: 'files' });
  assert.equal(layout.methods.getLayout().collapsed.files, true);
  assert.equal(fileButton().tooltip, 'Show Files');
  left.onEvent(ctx, { action: 'toggle', value: 'files' });
  assert.equal(layout.methods.getLayout().collapsed.files, false);
  await layout.onEvent(ctx, { action: 'hide', value: 'files' });
  assert.equal(fileButton().variant, 'ghost');
  left.onEvent(ctx, { action: 'toggle', value: 'files' });
  assert.ok(layout.methods.getLayout().columns.some(c => c.panels.includes('files')));
  assert.equal(fileButton().variant, 'primary');
  left.onEvent(ctx, { action: 'toggle', value: 'ai' });
  assert.ok(!layout.methods.getLayout().collapsed.ai, 'a sidebar ignores buttons it does not show');
  sidebar.onEvent(ctx, { action: 'toggle', value: 'ai' });
  assert.equal(layout.methods.getLayout().collapsed.ai, true);
  assert.equal(sidebar.render().children.find(n => n.key === 'ai').tooltip, 'Show AI Chat');
  sidebar.onEvent(ctx, { action: 'toggle', value: 'ai' });
  assert.equal(layout.methods.getLayout().collapsed.ai, false);
  await layout.onEvent(ctx, { action: 'hide', value: 'terminal' });
  left.onEvent(ctx, { action: 'toggle', value: 'terminal' });
  assert.ok(layout.methods.getLayout().bottom.panels.includes('terminal'));
  assert.equal(left.render().children.find(n => n.key === 'terminal').variant, 'primary');
  left.onEvent(ctx, { action: 'toggle', value: 'terminal' });
  assert.equal(layout.methods.getLayout().collapsed.terminal, true);
});

test('sidebar drawings are module data and a new module build picks up edited SVGs', async () => {
  const sidebar = await load('sidebar'), left = await load('left-sidebar');
  const ctx = { host: { plugins: pluginsHost() }, state: { get() {}, watch() {} }, events: { on() { return () => {}; } }, ui: { invalidate() {} }, log: { warn() {} } };
  await sidebar.activate(ctx); await left.activate(ctx);
  assert.deepEqual(left.render().children.map(n => n.key), ['projects', 'files', 'git', 'remote', 'viewer', 'git-changes', 'workflows', 'terminal']);
  assert.deepEqual(sidebar.render().children.map(n => n.key), ['git-task-changes', 'git-history', 'ai', 'agents', 'mcps']);
  for (const node of [...sidebar.render().children, ...left.render().children].filter(n => n.type === 'button')) {
    assert.equal(node.icon, undefined);
    assert.match(node.iconSvg, /<svg /);
    assert.match(node.iconSvg, /stroke="currentColor"/);
    assert.equal(node.iconSize, 22);
  }
  const changed = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/></svg>';
  const originalFiles = left.render().children[1].iconSvg;
  const updated = await load('left-sidebar', { projects: changed, files: originalFiles });
  await updated.activate(ctx);
  assert.equal(updated.render().children[0].iconSvg, changed);
  assert.equal(updated.render().children[1].iconSvg, originalFiles);
});

test('sidebar settings move, hide and persist buttons independently of panel docking', async t => {
  const layout = await load('workspace-layout'), right = await load('sidebar'), left = await load('left-sidebar');
  t.after(() => { layout.deactivate(); right.deactivate(); left.deactivate(); });
  const stored = new Map([['activity-sidebar.v1', { files: 'left-bottom', ai: 'right-top', terminal: 'right-bottom', remote: 'hidden' }], ['sidebar-order.v1', {}]]);
  const state = new Map(), watchers = new Map(), events = new Map();
  let failSave = false;
  const ctx = { moduleId: 'workspace-layout', host: { env: { info: () => ({ repoRoot: '/runtime', dataDir: '/data' }) }, plugins: pluginsHost() },
    state: { get: k => state.get(k), set(k, v) { state.set(k, v); for (const fn of watchers.get(k) || []) fn(v); }, watch(k, fn) { const list = watchers.get(k) || []; list.push(fn); watchers.set(k, list); } },
    events: { on(k, fn) { const set = events.get(k) || new Set(); set.add(fn); events.set(k, set); return () => set.delete(fn); }, emit(k, v) { for (const fn of events.get(k) || []) fn(v); } },
    modules: { async call(_id, method, args) {
      if (method === 'settings.get') return stored.get(args.key);
      if (method === 'settings.set') { if (failSave) throw new Error('Save failed'); stored.set(args.key, args.value); }
      if (method === 'list') return [];
      if (method === 'updates') return { modules: [], available: [], errors: [] };
    } }, ui: { invalidate() {} }, log: { warn() {} },
  };
  await layout.activate(ctx); await right.activate(ctx); await left.activate(ctx);
  const keys = mod => mod.render().children.map(n => n.key);
  assert.ok(keys(left).indexOf('files') > keys(left).indexOf('sidebar-spacer'));
  assert.ok(!keys(right).includes('files'));
  assert.ok(keys(right).indexOf('ai') < keys(right).indexOf('sidebar-spacer'));
  assert.ok(keys(right).indexOf('terminal') > keys(right).indexOf('sidebar-spacer'));
  assert.ok(!keys(right).includes('remote'));
  const settings = () => state.get('workspace-layout.settings');
  const section = () => settings().sections.find(s => s.key === 'side-panels');
  assert.deepEqual(section().fields.find(f => f.key === 'files').options.map(o => o.value), ['left-top', 'left-bottom', 'right-top', 'right-bottom', 'hidden']);
  const before = JSON.stringify(layout.methods.getLayout());
  const edit = async (key, value) => {
    ctx.events.emit('settings.change', { module: 'workspace-layout', section: 'side-panels', key, value });
    await new Promise(r => setImmediate(r));
  };
  await edit('files', 'left-top');
  assert.ok(!keys(left).includes('sidebar-spacer'), 'only top buttons need no spacer');
  assert.equal(stored.get('activity-sidebar.v1').files, 'left-top');
  assert.equal(JSON.stringify(layout.methods.getLayout()), before, 'button placement leaves panel docking untouched');
  await edit('files', 'hidden');
  assert.ok(!keys(left).includes('files'));
  await edit('files', 'right-bottom');
  assert.ok(keys(right).indexOf('files') > keys(right).indexOf('sidebar-spacer'));
  right.onEvent(ctx, { action: 'toggle', value: 'files' });
  assert.equal(layout.methods.getLayout().collapsed.files, true, 'a moved button still controls its panel');
  const orderField = state.get('workspace-layout.settings').sections.find(s => s.key === 'sidebar-order').fields.find(f => f.key === 'right-bottom');
  const items = JSON.parse(orderField.value).reverse(); items.splice(1, 0, '@spacer:test');
  ctx.events.emit('settings.change', { module: 'workspace-layout', section: 'sidebar-order', key: 'right-bottom', value: JSON.stringify(items) });
  await new Promise(r => setImmediate(r));
  const rendered = right.render().children;
  const tail = rendered.slice(rendered.findIndex(n => n.key === 'sidebar-spacer') + 1);
  assert.deepEqual(tail.map(n => n.key), items);
  assert.equal(tail.find(n => n.key === '@spacer:test').height, 12);
  assert.deepEqual(stored.get('sidebar-order.v1')['right-bottom'], items);
  failSave = true;
  await edit('files', 'left-bottom');
  assert.equal(section().fields.find(f => f.key === 'files').value, 'right-bottom');
  assert.equal(settings().error, 'Save failed');
  assert.ok(keys(right).includes('files'), 'failed persistence leaves the current button in place');
  failSave = false;
  assert.equal(layout.snapshot().sidebarButtons.files, "right-bottom");
  layout.deactivate();
  await layout.activate(ctx);
  assert.equal(state.get('workspace-layout.sidebarButtons').files, 'right-bottom', 'hot reload retains placement');
});
