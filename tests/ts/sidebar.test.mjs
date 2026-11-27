import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as esbuild from 'esbuild';
import { builtinPlugins, pluginsHost } from './plugin-fixture.mjs';
let generation = 0;
async function load(id, icons) {
  const built = await esbuild.build({ entryPoints: [`Hato-plugins/modules/ui/${id}/src/index.ts`], bundle: true, format: 'esm', write: false, plugins: icons ? [{ name: 'edited-icons', setup(build) { build.onLoad({ filter: /sidebar-icons\.ts$/ }, () => ({ contents: `export const sidebarIcons = ${JSON.stringify(icons)}`, loader: 'ts' })); } }] : [] });
  return (await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64') + '#' + generation++)).default;
}
/** Depth-first search of a rendered Halo rail. */
const find = (node, pred) => { if (!node || typeof node !== 'object') return null; if (pred(node)) return node; for (const c of node.children || []) { const hit = find(c, pred); if (hit) return hit; } return null; };
const all = (node, pred, out = []) => { if (node && typeof node === 'object') { if (pred(node)) out.push(node); for (const c of node.children || []) all(c, pred, out); } return out; };
const rowOf = (tree, id) => find(tree, n => n.key === `row:${id}`);
const panelRows = tree => all(tree, n => typeof n.key === 'string' && n.key.startsWith('row:') && n.action === 'toggle').map(n => n.key.slice(4));
const active = (tree, id) => rowOf(tree, id)?.style?.background === 'selection';
const section = (tree, key) => {
  // Each section renders as `lane:<key>` (plus `lane:<key>:items` when its items scroll on their own).
  const lanes = all(tree, n => n.key === `lane:${key}` || n.key === `lane:${key}:items`);
  return lanes.flatMap(l => l.children).filter(n => n.key.startsWith('row:')).map(n => n.key.slice(4));
};
function stateCtx(extra = {}) {
  const values = new Map(), watches = new Map(), events = new Map();
  return { values, ctx: { host: { env: { info: () => ({ repoRoot: '/runtime', dataDir: '/data' }) }, plugins: pluginsHost() },
    state: { get: key => values.get(key), set(key, value) { values.set(key, value); for (const fn of watches.get(key) || []) fn(value); }, watch(key, fn) { watches.set(key, [...(watches.get(key) || []), fn]); return () => watches.set(key, (watches.get(key) || []).filter(f => f !== fn)); } },
    events: { emitted: [], on(key, fn) { events.set(key, fn); return () => {}; }, emit(key, value) { this.emitted.push([key, value]); events.get(key)?.(value); } },
    modules: { calls: [], async call(target, method, args) { this.calls.push([target, method, args]); if (method === 'list') return []; if (method === 'updates') return { modules: [], available: [], errors: [] }; } },
    ui: { invalidate() {} }, log: { warn() {} }, ...extra } };
}

test('Halo rails toggle layout panels and reflect collapse, hide and restore state', async () => {
  const layout = await load('workspace-layout'), sidebar = await load('sidebar'), left = await load('left-sidebar');
  const { ctx } = stateCtx();
  await layout.activate(ctx, { sidebarButtons: {}, sidebarOrder: {}, panelSharing: {} });
  await sidebar.activate(ctx);
  await left.activate(ctx);
  assert.equal(ctx.state.get('left-sidebar.preferredWidth'), 72, 'collapsed left card (64) plus the outer inset');
  assert.equal(ctx.state.get('sidebar.preferredWidth'), 56, 'collapsed right card (48) plus the outer inset');
  assert.ok(active(left.render(), 'files'));
  ctx.state.set('git-panel.panelBadge.git', 12);
  assert.ok(find(rowOf(left.render(), 'git'), n => n.key === 'badge'), 'collapsed rail shows a badge dot');
  await left.onEvent(ctx, { action: 'expand', value: true });
  assert.equal(ctx.state.get('left-sidebar.preferredWidth'), 248);
  ctx.state.set('projects-panel.rail', { selected: null, projects: [] });
  const projectControl = () => find(find(left.render(), n => n.key === 'head:projects'), n => n.key === 'add');
  assert.equal(projectControl().action, 'toggleProjectPanel');
  assert.match(projectControl().children[0].svg, /m9 6 6 6-6 6/);
  const projectsWereVisible = ctx.state.get('workspace-layout.panels').projects;
  await left.onEvent(ctx, { action: projectControl().action });
  assert.equal(ctx.state.get('workspace-layout.panels').projects, !projectsWereVisible);
  await left.onEvent(ctx, { action: projectControl().action });
  assert.equal(ctx.state.get('workspace-layout.panels').projects, projectsWereVisible);
  assert.equal(find(rowOf(left.render(), 'git'), n => n.key === 'n').text, '12');
  ctx.state.set('git-panel.panelBadge.git', 125);
  assert.equal(find(rowOf(left.render(), 'git'), n => n.key === 'n').text, '99+');
  ctx.state.set('git-panel.panelBadge.git', 0);
  assert.equal(find(rowOf(left.render(), 'git'), n => n.key === 'badge'), null);
  await left.onEvent(ctx, { action: 'toggle', value: 'files' });
  assert.equal(layout.methods.getLayout().collapsed.files, true);
  assert.ok(!active(left.render(), 'files'));
  await left.onEvent(ctx, { action: 'toggle', value: 'files' });
  assert.equal(layout.methods.getLayout().collapsed.files, false);
  assert.ok(find(rowOf(left.render(), 'files'), n => n.key === 'indicator'), 'the indicator follows the panel just opened');
  await layout.onEvent(ctx, { action: 'hide', value: 'files' });
  assert.ok(!active(left.render(), 'files'));
  await left.onEvent(ctx, { action: 'toggle', value: 'files' });
  assert.ok(layout.methods.getLayout().columns.some(c => c.panels.includes('files')));
  await left.onEvent(ctx, { action: 'open', value: 'settings' });
  await new Promise(r => setImmediate(r));
  assert.ok(ctx.modules.calls.some(([target, method]) => target === 'settings' && method === 'open'), 'the machine menu opens Settings through workspace-layout');
  await left.onEvent(ctx, { action: 'open', value: 'layout' });
  assert.ok(JSON.stringify(layout.render()).includes('layout-modal'));
  await left.onEvent(ctx, { action: 'toggle', value: 'ai' });
  assert.ok(!layout.methods.getLayout().collapsed.ai, 'a rail ignores buttons it does not show');
  await sidebar.onEvent(ctx, { action: 'toggle', value: 'ai' });
  assert.equal(layout.methods.getLayout().collapsed.ai, true);
  await sidebar.onEvent(ctx, { action: 'toggle', value: 'ai' });
  assert.equal(layout.methods.getLayout().collapsed.ai, false);
});

test('Editor on the right rail closes and restores its existing panel', async () => {
  const layout = await load('workspace-layout'), sidebar = await load('sidebar');
  const { ctx } = stateCtx();
  const installed = builtinPlugins();
  installed.find(p => p.id === 'viewer').contributes.panels[0].pinned = true;
  ctx.host.plugins = pluginsHost(installed);
  await layout.activate(ctx, { sidebarButtons: { viewer: 'right-top' }, sidebarOrder: {}, panelSharing: {} });
  await sidebar.activate(ctx);
  assert.ok(rowOf(sidebar.render(), 'viewer'));
  if (!ctx.state.get('workspace-layout.panels').viewer) {
    await sidebar.onEvent(ctx, { action: 'toggle', value: 'viewer' });
  }
  assert.equal(ctx.state.get('workspace-layout.panels').viewer, true);
  const originalColumns = layout.methods.getLayout().columns.map(c => [...c.panels]);
  for (let i = 0; i < 2; i++) {
    await sidebar.onEvent(ctx, { action: 'toggle', value: 'viewer' });
    assert.equal(ctx.state.get('workspace-layout.panels').viewer, false);
    assert.equal(layout.methods.getLayout().collapsed.viewer, true);
    await sidebar.onEvent(ctx, { action: 'toggle', value: 'viewer' });
    assert.equal(ctx.state.get('workspace-layout.panels').viewer, true);
    assert.deepEqual(layout.methods.getLayout().columns.map(c => c.panels), originalColumns);
  }
});

test('Workflows expands inline without opening a panel; child selection reveals that workflow', async t => {
  const layout = await load('workspace-layout'), left = await load('left-sidebar'), workflows = await load('workflows-panel');
  const { ctx } = stateCtx();
  const calls = [];
  const summaries = [{ id: 'build', name: 'Build project', blocks: 4 }, { id: 'review', name: 'Review changes', blocks: 3 }];
  const fallback = ctx.modules.call.bind(ctx.modules);
  ctx.modules.call = async (target, method, args) => {
    if (target !== 'workflows') return fallback(target, method, args);
    calls.push(method);
    if (method === 'list') return summaries;
    if (method === 'catalog') return {};
    if (method === 'runs') return [];
    if (method === 'get') return { definition: { id: args.id, name: args.id, blocks: [], edges: [] } };
    throw new Error(method);
  };
  ctx.state.set('workspace.selected', { id: 'ws' });
  await layout.activate(ctx, { sidebarButtons: {}, sidebarOrder: {}, panelSharing: {} });
  await left.activate(ctx);
  await workflows.activate(ctx);
  t.after(() => workflows.deactivate());
  assert.deepEqual(calls, ['list'], 'hidden panel loads only navigation summaries');
  assert.equal(ctx.state.get('workspace-layout.panels').workflows, false);
  await left.onEvent(ctx, { action: rowOf(left.render(), 'workflows').action, value: 'workflows' });
  let tree = left.render();
  assert.equal(ctx.state.get('workspace-layout.panels').workflows, false);
  const children = find(tree, n => n.key === 'children:workflows');
  assert.ok(children, 'a collapsed rail expands to show the workflow list');
  assert.equal(find(children, n => n.key === 'child:library'), null);
  assert.equal(find(children, n => n.key === 'child:workflow:build').children.find(n => n.key === 'label').text, 'Build project');
  assert.equal(find(children, n => n.key === 'child:workflow:build').children.find(n => n.key === 'detail').text, '4');
  await left.onEvent(ctx, { action: 'toggle', value: 'workflows' });
  assert.equal(find(left.render(), n => n.key === 'children:workflows'), null);
  await left.onEvent(ctx, { action: 'toggle', value: 'workflows' });
  await left.onEvent(ctx, { action: 'child', value: { panel: 'workflows', child: 'workflow:review' } });
  await new Promise(r => setImmediate(r));
  assert.equal(ctx.state.get('workspace-layout.panels').workflows, true);
  assert.equal(workflows.snapshot().maximized, 'review');
  assert.ok(!calls.includes('run'), 'navigation never starts a workflow');
  await left.onEvent(ctx, { action: 'child', value: { panel: 'workflows', child: 'workflow:review' } });
  assert.equal(workflows.snapshot().maximized, null);
  assert.equal(ctx.state.get('workspace-layout.panels').workflows, false, 'clicking the selected workflow closes its view');
  assert.ok(find(left.render(), n => n.key === 'children:workflows'), 'the workflow list stays expanded');
  assert.ok(ctx.state.get('workflows-panel.panelChildren.workflows').every(c => !c.selected));
  await left.onEvent(ctx, { action: 'child', value: { panel: 'workflows', child: 'workflow:review' } });
  assert.equal(ctx.state.get('workspace-layout.panels').workflows, true, 'the same workflow can be reopened');
  await left.onEvent(ctx, { action: 'child', value: { panel: 'workflows', child: 'workflow:build' } });
  assert.equal(workflows.snapshot().maximized, 'build', 'another workflow replaces the open view');
  assert.equal(ctx.state.get('workspace-layout.panels').workflows, true);
  ctx.state.set('workspace.selected', null);
  assert.deepEqual(ctx.state.get('workflows-panel.panelChildren.workflows'), []);
  assert.ok(find(rowOf(left.render(), 'workflows'), n => n.key === 'chev'), 'the empty workflow list keeps its disclosure button');
});

test('workflow navigation discards delayed lists after a workspace switch', async t => {
  const workflows = await load('workflows-panel');
  const { ctx } = stateCtx();
  let release;
  ctx.modules.call = async (_target, method, args) => {
    assert.equal(method, 'list');
    if (args.workspaceId === 'old') return new Promise(resolve => { release = resolve; });
    return [{ id: 'current', name: 'Current project workflow', blocks: 2 }];
  };
  ctx.state.set('workspace.selected', { id: 'old' });
  const activation = workflows.activate(ctx);
  t.after(() => workflows.deactivate());
  ctx.state.set('workspace.selected', { id: 'new' });
  await new Promise(r => setImmediate(r));
  release([{ id: 'stale', name: 'Wrong project workflow', blocks: 1 }]);
  await activation;
  assert.deepEqual(ctx.state.get('workflows-panel.panelChildren.workflows').map(c => c.id), ['workflow:current']);
});

test('an empty workflow list offers Create new workflow, which reveals the panel and opens the designer', async t => {
  const layout = await load('workspace-layout'), left = await load('left-sidebar'), workflows = await load('workflows-panel');
  const { ctx } = stateCtx();
  const calls = [];
  let list = [];
  const fallback = ctx.modules.call.bind(ctx.modules);
  ctx.modules.call = async (target, method, args) => {
    if (target !== 'workflows') return fallback(target, method, args);
    calls.push([method, args]);
    if (method === 'list') return list;
    if (method === 'catalog') return { templates: [{ id: 'blank', name: 'Blank' }], profiles: [], mcps: [] };
    if (method === 'runs') return [];
    if (method === 'create') { list = [{ id: 'fresh', name: 'Untitled', blocks: 0 }]; return { id: 'fresh', definition: { id: 'fresh', name: 'Untitled', blocks: [], edges: [] } }; }
    if (method === 'get') return { definition: { id: args.id, name: 'Untitled', blocks: [], edges: [] }, revision: 1, issues: [] };
    throw new Error(method);
  };
  ctx.state.set('workspace.selected', { id: 'ws' });
  await layout.activate(ctx, { sidebarButtons: {}, sidebarOrder: {}, panelSharing: {} });
  await left.activate(ctx);
  await workflows.activate(ctx);
  t.after(() => workflows.deactivate());
  assert.deepEqual(ctx.state.get('workflows-panel.panelChildren.workflows').map(c => [c.id, c.label]), [['create-workflow', 'Create new workflow…']]);
  await left.onEvent(ctx, { action: 'child', value: { panel: 'workflows', child: 'create-workflow' } });
  for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r));
  assert.equal(ctx.state.get('workspace-layout.panels').workflows, true, 'the Workflows panel opens');
  assert.deepEqual(calls.find(([m]) => m === 'create')?.[1]?.templateId, 'blank');
  assert.equal(workflows.snapshot().designerOpen, true, 'the new workflow opens in the designer');
  assert.equal(workflows.snapshot().selectedId, 'fresh');
  assert.deepEqual(ctx.state.get('workflows-panel.panelChildren.workflows').map(c => c.id), ['workflow:fresh'], 'the new workflow replaces the create entry');
});

test('rail drawings are module data and a new module build picks up edited SVGs', async () => {
  const sidebar = await load('sidebar'), left = await load('left-sidebar');
  const { ctx } = stateCtx();
  await sidebar.activate(ctx); await left.activate(ctx);
  // Projects are a section of their own on the left rail, not a panel button.
  const leftRows = panelRows(left.render()), rightRows = panelRows(sidebar.render());
  assert.ok(!leftRows.includes('projects'));
  for (const id of ['files', 'git', 'viewer', 'terminal']) assert.ok(leftRows.includes(id), id);
  assert.ok(leftRows.indexOf('files') < leftRows.indexOf('terminal'), 'top placements before bottom ones');
  for (const id of ['ai', 'agents', 'mcps']) assert.ok(rightRows.includes(id), id);
  assert.ok(!rightRows.some(id => leftRows.includes(id)));
  for (const node of all(left.render(), n => n.type === 'icon')) assert.match(node.svg, /<svg /);
  const changed = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/></svg>';
  const originalGit = find(rowOf(left.render(), 'git'), n => n.type === 'icon').svg;
  const updated = await load('left-sidebar', { files: changed, git: originalGit });
  await updated.activate(ctx);
  assert.equal(find(rowOf(updated.render(), 'files'), n => n.type === 'icon').svg, changed);
  assert.equal(find(rowOf(updated.render(), 'git'), n => n.type === 'icon').svg, originalGit);
});

test('the Workspace rail switches projects and tasks; the Assistant rail lists chats and usage', async () => {
  const sidebar = await load('sidebar'), left = await load('left-sidebar');
  const { ctx } = stateCtx();
  await sidebar.activate(ctx); await left.activate(ctx);
  ctx.state.set('workspace.selected', { id: 'task:t1', name: 'Hato / polish', location: 'local', machineId: 'local' });
  ctx.state.set('projects-panel.rail', { selected: 'task:t1', projects: [
    { id: 'project:a:root', name: 'Hato', kind: 'local', busy: 0, stats: { added: 3, removed: 1 }, tasks: [{ id: 'task:t1', name: 'polish', branch: 'polish', status: 'ready', busy: 1, stats: null }] },
    { id: 'project:b:root', name: 'Site', kind: 'ssh', busy: 0, stats: null, tasks: [] },
  ] });
  await left.onEvent(ctx, { action: 'expand', value: true });
  let tree = left.render();
  assert.ok(active(tree, 'project:project:a:root'), 'the project of the selected task is active');
  assert.equal(find(tree, n => n.key === 'child:task:t1').action, 'workspace');
  assert.ok(find(find(tree, n => n.key === 'child:task:t1'), n => n.type === 'spinner'), 'busy task shows a spinner');
  await left.onEvent(ctx, { action: 'workspace', value: 'project:b:root' });
  assert.deepEqual(ctx.events.emitted.at(-1), ['left-sidebar.selectWorkspace', { workspaceId: 'project:b:root' }], 'rails request by event: they hold no call grants');
  await left.onEvent(ctx, { action: 'query', value: 'site' });
  assert.deepEqual(section(left.render(), 'projects'), ['project:project:b:root']);
  await left.onEvent(ctx, { action: 'expand', value: false });
  tree = left.render();
  assert.deepEqual(section(tree, 'projects'), ['project:project:a:root'], 'collapsed rail keeps only the active project tile');

  ctx.state.set('ai.rail', { workspaceId: 'task:t1', activeId: 'c2', conversations: [{ id: 'c1', title: 'Fix tests', provider: 'Codex', status: 'busy' }, { id: 'c2', title: 'Rail polish', provider: 'Claude', status: 'online' }] });
  ctx.state.set('acp.limits', { claude: { provider: 'claude', windows: [{ id: 'five_hour', label: '5h', usedPercent: 68.4, resetsAt: null }, { id: 'seven_day', label: 'Wk', usedPercent: 22, resetsAt: null }, { id: 'sonnet', label: 'Wk · Sonnet', usedPercent: 5, resetsAt: null }], plan: null, updatedAt: 1, source: 'probe', error: null } });
  let right = sidebar.render();
  assert.deepEqual(all(right, n => n.type === 'ring').map(r => [r.key, r.value]), [['outer', 68.4], ['inner', 22]], 'collapsed usage is a double ring: 5 h outside, weekly inside');
  assert.deepEqual(section(right, 'chats'), [], 'collapsed Assistant rail hides the chat list');
  await sidebar.onEvent(ctx, { action: 'expand', value: true });
  right = sidebar.render();
  assert.deepEqual(all(right, n => n.type === 'meter').map(m => m.value), [68.4, 22], 'expanded usage is a double bar');
  assert.deepEqual(section(right, 'chats'), ['chat:c1', 'chat:c2', 'chats-all']);
  await sidebar.onEvent(ctx, { action: 'chat', value: 'c1' });
  assert.deepEqual(ctx.events.emitted.at(-1), ['sidebar.selectConversation', { id: 'c1' }]);
  assert.equal(ctx.modules.calls.filter(([target]) => target !== 'persistence' && target !== 'module-dev' && target !== 'settings').length, 0);
  ctx.state.set('ai-sessions.busy', { 'task:t1': 1 });
  ctx.state.set('persistent-agents.busy', { 'task:t1': 2 });
  assert.match(JSON.stringify(sidebar.render()), /3 agents working/, 'counts agents, not workspaces');
  assert.doesNotMatch(JSON.stringify(left.render()), /agents working|"spinner".*"busy"/, 'working agents show in one place: the Assistant rail');
  ctx.state.set('persistent-agents.working', [{ id: 's1', name: 'Reviewer', workspaceId: 'project:b:root', status: 'busy', workflow: null }]);
  ctx.state.set('ai-sessions.working', [{ id: 'c1', title: 'Fix tests', workspaceId: 'task:t1', status: 'busy' }]);
  right = sidebar.render();
  const agent = find(right, n => n.key === 'task:working:agent:s1');
  assert.equal(find(agent, n => n.key === 'detail').text, 'Site');
  await sidebar.onEvent(ctx, { action: agent.action, value: agent.value });
  assert.deepEqual(ctx.events.emitted.at(-1), ['sidebar.openAgent', { kind: 'agent', id: 's1', workspaceId: 'project:b:root', workflow: null }]);
  assert.equal(find(find(right, n => n.key === 'task:working:chat:c1'), n => n.key === 'detail').text, 'Hato / polish');

  // Project groups become tabs over the project list.
  ctx.state.set('projects-panel.rail', { ...ctx.state.get('projects-panel.rail'), activeGroup: 'g1', groups: [{ id: 'g1', name: 'Work', projectIds: ['b'] }],
    projects: ctx.state.get('projects-panel.rail').projects.map(p => ({ ...p, projectId: p.id === 'project:b:root' ? 'b' : 'a' })) });
  await left.onEvent(ctx, { action: 'query', value: '' });
  await left.onEvent(ctx, { action: 'expand', value: true });
  tree = left.render();
  assert.deepEqual(all(find(tree, n => n.key === 'tabs:projects'), n => n.key?.startsWith('tab:')).map(n => n.key), ['tab:all', 'tab:g1']);
  assert.deepEqual(section(tree, 'projects'), ['project:project:b:root']);
  await left.onEvent(ctx, { action: 'selectGroup', value: 'all' });
  assert.deepEqual(ctx.events.emitted.at(-1), ['left-sidebar.selectGroup', { id: 'all' }]);
});
