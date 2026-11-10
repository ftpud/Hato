import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as esbuild from 'esbuild';
let generation = 0;
async function load(entry) {
  const built = await esbuild.build({ entryPoints: [entry], bundle: true, format: 'esm', write: false });
  return import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64') + '#' + (++generation));
}
const walk = node => [node, ...(node.children || []).flatMap(walk)];
const entry = (path, kind = 'file') => ({ relativePath: path, name: path.split('/').pop(), kind });

test('compact folders preserve the leaf action key and keep files below a branch', async () => {
  const { treeRows, directories } = await load('Hato-plugins/modules/ui/explorer/src/model.ts');
  const dirs = directories([entry('a', 'dir'), entry('a/b', 'dir'), entry('a/b/c', 'dir'), entry('a/b/c/one'), entry('a/b/c/two')]);
  const rows = treeRows(dirs, new Set(['a/b/c']), 'a/b/c/two');
  assert.equal(rows[0].label, 'a/b/c');
  assert.equal(rows[0].key, 'a/b/c');
  assert.deepEqual(rows.map(row => row.depth), [0, 1, 1]);
  assert.equal(rows[2].selected, true);
});

test('file watch refresh retains visible rows and queues events received during an in-flight listing', async () => {
  const { default: mod } = await load('Hato-plugins/modules/ui/explorer/src/index.ts');
  const events = {};
  let release, calls = 0;
  const ctx = { events: { on: (name, callback) => { events[name] = callback; } }, state: { get: () => ({ id: 'ws', view: {} }), watch() {} }, ui: { invalidate() {} }, modules: { async call(module, method) {
    if (method === 'status') return { files: [] };
    if (method === 'list') {
      calls++;
      if (calls === 2) await new Promise(resolve => { release = resolve; });
      return { entries: [entry(calls > 1 ? 'new.txt' : 'old.txt')] };
    }
  } } };
  await mod.activate(ctx);
  const rows = () => walk(mod.render()).find(node => node.type === 'tree').rows;
  events['files.changed']({ workspaceId: 'ws' });
  assert.equal(rows()[0].key, 'old.txt');
  events['files.changed']({ workspaceId: 'ws' });
  release();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(calls, 3);
  assert.equal(rows()[0].key, 'new.txt');
});

test('New chat creates a daemon session, remembers it, and sends through the background gateway', async () => {
  const { default: mod } = await load('Hato-plugins/modules/ui/ai/src/index.ts');
  const events = {}, requests = [], patches = [];
  const selected = { id: 'ws', name: 'Workspace', view: {} };
  const session = { id: 'background', workspaceId: 'ws', name: 'Chat', profile: { id: 'provider', name: 'Provider' }, mcps: [], skills: [], status: 'ready', model: '', configOptions: [] };
  const page = { session, messages: [], queued: [], permissions: [], before: null };
  const ctx = {
    state: { get: key => key === 'workspace.selected' ? selected : null, set() {}, watch() {} },
    ui: { invalidate() {} },
    host: { plugins: { async list() { return { plugins: [{ id: 'persistent-agents', active: 'v1' }] }; } } },
    events: { on: (name, callback) => { events[name] = callback; }, emit(name, value) {
      if (name !== 'ai.persistentRequest') return;
      requests.push(value);
      const result = value.method === 'catalog' ? { profiles: [session.profile], agentFiles: [] } : value.method === 'create' ? session : value.method === 'view' ? page : null;
      events['persistent-agents.chatResponse']({ requestId: value.requestId, value: result });
    } },
    modules: { async call(module, method, args) {
      if (module === 'workspace' && method === 'view.get') return {};
      if (method === 'view.patch') { patches.push(args); return; }
      if (module === 'ai-sessions' && method === 'view') return { workspace: selected, profiles: [session.profile], conversations: [], active: null };
      throw new Error(`Unexpected desktop call: ${module}.${method}`);
    } },
  };
  try {
    await mod.activate(ctx);
    await mod.onEvent(ctx, { action: 'newChat', key: 'new', inputs: {} });
    assert.ok(requests.some(request => request.method === 'create' && request.args.mcps.includes('internal-remote-mcp')));
    assert.ok(patches.some(patch => patch.patch.ui.aiBackgroundSession === 'background'));
    await mod.onEvent(ctx, { action: 'send', key: 'prompt', inputs: { prompt: 'Run in background' } });
    assert.ok(requests.some(request => request.method === 'send' && request.args.id === 'background' && request.args.text === 'Run in background'));
    assert.equal((await mod.snapshot()).background.id, 'background');
  } finally { mod.deactivate(); }
});

test('terminal output marks inactive tabs unread and selecting a tab clears its dot', async () => {
  const { default: mod } = await load('Hato-plugins/modules/ui/terminal-panel/src/index.ts');
  let tick, cursor = 5;
  const original = globalThis.setInterval;
  globalThis.setInterval = callback => { tick = callback; return { unref() {} }; };
  const selected = { id: 'ws', view: { ui: { terminalTabs: { keys: ['main', 'other'], active: 'main' } } } };
  const ctx = { state: { get: () => selected, watch() {} }, events: { on() {} }, ui: { invalidate() {} }, modules: { async call(module, method) {
    if (method === 'activity') return [{ key: 'main', cursor }, { key: 'other', cursor }];
    if (method === 'attach') return { pty: 'pty' };
  } } };
  const flush = () => new Promise(resolve => setImmediate(resolve));
  try {
    await mod.activate(ctx); await flush();
    cursor++;
    tick(); await flush();
    const tab = () => walk(mod.render()).find(node => node.action === 'select:other');
    assert.match(tab().text, /•/);
    assert.equal(tab().middleClickAction, 'close:other');
    await mod.onEvent(ctx, { action: 'select:other', inputs: {} });
    assert.doesNotMatch(tab().text, /•/);
  } finally { mod.deactivate(); globalThis.setInterval = original; }
});

test('editor context menu closes only tabs to the right and then all tabs', async () => {
  const { default: mod } = await load('Hato-plugins/modules/ui/viewer/src/index.ts');
  let selected = { id: 'ws', view: { previewPath: 'b.ts', ui: { viewerTabs: ['a.ts', 'b.ts', 'c.ts'] } } }, watcher;
  const ctx = { moduleId: 'viewer', state: { get: () => selected, set() {}, watch: (_, callback) => { watcher = callback; } }, events: { on() {} }, ui: { invalidate() {} }, modules: { async call(module, method, args) {
    if (method === 'settings.get') return null;
    if (method === 'open') return { document: args.relativePath, relativePath: args.relativePath };
    if (method === 'view.patch') { selected = { ...selected, view: { ...selected.view, ...args.patch, ui: { ...selected.view.ui, ...args.patch.ui } } }; watcher(selected); }
  } } };
  try {
    await mod.activate(ctx);
    assert.equal(walk(mod.render()).find(node => node.action === 'select:b.ts').middleClickAction, 'close:b.ts');
    await mod.onEvent(ctx, { action: 'tabMenu:b.ts', inputs: {} });
    assert.ok(walk(mod.render()).some(node => node.action === 'closeRight'));
    await mod.onEvent(ctx, { action: 'closeRight', inputs: {} });
    assert.deepEqual(selected.view.ui.viewerTabs, ['a.ts', 'b.ts']);
    assert.equal(selected.view.previewPath, 'b.ts');
    await mod.onEvent(ctx, { action: 'tabMenu:b.ts', inputs: {} });
    await mod.onEvent(ctx, { action: 'closeAll', inputs: {} });
    assert.deepEqual(selected.view.ui.viewerTabs, []);
    assert.equal(selected.view.previewPath, null);
  } finally { await mod.deactivate(ctx); }
});
