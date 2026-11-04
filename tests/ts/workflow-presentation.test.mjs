import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as esbuild from 'esbuild';
let generation = 0;
const load = async path => {
  const built = await esbuild.build({ entryPoints: [path], bundle: true, format: 'esm', write: false });
  return import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64') + '#' + generation++);
};
const walk = node => [node, ...(node.children || []).flatMap(walk)];
const block = (id, type) => ({ id, type, label: id, prompt: '', position: { x: 0, y: 0 } });

test('Meeting participants retain distinct name colors and left borders across messages', async () => {
  const { blockRunView, participantColor } = await load('modules/ui/workflows-panel/src/runs.ts');
  const room = block('room', 'meeting');
  const run = { id: 'run', definition: { blocks: [block('alice', 'ai'), block('bob', 'chatbox'), room] } };
  const at = new Date().toISOString();
  const state = { blockId: 'room', status: 'idle', runs: 0, log: [], meeting: { messages: [
    { seq: 1, blockId: 'alice', author: 'Alice', text: 'First proposal', at },
    { seq: 2, blockId: 'bob', author: 'Bob', text: 'Reply', at },
    { seq: 3, blockId: 'alice', author: 'Alice', text: 'Second proposal', at },
  ] } };
  const nodes = blockRunView(run, room, state, 'test');
  const transcript = nodes.find(n => n.key.endsWith(':transcript'));
  const [alice, bob, again] = transcript.children;
  assert.equal(alice.style.borderLeft, 3);
  assert.equal(alice.style.borderColor, again.style.borderColor);
  assert.notEqual(alice.style.borderColor, bob.style.borderColor);
  assert.equal(alice.children[0].color, alice.style.borderColor);
  assert.equal(bob.style.borderColor, participantColor(run, 'bob'));
  assert.equal(transcript.scroll, true);
});

test('Chatbox session status supersedes an old completed invocation and exposes permission review', async () => {
  const { blockRunView, blockStatus } = await load('modules/ui/workflows-panel/src/runs.ts');
  const chat = block('chat', 'chatbox'), run = { id: 'run', status: 'succeeded' };
  const state = { blockId: 'chat', status: 'succeeded', runs: 1, log: [], sessionId: 'session', agentActivity: { status: 'busy', text: 'Reading status' } };
  let nodes = blockRunView(run, chat, state, 'test');
  let rendered = nodes.flatMap(walk);
  assert.ok(rendered.some(n => n.text === 'Working'));
  assert.ok(rendered.some(n => n.text === 'Reading status'));
  assert.ok(rendered.some(n => n.type === 'progress'));
  assert.equal(rendered.find(n => n.action === 'chatSend').disabled, true);
  assert.equal(blockStatus(chat, state), 'running');
  state.agentActivity = { status: 'waiting', text: 'Awaiting approval', permissionId: 'permission' };
  rendered = blockRunView(run, chat, state, 'test').flatMap(walk);
  assert.ok(rendered.some(n => n.text === 'Waiting for permission'));
  assert.deepEqual(rendered.find(n => n.action === 'reviewPermission').value, { sessionId: 'session', permissionId: 'permission' });
  state.agentActivity = { status: 'ready', text: 'Ready for a message' };
  rendered = blockRunView(run, chat, state, 'test').flatMap(walk);
  assert.equal(rendered.find(n => n.action === 'chatSend').disabled, false);
  assert.ok(!rendered.some(n => n.type === 'progress'));
});

test('workflow gateway queries the actual Chatbox session while preserving run state and session scope', async () => {
  const mod = (await load('modules/services/workflows/src/index.ts')).default;
  const W = await load('sdk/workflows.ts');
  const run = { id: 'run', projectId: 'project', status: 'succeeded', definition: { blocks: [block('chat', 'chatbox')] }, blocks: [{ blockId: 'chat', sessionId: 'session', status: 'succeeded', log: [] }] };
  let status = 'busy', wrongScope = false, unavailable = false;
  const requests = [];
  const ctx = { modules: { call: async (_id, method) => {
    assert.equal(method, 'resolve'); return { id: 'ws', projectId: 'project', location: 'local', machineId: 'local' };
  } }, host: { daemon: {
    ensure: async () => ({ bin: '/hatod', dir: '/daemon' }),
    request: async (_target, op, args) => {
      if (op === 'plugins.list') return { plugins: ['internal-remote-mcp', 'agent-runner', 'workflow-runner'].map(id => ({ id, active: true })) };
      if (args?.method === 'health') return { version: W.WORKFLOW_RUNNER_VERSION, active: 0, apps: 0, reasoning: true };
      if (args?.target === 'workflow-runner') return structuredClone(run);
      assert.equal(args.target, 'agent-runner'); assert.equal(args.method, 'view'); requests.push(args.args);
      if (unavailable) throw new Error('Disconnected');
      return { session: { workspaceId: wrongScope ? 'other' : 'ws', status, workflow: { runId: 'run', blockId: 'chat' } }, messages: [{ role: 'tool', title: 'Read file', text: '', status: 'in_progress' }], permissions: [], queued: [] };
    },
  } } };
  let detail = await mod.methods.runDetail(ctx, { workspaceId: 'ws', runId: 'run' });
  assert.equal(detail.status, 'succeeded');
  assert.equal(detail.blocks[0].status, 'succeeded');
  assert.equal(detail.blocks[0].agentActivity.status, 'busy');
  assert.match(detail.blocks[0].agentActivity.text, /Read file/);
  assert.equal(detail.blocks[0].agentMessages[0].title, "Read file");
  assert.equal(run.blocks[0].agentActivity, undefined, 'live projection never mutates stored run data');
  status = 'ready';
  detail = await mod.methods.runDetail(ctx, { workspaceId: 'ws', runId: 'run' });
  assert.equal(detail.blocks[0].agentActivity.text, 'Ready for a message');
  const page = await mod.methods.chatHistory(ctx, { workspaceId: 'ws', runId: 'run', blockId: 'chat', before: 100 });
  assert.equal(page.sessionId, 'session');
  assert.equal(requests.at(-1).before, 100);
  assert.equal(requests.at(-1).limit, 40);
  await assert.rejects(mod.methods.chatHistory(ctx, { workspaceId: 'ws', runId: 'run', blockId: 'chat', before: -1 }), /cursor/);
  wrongScope = true;
  await assert.rejects(mod.methods.chatHistory(ctx, { workspaceId: 'ws', runId: 'run', blockId: 'chat', before: 100 }), /another workflow/);
  detail = await mod.methods.runDetail(ctx, { workspaceId: 'ws', runId: 'run' });
  assert.equal(detail.blocks[0].agentActivity.status, 'unavailable');
  assert.ok(!detail.blocks[0].agentActivity.text.includes('Read file'));
  wrongScope = false; unavailable = true;
  detail = await mod.methods.runDetail(ctx, { workspaceId: 'ws', runId: 'run' });
  assert.equal(detail.blocks[0].agentActivity.status, 'unavailable');
  assert.ok(requests.every(r => r.id === 'session' && r.limit === 40));
});

test('completed Chatboxes keep polling live activity and retain drafts while the agent is busy', async t => {
  const mod = (await load('modules/ui/workflows-panel/src/index.ts')).default;
  t.after(() => mod.deactivate());
  const def = { id: 'chatflow', name: 'Chat', blocks: [block('chat', 'chatbox')], edges: [] };
  let status = 'ready', detailCalls = 0, sent = 0;
  const ctx = { events: { on() {} }, state: { get: k => k === 'workspace.selected' ? { id: 'ws' } : { workflows: true }, watch() {} }, ui: { invalidate() {} }, modules: { call: async (_id, method) => {
    if (method === 'catalog') return {};
    if (method === 'list') return [{ id: 'chatflow', name: 'Chat', blocks: 1 }];
    if (method === 'runs') return [{ id: 'run', workflowId: 'chatflow', status: 'succeeded', createdAt: new Date().toISOString() }];
    if (method === 'get') return { definition: def };
    if (method === 'runDetail') {
      detailCalls++;
      return { id: 'run', workflowId: 'chatflow', status: 'succeeded', definition: structuredClone(def), blocks: [{ blockId: 'chat', status: 'succeeded', runs: 1, log: [], sessionId: 'session', agentActivity: { status, text: status === 'busy' ? 'Checking tools' : 'Ready for a message' } }] };
    }
    if (method === 'chat') { sent++; return {}; }
    throw new Error(method);
  } } };
  await mod.activate(ctx);
  await mod.onEvent(ctx, { action: 'previewSelect', key: 'preview:chatflow', value: { key: 'chat' } });
  const before = detailCalls;
  status = 'busy';
  const deadline = Date.now() + 4000;
  while (detailCalls === before && Date.now() < deadline) await new Promise(r => setTimeout(r, 25));
  assert.ok(detailCalls > before, 'completed workflow still refreshes Chatbox session status');
  assert.ok(walk(mod.render()).some(n => n.text === 'Checking tools'));
  const ref = 'chat:run:chat';
  await mod.onEvent(ctx, { action: 'chatText', key: ref, value: 'Keep this draft' });
  await mod.onEvent(ctx, { action: 'chatSend', key: ref, inputs: { [ref]: 'Keep this draft' } });
  assert.equal(sent, 0);
  assert.equal(walk(mod.render()).find(n => n.key === ref).value, 'Keep this draft');
  const canvas = walk(mod.render()).find(n => n.type === 'canvas');
  assert.equal(canvas.items[0].pulse, 'primary', 'preview marks the actual busy session');
});


test('compact preview preserves designer rows and branch arrangement without packing', async () => {
  const { preview } = await load('modules/ui/workflows-panel/src/runs.ts');
  const blocks = [
    { ...block('a', 'ai'), position: { x: -100, y: 200 } },
    { ...block('b', 'ai'), position: { x: 200, y: 200 } },
    { ...block('c', 'meeting'), position: { x: 500, y: 800 } },
  ];
  const def = { blocks, edges: [] };
  const frame = preview('shape', def, undefined, undefined, { maxHeight: 250 });
  const [a, b, c] = frame.children[0].items;
  assert.equal(a.y, b.y, 'same designer row stays aligned');
  const scale = (b.x - a.x) / 300;
  assert.equal(c.y - a.y, 32, 'designer rows have a compact vertical gap even across columns');
  assert.equal((c.x - b.x) / 300, scale, 'columns retain their relative spacing');
  assert.equal(a.height, 24, 'preview blocks remain vertically compact');
  assert.equal(a.width, 120);
  assert.equal(b.x - a.x, 136, 'columns retain compact horizontal spacing');
  assert.ok(frame.height < 100, 'preview keeps its earlier compact height');
  assert.equal(preview('bounded', def, undefined, undefined, { maxHeight: 50 }).height, 50);
  const shifted = preview('shift', { ...def, blocks: blocks.map(b => ({ ...b, position: { x: b.position.x + 2000, y: b.position.y + 3000 } })) }, undefined, undefined, { maxHeight: 250 });
  assert.deepEqual(shifted.children[0].items.map(b => [b.x, b.y]), [a,b,c].map(b => [b.x,b.y]), 'outer empty space is trimmed without rearranging nodes');
  const middle = { ...block('middle', 'ai'), position: { x: 200, y: 500 } };
  const branched = preview('branches', { blocks: [...blocks, middle], edges: [] }, undefined, undefined, { maxHeight: 250 }).children[0].items;
  assert.equal(branched[3].y - branched[0].y, branched[2].y - branched[3].y, 'relative row distances survive compression');
  assert.ok(branched[2].y > branched[3].y, 'lower branch is never packed into an earlier row');
  const single = preview('single', { blocks: [blocks[0]], edges: [] }, undefined, undefined, { maxHeight: 250 });
  assert.ok(single.height < 100, 'small graphs do not reserve an empty tall preview');
});

test('compact connectors use facing sides and short curves, including backward responses', async () => {
  const { preview } = await load('modules/ui/workflows-panel/src/runs.ts');
  const def = { blocks: [
    { ...block('a', 'ai'), position: { x: 0, y: 0 } },
    { ...block('b', 'ai'), position: { x: 300, y: 0 } },
    { ...block('c', 'meeting'), position: { x: 0, y: 180 } },
  ], edges: [
    { id: 'right', from: 'a', to: 'b', type: 'use' },
    { id: 'down', from: 'a', to: 'c', type: 'use' },
    { id: 'left', from: 'b', to: 'a', type: 'follow' },
  ] };
  const run = { id: 'compact-curves', blocks: [], transfers: [{ seq: 1, edgeId: 'down', callId: 'call', phase: 'return', at: new Date().toISOString() }] };
  const edges = preview('curves', def, run, undefined, { maxHeight: 200 }).children[0].edges;
  assert.deepEqual(edges.slice(0,3).map(e => [e.fromSide, e.toSide, e.curveOffset]), [['right', 'left', 8], ['bottom', 'top', 4], ['left', 'right', 8]]);
  const response = edges.find(e => e.key === 'transfer:1');
  assert.deepEqual([response.from, response.to, response.fromSide, response.toSide, response.curveOffset], ['c', 'a', 'top', 'bottom', 4]);
});


test('uneven designer row gaps compress individually instead of inheriting the smallest gap scale', async () => {
  const { preview } = await load('modules/ui/workflows-panel/src/runs.ts');
  const blocks = [0, 24, 400, 900, 1200].map((y, i) => ({ ...block(String(i), 'ai'), position: { x: i * 300, y } }));
  const canvas = preview('uneven', { blocks, edges: [] }, undefined, undefined, { maxHeight: 400 });
  const items = canvas.children[0].items;
  for (let i = 1; i < items.length; i++) {
    assert.ok(items[i].y > items[i - 1].y, 'branches retain their vertical order');
    assert.ok(items[i].y - items[i - 1].y <= 32 + 1e-9, 'no empty vertical band exceeds the compact row step');
  }
  assert.ok(canvas.height < 160, 'irregular row spacing does not inflate the preview');
});


test('Chatbox shows streamed reasoning and tool status in chat with a compact status line', async () => {
  const { blockRunView } = await load('modules/ui/workflows-panel/src/runs.ts');
  const state = { blockId: 'chat', status: 'running', runs: 1, log: [],
    agentActivity: { status: 'busy', text: 'Thinking: first line\n' + 'more detail '.repeat(30) },
    agentMessages: [
      { key: 'u', role: 'user', text: 'Check the project' },
      { key: 'r', role: 'thought', text: 'I will inspect the configuration first.' },
      { key: 't', role: 'tool', title: 'Read config', status: 'in_progress', text: '' },
      { key: 'a', role: 'assistant', text: 'Streaming answer' },
      { key: 's', role: 'system', text: 'Turn ended: complete' },
    ] };
  const nodes = blockRunView({ id: 'run', status: 'running' }, block('chat', 'chatbox'), state, 'test');
  const messages = nodes.find(n => n.key.endsWith(':messages')).children.flatMap(walk);
  assert.ok(messages.some(n => n.text === 'REASONING'));
  assert.ok(messages.some(n => n.text === state.agentMessages[1].text));
  assert.ok(messages.some(n => n.text === 'Read config'));
  assert.ok(messages.some(n => n.text === 'in_progress'));
  assert.ok(messages.some(n => n.text === 'Streaming answer'));
  assert.ok(messages.some(n => n.key === 's' && n.type === 'divider'));
  assert.ok(!messages.some(n => n.text === 'Turn ended: complete'));
  const transcript = nodes.find(n => n.key.endsWith(':messages')).children[0];
  assert.equal(transcript.type, 'transcript');
  assert.equal(transcript.followKey, 'u');
  const status = nodes.find(n => n.key.endsWith(':agent-status')).children.find(n => n.key === 'activity');
  assert.equal(status.wrap, false);
  assert.ok(status.text.length <= 100);
  assert.ok(!status.text.includes('\n'));
});
