import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import * as esbuild from 'esbuild';

let generation = 0;
async function load(entry) {
  const built = await esbuild.build({ entryPoints: [entry], bundle: true, format: 'esm', write: false, loader: { '.sql': 'text' } });
  return (await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64') + '#' + generation++)).default;
}
const find = (n, match) => {
  if (match(n)) return n;
  for (const c of n.children || []) { const found = find(c, match); if (found) return found; }
};

test('All Chats confirms deletion, keeps cancellation harmless, and refreshes the current selection', async t => {
  const mod = await load('Hato-plugins/modules/ui/ai/src/index.ts');
  t.after(() => mod.deactivate());
  const rows = [{ id: 'one', title: 'First chat', status: 'online' }, { id: 'two', title: 'Second chat', status: 'busy' }];
  const state = new Map([['workspace.selected', { id: 'ws' }]]), removed = [];
  const view = () => ({ activeId: rows[0]?.id, profiles: [], conversations: [...rows], workspace: { name: 'Test' }, active: rows[0] ? { conversation: rows[0], messages: [], live: { status: 'ready' } } : null });
  let fail = false;
  const ctx = { state: { get: k => state.get(k), set: (k, v) => state.set(k, v), watch() {} }, events: { on() {}, emit() {} }, ui: { invalidate() {} }, modules: { async call(target, method, args) {
    if (target === 'ai-sessions' && method === 'view') return view();
    if (target === 'ai-sessions' && method === 'remove') {
      if (fail) throw new Error('Storage unavailable');
      removed.push(args); rows.splice(rows.findIndex(r => r.id === args.conversationId), 1); return null;
    }
    if (method === 'adapters') return [];
    return null;
  } } };
  const event = (action, value) => mod.onEvent(ctx, { action, value, inputs: {} });
  await mod.activate(ctx);
  await mod.methods.openHistory(ctx);
  const row = id => find(mod.render(), n => n.key === 'session-list')?.children.find(n => n.key === id);
  assert.equal(find(row('two'), n => n.key === 'delete').disabled, true);
  await event('requestDeleteChat', 'two');
  assert.equal(find(mod.render(), n => n.key === 'confirm-delete'), undefined);
  await event('requestDeleteChat', 'one');
  assert.ok(find(row('one'), n => n.key === 'confirm-delete'));
  assert.deepEqual(removed, []);
  await event('cancelDeleteChat');
  await event('confirmDeleteChat');
  assert.deepEqual(removed, []);
  fail = true;
  await event('requestDeleteChat', 'one');
  await event('confirmDeleteChat');
  assert.ok(row('one'), 'failed deletion keeps the chat visible');
  fail = false;
  await event('confirmDeleteChat');
  assert.deepEqual(removed, [{ workspaceId: 'ws', conversationId: 'one' }]);
  assert.equal(row('one'), undefined);
  assert.equal(find(row('two'), n => n.key === 'select').selected, true);
  assert.ok(find(mod.render(), n => n.key === 'history'), 'the picker stays open');
});

test('All Chats can delete the selected background chat through the existing agent gateway', async t => {
  const mod = await load('Hato-plugins/modules/ui/ai/src/index.ts');
  t.after(() => mod.deactivate());
  const listeners = new Map(), removed = [], state = new Map([['workspace.selected', { id: 'ws' }]]);
  const session = { id: 'bg', name: 'Background chat', workspaceId: 'ws', status: 'ready', profile: { id: 'codex', name: 'Codex' }, skills: [], mcps: [] };
  const ctx = { state: { get: k => state.get(k), set: (k, v) => state.set(k, v), watch() {} }, ui: { invalidate() {} }, events: {
    on: (key, fn) => listeners.set(key, fn),
    emit(topic, request) {
      if (topic !== 'ai.persistentRequest') return;
      const value = request.method === 'list' ? [session] : request.method === 'catalog' ? { profiles: [session.profile], skills: [], mcps: [] } : request.method === 'remove' ? removed.push(request.args) : { session, messages: [], queued: [], before: null };
      listeners.get('persistent-agents.chatResponse')({ requestId: request.requestId, value });
    },
  }, modules: { async call(_target, method) {
    if (method === 'view') return { profiles: [], conversations: [], workspace: {}, active: null };
    return {};
  } } };
  await mod.activate(ctx, { background: { workspaceId: 'ws', id: 'bg' } });
  await new Promise(resolve => setImmediate(resolve));
  await mod.methods.openHistory(ctx);
  const row = find(mod.render(), n => n.key === 'session-list').children[0];
  assert.equal(row.key, 'bg');
  await mod.onEvent(ctx, { action: 'requestDeleteChat', value: 'bg' });
  await mod.onEvent(ctx, { action: 'confirmDeleteChat' });
  assert.deepEqual(removed, [{ workspaceId: 'ws', id: 'bg' }]);
  assert.equal(mod.snapshot().background, undefined);
  assert.ok(find(mod.render(), n => n.key === 'no-sessions'));
});

test('saved chat deletion is workspace-scoped and refuses active turns', async () => {
  const mod = await load('Hato-plugins/modules/services/ai-sessions/src/index.ts');
  const rows = new Map([['idle', { id: 'idle', workspaceId: 'ws' }], ['running', { id: 'running', workspaceId: 'ws' }]]);
  const calls = [];
  const ctx = { state: { set() {} }, log: { warn() {} }, modules: { async call(target, method, args) {
    calls.push([target, method, args]);
    if (method === 'conversations.get') return rows.get(args.id);
    if (method === 'messages.list') return [];
    if (method === 'state') return { status: args.conversationId === 'running' ? 'busy' : 'ready' };
    if (method === 'conversations.remove') rows.delete(args.id);
  } } };
  await assert.rejects(mod.methods.remove(ctx, { workspaceId: 'other', conversationId: 'idle' }), /workspace/);
  await assert.rejects(mod.methods.remove(ctx, { workspaceId: 'ws', conversationId: 'running' }), /Finish or stop/);
  assert.ok(!calls.some(([, method]) => method === 'stop'));
  await mod.methods.remove(ctx, { workspaceId: 'ws', conversationId: 'idle' });
  assert.equal(rows.has('idle'), false);
  assert.equal(rows.has('running'), true);
  assert.ok(calls.findIndex(([, method]) => method === 'stop') < calls.findIndex(([, method]) => method === 'conversations.remove'));
});

test('persistent deletion removes history and selection atomically without touching other workspaces', async () => {
  const mod = await load('Hato-plugins/modules/services/persistence/src/index.ts');
  const schema = readFileSync('Hato-plugins/modules/services/persistence/migrations/001_init.sql', 'utf8');
  const run = async (workspaceId, fail = false) => {
    let statements;
    await mod.methods['conversations.remove']({ host: { db: { async transaction(_, items) { statements = items; } } } }, { id: 'one', workspaceId });
    const script = `import json,sqlite3,sys
p=json.load(sys.stdin);db=sqlite3.connect(':memory:');db.executescript(p['schema']);db.execute('PRAGMA foreign_keys=ON')
for id,ws in [('one','ws'),('two','other')]:
 db.execute("INSERT INTO ai_conversations(id,workspace_id,acp_profile_id,title,created_at,updated_at) VALUES(?,?,'test',?,'now','now')",(id,ws,id))
 db.execute("INSERT INTO ai_messages(id,conversation_id,sequence,kind,payload_json,created_at) VALUES(?,?,1,'user','{}','now')",('msg-'+id,id))
 db.execute('INSERT INTO workspace_views(workspace_id,active_conversation_id) VALUES(?,?)',(ws,id))
db.commit()
try:
 with db:
  for i,s in enumerate(p['statements']):
   db.execute(s['sql'],s['params'])
   if p['fail'] and i==0:raise RuntimeError('rollback')
except RuntimeError:pass
print(json.dumps({'chats':db.execute('SELECT id FROM ai_conversations ORDER BY id').fetchall(),'messages':db.execute('SELECT conversation_id FROM ai_messages ORDER BY conversation_id').fetchall(),'views':db.execute('SELECT workspace_id,active_conversation_id FROM workspace_views ORDER BY workspace_id').fetchall()}))`;
    return JSON.parse(execFileSync('python3', ['-c', script], { input: JSON.stringify({ schema, statements, fail }), encoding: 'utf8' }));
  };
  const deleted = await run('ws');
  assert.deepEqual(deleted.chats, [['two']]);
  assert.deepEqual(deleted.messages, [['two']]);
  assert.deepEqual(deleted.views, [['other', 'two'], ['ws', null]]);
  for (const result of [await run('other'), await run('ws', true)]) {
    assert.deepEqual(result.chats, [['one'], ['two']]);
    assert.deepEqual(result.messages, [['one'], ['two']]);
    assert.deepEqual(result.views, [['other', 'two'], ['ws', 'one']]);
  }
});
