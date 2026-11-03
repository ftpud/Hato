import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as esbuild from 'esbuild';
async function load(id, icons) {
  const built = await esbuild.build({ entryPoints: [`modules/ui/${id}/src/index.ts`], bundle: true, format: 'esm', write: false, plugins: icons ? [{ name: 'edited-icons', setup(build) { build.onLoad({ filter: /sidebar-icons\.ts$/ }, () => ({ contents: `export const sidebarIcons = ${JSON.stringify(icons)}`, loader: 'ts' })); } }] : [] });
  return (await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64'))).default;
}
test('separate sidebar toggles layout panels and reflects collapse, hide and restore state', async () => {
  const layout = await load('workspace-layout'), sidebar = await load('sidebar'), left = await load('left-sidebar');
  const values = new Map(), watches = new Map(), events = new Map();
  const ctx = { state: { get: key => values.get(key), set(key, value) { values.set(key, value); for (const fn of watches.get(key) || []) fn(value); }, watch(key, fn) { watches.set(key, [...(watches.get(key) || []), fn]); } },
    events: { on(key, fn) { events.set(key, fn); }, emit(key, value) { events.get(key)?.(value); } },
    modules: { async call(_, method) { if (method === 'list') return []; if (method === 'updates') return { modules: [], available: [], errors: [] }; } },
    ui: { invalidate() {} }, log: { warn() {} } };
  await layout.activate(ctx);
  sidebar.activate(ctx);
  left.activate(ctx);
  assert.equal(sidebar.render().border, undefined);
  assert.equal(sidebar.render().surface, undefined);
  assert.equal(left.render().surface, undefined);
  const fileButton = () => sidebar.render().children.find(n => n.key === 'files');
  assert.equal(fileButton().variant, 'primary');
  sidebar.onEvent(ctx, { action: 'toggle', value: 'files' });
  assert.equal(layout.methods.getLayout().collapsed.files, true);
  assert.equal(fileButton().tooltip, 'Show Files');
  sidebar.onEvent(ctx, { action: 'toggle', value: 'files' });
  assert.equal(layout.methods.getLayout().collapsed.files, false);
  await layout.onEvent(ctx, { action: 'hide', value: 'files' });
  assert.equal(fileButton().variant, 'ghost');
  sidebar.onEvent(ctx, { action: 'toggle', value: 'files' });
  assert.ok(layout.methods.getLayout().columns.some(c => c.panels.includes('files')));
  assert.equal(fileButton().variant, 'primary');
  sidebar.onEvent(ctx, { action: 'toggle', value: 'ai' });
  assert.ok(!layout.methods.getLayout().collapsed.ai);
  left.onEvent(ctx, { action: 'toggle', value: 'ai' });
  assert.equal(layout.methods.getLayout().collapsed.ai, true);
  assert.equal(left.render().children.find(n => n.key === 'ai').tooltip, 'Show AI Chat');
  left.onEvent(ctx, { action: 'toggle', value: 'ai' });
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
  assert.deepEqual(sidebar.render().children.map(n => n.key), ['projects', 'files']);
  for (const node of [...sidebar.render().children, ...left.render().children]) {
    assert.equal(node.icon, undefined);
    assert.match(node.iconSvg, /<svg /);
    assert.match(node.iconSvg, /stroke="currentColor"/);
    assert.equal(node.iconSize, 22);
  }
  const changed = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/></svg>';
  const originalFiles = sidebar.render().children[1].iconSvg;
  const updated = await load('sidebar', { projects: changed, files: originalFiles });
  assert.equal(updated.render().children[0].iconSvg, changed);
  assert.equal(updated.render().children[1].iconSvg, originalFiles);
});
