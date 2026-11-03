import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as esbuild from 'esbuild';
let n = 0;
async function moduleAt(path) {
  const built = await esbuild.build({ entryPoints: [path], bundle: true, format: 'esm', write: false });
  return (await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64') + '#' + n++)).default;
}
const walk = node => [node, ...(node.children || []).flatMap(walk)];
function context(service) {
  let ws = { id: 'one', view: { ui: {}, previewPath: null } }, watcher;
  const ctx = { moduleId: 'test', state: { get: () => ws, set() {}, watch(_, fn) { watcher = fn; } }, events: { on() {} }, ui: { invalidate() {} }, modules: { async call(mod, method, args) {
    if (method === 'settings.get') return true;
    if (method === 'view.patch') { ws = { ...ws, view: { ...ws.view, ...args.patch, ui: { ...ws.view.ui, ...args.patch.ui } } }; watcher(ws); return; }
    return service(mod, method, args);
  } } };
  return { ctx, selected: () => ws, async switchTo(next) { ws = next; watcher(ws); await new Promise(r => setTimeout(r, 0)); } };
}
test('terminal tabs attach independent shells, retain selection, and close the selected PTY', async () => {
  const calls = [];
  const mod = await moduleAt('modules/ui/terminal-panel/src/index.ts');
  const c = context(async (_, method, args) => { calls.push({ method, ...args }); return { pty: args.workspaceId + ':' + args.key }; });
  await mod.activate(c.ctx);
  await mod.onEvent(c.ctx, { action: 'new' });
  const newKey = c.selected().view.ui.terminalTabs.active;
  assert.notEqual(newKey, 'main');
  assert.equal(c.selected().view.ui.terminalTabs.keys.length, 2);
  await mod.onEvent(c.ctx, { action: 'select:main' });
  assert.equal(walk(mod.render()).find(n => n.type === 'terminal').pty, 'one:main');
  await mod.onEvent(c.ctx, { action: 'close:' + newKey });
  assert.ok(calls.some(c => c.method === 'close' && c.key === newKey));
  assert.deepEqual(c.selected().view.ui.terminalTabs.keys, ['main']);
  const saved = c.selected();
  await c.switchTo({ id: 'two', view: {} });
  await c.switchTo(saved);
  assert.equal(walk(mod.render()).find(n => n.type === 'terminal').pty, 'one:main');
});
test('viewer retains file tabs and closing active file selects its neighbor', async () => {
  const mod = await moduleAt('modules/ui/viewer/src/index.ts');
  const c = context(async (_, method, args) => { assert.equal(method, 'open'); return { relativePath: args.relativePath, document: args.relativePath }; });
  await mod.activate(c.ctx);
  for (const path of ['src/a.ts', 'src/b.ts']) {
    await c.ctx.modules.call('workspace', 'view.patch', { patch: { previewPath: path } });
    await new Promise(r => setTimeout(r, 0));
  }
  assert.deepEqual(c.selected().view.ui.viewerTabs, ['src/a.ts', 'src/b.ts']);
  await mod.onEvent(c.ctx, { action: 'close:src/b.ts' });
  await new Promise(r => setTimeout(r, 0));
  assert.deepEqual(c.selected().view.ui.viewerTabs, ['src/a.ts']);
  assert.equal(c.selected().view.previewPath, 'src/a.ts');
  assert.equal(walk(mod.render()).find(n => n.type === 'codeViewer').document, 'src/a.ts');
  await mod.onEvent(c.ctx, { action: 'close:src/a.ts' });
  await new Promise(r => setTimeout(r, 0));
  assert.equal(c.selected().view.previewPath, null);
  assert.equal(walk(mod.render()).find(n => n.type === 'codeViewer').document, null);
});

test('Markdown files render by default and the source toggle persists without reopening the document', async () => {
  const mod = await moduleAt('modules/ui/viewer/src/index.ts');
  const saved = [];
  let opens = 0;
  const c = context(async (_, method, args) => {
    if (method === 'settings.set') { saved.push(args); return; }
    assert.equal(method, 'open'); opens++;
    return { relativePath: args.relativePath, language: 'markdown', document: 'markdown-document', size: 123 };
  });
  await mod.activate(c.ctx);
  await c.ctx.modules.call('workspace', 'view.patch', { patch: { previewPath: 'README.md' } });
  await new Promise(r => setTimeout(r, 0));
  assert.equal(walk(mod.render()).find(n => n.type === 'markdown').document, 'markdown-document');
  await mod.onEvent(c.ctx, { action: 'toggleMarkdown' });
  assert.equal(walk(mod.render()).find(n => n.type === 'codeViewer').document, 'markdown-document');
  assert.deepEqual(saved.at(-1), { key: 'viewer.renderMarkdown', value: false });
  await mod.onEvent(c.ctx, { action: 'toggleMarkdown' });
  assert.ok(walk(mod.render()).some(n => n.type === 'markdown'));
  assert.equal(opens, 1);
});
