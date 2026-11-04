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
    if (method === 'settings.get') return [];
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
  assert.equal(nodes.find(n => n.key === 'agent').height, 32);
  assert.equal(nodes.find(n => n.key === 'agent').buttonStyle.height, nodes.find(n => n.key === 'cfg-model').style.height);
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
  assert.ok(walk(mod.render()).some(n => n.key === 'mcp-internal' && n.children.some(c => c.type === 'switch')), 'MCP switches live in the composer popover');
  assert.equal(walk(mod.render()).find(n => n.key === 'mcp-picker').type, 'popover');
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
    if (method === 'settings.get') return [];
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
  assert.equal(mod.snapshot().draft, 'Keep my draft');
  assert.deepEqual(mod.snapshot().attachments, [picture]);
  await mod.onEvent(ctx, { action: 'toggleMcpPicker', inputs: {} });
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
  assert.ok(!walk(mod.render()).some(n => n.key === 'skills-toggle'), 'skills moved into the MCP popover');
  await mod.onEvent(ctx, { action: 'toggleMcpPicker', inputs: {} });
  await mod.onEvent(ctx, { action: 'toggleSkills', inputs: {} });
  let picker = walk(mod.render()).find(n => n.key === 'skills-picker');
  assert.deepEqual(picker.children.map(n => n.value), [skills[0].path]);
  assert.equal(picker.scroll, true);
  assert.ok(picker.maxHeight <= 220);
  assert.ok(emitted.includes('ai.skillsRequested'));
  await mod.onEvent(ctx, { action: 'useSkill', value: skills[0].path, inputs: { prompt: 'Review my edits' } });
  assert.equal(mod.snapshot().draft, 'Use the workspace skill at .agents/skills/review/SKILL.md.\nReview my edits');
  selected = { id: 'two' }; watchers['workspace.selected'](selected);
  await mod.onEvent(ctx, { action: 'toggleMcpPicker', inputs: {} });
  await mod.onEvent(ctx, { action: 'toggleSkills', inputs: {} });
  picker = walk(mod.render()).find(n => n.key === 'skills-picker');
  assert.ok(!picker.children.some(n => n.value === skills[0].path));
  assert.match(walk(mod.render()).find(n => n.key === 'skills-h').text, /· 0$/);
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
    if (method === 'settings.get') return [];
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
  const transcriptNode = () => walk(mod.render()).find(n => n.type === 'transcript');
  const transcript = () => { const t = transcriptNode(); return { ...t, messages: t.children.filter(c => c.key !== '__older') }; };
  assert.equal(calls.find(c => c.method === 'view').args.messageLimit, 20);
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
  const transcriptNode = () => walk(mod.render()).find(n => n.type === 'transcript');
  const transcript = () => { const t = transcriptNode(); return { ...t, messages: t.children.filter(c => c.key !== '__older') }; };
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

test('chat composer divider restores workspace size and keeps draft across resizing and reload', async () => {
  const mod = await load('modules/ui/ai/src/index.ts');
  const view = { activeId: 'c', conversations: [{ id: 'c', title: 'Chat' }], profiles: [{ id: 'claude', provider: 'claude', name: 'Claude' }], workspace: { machineId: 'local', root: '/test' }, active: { conversation: { id: 'c', acpProfileId: 'claude' }, messages: [], live: { status: 'ready' } } };
  const stored = new Map([['ws', 0.3], ['other', 0.2]]), watchers = new Map(), saved = [];
  let workspace = { id: 'ws' };
  const ctx = { state: { get: key => key === 'workspace.selected' ? workspace : null, watch: (key, fn) => watchers.set(key, fn) },
    events: { on() {}, emit() {} }, ui: { invalidate() {} }, modules: { async call(_, method, args) {
      if (method === 'view') return view;
      if (method === 'view.get') return { ui: { aiComposerFraction: stored.get(args.workspaceId) } };
      if (method === 'view.patch') { saved.push(args); stored.set(args.workspaceId, args.patch.ui.aiComposerFraction); }
    } } };
  const walk = n => [n, ...(n.children || []).flatMap(walk)];
  const split = () => walk(mod.render()).find(n => n.key === 'chat-composer-split');
  await mod.activate(ctx);
  assert.deepEqual(split().sizes, [0.7, 0.3]);
  assert.equal(split().resizeAction, 'resizeComposer');
  const input = walk(mod.render()).find(n => n.key === 'prompt');
  assert.equal(input.fillHeight, true);
  await mod.onEvent(ctx, { action: 'draftChanged', value: 'Keep my draft', inputs: {} });
  await mod.onEvent(ctx, { action: 'resizeComposer', value: { sizes: [0.6, 0.4] }, inputs: {} });
  assert.deepEqual(split().sizes, [0.6, 0.4]);
  assert.equal(walk(mod.render()).find(n => n.key === 'prompt').value, 'Keep my draft');
  assert.equal(saved.at(-1).patch.ui.aiComposerFraction, 0.4);
  const snapshot = mod.snapshot(); mod.deactivate();
  await mod.activate(ctx, snapshot);
  assert.equal(split().sizes[1], 0.4);
  workspace = { id: 'other' }; watchers.get('workspace.selected')(workspace);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(split().sizes[1], 0.2);
  const count = saved.length;
  await mod.onEvent(ctx, { action: 'resizeComposer', value: { sizes: [NaN, 1] }, inputs: {} });
  assert.equal(saved.length, count);
  mod.deactivate();
});

test('new chats copy active settings and live defaults without session identity', async () => {
  const mod = await load('modules/services/ai-sessions/src/index.ts');
  const previous = { id: 'old', workspaceId: 'ws', acpProfileId: 'codex', approvalPolicy: 'autopilot', mcpSelection: [], config: { reasoning: 'high' }, providerSessionId: 'private-session' };
  let inserted;
  const ctx = { modules: { async call(_, method, args) {
    if (method === 'resolve') return { id: 'ws', machineId: 'local' };
    if (method === 'profiles') return [{ id: 'codex' }, { id: 'claude' }];
    if (method === 'conversations.list') return [previous];
    if (method === 'view.get') return { activeConversationId: 'old', ui: { lastAcpProfileId: 'claude' } };
    if (method === 'conversations.get') return args.id === 'old' ? previous : inserted;
    if (method === 'messages.list') return [];
    if (method === 'state') return { status: 'ready', configOptions: [{ id: 'model', currentValue: 'best' }, { id: 'reasoning', currentValue: 'medium' }] };
    if (method === 'authSettings') return {};
    if (method === 'conversations.insert') { inserted = args.conversation; return; }
    if (method === 'view.patch') return;
    if (method === 'settings.get') return [];
    throw new Error(method);
  } } };
  await mod.methods.view(ctx, { workspaceId: 'ws' });
  await mod.methods.create(ctx, { workspaceId: 'ws' });
  assert.equal(inserted.acpProfileId, 'codex');
  assert.equal(inserted.approvalPolicy, 'autopilot');
  assert.deepEqual(inserted.mcpSelection, []);
  assert.deepEqual(inserted.config, { reasoning: 'medium', model: 'best' });
  assert.equal(inserted.providerSessionId, undefined);
  assert.notEqual(inserted.id, previous.id);
  await mod.methods.create(ctx, { workspaceId: 'ws', profileId: 'claude' });
  assert.deepEqual(inserted.config, {});
});

test('sessions search and both chat popovers use an opaque semantic background', async () => {
  const mod = await load('modules/ui/ai/src/index.ts');
  const view = { activeId: 'one', profiles: [{ id: 'codex', name: 'Codex' }], conversations: [{ id: 'one', title: 'Fix login', acpProfileId: 'codex' }, { id: 'two', title: 'Polish UI' }], workspace: { name: 'Hato' }, active: { conversation: { id: 'one' }, messages: [], live: { status: 'ready' } } };
  const ctx = { state: { get: () => ({ id: 'ws' }), watch() {} }, events: { on() {}, emit() {} }, ui: { invalidate() {} }, modules: { async call() { return view; } } };
  await mod.activate(ctx);
  const walk = n => [n, ...(n.children || []).flatMap(walk)];
  await mod.onEvent(ctx, { action: 'toggleHistory', inputs: {} });
  await mod.onEvent(ctx, { action: 'searchSessions', value: 'codex', inputs: {} });
  assert.deepEqual(walk(mod.render()).find(n => n.key === 'session-list').children.map(n => n.key), ['one']);
  assert.equal(walk(mod.render()).find(n => n.key === 'one').selected, true);
  for (const [action, key] of [['toggleModels', 'model-picker'], ['toggleMcpPicker', 'mcp-picker']]) {
    await mod.onEvent(ctx, { action, inputs: {} });
    assert.equal(walk(mod.render()).find(n => n.key === key).style.background, 'background');
  }
});

test('chat MCP selections preserve other servers and connect configured transports with OAuth', async () => {
  const mod = await load('modules/services/ai-sessions/src/index.ts');
  const auth = await load('modules/services/mcp-auth/src/index.ts');
  const server = { id: 'remote', name: 'Remote', transport: 'http', url: 'https://example.com/mcp', auth: { type: 'oauth' } };
  const authCtx = { modules: { async call(target, method, args) {
    assert.equal(target, 'persistence');
    assert.equal(method, 'settings.get');
    assert.equal(args.key, 'mcp-auth.tokens.v1');
    return { remote: { resource: server.url, accessToken: 'fresh', expiresAt: Date.now() + 3600000 } };
  } }, state: { set() {} } };
  await auth.activate(authCtx);
  assert.equal(auth.methods.status(authCtx, { servers: [server] }).remote.state, 'signedIn');
  await assert.rejects(auth.methods.authorization(authCtx, { serverId: server.id, url: server.url }, { caller: 'ai' }), /only issued/);
  assert.equal(await auth.methods.authorization(authCtx, { serverId: server.id, url: server.url }, { caller: 'persistent-agents' }), 'Bearer fresh');
  await assert.rejects(auth.methods.authorization(authCtx, { serverId: server.id, url: 'https://other.example/mcp' }, { caller: 'ai-sessions' }), /Sign-in required/);
  let row = { id: 'mcp-chat', workspaceId: 'ws', acpProfileId: 'codex', mcpSelection: ['internal'], config: {} };
  let start;
  const ctx = { modules: { async call(target, method, args) {
    if (method === 'conversations.get') return row;
    if (method === 'messages.list') return [];
    if (method === 'conversations.update') { row = { ...row, ...args.fields }; return; }
    if (method === 'settings.get') return [
      server,
      { id: 'off', name: 'Off', enabled: false },
      { id: 'local', name: 'Local', command: 'node', args: ['server.js'], env: [] },
    ];
    if (method === 'authorization') {
      assert.equal(target, 'mcp-auth');
      return auth.methods.authorization(authCtx, args, { caller: 'ai-sessions' });
    }
    if (method === 'start') { start = args; return { sessionId: 'provider-session', configOptions: [] }; }
    throw new Error(`${target}.${method}`);
  } } };
  await mod.methods.setMcp(ctx, { conversationId: row.id, serverId: 'remote', enabled: true });
  await mod.methods.setMcp(ctx, { conversationId: row.id, serverId: 'local', enabled: true });
  await mod.methods.setMcp(ctx, { conversationId: row.id, internal: false });
  assert.deepEqual(row.mcpSelection, ['remote', 'local']);
  await assert.rejects(mod.methods.setMcp(ctx, { conversationId: row.id, serverId: 'off', enabled: true }), /disabled/);
  await mod.methods.connect(ctx, { conversationId: row.id });
  assert.equal(start.mcp, false);
  assert.deepEqual(start.mcpSelection, ['remote', 'local']);
  assert.deepEqual(start.mcpServers, [
    { type: 'http', name: 'Remote', url: 'https://example.com/mcp', headers: [{ name: 'Authorization', value: 'Bearer fresh' }] },
    { name: 'Local', command: 'node', args: ['server.js'], env: [] },
  ]);
});

test('chat catalog lists enabled configured servers without exposing credentials', async () => {
  const mod = await load('modules/services/ai-sessions/src/index.ts');
  const ctx = { modules: { async call(_, method) {
    if (method === 'resolve') return { id: 'ws' };
    if (method === 'conversations.list' || method === 'profiles') return [];
    if (method === 'view.get' || method === 'authSettings') return {};
    if (method === 'settings.get') return [
      { id: 'remote', name: 'My server', transport: 'http', url: 'https://example.com', auth: { type: 'bearer', token: 'secret' } },
      { id: 'disabled', name: 'Disabled', enabled: false },
    ];
    throw Error(method);
  } } };
  const view = await mod.methods.view(ctx, { workspaceId: 'ws' });
  assert.deepEqual(view.mcpServers.map(m => m.id), ['internal', 'remote']);
  assert.equal(JSON.stringify(view.mcpServers).includes('secret'), false);
});

test('switching providers preserves an active agent and selecting the same provider does nothing', async () => {
  for (const status of ['busy', 'starting']) {
    const mod = await load('modules/services/ai-sessions/src/index.ts');
    const mutations = [];
    const ctx = { modules: { async call(service, method, args) {
      if (method === 'conversations.get') return { id: 'switch', workspaceId: 'ws', acpProfileId: 'codex' };
      if (method === 'messages.list') return [];
      if (method === 'state') return { status };
      mutations.push(method);
      throw new Error(`Unexpected mutation: ${method}`);
    } } };
    await mod.methods.setProfile(ctx, { conversationId: 'switch', profileId: 'codex' });
    await assert.rejects(mod.methods.setProfile(ctx, { conversationId: 'switch', profileId: 'claude' }), /finish or stop/);
    assert.deepEqual(mutations, []);
  }
});

test('ACP reports a crashed turn once and suppresses errors for intentional stops', async () => {
  for (const intentional of [false, true]) {
    const mod = await load('modules/services/acp/src/index.ts');
    let ended;
    const events = [];
    const ctx = { modules: { async call() { return [{ id: 'codex' }, { id: 'claude' }]; } },
      log: { info() {}, warn() {} }, state: { get() {}, set() {}, watch() {} },
      events: { emit: (topic, value) => events.push({ topic, value }) }, host: {
        streams: { async listen(_, options, callback, onEnd) { if (options.channel === 'stdout') ended = onEnd; } },
        process: { async write() {}, async closeStdin() { ended(); }, async terminate() {}, async wait() { return { code: 1 }; } }
      } };
    await mod.activate(ctx, { conns: [{ conversationId: 'exit', sessionId: 's', proc: 'p', status: 'ready', stderrTail: '', nextId: 1, commands: [] }] });
    await mod.methods.prompt(ctx, { conversationId: 'exit', text: 'Continue' });
    if (intentional) await mod.methods.stop(ctx, { conversationId: 'exit' });
    else ended();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(events.filter(e => e.topic === 'acp.turnEnded').length, intentional ? 0 : 1);
    if (!intentional) assert.equal(mod.methods.state(ctx, { conversationId: 'exit' }).status, 'exited');
  }
});
