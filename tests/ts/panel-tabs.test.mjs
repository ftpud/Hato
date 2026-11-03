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

test('terminal blocks split in both directions, resize, preserve PTYs across workspace switches and close independently', async () => {
  const mod = await moduleAt('modules/ui/terminal-panel/src/index.ts');
  const calls = [];
  const c = context(async (_, method, args) => { calls.push({ method, ...args }); return { pty: args.workspaceId + ':' + args.key }; });
  await mod.activate(c.ctx);
  const terminals = () => walk(mod.render()).filter(n => n.type === 'terminal');
  const action = name => walk(mod.render()).find(n => n.key === name).action;
  const original = terminals()[0].pty;
  await mod.onEvent(c.ctx, { action: action('splitRight') });
  assert.equal(terminals().length, 2);
  const horizontal = walk(mod.render()).find(n => n.type === 'split');
  assert.equal(horizontal.direction, 'horizontal');
  assert.equal(terminals()[0].pty, original);
  assert.notEqual(terminals()[1].pty, original);
  await mod.onEvent(c.ctx, { action: 'resizeBlocks', key: horizontal.key, value: { sizes: [0.7, 0.3] } });
  assert.deepEqual(c.selected().view.ui.terminalLayout.sizes, [0.7, 0.3]);
  const right = c.selected().view.ui.terminalLayout.children[1];
  await mod.onEvent(c.ctx, { action: 'new:' + right.id });
  assert.equal(c.selected().view.ui.terminalLayout.children[1].keys.length, 2);
  assert.equal(c.selected().view.ui.terminalLayout.children[0].keys.length, 1);
  const before = terminals().map(n => n.pty);
  await mod.onEvent(c.ctx, { action: 'splitDown:' + right.id });
  assert.equal(terminals().length, 3);
  assert.deepEqual(walk(mod.render()).filter(n => n.type === 'split').map(n => n.direction), ['horizontal', 'vertical']);
  assert.deepEqual(terminals().slice(0, 2).map(n => n.pty), before);
  const saved = c.selected(), ptys = terminals().map(n => n.pty);
  await c.switchTo({ id: 'two', view: {} });
  assert.equal(terminals().length, 1);
  await c.switchTo(saved);
  assert.deepEqual(terminals().map(n => n.pty), ptys);
  const close = walk(mod.render()).filter(n => n.key === 'closeBlock')[1].action;
  const closeBefore = calls.filter(c => c.method === 'close').length;
  await mod.onEvent(c.ctx, { action: close });
  assert.equal(terminals().length, 2);
  assert.equal(terminals()[0].pty, original);
  assert.equal(calls.filter(c => c.method === 'close').length - closeBefore, 2);
  assert.equal(walk(mod.render()).filter(n => n.type === 'split').length, 1);
});

test('late terminal attaches from another workspace never replace current block contents', async () => {
  const mod = await moduleAt('modules/ui/terminal-panel/src/index.ts');
  let release;
  const c = context(async (_, method, args) => {
    if (args.workspaceId === 'one' && args.key !== 'main') return new Promise(resolve => { release = () => resolve({ pty: 'stale' }); });
    return { pty: args.workspaceId + ':' + args.key };
  });
  await mod.activate(c.ctx);
  const split = walk(mod.render()).find(n => n.key === 'splitRight').action;
  const pending = mod.onEvent(c.ctx, { action: split });
  await new Promise(r => setTimeout(r, 0));
  assert.equal((await mod.canSwap()).ok, false);
  await c.switchTo({ id: 'two', view: {} });
  release(); await pending;
  assert.deepEqual(walk(mod.render()).filter(n => n.type === 'terminal').map(n => n.pty), ['two:main']);
  assert.equal((await mod.canSwap()).ok, true);
});
