import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as esbuild from 'esbuild';
let generation = 0;
async function load(entry) {
  const built = await esbuild.build({ entryPoints: [entry], bundle: true, format: 'esm', write: false });
  return import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64') + '#' + (++generation));
}
const entry = (relativePath, kind = 'file') => ({ relativePath, name: relativePath.split('/').pop(), kind, size: 1 });
const walk = node => [node, ...(node.children || []).flatMap(walk)];
const settle = () => new Promise(resolve => setTimeout(resolve, 200));

test('tree sorts directories first, expands lazily and assigns file type icons', async () => {
  const { treeRows, fileIcon, directories } = await load('modules/ui/explorer/src/model.ts');
  const dirs = directories([entry('src', 'dir'), entry('README.md'), entry('src/index.ts'), entry('package.json')]);
  assert.deepEqual(treeRows(dirs, new Set(), null).map(row => row.key), ['src', 'package.json', 'README.md']);
  assert.equal(treeRows(dirs, new Set(['src']), 'src/index.ts')[1].selected, true);
  assert.equal(treeRows(dirs, new Set(), null, true).find(row => row.key === 'src/index.ts').depth, 1);
  assert.equal(fileIcon(entry('photo.png')), 'image');
  assert.equal(fileIcon(entry('package.json')), 'config');
  assert.equal(fileIcon(entry('README.md')), 'text');
  assert.equal(fileIcon(entry('index.ts')), 'code');
});

test('file tree opens files in the viewer and filters workspace results while retaining expansion', async () => {
  const { default: mod } = await load('modules/ui/explorer/src/index.ts');
  const selected = { id: 'ws', name: 'Workspace', view: { previewPath: null } };
  const calls = [];
  const ctx = { events: { on() {} }, state: { get: () => selected, watch() {} }, ui: { invalidate() {} }, modules: { async call(module, method, args) {
    calls.push({ module, method, args });
    if (method === 'list') return { entries: args.relativeDir === '.' ? [entry('src', 'dir'), entry('README.md'), entry('.git', 'dir')] : [entry('src/index.ts')] };
    if (method === 'view.patch') return;
    if (method === 'search') return { entries: [entry('src', 'dir'), entry('src/index.ts')], matchCount: 1, partial: false };
    throw new Error(method);
  } } };
  await mod.activate(ctx);
  const tree = () => walk(mod.render()).find(node => node.type === 'tree');
  assert.ok(!tree().rows.some(row => row.key === 'src/index.ts'));
  await mod.onEvent(ctx, { action: 'expand', rowKey: 'src', inputs: {} });
  assert.ok(tree().rows.some(row => row.key === 'src/index.ts'));
  await mod.onEvent(ctx, { action: 'open', rowKey: 'src/index.ts', inputs: {} });
  assert.ok(calls.some(call => call.args.patch?.previewPath === 'src/index.ts'));
  await mod.onEvent(ctx, { action: 'filter', value: 'index', inputs: {} });
  await settle();
  assert.deepEqual(tree().rows.map(row => row.key), ['src', 'src/index.ts']);
  assert.equal(walk(mod.render()).find(node => node.key === 'count').text, '1 match');
  await mod.onEvent(ctx, { action: 'expand', rowKey: 'src', inputs: {} });
  assert.deepEqual(tree().rows.map(row => row.key), ['src']);
  assert.equal(walk(mod.render()).find(node => node.key === 'file-filter').value, 'index');
  await mod.onEvent(ctx, { action: 'clearFilter', inputs: {} });
  assert.ok(tree().rows.some(row => row.key === 'README.md'));
  assert.ok(tree().rows.some(row => row.key === 'src/index.ts'));
  await mod.onEvent(ctx, { action: 'collapseAll', inputs: {} });
  assert.ok(!tree().rows.some(row => row.key === 'src/index.ts'));
});

test('old workspace searches cannot overwrite a newly selected workspace', async () => {
  const { default: mod } = await load('modules/ui/explorer/src/index.ts');
  let selected = { id: 'one', view: {} }, watcher, resolveSearch;
  const ctx = { events: { on() {} }, state: { get: () => selected, watch: (_, callback) => { watcher = callback; } }, ui: { invalidate() {} }, modules: { async call(_, method, args) {
    if (method === 'list') return { entries: [entry(args.workspaceId + '.txt')] };
    if (method === 'search') return new Promise(resolve => { resolveSearch = resolve; });
  } } };
  await mod.activate(ctx);
  await mod.onEvent(ctx, { action: 'filter', value: 'one', inputs: {} });
  await settle();
  selected = { id: 'two', view: {} }; watcher(selected);
  await settle();
  resolveSearch({ entries: [entry('old.txt')], matchCount: 1 });
  await settle();
  const nodes = walk(mod.render());
  assert.deepEqual(nodes.find(node => node.type === 'tree').rows.map(row => row.key), ['two.txt']);
  assert.equal(nodes.find(node => node.key === 'file-filter').value, '');
});

test('scoped search includes ancestors, caches listings and avoids symlink and .git traversal', async () => {
  const { searchFiles } = await load('modules/services/files/src/search.ts');
  const calls = [], grants = [];
  const entries = { '.': [entry('src', 'dir'), entry('.git', 'dir'), entry('linked', 'symlink')], src: [entry('src/nested', 'dir')], 'src/nested': [entry('src/nested/target.ts')] };
  const ctx = { host: { capabilities: { async request(args) { grants.push(args); return { grant: 'scope' }; } }, fs: { async list(grant, path) { calls.push(path); assert.equal(grant, 'scope'); return { entries: entries[path] || [] }; } } } };
  const desc = { id: 'ws', location: 'local', machineId: 'local', rootAbsolutePath: '/workspace' };
  const result = await searchFiles(ctx, desc, 'TARGET.ts');
  assert.deepEqual(result.entries.map(item => item.relativePath).sort(), ['src', 'src/nested', 'src/nested/target.ts']);
  assert.equal(result.matchCount, 1);
  assert.equal(result.partial, false);
  assert.equal(grants[0].root, '/workspace');
  assert.ok(!calls.includes('.git') && !calls.includes('linked'));
  await searchFiles(ctx, desc, 'src');
  assert.equal(calls.length, 3);
  await searchFiles(ctx, desc, 'target', true);
  assert.equal(calls.length, 6);
});
