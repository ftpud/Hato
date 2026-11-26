import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as esbuild from 'esbuild';
import { builtinPlugins } from './plugin-fixture.mjs';
const load = async path => import('data:text/javascript;base64,' + Buffer.from((await esbuild.build({ entryPoints: [path], bundle: true, format: 'esm', write: false })).outputFiles[0].text).toString('base64'));
const { updateSubagents, disconnectSubagents, hasWorkingSubagents, openCodeChildUpdate, trackFinishedSubagents } = await load('sdk/acp-subagents.ts');
const association = (sessionId, state, extra = {}) => ({ sessionUpdate: 'subagent_update', sessionId, ...(state !== undefined ? { state } : {}), ...extra });

test('subagent associations preserve hierarchy, patch metadata and reject foreign or cyclic parents', () => {
  const children = {};
  const send = (parent, update, replay) => updateSubagents(children, 'root', { sessionId: parent, update }, replay);
  assert.equal(send('foreign', association('child', { state: 'running' })), false);
  send('root', association('child', { state: 'running' }, { title: 'Reviewer' }));
  send('child', association('nested', { state: 'requires_action' }));
  assert.equal(send('nested', association('child')), false);
  assert.equal(send('root', association('nested')), false);
  assert.equal(send('root', association('root')), false);
  send('root', association('child', undefined, { title: null, description: 'Check tests' }));
  assert.equal(children.child.title, undefined);
  assert.equal(children.child.state, 'running');
  assert.equal(children.nested.parentId, 'child');
  send('root', association('child', { state: 'idle', stopReason: 'error' }));
  assert.equal(children.child.stopReason, 'error');
  send('root', association('child', { state: 'running' }));
  assert.equal(children.child.stopReason, undefined);
  assert.equal(hasWorkingSubagents(children), true);
  send('root', association('child', null));
  assert.equal(children.child.state, 'unknown');
  send('root', association('child', { state: 'running' }), true);
  assert.equal(children.child.state, 'unknown', 'replayed activity is not live');
  assert.equal(hasWorkingSubagents(disconnectSubagents(children)), false);
  send('root', association('__proto__', { state: 'running' }));
  assert.equal(Object.getPrototypeOf(children), Object.prototype);
  assert.equal(Object.hasOwn(children, '__proto__'), true);
});

test('legacy OpenCode metadata and split child progress markers update the display projection', () => {
  const children = {};
  const send = update => updateSubagents(children, 'root', { sessionId: 'root', update });
  send({ sessionUpdate: 'tool_call', _meta: { 'opencode/child-session': { id: 'child', title: 'Explore', status: 'busy' } } });
  assert.equal(children.child.state, 'running');
  for (const text of ['<!-- hato-pro', 'gress 42 | Reading -->']) updateSubagents(children, 'root', { sessionId: 'child', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } });
  assert.equal(children.child.progress.percent, 42);
  send(association('child', { state: 'idle', stopReason: 'end_turn' }));
  send(association('child', { state: 'running' }));
  assert.equal(children.child.progress, undefined, 'reused workers start with fresh progress');
});

test('OpenCode child_update status events drive child lifecycle and traffic keeps the child tag', () => {
  const children = {};
  const feed = params => { const p = openCodeChildUpdate(params); if (p) updateSubagents(children, 'root', p); return p; };
  const base = { rootSessionId: 'root', childSessionId: 'child', parentSessionId: 'root', depth: 1, title: 'Explore' };
  assert.equal(openCodeChildUpdate({ ...base, rootSessionId: '' }), null);
  feed({ ...base, type: 'status', status: 'created' });
  assert.equal(children.child.state, 'running');
  assert.equal(children.child.title, 'Explore');
  const traffic = feed({ ...base, type: 'update', update: { sessionUpdate: 'tool_call', toolCallId: 'child:t1', title: 'Explore: read' } });
  assert.equal(traffic.sessionId, 'root');
  assert.equal(traffic.update._meta['opencode/child-session'].id, 'child');
  assert.equal(children.child.state, 'running', 'status-less traffic keeps the live state');
  feed({ ...base, type: 'status', status: 'completed' });
  assert.deepEqual([children.child.state, children.child.stopReason], ['idle', 'end_turn']);
  feed({ ...base, type: 'status', status: 'failed', error: {} });
  assert.equal(children.child.stopReason, 'error');
  feed({ ...base, type: 'status', status: 'interrupted' });
  assert.equal(children.child.stopReason, 'cancelled');
  assert.equal(hasWorkingSubagents(children), false);
});

test('desktop ACP routes announced descendants without contaminating the parent transcript or usage', async () => {
  const { default: acp } = await load('Hato-plugins/modules/services/acp/src/index.ts');
  let feed;
  const events = [];
  const ctx = { modules: { call: async () => [] }, log: { info() {}, warn() {} }, state: { set() {} }, events: { emit: (topic, value) => events.push({ topic, value }) }, host: {
    plugins: { list: async () => ({ plugins: builtinPlugins() }) },
    streams: { listen: async (_, opts, cb) => { if (opts.channel === 'stdout') feed = cb; } },
    process: { write: async () => {} },
  } };
  await acp.activate(ctx, { conns: [{ conversationId: 'conversation', sessionId: 'root', proc: 'p', status: 'ready', stderrTail: '', nextId: 1, commands: [], configOptions: null, childSessions: {} }] });
  const send = (sessionId, update) => feed(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update } }) + '\n');
  send('root', association('child', { state: 'running' }, { title: 'Reviewer' }));
  send('child', association('nested', { state: 'running' }));
  send('child', { sessionUpdate: 'usage_update', used: 90, size: 100 });
  send('child', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Child reply' } });
  send('foreign', association('bad', { state: 'running' }));
  send('root', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Parent reply' } });
  const state = acp.methods.state(ctx, { conversationId: 'conversation' });
  assert.deepEqual(Object.keys(state.childSessions), ['child', 'nested']);
  assert.equal(state.usage, null);
  assert.deepEqual(events.filter(e => e.topic === 'acp.update').map(e => e.value.update.content.text), ['Parent reply']);
  assert.equal(acp.canSwap().ok, false, 'working children keep their connection alive');
});

test('roots leaving a working list keep their final child states for a short time', () => {
  const store = new Map();
  const kids = { a: [{ id: 'c', parentId: 'a', state: 'idle', stopReason: 'end_turn' }] };
  assert.equal(trackFinishedSubagents(store, new Set(['a', 'b']), new Set(), id => kids[id], 1000), true);
  assert.deepEqual([...store.keys()], ['a'], 'roots without children are not recorded');
  assert.equal(trackFinishedSubagents(store, new Set(), new Set(), () => undefined, 5000), false);
  trackFinishedSubagents(store, new Set(), new Set(['a']), () => undefined, 6000);
  assert.equal(store.size, 0, 'working again drops it');
  trackFinishedSubagents(store, new Set(['a']), new Set(), id => kids[id], 7000);
  trackFinishedSubagents(store, new Set(), new Set(), () => undefined, 30000);
  assert.equal(store.size, 0, 'expired');
});
