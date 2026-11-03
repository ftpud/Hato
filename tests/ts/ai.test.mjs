import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as esbuild from 'esbuild';
let moduleLoad = 0;
async function load(entry) {
  const r = await esbuild.build({ entryPoints: [entry], bundle: true, format: 'esm', write: false });
  return (await import('data:text/javascript;base64,' + Buffer.from(r.outputFiles[0].text).toString('base64') + '#' + (++moduleLoad))).default;
}
test('new chats retain the remembered provider and fall back when it is unavailable', async () => {
  const mod = await load('modules/services/ai-sessions/src/index.ts');
  let preferred = 'claude', inserted, patch;
  const ctx = { modules: { async call(_, method, args) {
    if (method === 'resolve') return { id: 'ws', machineId: 'local' };
    if (method === 'profiles') return [{ id: 'codex' }, { id: 'claude' }];
    if (method === 'conversations.list') return [];
    if (method === 'view.get') return { ui: { lastAcpProfileId: preferred } };
    if (method === 'conversations.insert') { inserted = args.conversation; return; }
    if (method === 'view.patch') { patch = args.patch; return; }
    if (method === 'conversations.get') return inserted;
    throw new Error(method);
  } } };
  await mod.methods.create(ctx, { workspaceId: 'ws' });
  assert.equal(inserted.acpProfileId, 'claude');
  assert.equal(patch.ui.lastAcpProfileId, 'claude');
  preferred = 'removed';
  await mod.methods.create(ctx, { workspaceId: 'ws' });
  assert.equal(inserted.acpProfileId, 'codex');
});
test('chat auto-connects once and keeps secondary controls behind the cog', async () => {
  const mod = await load('modules/ui/ai/src/index.ts');
  const calls = [];
  const view = { activeId: 'c', conversations: [{ id: 'c', title: 'Chat 1' }], profiles: [{ id: 'claude', provider: 'claude', name: 'Claude' }], workspace: { machineId: 'local', root: '/test' }, active: { conversation: { id: 'c', acpProfileId: 'claude' }, messages: [], live: null } };
  const ctx = { state: { get: () => ({ id: 'ws' }), watch() {} }, events: { on() {}, emit() {} }, ui: { invalidate() {} }, modules: { async call(_, method) { calls.push(method); if (method === 'view') return view; if (method === 'connect') view.active.live = { status: 'ready' }; } } };
  await mod.activate(ctx);
  assert.equal(calls.filter(x => x === 'connect').length, 1);
  const walk = n => [n, ...(n.children || []).flatMap(walk)];
  let nodes = walk(mod.render());
  const header = nodes.find(n => n.key === 'hdr');
  assert.deepEqual(header.children.slice(0, 3).map(n => n.key), ['provider-field', 'model-field', 'auto']);
  assert.equal(nodes.find(n => n.key === 'agent').label, undefined);
  assert.equal(nodes.find(n => n.key === 'cfg-model').label, undefined);
  assert.equal(header.children[2].type, 'switch');
  assert.ok(!nodes.some(n => n.key === 'policy'));
  await mod.onEvent(ctx, { action: 'toggleSettings', inputs: {} });
  nodes = walk(mod.render());
  assert.ok(nodes.some(n => n.key === 'policy'));
  assert.equal(calls.filter(x => x === 'connect').length, 1);
  assert.ok(!nodes.some(n => n.key === 'transcript'));
  await mod.onEvent(ctx, { action: 'toggleSettings', inputs: {} });
  await mod.onEvent(ctx, { action: 'toggleMcpPicker', inputs: {} });
  assert.ok(walk(mod.render()).some(n => n.key === 'mcp-internal' && n.type === 'toggle'));
  await mod.onEvent(ctx, { action: 'toggleAuto', value: true, inputs: {} });
  assert.ok(calls.includes('setPolicy'));
});

test('steering cancels once, retains follow-ups, and submits them after the active turn ends', async () => {
  const mod = await load('modules/services/ai-sessions/src/index.ts');
  const listeners = {}, prompts = [], stored = [];
  let cancels = 0;
  const ctx = {
    events: { on: (name, fn) => { listeners[name] = fn; }, emit() {} }, state: { set() {}, get() {}, watch() {} },
    log: { warn() {} },
    modules: { async call(service, method, args) {
      if (method === 'conversations.get') return { id: 'steer-c', workspaceId: 'ws', title: 'Existing' };
      if (method === 'messages.list') return [];
      if (method === 'state') return { status: 'busy' };
      if (method === 'messages.upsert') { stored.push(args); return; }
      if (method === 'cancel') { cancels++; return; }
      if (method === 'prompt') { prompts.push(args.text); return; }
      throw new Error(service + ':' + method);
    } }
  };
  await mod.activate(ctx);
  assert.deepEqual(await mod.methods.send(ctx, { conversationId: 'steer-c', text: 'Use blue' }), { accepted: true, steering: true });
  await mod.methods.send(ctx, { conversationId: 'steer-c', text: 'And larger text' });
  assert.equal(cancels, 1);
  assert.deepEqual(prompts, []);
  assert.equal(mod.canSwap().ok, false);
  listeners['acp.status']({ conversationId: 'steer-c', status: 'ready' });
  await listeners['acp.turnEnded']({ conversationId: 'steer-c', stopReason: 'cancelled' });
  assert.deepEqual(prompts, ['Use blue\n\nAnd larger text']);
  assert.equal(stored.filter(m => m.kind === 'user').length, 2);
  await mod.methods.send(ctx, { conversationId: 'steer-c', text: 'Never mind' });
  await mod.methods.cancel(ctx, { conversationId: 'steer-c' });
  listeners['acp.status']({ conversationId: 'steer-c', status: 'ready' });
  await listeners['acp.turnEnded']({ conversationId: 'steer-c', stopReason: 'cancelled' });
  assert.equal(prompts.length, 1);
  assert.equal(mod.canSwap().ok, true);
});

test('pictures can be attached, removed, sent without text and retained on send failure', async () => {
  const mod = await load('modules/ui/ai/src/index.ts');
  const picture = { name: 'test.png', mimeType: 'image/png', data: 'iVBORw0KGgo=' };
  const view = { activeId: 'img-c', conversations: [], profiles: [], workspace: {}, active: { conversation: { id: 'img-c' }, messages: [], live: { status: 'ready' } } };
  let fail = true, sent;
  const ctx = { state: { get: () => ({ id: 'ws' }), watch() {} }, events: { on() {}, emit() {} }, ui: { invalidate() {} }, modules: { async call(_, method, args) {
    if (method === 'view') return view;
    if (method === 'send') { sent = args; if (fail) throw new Error('Send failed'); return { accepted: true }; }
  } } };
  await mod.activate(ctx);
  await mod.onEvent(ctx, { action: 'attachImages', value: [picture], inputs: {} });
  assert.deepEqual(mod.snapshot().attachments, [picture]);
  await mod.onEvent(ctx, { action: 'removeImage', value: 0, inputs: {} });
  assert.deepEqual(mod.snapshot().attachments, []);
  await mod.onEvent(ctx, { action: 'attachImages', value: [picture], inputs: {} });
  await mod.onEvent(ctx, { action: 'send', inputs: { prompt: '' } });
  assert.deepEqual(mod.snapshot().attachments, [picture]);
  fail = false;
  await mod.onEvent(ctx, { action: 'send', inputs: { prompt: '' } });
  assert.deepEqual(sent.images, [picture]);
  assert.deepEqual(mod.snapshot().attachments, []);
});

test('image-only prompts are persisted and passed to ACP, including steering', async () => {
  const mod = await load('modules/services/ai-sessions/src/index.ts');
  const picture = { name: 'test.png', mimeType: 'image/png', data: 'iVBORw0KGgo=' };
  const listeners = {}, prompts = [], stored = [];
  let support = true;
  const ctx = { events: { on: (name, fn) => { listeners[name] = fn; }, emit() {} }, state: { set() {}, get() {}, watch() {} }, log: { warn() {} }, modules: { async call(_, method, args) {
    if (method === 'conversations.get') return { id: args.id, title: 'Existing' };
    if (method === 'messages.list') return [];
    if (method === 'state') return { status: 'ready', agentCapabilities: { promptCapabilities: { image: support } } };
    if (method === 'messages.upsert') { stored.push(args); return; }
    if (method === 'prompt') { prompts.push(args); return; }
    if (method === 'cancel') return;
    throw new Error(method);
  } } };
  await mod.activate(ctx);
  await mod.methods.send(ctx, { conversationId: 'pictures', text: '', images: [picture] });
  assert.deepEqual(prompts[0].images, [picture]);
  assert.deepEqual(stored[0].payload.images, [picture]);
  await mod.methods.send(ctx, { conversationId: 'pictures', text: 'look here', images: [picture] });
  await listeners['acp.turnEnded']({ conversationId: 'pictures' });
  assert.deepEqual(prompts[1].images, [picture]);
  support = false;
  await assert.rejects(mod.methods.send(ctx, { conversationId: 'unsupported', images: [picture] }), /does not support image/);
  assert.equal(prompts.length, 2);
});

test('model picker searches advertised metadata, selects the right config and preserves draft attachments', async () => {
  const mod = await load('modules/ui/ai/src/index.ts');
  const picture = { name: 'image.png', mimeType: 'image/png', data: 'iVBORw0KGgo=' };
  const configOptions = [{ id: 'agent-model', category: 'model', type: 'select', currentValue: 'one', options: [{ value: 'one', name: 'First model', description: 'Fast tasks' }, { value: 'two', name: 'Second model', description: 'Deep reasoning' }] }];
  const view = { profiles: [{ id: 'provider', name: 'Codex ACP' }], conversations: [], workspace: {}, active: { conversation: { id: 'picker', acpProfileId: 'provider' }, live: { status: 'ready', configOptions }, messages: [] } };
  let selected;
  const ctx = { state: { get: () => ({ id: 'ws' }), watch() {} }, events: { on() {}, emit() {} }, ui: { invalidate() {} }, modules: { async call(_, method, args) {
    if (method === 'view') return view;
    if (method === 'setConfig') { selected = args; configOptions[0].currentValue = args.value; }
  } } };
  const walk = n => [n, ...(n.children || []).flatMap(walk)];
  await mod.activate(ctx, { draft: 'Keep my draft', attachments: [picture] });
  await mod.onEvent(ctx, { action: 'toggleModels', inputs: {} });
  await mod.onEvent(ctx, { action: 'searchModels', value: 'deep', inputs: {} });
  const results = walk(mod.render()).find(n => n.key === 'results');
  assert.deepEqual(results.children.map(n => n.key), ['two']);
  await mod.onEvent(ctx, { action: 'chooseModel', value: 'two', inputs: {} });
  assert.deepEqual(selected, { conversationId: 'picker', configId: 'agent-model', value: 'two' });
  assert.ok(!walk(mod.render()).some(n => n.key === 'model-picker'));
  assert.deepEqual(mod.snapshot(), { draft: 'Keep my draft', attachments: [picture] });
  await mod.onEvent(ctx, { action: 'toggleSkills', inputs: {} });
  assert.ok(walk(mod.render()).some(n => n.key === 'skills-picker'));
});

test('Skills lists only active workspace files and invokes the explicit workspace path', async () => {
  const mod = await load('modules/ui/ai/src/index.ts');
  const skills = [{ name: 'Review changes', description: 'Review this workspace', path: '.agents/skills/review/SKILL.md' }];
  let selected = { id: 'one' };
  let skillState = { workspaceId: 'one', skills };
  const watchers = {}, emitted = [];
  const view = { profiles: [], conversations: [], workspace: {}, active: { conversation: { id: 'skills' }, messages: [], live: { status: 'ready', commands: [{ name: 'global-command' }] } } };
  const ctx = { state: { get: key => key === 'files.skills' ? skillState : selected, watch: (key, fn) => { watchers[key] = fn; } }, events: { on() {}, emit: (topic) => emitted.push(topic) }, ui: { invalidate() {} }, modules: { async call() { return view; } } };
  const walk = n => [n, ...(n.children || []).flatMap(walk)];
  await mod.activate(ctx);
  await mod.onEvent(ctx, { action: 'toggleSkills', inputs: {} });
  let picker = walk(mod.render()).find(n => n.key === 'skills-picker');
  assert.deepEqual(picker.children.map(n => n.value), [skills[0].path]);
  assert.equal(picker.scroll, true);
  assert.ok(picker.maxHeight <= 220);
  assert.ok(emitted.includes('ai.skillsRequested'));
  await mod.onEvent(ctx, { action: 'useSkill', value: skills[0].path, inputs: { prompt: 'Review my edits' } });
  assert.equal(mod.snapshot().draft, 'Use the workspace skill at .agents/skills/review/SKILL.md.\nReview my edits');
  selected = { id: 'two' }; watchers['workspace.selected'](selected);
  await mod.onEvent(ctx, { action: 'toggleSkills', inputs: {} });
  picker = walk(mod.render()).find(n => n.key === 'skills-picker');
  assert.ok(!picker.children.some(n => n.value === skills[0].path));
  assert.equal(walk(mod.render()).find(n => n.key === 'skills-toggle').text, 'Skills 0');
});

test('existing history projects embedded image data as a preview and replayed image blocks stay out of text', async () => {
  const mod = await load('modules/services/ai-sessions/src/index.ts');
  const data = '/9j/' + 'ABCD'.repeat(200);
  const listeners = {};
  const ctx = { events: { on: (topic, fn) => { listeners[topic] = fn; }, emit() {} }, state: { set() {}, get() {}, watch() {} }, modules: { async call(_, method) {
    if (method === 'resolve') return { id: 'ws', machineId: 'local' };
    if (method === 'conversations.list') return [{ id: 'history', title: 'History' }];
    if (method === 'view.get') return { activeConversationId: 'history' };
    if (method === 'profiles') return [];
    if (method === 'conversations.get') return { id: 'history' };
    if (method === 'messages.list') return [{ id: 'old', kind: 'user', payload: { text: `Look at this\n![Picture](data:image/jpeg;base64,${data})` } }];
    if (method === 'state') return { status: 'ready' };
    if (method === 'authSettings') return {};
    if (method === 'messages.upsert') return;
    throw new Error(method);
  } } };
  await mod.activate(ctx);
  let result = await mod.methods.view(ctx, { workspaceId: 'ws' });
  assert.equal(result.active.messages[0].text, 'Look at this');
  assert.equal(result.active.messages[0].images[0].data, data);
  listeners['acp.update']({ conversationId: 'history', update: { sessionUpdate: 'user_message_chunk', content: { type: 'image', mimeType: 'image/jpeg', data } } });
  result = await mod.methods.view(ctx, { workspaceId: 'ws' });
  assert.equal(result.active.messages[1].text, '');
  assert.equal(result.active.messages[1].images[0].data, data);
});

test('chat renders at most 20 cards, pages older messages and returns to latest without deleting history', async () => {
  const mod = await load('modules/ui/ai/src/index.ts');
  const messages = Array.from({ length: 200 }, (_, i) => ({ key: 'm' + (i + 1), role: 'user', text: 'Message ' + (i + 1) }));
  const view = { activeId: 'c', conversations: [{ id: 'c', title: 'Chat' }], profiles: [{ id: 'codex', name: 'Codex', provider: 'codex' }], workspace: { id: 'ws', machineId: 'local', root: '/test' },
    active: { conversation: { id: 'c', acpProfileId: 'codex' }, messages, hasOlder: false, live: { status: 'ready' } } };
  const calls = [];
  const ctx = { state: { get: () => ({ id: 'ws' }), watch() {} }, events: { on() {}, emit() {} }, ui: { invalidate() {} }, modules: { async call(_, method, args) { calls.push({ method, args }); if (method === 'view') return view; throw new Error(method); } } };
  await mod.activate(ctx);
  const walk = n => [n, ...(n.children || []).flatMap(walk)];
  const transcript = () => walk(mod.render()).find(n => n.type === 'chatTranscript');
  assert.equal(calls[0].args.messageLimit, 20);
  assert.equal(transcript().messages.length, 20);
  assert.equal(transcript().messages[0].key, 'm181');
  assert.equal(transcript().loadOlderAction, 'revealOlder');
  await mod.onEvent(ctx, { action: 'olderMessages', inputs: {} });
  assert.equal(transcript().messages.length, 20);
  assert.equal(transcript().messages[0].key, 'm161');
  messages.push({ key: 'm201', role: 'assistant', text: 'Live reply' });
  await mod.onEvent(ctx, { action: 'olderMessages', inputs: {} });
  assert.equal(transcript().messages[0].key, 'm141');
  await mod.onEvent(ctx, { action: 'newerMessages', inputs: {} });
  assert.equal(transcript().messages[0].key, 'm161');
  await mod.onEvent(ctx, { action: 'latestMessages', inputs: {} });
  assert.equal(transcript().messages.length, 20);
  assert.equal(transcript().messages.at(-1).key, 'm201');
  assert.equal(messages.length, 201);
});

test('scroll history grows in batches, stays bounded to 60 and collapses to 20 at the latest end', async () => {
  const mod = await load('modules/ui/ai/src/index.ts');
  const messages = Array.from({ length: 200 }, (_, i) => ({ key: 'm' + (i + 1), role: 'user', text: String(i + 1) }));
  const view = { activeId: 'c', conversations: [], profiles: [{ id: 'codex', name: 'Codex', provider: 'codex' }], workspace: { id: 'ws', machineId: 'local', root: '/test' },
    active: { conversation: { id: 'c', acpProfileId: 'codex' }, messages, hasOlder: false, live: { status: 'ready' } } };
  const ctx = { state: { get: () => ({ id: 'ws' }), watch() {} }, events: { on() {}, emit() {} }, ui: { invalidate() {} }, modules: { async call(_, method) { if (method === 'view') return view; throw new Error(method); } } };
  await mod.activate(ctx);
  const walk = n => [n, ...(n.children || []).flatMap(walk)];
  const transcript = () => walk(mod.render()).find(n => n.type === 'chatTranscript');
  const event = action => mod.onEvent(ctx, { action, inputs: {} });
  await event('revealOlder');
  assert.equal(transcript().messages.length, 40);
  assert.equal(transcript().messages[0].key, 'm161');
  assert.equal(transcript().preserveScrollOnChange, true);
  await event('revealOlder');
  assert.equal(transcript().messages.length, 60);
  await event('revealOlder');
  assert.equal(transcript().messages.length, 60);
  assert.equal(transcript().messages[0].key, 'm121');
  assert.equal(transcript().messages.at(-1).key, 'm180');
  assert.equal(transcript().bottomAction, 'revealNewer');
  await event('revealOlder');
  assert.equal(transcript().messages[0].key, 'm101');
  await event('revealNewer');
  assert.equal(transcript().messages[0].key, 'm121');
  await event('revealNewer');
  assert.equal(transcript().messages.at(-1).key, 'm200');
  assert.equal(transcript().bottomAction, 'collapseHistory');
  await event('collapseHistory');
  assert.equal(transcript().messages.length, 20);
  assert.equal(transcript().messages[0].key, 'm181');
  assert.equal(transcript().bottomAction, undefined);
  assert.equal(transcript().preserveScrollOnChange, false);
  assert.ok(transcript().scrollReset > 0);
  assert.equal(messages.length, 200);
});
