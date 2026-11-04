// Explorer content search, .gitignore visibility, and the files service's git-backed helpers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as esbuild from 'esbuild';
let generation = 0;
const load = async entry => import('data:text/javascript;base64,' + Buffer.from((await esbuild.build({ entryPoints: [entry], bundle: true, format: 'esm', write: false })).outputFiles[0].text).toString('base64') + '#' + (++generation));
const walk = n => [n, ...(n.children || []).flatMap(walk)];
const settle = () => new Promise(r => setTimeout(r, 600));

test('explorer hides ignored files by default and searches file contents on demand', async () => {
  const { default: mod } = await load('modules/ui/explorer/src/index.ts');
  const ws = { id: 'ws', view: { previewPath: null, ui: {} } };
  const calls = [];
  const ctx = { events: { on() {} }, state: { get: () => ws, watch() {} }, ui: { invalidate() {} }, modules: { async call(module, method, args) {
    calls.push({ method, args });
    if (method === 'list') return { entries: [{ name: 'src', relativePath: 'src', kind: 'dir' }] };
    if (method === 'grep') return { files: [{ relativePath: 'src/a.ts', matches: [{ line: 3, text: 'const needle = 1' }, { line: 9, text: 'needle()' }] }], matchCount: 2, fileCount: 1, truncated: false };
    if (method === 'search') return { entries: [], matchCount: 0 };
    return null;
  } } };
  await mod.activate(ctx);
  assert.equal(calls.find(c => c.method === 'list').args.hideIgnored, true, 'ignored files are hidden by default');
  const bar = () => walk(mod.render()).find(n => n.key === 'filter-bar').children.map(n => n.key);
  assert.deepEqual(bar(), ['file-filter', 'content-mode', 'show-ignored']);
  await mod.onEvent(ctx, { action: 'toggleContent', inputs: {} });
  await mod.onEvent(ctx, { action: 'filter', value: 'needle', inputs: {} });
  await settle();
  const grep = calls.filter(c => c.method === 'grep').at(-1);
  assert.deepEqual([grep.args.query, grep.args.hideIgnored], ['needle', true]);
  const tree = walk(mod.render()).find(n => n.key === 'files');
  assert.deepEqual(tree.rows.map(r => r.key), ['src', 'src/a.ts']);
  assert.equal(tree.rows[0].expandable, true);
  assert.equal(tree.rows[0].expanded, true);
  assert.equal(tree.rows[1].label, 'a.ts');
  assert.equal(tree.rows[1].expandable, false);
  assert.ok(!tree.rows.some(row => /needle/.test(row.label)));
  assert.match(walk(mod.render()).find(n => n.key === 'count').text, /2 matches in 1 file/);
  await mod.onEvent(ctx, { action: 'open', rowKey: 'src/a.ts', inputs: {} });
  assert.ok(calls.some(c => c.method === 'view.patch' && c.args.patch.previewPath === 'src/a.ts'));
  await mod.onEvent(ctx, { action: 'expand', rowKey: 'src', inputs: {} });
  assert.deepEqual(walk(mod.render()).find(n => n.key === 'files').rows.map(r => r.key), ['src']);
  await mod.onEvent(ctx, { action: 'expand', rowKey: 'src', inputs: {} });
  assert.deepEqual(walk(mod.render()).find(n => n.key === 'files').rows.map(r => r.key), ['src', 'src/a.ts']);
  await mod.onEvent(ctx, { action: 'toggleIgnored', inputs: {} });
  assert.equal(calls.filter(c => c.method === 'list').at(-1).args.hideIgnored, false);
  assert.equal(calls.filter(c => c.method === 'grep').at(-1).args.hideIgnored, false, 'the visible search reruns with ignored files');
  assert.equal(mod.snapshot().showIgnored, true);
});

test('git helpers parse check-ignore, ignored listings and grep output', async () => {
  const G = await load('modules/services/files/src/gitignore.ts');
  const runs = [];
  const reply = { 'check-ignore': { code: 0, stdout: 'build/\0.env\0' }, 'ls-files': { code: 0, stdout: 'node_modules/\0dist/\0.env\0' },
    grep: { code: 0, stdout: 'src/a.ts\x003\x00  const x = 1\nREADME.md\x0010\x00x marks\n' } };
  const ctx = { host: { capabilities: { async request() { return { grant: 'g' }; } }, process: { async run(_g, req, opts) {
    runs.push({ executable: req.executable, args: req.args, stdin: opts.stdin });
    const sub = req.args.find(a => reply[a]); return { ...reply[sub], stderr: '', truncated: false, signal: null };
  } } } };
  const d = { id: 'w', machineId: 'local', rootAbsolutePath: '/repo', location: 'local' };
  const ignored = await G.ignoredAmong(ctx, d, [{ relativePath: 'build', kind: 'dir' }, { relativePath: '.env', kind: 'file' }, { relativePath: 'src', kind: 'dir' }, { relativePath: '.git', kind: 'dir' }]);
  assert.deepEqual([...ignored].sort(), ['.env', '.git', 'build']);
  assert.equal(runs[0].stdin, 'build/\0.env\0src/\0', 'directories are queried with a trailing slash');
  const set = await G.ignoredSet(ctx, d);
  assert.ok(G.isIgnored(set, 'node_modules/react/index.js') && G.isIgnored(set, 'dist') && G.isIgnored(set, '.env') && !G.isIgnored(set, 'src/a.ts'));
  const r = await G.grepFiles(ctx, d, 'x', false);
  assert.deepEqual(r.files, [{ relativePath: 'src/a.ts', matches: [{ line: 3, text: 'const x = 1' }] }, { relativePath: 'README.md', matches: [{ line: 10, text: 'x marks' }] }]);
  assert.ok(!runs.at(-1).args.includes('--no-exclude-standard'));
  await G.grepFiles(ctx, d, 'x', true);
  assert.ok(runs.at(-1).args.includes('--no-exclude-standard'));
});

test('workflow agents are hidden by default behind a toggle next to the filter', async () => {
  const { default: mod } = await load('modules/ui/agents-panel/src/index.ts');
  const ws = { id: 'ws' };
  const agent = (id, extra = {}) => ({ id, name: id, status: 'ready', profile: { name: 'Codex' }, machineId: 'local', workspaceId: 'ws', mcps: [], ...extra });
  const list = [agent('mine'), agent('run', { workflow: { runId: 'r', blockId: 'b' } }), agent('Workflow configurator', { workflow: { configurator: true } })];
  const ctx = { state: { get: k => k === 'workspace.selected' ? ws : k === 'workspace-layout.panels' ? { agents: true } : undefined, watch() {} },
    events: { on() { return () => {}; }, emit() {} }, ui: { invalidate() {} }, log: { warn() {} },
    modules: { async call(_m, method) { return method === 'list' ? list : method === 'catalog' ? { profiles: [], skills: [], agentFiles: [], mcps: [] } : null; } } };
  try {
    await mod.activate(ctx);
    await new Promise(r => setTimeout(r, 50));
    const keys = () => walk(mod.render()).find(n => n.key === 'agents').rows.map(r => r.key);
    assert.deepEqual(walk(mod.render()).find(n => n.key === 'header').children.slice(0, 2).map(n => n.key), ['agent-filter', 'workflow-toggle']);
    assert.deepEqual(keys(), ['mine']);
    assert.match(walk(mod.render()).find(n => n.key === 'count').text, /1 agents · 2 workflow hidden/);
    await mod.onEvent(ctx, { action: 'toggleWorkflow', inputs: {} });
    assert.deepEqual(keys(), ['mine', 'run', 'Workflow configurator']);
    assert.equal(mod.snapshot().showWorkflow, true);
  } finally { mod.deactivate?.(ctx); }
});
