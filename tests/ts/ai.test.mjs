import {builtinPlugins} from "./plugin-fixture.mjs";
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as esbuild from 'esbuild';
function unscoped(n) {
  const copy = { ...n };
  for(const k of Object.keys(copy)) if((k==='action'||k.endsWith('Action'))&&typeof copy[k]==='string')copy[k]=copy[k].replace(/^origin:[^:]+:/,'');
  return copy;
}
async function dispatch(mod,ctx,ev) {
  await mod.onEvent(ctx,ev);
  for(let i=0; i<100 && mod.canSwap?.().ok===false; i++)await new Promise(resolve=>setTimeout(resolve,1));
}
let moduleLoad = 0;
async function load(entry) {
  const r = await esbuild.build({ entryPoints: [entry], bundle: true, format: 'esm', write: false });
  return (await import('data:text/javascript;base64,' + Buffer.from(r.outputFiles[0].text).toString('base64') + '#' + (++moduleLoad))).default;
}
test('new chats retain the remembered provider and fall back when it is unavailable', async () => {
  const mod = await load('Hato-plugins/modules/services/ai-sessions/src/index.ts');
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
  const mod = await load('Hato-plugins/modules/ui/ai/src/index.ts');
  const calls = [];
  const view = { activeId: 'c', conversations: [{ id: 'c', title: 'Chat 1' }], profiles: [{ id: 'claude', provider: 'claude', name: 'Claude' }], workspace: { machineId: 'local', root: '/test' }, active: { conversation: { id: 'c', acpProfileId: 'claude' }, messages: [], live: null } };
  const ctx = { state: { get: () => ({ id: 'ws' }), set() {}, watch() {} }, events: { on() {}, emit() {} }, ui: { invalidate() {} }, modules: { async call(_, method) { calls.push(method); if (method === 'view') return view; if (method === 'connect') view.active.live = { status: 'ready' }; } } };
  await mod.activate(ctx);
  assert.equal(calls.filter(x => x === 'connect').length, 1);
  const walk = n => [unscoped(n), ...(n.children || []).flatMap(walk)];
  let nodes = walk(mod.render());
  assert.equal(nodes.find(n => n.key === 'cfg-model').action, 'toggleModels');
  assert.equal(nodes.find(n => n.key === 'cfg-model').style.height, 32);
  assert.equal(nodes.find(n => n.key === 'auto').type, 'switch');
  assert.ok(!nodes.some(n => n.key === 'policy'));
  await dispatch(mod,ctx, { action: 'toggleSettings', inputs: {} });
  nodes = walk(mod.render());
  assert.ok(nodes.some(n => n.key === 'policy'));
  assert.equal(calls.filter(x => x === 'connect').length, 1);
  assert.ok(!nodes.some(n => n.key === 'transcript'));
  await dispatch(mod,ctx, { action: 'toggleSettings', inputs: {} });
  await dispatch(mod,ctx, { action: 'toggleMcpPicker', inputs: {} });
  assert.ok(walk(mod.render()).some(n => n.key === 'mcp-internal' && walk(n).some(c => c.type === 'switch')), 'MCP switches live in the composer popover');
  assert.equal(walk(mod.render()).find(n => n.key === 'mcp-picker').type, 'popover');
  await dispatch(mod,ctx, { action: 'toggleAuto', value: true, inputs: {} });
  assert.ok(calls.includes('setPolicy'));
});

test('form elicitation renders defaults, validates required input and routes accept, decline and cancel', async () => {
  const mod = await load('Hato-plugins/modules/ui/ai/src/index.ts');
  const listeners = {}, responses = [];
  const view = { profiles: [], conversations: [], workspace: {}, active: { conversation: { id: 'forms' }, messages: [], live: { status: 'busy' } } };
  const ctx = { state: { get: () => ({ id: 'ws' }), set() {}, watch() {} }, events: { on: (name, fn) => { listeners[name] = fn; }, emit() {} }, ui: { invalidate() {} }, modules: { async call(_, method, args) {
    if (method === 'view') return view;
    if (method === 'respondElicitation') { responses.push(args); return null; }
    throw new Error(method);
  } } };
  const walk = n => [unscoped(n), ...(n.children || []).flatMap(walk)];
  const schema = { type: 'object', required: ['name', 'strategy'], properties: {
    name: { type: 'string', default: 'Ada', minLength: 2 }, strategy: { type: 'string', enum: ['safe', 'fast'] },
    count: { type: 'integer', default: 2, minimum: 1 }, notify: { type: 'boolean', default: true },
    tags: { type: 'array', items: { enum: ['one', 'two'] }, default: ['one'] },
  } };
  const request = id => listeners['acp.elicitation']({ conversationId: 'forms', requestId: id, request: { mode: 'form', message: 'Choose options', requestedSchema: schema } });
  await mod.activate(ctx);
  request(10);
  let nodes = walk(mod.render());
  const fields = nodes.find(n => n.key === 'elicitation-fields').children;
  const name = fields[0].children.find(n => n.type === 'textInput');
  const strategy = fields[1].children.find(n => n.type === 'select');
  const count = fields[2].children.find(n => n.type === 'textInput');
  const notify = fields[3].children.find(n => n.type === 'toggle');
  const accept = nodes.find(n => n.key === 'accept');
  assert.equal(name.value, 'Ada');
  assert.equal(count.value, '2');
  assert.equal(notify.checked, true);
  await dispatch(mod,ctx, { action: strategy.action, value: 'safe', inputs: {} });
  await dispatch(mod,ctx, { action: accept.action, inputs: { [name.key]: '', [count.key]: '3' } });
  assert.equal(responses.length, 0);
  assert.ok(walk(mod.render()).some(n => n.key === 'error' && /required/.test(n.text)));
  await dispatch(mod,ctx, { action: accept.action, inputs: { [name.key]: 'Ada', [count.key]: '3' } });
  assert.deepEqual(responses[0], { conversationId: 'forms', requestId: 10, response: { action: 'accept', content: { name: 'Ada', strategy: 'safe', count: 3, notify: true, tags: ['one'] } } });
  request(11);
  await dispatch(mod,ctx, { action: walk(mod.render()).find(n => n.key === 'decline').action, inputs: {} });
  assert.equal(responses.at(-1).response.action, 'decline');
  request(12);
  await dispatch(mod,ctx, { action: walk(mod.render()).find(n => n.key === 'cancel' && n.action?.startsWith('cancelElicitation:')).action, inputs: {} });
  assert.equal(responses.at(-1).response.action, 'cancel');
});

test('composer autocomplete shows ACP command hints and submits slash arguments as a normal prompt', async () => {
  const mod = await load('Hato-plugins/modules/ui/ai/src/index.ts');
  const sent = [];
  const view = { profiles: [], conversations: [], workspace: {}, active: { conversation: { id: 'commands' }, messages: [], live: { status: 'ready', commands: [{ name: 'review', description: 'Review changes', input: { hint: 'path or focus' } }] } } };
  const ctx = { state: { get: () => ({ id: 'ws' }), set() {}, watch() {} }, events: { on() {}, emit() {} }, ui: { invalidate() {} }, modules: { async call(_, method, args) {
    if (method === 'view') return view;
    if (method === 'send') { sent.push(args); return { accepted: true }; }
    throw new Error(method);
  } } };
  const walk = n => [unscoped(n), ...(n.children || []).flatMap(walk)];
  await mod.activate(ctx);
  await dispatch(mod,ctx, { action: 'draftChanged', value: '/re', inputs: {} });
  const tree = walk(mod.render());
  const popup = tree.find(n => n.key === 'slash-commands');
  // Pinned over the transcript, above the composer. Not a popover: popovers take keyboard focus
  // from the composer as they open. An explicit height keeps the list scrollable.
  assert.equal(popup.type, 'column'); assert.equal(popup.scroll, true); assert.ok(popup.height > 0);
  assert.equal(popup.style.position, 'absolute');
  assert.ok(!tree.some(n => n.type === 'popover' && walk(n).some(c => c.key === 'slash-commands')));
  assert.ok(tree.find(n => n.key === 'transcript-pane').children.some(n => n.key === 'slash-commands'));
  assert.ok(!walk(tree.find(n => n.key === 'composer')).some(n => n.key === 'slash-commands'));
  const suggestion = popup.children[0];
  assert.equal(suggestion.text, '/review');
  assert.match(suggestion.description, /Review changes.*path or focus/);
  await dispatch(mod,ctx, { action: 'chooseCommand', value: 'review', inputs: { prompt: '/re' } });
  assert.equal(mod.snapshot().draft, '/review ');
  await dispatch(mod,ctx, { action: 'send', inputs: { prompt: '/review src/parser.ts' } });
  assert.equal(sent[0].text, '/review src/parser.ts');
});

test('provider Sessions UI pages opaque cursors and routes lifecycle actions', async () => {
  const mod = await load('Hato-plugins/modules/ui/ai/src/index.ts');
  const calls = [];
  const live = { status: 'ready', sessionId: 's-current', agentCapabilities: { loadSession: true, sessionCapabilities: { list: {}, resume: {}, fork: {}, close: {}, delete: {} } } };
  const view = { profiles: [{ id: 'provider', name: 'Codex' }], conversations: [], workspace: { machineId: 'local', root: '/test' }, active: { conversation: { id: 'provider-ui', acpProfileId: 'provider' }, messages: [{ key: 'local', role: 'user', text: 'Local history' }], live } };
  const ctx = { state: { get: () => ({ id: 'ws' }), set() {}, watch() {} }, events: { on() {}, emit() {} }, ui: { invalidate() {} }, modules: { async call(_, method, args) {
    calls.push({ method, args });
    if (method === 'view') return view;
    if (method === 'providerSessions') return args.cursor ? { sessions: [{ sessionId: 's-third', title: 'Third' }], nextCursor: null } : { sessions: [{ sessionId: 's-current', title: 'Current' }, { sessionId: 's-new', title: 'New' }], nextCursor: 'opaque' };
    if (['newProviderSession', 'resumeProviderSession', 'loadProviderSession', 'forkProviderSession', 'closeProviderSession', 'deleteProviderSession'].includes(method)) return { ...live, sessionId: args.sessionId || 's-fresh' };
    throw new Error(method);
  } } };
  const walk = n => [unscoped(n), ...(n.children || []).flatMap(walk)];
  await mod.activate(ctx);
  await dispatch(mod,ctx, { action: 'toggleSettings', inputs: {} });
  await dispatch(mod,ctx, { action: 'openProviderSessions', inputs: {} });
  assert.equal(calls.find(c => c.method === 'providerSessions').args.cursor, undefined);
  let nodes = walk(mod.render());
  assert.equal(nodes.find(n => n.key === 'provider-sessions-modal').type, 'modal');
  assert.ok(nodes.some(n => n.action === 'resumeProviderSession' && n.value?.sessionId === 's-new'));
  await dispatch(mod,ctx, { action: 'moreProviderSessions', inputs: {} });
  assert.equal(calls.filter(c => c.method === 'providerSessions').at(-1).args.cursor, 'opaque');
  nodes = walk(mod.render());
  assert.ok(nodes.some(n => n.key === 's-third'));
  await dispatch(mod,ctx, { action: 'resumeProviderSession', value: nodes.find(n => n.action === 'resumeProviderSession' && n.value?.sessionId === 's-new').value, inputs: {} });
  assert.deepEqual(calls.find(c => c.method === 'resumeProviderSession').args, { conversationId: 'provider-ui', sessionId: 's-new' });
  assert.equal(view.active.messages[0].text, 'Local history');
});

test('AI panel renders advertised authentication and routes terminal output, input and cancel', async () => {
  const mod = await load('Hato-plugins/modules/ui/ai/src/index.ts');
  const listeners = {}, calls = [];
  const view = { activeId: 'auth-ui', profiles: [{ id: 'provider', name: 'Codex' }], conversations: [], workspace: { machineId: 'local', root: '/test' }, active: { conversation: { id: 'auth-ui', acpProfileId: 'provider' }, messages: [], live: { status: 'ready', authMethods: [{ id: 'login', name: 'Log in', type: 'terminal', description: 'Device login' }], authProcess: null } } };
  const ctx = { state: { get: () => ({ id: 'ws' }), set() {}, watch() {} }, events: { on: (name, fn) => { listeners[name] = fn; }, emit() {} }, ui: { invalidate() {} }, modules: { async call(_, method, args) {
    calls.push({ method, args });
    if (method === 'view') return view;
    if (method === 'authenticate') return { outcome: 'terminal', label: 'Log in', display: 'codex auth login', envKeys: ['AUTH_MODE'], command: 'codex', args: ['auth', 'login'] };
    if (['authInput', 'cancelAuth'].includes(method)) return null;
    throw new Error(method);
  } } };
  const walk = n => [unscoped(n), ...(n.children || []).flatMap(walk)];
  await mod.activate(ctx);
  await dispatch(mod,ctx, { action: 'toggleSettings', inputs: {} });
  assert.ok(walk(mod.render()).some(n => n.action === 'authenticate:login'));
  await dispatch(mod,ctx, { action: 'authenticate:login', inputs: {} });
  assert.equal(calls.find(c => c.method === 'authenticate').args.methodId, 'login');
  let nodes = walk(mod.render());
  assert.equal(nodes.find(n => n.key === 'auth-command').text, 'codex auth login');
  assert.match(nodes.find(n => n.key === 'auth-env').text, /values hidden/);
  listeners['acp.authOutput']({ conversationId: 'auth-ui', methodId: 'login', channel: 'stdout', data: 'Open this URL\n' });
  nodes = walk(mod.render());
  assert.match(nodes.find(n => n.key === 'auth-output-text').text, /Open this URL/);
  const input = nodes.find(n => n.submitAction === 'authInput');
  assert.equal(input.secret, true);
  await dispatch(mod,ctx, { action: input.submitAction, inputs: { [input.key]: 'choice' } });
  assert.equal(calls.find(c => c.method === 'authInput').args.data, 'choice\n');
  await dispatch(mod,ctx, { action: 'cancelAuth', inputs: {} });
  assert.ok(calls.some(c => c.method === 'cancelAuth'));
  assert.ok(walk(mod.render()).some(n => n.key === 'auth-cancelled'));
});

test('steering cancels once, retains follow-ups, and submits them after the active turn ends', async () => {
  const mod = await load('Hato-plugins/modules/services/ai-sessions/src/index.ts');
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
  const walk = node => [unscoped(node), ...(node.children || []).flatMap(walk)];
  const mod = await load('Hato-plugins/modules/ui/ai/src/index.ts');
  const picture = { name: 'test.png', mimeType: 'image/png', data: 'iVBORw0KGgo=' };
  const view = { activeId: 'img-c', conversations: [], profiles: [], workspace: {}, active: { conversation: { id: 'img-c' }, messages: [], live: { status: 'ready' } } };
  let fail = true, sent;
  const ctx = { state: { get: () => ({ id: 'ws' }), set() {}, watch() {} }, events: { on() {}, emit() {} }, ui: { invalidate() {} }, modules: { async call(_, method, args) {
    if (method === 'view') return view;
    if (method === 'send') { sent = args; if (fail) throw new Error('Send failed'); return { accepted: true }; }
  } } };
  await mod.activate(ctx);
  await dispatch(mod,ctx, { action: 'attachImages', value: [picture], inputs: {} });
  assert.deepEqual(mod.snapshot().attachments, [picture]);
  assert.equal(walk(mod.render()).find(node => node.key === 'chat-composer-split').fixed[1], 240);
  assert.ok(walk(mod.render()).find(node => node.key === 'prompt').style.minHeight >= 56);
  await dispatch(mod,ctx, { action: 'removeImage', value: 0, inputs: {} });
  assert.deepEqual(mod.snapshot().attachments, []);
  assert.equal(walk(mod.render()).find(node => node.key === 'chat-composer-split').fixed, undefined);
  await dispatch(mod,ctx, { action: 'attachImages', value: [picture], inputs: {} });
  await dispatch(mod,ctx, { action: 'send', inputs: { prompt: '' } });
  assert.deepEqual(mod.snapshot().attachments, [picture]);
  fail = false;
  await dispatch(mod,ctx, { action: 'send', inputs: { prompt: '' } });
  assert.deepEqual(sent.images, [picture]);
  assert.deepEqual(mod.snapshot().attachments, []);
});

test('image-only prompts are persisted and passed to ACP, including steering', async () => {
  const mod = await load('Hato-plugins/modules/services/ai-sessions/src/index.ts');
  const picture = { name: 'test.png', mimeType: 'image/png', data: 'iVBORw0KGgo=' };
  const listeners = {}, prompts = [], stored = [];
  let support = true;
  const ctx = { events: { on: (name, fn) => { listeners[name] = fn; }, emit() {} }, state: { set() {}, get() {}, watch() {} }, log: { warn() {} }, modules: { async call(_, method, args) {
    if (method === 'conversations.get') return { id: args.id, title: 'Existing' };
    if (method === 'messages.list') return [];
    if (method === 'state') return { status: 'ready', sessionId: 'pictures-session', agentCapabilities: { promptCapabilities: { image: support } } };
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

test('provider session actions persist the selected session without clearing Hato transcript history', async () => {
  const mod = await load('Hato-plugins/modules/services/ai-sessions/src/index.ts');
  const calls = [], updates = [];
  const ctx = { events: { on() {}, emit() {} }, state: { set() {}, get() {}, watch() {} }, log: { warn() {} }, modules: { async call(service, method, args) {
    calls.push({ service, method, args });
    if (method === 'conversations.get') return { id: 'provider-chat', workspaceId: 'ws', title: 'Chat', providerSessionId: 's-old' };
    if (method === 'resolve') return { id: 'ws', machineId: 'local' };
    if (method === 'conversations.list') return [{ id: 'provider-chat', workspaceId: 'ws', title: 'Chat', providerSessionId: 's-old' }];
    if (method === 'view.get') return { activeConversationId: 'provider-chat' };
    if (method === 'profiles') return [];
    if (method === 'authSettings') return {};
    if (method === 'settings.get') return [];
    if (method === 'messages.list') return [{ id: 'local-user', sequence: 1, kind: 'user', payload: { text: 'Keep this local history' } }];
    if (method === 'state') return { status: 'ready', sessionId: 's-old', agentCapabilities: { loadSession: true, sessionCapabilities: { list: {}, resume: {} } } };
    if (method === 'listSessions') return { sessions: [{ sessionId: 's-old' }, { sessionId: 's-new' }], nextCursor: 'next' };
    if (method === 'loadSession') return { status: 'ready', sessionId: args.sessionId, sessionClosed: false, agentCapabilities: { loadSession: true } };
    if (method === 'respondElicitation') return null;
    if (method === 'conversations.update') { updates.push(args); return; }
    throw new Error(service + ':' + method);
  } } };
  await mod.activate(ctx);
  const page = await mod.methods.providerSessions(ctx, { conversationId: 'provider-chat', cursor: 'cursor' });
  assert.equal(page.nextCursor, 'next');
  assert.equal(calls.find(c => c.method === 'listSessions').args.cursor, 'cursor');
  const live = await mod.methods.loadProviderSession(ctx, { conversationId: 'provider-chat', sessionId: 's-new' });
  assert.equal(live.sessionId, 's-new');
  assert.ok(updates.some(u => u.fields.providerSessionId === 's-new'));
  const view = await mod.methods.view(ctx, { workspaceId: 'ws' });
  assert.equal(view.active.messages[0].text, 'Keep this local history');
  await mod.methods.respondElicitation(ctx, { conversationId: 'provider-chat', requestId: 42, response: { action: 'cancel' } });
  assert.deepEqual(calls.find(c => c.method === 'respondElicitation').args, { conversationId: 'provider-chat', requestId: 42, response: { action: 'cancel' } });
});

test('authentication methods route through ai-sessions and successful terminal login reconnects', async () => {
  const mod = await load('Hato-plugins/modules/services/ai-sessions/src/index.ts');
  const listeners = {}, calls = [];
  let authOutcome = { outcome: 'terminal', label: 'Login', display: 'opencode auth login', envKeys: [] };
  const live = { status: 'error', sessionId: null, authMethods: [{ id: 'login', name: 'Login' }], authProcess: null };
  const ctx = { events: { on: (name, fn) => { listeners[name] = fn; }, emit() {} }, state: { set() {}, get() {}, watch() {} }, log: { warn() {} }, modules: { async call(service, method, args) {
    calls.push({ service, method, args });
    if (method === 'conversations.get') return { id: 'auth-chat', workspaceId: 'ws', title: 'Auth', status: 'error' };
    if (method === 'messages.list') return [];
    if (method === 'state') return live;
    if (method === 'authenticate') return authOutcome;
    if (method === 'start') return { status: 'ready', sessionId: 'new-session', configOptions: [] };
    if (['conversations.update', 'settings.get', 'messages.upsert', 'authInput', 'cancelAuth', 'stop'].includes(method)) return null;
    throw new Error(service + ':' + method);
  } } };
  await mod.activate(ctx);
  assert.deepEqual(await mod.methods.authenticate(ctx, { conversationId: 'auth-chat', methodId: 'login' }), authOutcome);
  assert.equal(calls.find(c => c.method === 'authenticate').args.methodId, 'login');
  await mod.methods.authInput(ctx, { conversationId: 'auth-chat', data: 'choice\n' });
  assert.equal(calls.find(c => c.method === 'authInput').args.data, 'choice\n');
  await mod.methods.cancelAuth(ctx, { conversationId: 'auth-chat' });
  assert.ok(calls.some(c => c.method === 'cancelAuth'));
  await listeners['acp.authCompleted']({ conversationId: 'auth-chat', methodId: 'login', code: 0, signal: null });
  assert.ok(calls.some(c => c.method === 'stop'));
  assert.ok(calls.some(c => c.method === 'start' && c.args.resumeSessionId == null));

  authOutcome = { outcome: 'authenticated', methodId: 'login' };
  await mod.methods.authenticate(ctx, { conversationId: 'auth-chat', methodId: 'login' });
  assert.equal(calls.filter(c => c.method === 'start').length, 2, 'agent-driven authentication also reconnects');
});

test('model picker searches advertised metadata, selects the right config and preserves draft attachments', async () => {
  const mod = await load('Hato-plugins/modules/ui/ai/src/index.ts');
  const picture = { name: 'image.png', mimeType: 'image/png', data: 'iVBORw0KGgo=' };
  const configOptions = [{ id: 'agent-model', category: 'model', type: 'select', currentValue: 'one', options: [{ value: 'one', name: 'First model', description: 'Fast tasks' }, { value: 'two', name: 'Second model', description: 'Deep reasoning' }] }];
  const view = { profiles: [{ id: 'provider', name: 'Codex ACP' }], conversations: [], workspace: {}, active: { conversation: { id: 'picker', acpProfileId: 'provider' }, live: { status: 'ready', configOptions }, messages: [] } };
  let selected;
  const ctx = { state: { get: () => ({ id: 'ws' }), set() {}, watch() {} }, events: { on() {}, emit() {} }, ui: { invalidate() {} }, modules: { async call(_, method, args) {
    if (method === 'view') return view;
    if (method === 'setConfig') { selected = args; configOptions[0].currentValue = args.value; }
  } } };
  const walk = n => [unscoped(n), ...(n.children || []).flatMap(walk)];
  await mod.activate(ctx, { draft: 'Keep my draft', attachments: [picture] });
  await dispatch(mod,ctx, { action: 'toggleModels', inputs: {} });
  await dispatch(mod,ctx, { action: 'searchModels', value: 'deep', inputs: {} });
  const results = walk(mod.render()).find(n => n.key === 'results');
  assert.deepEqual(results.children.map(n => n.key), ['two']);
  await dispatch(mod,ctx, { action: 'chooseModel', value: 'two', inputs: {} });
  assert.deepEqual(selected, { conversationId: 'picker', configId: 'agent-model', value: 'two' });
  assert.ok(!walk(mod.render()).some(n => n.key === 'model-picker'));
  assert.equal(mod.snapshot().draft, 'Keep my draft');
  assert.deepEqual(mod.snapshot().attachments, [picture]);
  await dispatch(mod,ctx, { action: 'toggleMcpPicker', inputs: {} });
  await dispatch(mod,ctx, { action: 'toggleSkills', inputs: {} });
  assert.ok(walk(mod.render()).some(n => n.key === 'mcp-picker'));
});

test('Skills lists only active workspace files and invokes the explicit workspace path', async () => {
  const mod = await load('Hato-plugins/modules/ui/ai/src/index.ts');
  const skills = [{ name: 'Review changes', description: 'Review this workspace', path: '.agents/skills/review/SKILL.md' }];
  let selected = { id: 'one' };
  let skillState = { workspaceId: 'one', skills };
  const watchers = {}, emitted = [];
  const view = { profiles: [], conversations: [], workspace: {}, active: { conversation: { id: 'skills' }, messages: [], live: { status: 'ready', commands: [{ name: 'global-command' }] } } };
  const ctx = { state: { get: key => key === 'files.skills' ? skillState : selected, set() {}, watch: (key, fn) => { watchers[key] = fn; } }, events: { on() {}, emit: (topic) => emitted.push(topic) }, ui: { invalidate() {} }, modules: { async call() { return view; } } };
  const walk = n => [unscoped(n), ...(n.children || []).flatMap(walk)];
  await mod.activate(ctx);
  assert.ok(!walk(mod.render()).some(n => n.key === 'skills-toggle'), 'skills moved into the MCP popover');
  await dispatch(mod,ctx, { action: 'toggleMcpPicker', inputs: {} });
  await dispatch(mod,ctx, { action: 'toggleSkills', inputs: {} });
  let picker = walk(mod.render()).find(n => n.key === 'mcp-picker');
  assert.deepEqual(walk(picker).filter(n=>n.action==='useSkill').map(n=>n.value),[skills[0].path]);
  assert.equal(picker.type,'popover');
  assert.ok(emitted.includes('ai.skillsRequested'));
  await dispatch(mod,ctx, { action: 'useSkill', value: skills[0].path, inputs: { prompt: 'Review my edits' } });
  assert.equal(mod.snapshot().draft, 'Use the workspace skill at .agents/skills/review/SKILL.md.\nReview my edits');
  selected = { id: 'two' }; watchers['workspace.selected'](selected);
  await dispatch(mod,ctx, { action: 'toggleMcpPicker', inputs: {} });
  await dispatch(mod,ctx, { action: 'toggleSkills', inputs: {} });
  picker = walk(mod.render()).find(n => n.key === 'mcp-picker');
  assert.ok(!walk(picker).some(n => n.value === skills[0].path));
  assert.ok(walk(mod.render()).some(n => n.key === 'skills-none'));
});

test('existing history projects embedded image data as a preview and replayed image blocks stay out of text', async () => {
  const mod = await load('Hato-plugins/modules/services/ai-sessions/src/index.ts');
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
  const mod = await load('Hato-plugins/modules/ui/ai/src/index.ts');
  const messages = Array.from({ length: 200 }, (_, i) => ({ key: 'm' + (i + 1), role: 'user', text: 'Message ' + (i + 1) }));
  const view = { activeId: 'c', conversations: [{ id: 'c', title: 'Chat' }], profiles: [{ id: 'codex', name: 'Codex', provider: 'codex' }], workspace: { id: 'ws', machineId: 'local', root: '/test' },
    active: { conversation: { id: 'c', acpProfileId: 'codex' }, messages, hasOlder: false, live: { status: 'ready' } } };
  const calls = [];
  const ctx = { state: { get: () => ({ id: 'ws' }), set() {}, watch() {} }, events: { on() {}, emit() {} }, ui: { invalidate() {} }, modules: { async call(_, method, args) { calls.push({ method, args }); if (method === 'view') return view; throw new Error(method); } } };
  await mod.activate(ctx);
  const walk = n => [unscoped(n), ...(n.children || []).flatMap(walk)];
  const transcriptNode = () => walk(mod.render()).find(n => n.type === 'transcript');
  const transcript = () => { const t = transcriptNode(); return { ...t, messages: t.children.filter(c => c.key !== '__older') }; };
  assert.equal(calls.find(c => c.method === 'view').args.messageLimit, 20);
  assert.equal(transcript().messages.length, 20);
  assert.equal(transcript().messages[0].key, 'm181');
  assert.equal(transcript().loadOlderAction, 'revealOlder');
  await dispatch(mod,ctx, { action: 'olderMessages', inputs: {} });
  assert.equal(transcript().messages.length, 20);
  assert.equal(transcript().messages[0].key, 'm161');
  messages.push({ key: 'm201', role: 'assistant', text: 'Live reply' });
  await dispatch(mod,ctx, { action: 'olderMessages', inputs: {} });
  assert.equal(transcript().messages[0].key, 'm141');
  await dispatch(mod,ctx, { action: 'newerMessages', inputs: {} });
  assert.equal(transcript().messages[0].key, 'm161');
  await dispatch(mod,ctx, { action: 'latestMessages', inputs: {} });
  assert.equal(transcript().messages.length, 20);
  assert.equal(transcript().messages.at(-1).key, 'm201');
  assert.equal(messages.length, 201);
});

test('scroll history grows in batches, stays bounded to 60 and collapses to 20 at the latest end', async () => {
  const mod = await load('Hato-plugins/modules/ui/ai/src/index.ts');
  const messages = Array.from({ length: 200 }, (_, i) => ({ key: 'm' + (i + 1), role: 'user', text: String(i + 1) }));
  const view = { activeId: 'c', conversations: [], profiles: [{ id: 'codex', name: 'Codex', provider: 'codex' }], workspace: { id: 'ws', machineId: 'local', root: '/test' },
    active: { conversation: { id: 'c', acpProfileId: 'codex' }, messages, hasOlder: false, live: { status: 'ready' } } };
  const ctx = { state: { get: () => ({ id: 'ws' }), set() {}, watch() {} }, events: { on() {}, emit() {} }, ui: { invalidate() {} }, modules: { async call(_, method) { if (method === 'view') return view; throw new Error(method); } } };
  await mod.activate(ctx);
  const walk = n => [unscoped(n), ...(n.children || []).flatMap(walk)];
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
  const mod = await load('Hato-plugins/modules/ui/ai/src/index.ts');
  const view = { activeId: 'c', conversations: [{ id: 'c', title: 'Chat' }], profiles: [{ id: 'claude', provider: 'claude', name: 'Claude' }], workspace: { machineId: 'local', root: '/test' }, active: { conversation: { id: 'c', acpProfileId: 'claude' }, messages: [], live: { status: 'ready' } } };
  const stored = new Map([['ws', 0.3], ['other', 0.2]]), watchers = new Map(), saved = [];
  let workspace = { id: 'ws' };
  const ctx = { state: { get: key => key === 'workspace.selected' ? workspace : null, set() {}, watch: (key, fn) => watchers.set(key, fn) },
    events: { on() {}, emit() {} }, ui: { invalidate() {} }, modules: { async call(_, method, args) {
      if (method === 'view') return view;
      if (method === 'view.get') return { ui: { aiComposerFraction: stored.get(args.workspaceId) } };
      if (method === 'view.patch') { saved.push(args); stored.set(args.workspaceId, args.patch.ui.aiComposerFraction); }
    } } };
  const walk = n => [unscoped(n), ...(n.children || []).flatMap(walk)];
  const split = () => walk(mod.render()).find(n => n.key === 'chat-composer-split');
  await mod.activate(ctx);
  assert.deepEqual(split().sizes, [0.7, 0.3]);
  assert.equal(split().resizeAction, 'resizeComposer');
  const input = walk(mod.render()).find(n => n.key === 'prompt');
  assert.equal(input.fillHeight, true);
  await dispatch(mod,ctx, { action: 'draftChanged', value: 'Keep my draft', inputs: {} });
  await dispatch(mod,ctx, { action: 'resizeComposer', value: { sizes: [0.6, 0.4] }, inputs: {} });
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
  await dispatch(mod,ctx, { action: 'resizeComposer', value: { sizes: [NaN, 1] }, inputs: {} });
  assert.equal(saved.length, count);
  mod.deactivate();
});

test('new chats copy active settings and live defaults without session identity', async () => {
  const mod = await load('Hato-plugins/modules/services/ai-sessions/src/index.ts');
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
  const mod = await load('Hato-plugins/modules/ui/ai/src/index.ts');
  const view = { activeId: 'one', profiles: [{ id: 'codex', name: 'Codex' }], conversations: [{ id: 'one', title: 'Fix login', acpProfileId: 'codex' }, { id: 'two', title: 'Polish UI' }], workspace: { name: 'Hato' }, active: { conversation: { id: 'one' }, messages: [], live: { status: 'ready' } } };
  const ctx = { state: { get: () => ({ id: 'ws' }), set() {}, watch() {} }, events: { on() {}, emit() {} }, ui: { invalidate() {} }, modules: { async call() { return view; } } };
  await mod.activate(ctx);
  const walk = n => [unscoped(n), ...(n.children || []).flatMap(walk)];
  await dispatch(mod,ctx, { action: 'toggleHistory', inputs: {} });
  await dispatch(mod,ctx, { action: 'searchSessions', value: 'codex', inputs: {} });
  assert.deepEqual(walk(mod.render()).find(n => n.key === 'session-list').children.map(n => n.key), ['one']);
  assert.equal(walk(walk(mod.render()).find(n => n.key === 'one')).find(n=>n.type==='choice').selected, true);
  for (const [action, key] of [['toggleModels', 'model-picker'], ['toggleMcpPicker', 'mcp-picker']]) {
    await dispatch(mod,ctx, { action, inputs: {} });
    assert.equal(walk(mod.render()).find(n => n.key === key).style.background, 'background');
  }
});

test('chat MCP selections preserve other servers and connect configured transports with OAuth', async () => {
  const mod = await load('Hato-plugins/modules/services/ai-sessions/src/index.ts');
  const auth = await load('Hato-plugins/modules/services/mcp-auth/src/index.ts');
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
  const mod = await load('Hato-plugins/modules/services/ai-sessions/src/index.ts');
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
    const mod = await load('Hato-plugins/modules/services/ai-sessions/src/index.ts');
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
    const mod = await load('Hato-plugins/modules/services/acp/src/index.ts');
    let ended;
    const events = [];
    const ctx = { modules: { async call() { return [{ id: 'codex' }, { id: 'claude' }]; } },
      log: { info() {}, warn() {} }, state: { get() {}, set() {}, watch() {} },
      events: { emit: (topic, value) => events.push({ topic, value }) }, host: { plugins: {list: async () => ({plugins:builtinPlugins()})},
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

test('sending after closing a provider session reconnects with a local dialogue handoff', async () => {
  const mod = await load('Hato-plugins/modules/services/ai-sessions/src/index.ts');
  const calls = [];
  const ctx = { events: { on() {}, emit() {} }, state: { set() {} }, log: { warn() {} }, modules: { async call(_, method, args) {
    calls.push({ method, args });
    if (method === 'conversations.get') return { id: 'closed', workspaceId: 'ws', title: 'Existing', providerSessionId: 'old', config: {} };
    if (method === 'messages.list') return [{ id: 'previous', sequence: 1, kind: 'user', payload: { text: 'Remember the blue theme' } }];
    if (method === 'state') return { status: 'ready', sessionId: 'old' };
    if (method === 'closeSession') return { status: 'ready', sessionId: 'old', sessionClosed: true };
    if (method === 'start') return { status: 'ready', sessionId: 'fresh', configOptions: [] };
    if (method === 'settings.get') return [];
    if (['conversations.update', 'messages.upsert', 'prompt'].includes(method)) return null;
    throw new Error(method);
  } } };
  await mod.activate(ctx);
  await mod.methods.closeProviderSession(ctx, { conversationId: 'closed' });
  await mod.methods.send(ctx, { conversationId: 'closed', text: 'Continue' });
  assert.equal(calls.filter(c => c.method === 'start').length, 1);
  assert.equal(calls.find(c => c.method === 'start').args.resumeSessionId, null);
  const text = calls.find(c => c.method === 'prompt').args.text;
  assert.match(text, /Remember the blue theme/); assert.match(text, /Continue/);
});

test('native events carry conversation origins, reject stale send clicks, and return before long work',async()=>{
 const mod=await load('Hato-plugins/modules/ui/ai/src/index.ts');
 const listeners={},calls=[];let selected='a',finishSend;
 const ctx={state:{get:()=>({id:'ws'}),set(){},watch(){}},events:{on:(t,f)=>listeners[t]=f,emit(){}},ui:{invalidate(){}},modules:{async call(_,method,args){
  if(method==='view')return {profiles:[],conversations:[],workspace:{},active:{conversation:{id:selected},messages:[],live:{status:'ready',sessionId:'session-'+selected}}};
  if(method==='select'){selected=args.conversationId;return;}
  if(method==='send'){calls.push(args);return new Promise(resolve=>finishSend=resolve);}
  if(method==='view.patch')return;
  throw new Error(method);
 }}};
 await mod.activate(ctx);await new Promise(setImmediate);
 const raw=n=>[n,...(n.children||[]).flatMap(raw)];
 const oldSend=raw(mod.render()).find(n=>n.key==='send');assert.match(oldSend.action,/^origin:/);
 await dispatch(mod,ctx,{action:'selectConv',value:'b',inputs:{}});
 await mod.onEvent(ctx,{action:oldSend.action,key:'send',inputs:{prompt:'Stale request'}});assert.equal(calls.length,0);
 const current=raw(mod.render()).find(n=>n.key==='send');
 await mod.onEvent(ctx,{action:current.action,key:'send',inputs:{prompt:'Current request'}});
 assert.equal(calls.length,1);assert.equal(calls[0].conversationId,'b');assert.equal(mod.canSwap().ok,false);
 finishSend();await dispatch(mod,ctx,{action:'dismissCommands',inputs:{}});assert.equal(mod.canSwap().ok,true);
});

test('composer input keeps working after the conversation changes (native inputs keep their first actions)',async()=>{
 const mod=await load('Hato-plugins/modules/ui/ai/src/index.ts');
 const calls=[];let selected='a';
 const ctx={state:{get:()=>({id:'ws'}),set(){},watch(){}},events:{on(){},emit(){}},ui:{invalidate(){}},modules:{async call(_,method,args){
  if(method==='view')return {profiles:[],conversations:[],workspace:{},active:{conversation:{id:selected},messages:[],live:{status:'ready',sessionId:'session-'+selected}}};
  if(method==='select'){selected=args.conversationId;return;}
  if(method==='send'){calls.push(args);return;}
  if(method==='view.patch')return;
  throw new Error(method);
 }}};
 await mod.activate(ctx);await new Promise(setImmediate);
 const raw=n=>[n,...(n.children||[]).flatMap(raw)];
 // The native host builds the input once and keeps the action names from that first render.
 const prompt=raw(mod.render()).find(n=>n.key==='prompt');
 assert.equal(prompt.submitAction,'send');assert.equal(prompt.changeAction,'draftChanged');
 await dispatch(mod,ctx,{action:'selectConv',value:'b',inputs:{}});mod.render();
 await dispatch(mod,ctx,{action:prompt.changeAction,key:'prompt',value:'Hello b',inputs:{prompt:'Hello b'}});
 assert.equal(raw(mod.render()).find(n=>n.key==='prompt').value,'Hello b');
 await dispatch(mod,ctx,{action:prompt.submitAction,key:'prompt',value:null,inputs:{prompt:'Hello b'}});
 assert.equal(calls.length,1);assert.equal(calls[0].conversationId,'b');assert.equal(calls[0].text,'Hello b');
 assert.equal(raw(mod.render()).find(n=>n.key==='prompt').value,'','sent text is cleared from the composer');
 // Unscoped events from keys that are not a rendered input stay rejected.
 await dispatch(mod,ctx,{action:'send',key:'send',inputs:{prompt:'Forged'}});assert.equal(calls.length,1);
});

test('latest UI load wins and old failures cannot replace a newer selected view',async()=>{
 const mod=await load('Hato-plugins/modules/ui/ai/src/index.ts');
 const listeners={};let callNumber=0,rejectOld;
 const make=id=>({profiles:[],conversations:[],workspace:{},active:{conversation:{id},messages:[],live:{status:'ready',sessionId:id}}});
 const ctx={state:{get:()=>({id:'ws'}),set(){},watch(){}},events:{on:(t,f)=>listeners[t]=f,emit(){}},ui:{invalidate(){}},modules:{async call(_,method){
  if(method==='view'){if(++callNumber===1)return new Promise((_,reject)=>rejectOld=reject);return make('new');}
  throw new Error(method);
 }}};
 await mod.activate(ctx);
 listeners['acp.status']({});
 for(let i=0;i<100&&callNumber<2;i++)await new Promise(resolve=>setTimeout(resolve,5));
 rejectOld(new Error('Obsolete failure'));await new Promise(setImmediate);
 const nodes=(function walk(n){return [n,...(n.children||[]).flatMap(walk)];})(mod.render());
 assert.ok(nodes.some(n=>n.key==='transcript'&&n.scrollKey==='new'));assert.ok(!nodes.some(n=>/Obsolete failure/.test(n.text||'')));
});

test('auth launch errors remain visible when rendering rotates the attempt origin',async()=>{
 const mod=await load('Hato-plugins/modules/ui/ai/src/index.ts');let ready=false;
 const view={profiles:[],conversations:[],workspace:{},active:{conversation:{id:'auth'},messages:[],live:{status:'ready',sessionId:'s',authMethods:[{id:'login',name:'Login',type:'terminal'}]}}};
 const ctx={state:{get:()=>({id:'ws'}),set(){},watch(){}},events:{on(){},emit(){}},ui:{invalidate(){if(ready)mod.render();}},modules:{async call(_,method){if(method==='view')return view;if(method==='authenticate')throw new Error("Unsafe authentication environment variable 'PATH'");throw Error(method);}}};
 await mod.activate(ctx);ready=true;
 await dispatch(mod,ctx,{action:'authenticate:login',inputs:{}});
 const nodes=(function walk(n){return [n,...(n.children||[]).flatMap(walk)];})(mod.render());
 assert.ok(nodes.some(n=>/Unsafe authentication/.test(n.text||'')));
});

test('MCP popover offers a reconnect that restarts the chat tools, disabled during a turn', async () => {
  const mod = await load('Hato-plugins/modules/ui/ai/src/index.ts');
  const calls = [];
  const view = { profiles: [], conversations: [], workspace: { machineId: 'local', root: '/w' }, mcpServers: [{ id: 'internal', name: 'Hato' }],
    active: { conversation: { id: 'c', mcpSelection: ['internal'] }, messages: [], live: { status: 'ready', sessionId: 's', mcp: { selection: ['internal'] } } } };
  const ctx = { state: { get: () => ({ id: 'ws' }), set() {}, watch() {} }, events: { on() {}, emit() {} }, ui: { invalidate() {} }, modules: { async call(_, method, args) {
    calls.push(method);
    if (method === 'view') return view;
    if (method === 'disconnect' || method === 'connect') return {};
    throw new Error(method);
  } } };
  const walk = n => [unscoped(n), ...(n.children || []).flatMap(walk)];
  await mod.activate(ctx);
  await dispatch(mod, ctx, { action: 'toggleMcpPicker', inputs: {} });
  const button = walk(mod.render()).find(n => n.key === 'reconnect-tools').children.find(n => n.type === 'button');
  assert.equal(button.text, 'Reconnect MCPs'); assert.equal(button.disabled, false);
  await dispatch(mod, ctx, { action: button.action, inputs: {} });
  assert.deepEqual(calls.filter(m => m === 'disconnect' || m === 'connect'), ['disconnect', 'connect']);
  view.active.live.status = 'busy'; view.active.busy = true;
  await dispatch(mod, ctx, { action: 'dismissCommands', inputs: {} });
  assert.equal(walk(mod.render()).find(n => n.key === 'reconnect-tools').children.find(n => n.type === 'button').disabled, true);
});
