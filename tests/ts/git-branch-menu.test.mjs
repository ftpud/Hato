import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as esbuild from 'esbuild';
let generation = 0;
const walk = n => [n, ...(n.children || []).flatMap(walk)];
const branch = (name, current = false, remote = false) => ({ ref: `refs/${remote ? 'remotes' : 'heads'}/${name}`, name, current, commit: 'abcd123', upstream: null, worktree: null });
const catalog = (workspaceId = 'one', current = 'main') => ({ workspaceId, repo: true, current, head: 'abcd123', remotes: ['origin'], local: [branch('main', current === 'main'), branch('feature/welcome', current === 'feature/welcome')], remote: [branch('origin/feature/remote', false, true)] });
async function fixture(call) {
  const built = await esbuild.build({ entryPoints: ['modules/ui/git-branch/src/index.ts'], bundle: true, format: 'esm', write: false });
  const mod = (await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64') + '#' + ++generation)).default;
  const watchers = new Map(), events = new Map(), calls = [];
  const ctx = { state: { get: () => ({ id: 'one' }), watch(k, fn) { watchers.set(k, fn); } }, events: { on(k, fn) { events.set(k, fn); } }, ui: { invalidate() {} }, modules: { async call(target, method, args) { assert.equal(target, 'git'); calls.push([method, args]); return call ? call(method, args) : catalog(args.workspaceId); } } };
  const event = (action, value, inputs = {}) => mod.onEvent(ctx, { action, value, inputs });
  await mod.activate(ctx);
  return { mod, ctx, event, calls, watchers, events, nodes: () => walk(mod.render()) };
}

test('branch widget searches local/remote tabs, marks current branch, creates from a ref and checks out', async () => {
  const f = await fixture((method, args) => catalog(args.workspaceId, method === 'createBranch' ? args.name : method === 'checkout' ? 'feature/welcome' : 'main'));
  assert.equal(f.mod.render().type, 'dropdown');
  assert.equal(f.mod.render().text, '⌄');
  assert.equal(f.mod.render().variant, 'ghost');
  assert.ok(f.mod.render().iconSvg);
  assert.equal(f.mod.render().style?.background, 'transparent');
  assert.equal(f.mod.render().style?.borderWidth, 0);
  assert.match(f.mod.render().tooltip, /Current branch: main/);
  await f.event('toggle', true); assert.equal(f.mod.render().open, true);
  await f.event('filter', 'WELCOME');
  let rows = f.nodes().find(n => n.key === 'branches').children;
  assert.deepEqual(rows.map(n => n.key), ['refs/heads/feature/welcome']);
  await f.event('tab', 'remote'); await f.event('filter', 'remote');
  rows = f.nodes().find(n => n.key === 'branches').children;
  assert.deepEqual(rows.map(n => n.key), ['refs/remotes/origin/feature/remote']);
  await f.event('branchActions', rows[0].key); await f.event('createFrom', rows[0].key);
  await f.event('branchName', 'feature/new');
  await f.event('createBranch', null, { 'new-branch-name': 'feature/new' });
  assert.deepEqual(f.calls.find(([method]) => method === 'createBranch')[1], { workspaceId: 'one', name: 'feature/new', from: 'refs/remotes/origin/feature/remote' });
  assert.equal(f.mod.render().open, false); assert.match(f.mod.render().tooltip, /Current branch: feature\/new/);
  await f.event('toggle', true); await f.event('checkout', 'refs/heads/feature/welcome');
  assert.match(f.mod.render().tooltip, /Current branch: feature\/welcome/);
  assert.equal(f.mod.render().open, false);
});

test('checkout errors leave the picker open and preserve selection; popup closes on native dismissal', async () => {
  const f = await fixture((method, args) => { if (method === 'checkout') throw Error('Local changes would be overwritten'); return catalog(args.workspaceId); });
  await f.event('toggle', true); await f.event('checkout', 'refs/heads/feature/welcome');
  assert.equal(f.mod.render().open, true); assert.match(f.mod.render().tooltip, /Current branch: main/);
  assert.match(f.nodes().find(n => n.key === 'error').text, /Local changes/);
  await f.event('toggle', false); assert.equal(f.mod.render().open, false);
});

test('late results from a previous workspace cannot change the new workspace branch', async () => {
  let finish;
  const f = await fixture((method, args) => {
    if (method === 'checkout') return new Promise(resolve => finish = resolve);
    return catalog(args.workspaceId, args.workspaceId === 'two' ? 'other' : 'main');
  });
  const pending = f.event('checkout', 'refs/heads/feature/welcome');
  assert.equal(f.mod.canSwap().ok, false);
  f.watchers.get('workspace.selected')({ id: 'two' }); await new Promise(setImmediate);
  assert.match(f.mod.render().tooltip, /Current branch: other/);
  finish(catalog('one', 'feature/welcome')); await pending;
  assert.match(f.mod.render().tooltip, /Current branch: other/); assert.equal(f.mod.canSwap().ok, true);
});
