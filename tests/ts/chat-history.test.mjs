import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as esbuild from 'esbuild';
const replayBuild = await esbuild.build({ entryPoints: ['sdk/chat-replay.ts'], bundle: true, format: 'esm', write: false });
const { reconcileReplay } = await import('data:text/javascript;base64,'+Buffer.from(replayBuild.outputFiles[0].text).toString('base64'));
let generation = 0;
async function session() {
  const result = await esbuild.build({ entryPoints: ['Hato-plugins/modules/services/ai-sessions/src/index.ts'], bundle: true, format: 'esm', write: false });
  return (await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64') + '#' + (++generation))).default;
}
function fixture(total) {
  const rows = Array.from({ length: total }, (_, index) => ({ id: 'm' + (index + 1), sequence: index + 1, kind: 'user', payload: { text: 'Message ' + (index + 1) } }));
  const listeners = {}, requests = [];
  let intercept;
  const ctx = { events: { on: (topic, fn) => { listeners[topic] = fn; }, emit() {} }, state: { set() {}, get() {}, watch() {} }, log: { warn() {} }, modules: { async call(_, method, args) {
    if (method === 'resolve') return { id: 'ws', machineId: 'local' };
    if (method === 'conversations.list') return [{ id: 'c', title: 'Chat' }];
    if (method === 'view.get') return { activeConversationId: 'c' };
    if (method === 'profiles') return [];
    if (method === 'conversations.get') return { id: 'c', title: 'Chat', workspaceId: 'ws' };
    if (method === 'messages.list') {
      requests.push(args);
      if (intercept && args.beforeSequence) await intercept();
      return rows.filter(row => !args.beforeSequence || row.sequence < args.beforeSequence).slice(-args.limit);
    }
    if (method === 'messages.reconcileReplay') {
      const merged = reconcileReplay(rows, args.messages); rows.splice(0,rows.length,...merged);
      return { messages: merged.slice(-args.limit), hasOlder: merged.length > args.limit };
    }
    if (method === 'state') return { status: 'ready' };
    if (method === 'authSettings') return {};
    if (method === 'settings.get') return [];
    if (method === 'messages.upsert') return;
    throw new Error(method);
  } } };
  return { ctx, rows, listeners, requests, setIntercept: fn => { intercept = fn; } };
}

test('chat loads the newest page first and pages all older history without gaps or a 400-message cutoff', async () => {
  const mod = await session();
  const f = fixture(520);
  await mod.activate(f.ctx);
  let view = await mod.methods.view(f.ctx, { workspaceId: 'ws' });
  assert.equal(view.active.messages.length, 80);
  assert.equal(view.active.messages[0].key, 'm441');
  assert.equal(view.active.hasOlder, true);
  assert.equal(f.requests[0].limit, 81);
  for (let page = 0; page < 6; page++) await mod.methods.loadOlder(f.ctx, { conversationId: 'c' });
  view = await mod.methods.view(f.ctx, { workspaceId: 'ws' });
  assert.equal(view.active.messages.length, 520);
  assert.equal(view.active.hasOlder, false);
  assert.deepEqual(view.active.messages.map(m => m.key), f.rows.map(m => m.id));
  assert.deepEqual(f.requests.slice(1).map(r => r.beforeSequence), [441, 361, 281, 201, 121, 41]);
  assert.deepEqual(await mod.methods.loadOlder(f.ctx, { conversationId: 'c' }), { loaded: 0, hasOlder: false });
});

test('history requests are deduplicated and concurrent live messages survive prepend', async () => {
  const mod = await session();
  const f = fixture(120);
  await mod.activate(f.ctx);
  await mod.methods.view(f.ctx, { workspaceId: 'ws' });
  let release;
  f.setIntercept(() => new Promise(resolve => { release = resolve; }));
  const first = mod.methods.loadOlder(f.ctx, { conversationId: 'c' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await mod.methods.view(f.ctx, { workspaceId: 'ws' })).active.historyLoading, true);
  assert.deepEqual(await mod.methods.loadOlder(f.ctx, { conversationId: 'c' }), { loaded: 0, hasOlder: true });
  f.listeners['acp.update']({ conversationId: 'c', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Live reply' } } });
  release(); await first;
  const view = await mod.methods.view(f.ctx, { workspaceId: 'ws' });
  assert.equal(view.active.messages.length, 121);
  assert.equal(view.active.messages.at(-1).text, 'Live reply');
  assert.equal(view.active.historyLoading, false);
});

test('failed history requests preserve the cursor and expose an error for retry', async () => {
  const mod = await session();
  const f = fixture(100);
  await mod.activate(f.ctx);
  await mod.methods.view(f.ctx, { workspaceId: 'ws' });
  f.setIntercept(async () => { throw new Error('Read failed'); });
  await assert.rejects(mod.methods.loadOlder(f.ctx, { conversationId: 'c' }), /Read failed/);
  let view = await mod.methods.view(f.ctx, { workspaceId: 'ws' });
  assert.equal(view.active.historyError, 'Read failed');
  assert.equal(view.active.hasOlder, true);
  assert.equal(view.active.historyLoading, false);
  f.setIntercept(null);
  await mod.methods.loadOlder(f.ctx, { conversationId: 'c' });
  view = await mod.methods.view(f.ctx, { workspaceId: 'ws' });
  assert.equal(view.active.messages.length, 100);
  assert.equal(view.active.historyError, null);
  assert.equal(f.requests[1].beforeSequence, f.requests[2].beforeSequence);
});

test('session/load replay deduplicates persisted provider messages and messageId starts a new live message', async () => {
  const mod = await session(), f = fixture(0);
  f.rows.push(
    { id: 'u1', sequence: 1, kind: 'user', payload: { text: 'Question', providerMessageId: 'u-old', providerSessionId: 's-old' } },
    { id: 'a1', sequence: 2, kind: 'assistant', payload: { text: 'Saved answer', providerMessageId: 'a-old', providerSessionId: 's-old' } },
  );
  await mod.activate(f.ctx);
  await mod.methods.view(f.ctx, { workspaceId: 'ws' });
  const replay = (sessionUpdate, messageId, text) => f.listeners['acp.update']({ conversationId: 'c', sessionId: 's-old', replayed: true, update: { sessionUpdate, messageId, content: { type: 'text', text } } });
  replay('user_message_chunk', 'u-old', 'Question');
  replay('agent_message_chunk', 'a-old', 'Saved answer');
  replay('agent_message_chunk', 'a-new', 'Provider-only reply');
  f.listeners['acp.replayEnded']({ conversationId: 'c', sessionId: 's-old' });
  let view = await mod.methods.view(f.ctx, { workspaceId: 'ws' });
  assert.deepEqual(view.active.messages.map(m => [m.role, m.text]), [['user', 'Question'], ['assistant', 'Saved answer'], ['assistant', 'Provider-only reply']]);

  const live = (messageId, text) => f.listeners['acp.update']({ conversationId: 'c', sessionId: 's-old', update: { sessionUpdate: 'agent_message_chunk', messageId, content: { type: 'text', text } } });
  live('live-1', 'Hello'); live('live-1', ' world'); live('live-2', 'Second'); live('live-1', 'duplicate');
  view = await mod.methods.view(f.ctx, { workspaceId: 'ws' });
  assert.deepEqual(view.active.messages.slice(-2).map(m => m.text), ['Hello world', 'Second']);
});

test('anonymous replay chunks preserve role transitions and known message IDs stay session-scoped', async () => {
  const mod = await session(), f = fixture(0);
  f.rows.push({ id: 'old', sequence: 1, kind: 'assistant', payload: { text: 'Same reply', providerMessageId: 'same-id', providerSessionId: 's-old' } });
  await mod.activate(f.ctx);
  await mod.methods.view(f.ctx, { workspaceId: 'ws' });
  const replay = (sessionUpdate, text, messageId) => f.listeners['acp.update']({ conversationId: 'c', sessionId: 's-new', replayed: true, update: { sessionUpdate, messageId, content: { type: 'text', text } } });
  replay('agent_message_chunk', 'First reply');
  replay('user_message_chunk', 'Question');
  replay('agent_message_chunk', 'Second reply');
  replay('agent_message_chunk', 'Same reply', 'same-id');
  f.listeners['acp.replayEnded']({ conversationId: 'c', sessionId: 's-new' });
  f.listeners['acp.update']({ conversationId: 'c', sessionId: 's-new', update: { sessionUpdate: 'agent_message_chunk', messageId: 'same-id', content: { type: 'text', text: 'duplicate' } } });
  const view = await mod.methods.view(f.ctx, { workspaceId: 'ws' });
  assert.deepEqual(view.active.messages.map(message => [message.role, message.text]), [
    ['assistant', 'Same reply'], ['assistant', 'First reply'], ['user', 'Question'], ['assistant', 'Second reply'], ['assistant', 'Same reply'],
  ]);
});

test('the UI projection is limited to 20 messages and paging stays anchored during live appends', async () => {
  const mod = await session(), f = fixture(120);
  await mod.activate(f.ctx);
  const read = beforeMessageId => mod.methods.view(f.ctx, { workspaceId: 'ws', messageLimit: 20, windowConversationId: 'c', beforeMessageId });
  let view = await read();
  assert.equal(view.active.messages.length, 20);
  assert.equal(view.active.messages[0].key, 'm101');
  assert.equal(view.active.hasLoadedOlder, true);
  view = await read('m101');
  assert.equal(view.active.messages[0].key, 'm81');
  assert.equal(view.active.messages.at(-1).key, 'm100');
  f.listeners['acp.update']({ conversationId: 'c', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Live reply' } } });
  view = await read('m101');
  assert.equal(view.active.messages.length, 20);
  assert.equal(view.active.messages.at(-1).key, 'm100');
  assert.equal(view.active.hasNewer, true);
  await mod.methods.loadOlder(f.ctx, { conversationId: 'c' });
  view = await read('m41');
  assert.equal(view.active.messages.length, 20);
  assert.equal(view.active.messages[0].key, 'm21');
  assert.equal(view.active.messages.at(-1).key, 'm40');
  const latest = await read();
  assert.equal(latest.active.messages.length, 20);
  assert.equal(latest.active.messages.at(-1).text, 'Live reply');
  const unrestricted = await mod.methods.view(f.ctx, { workspaceId: 'ws' });
  assert.equal(unrestricted.active.messages.length, 121);
});

test('failed provider load discards partial replay before the next live update', async () => {
  const mod = await session(), f = fixture(1);
  await mod.activate(f.ctx); await mod.methods.view(f.ctx, { workspaceId: 'ws' });
  f.listeners['acp.update']({ conversationId: 'c', sessionId: 'broken', replayed: true, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Partial replay' } } });
  f.listeners['acp.replayEnded']({ conversationId: 'c', sessionId: 'broken', success: false });
  f.listeners['acp.update']({ conversationId: 'c', sessionId: 'current', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Live answer' } } });
  const view = await mod.methods.view(f.ctx, { workspaceId: 'ws' });
  assert.deepEqual(view.active.messages.map(m => m.text), ['Message 1', 'Live answer']);
});

test('full replay matches beyond the newest 80 rows and persists an anchored provider-only message',async()=>{
 const mod=await session(),f=fixture(520);await mod.activate(f.ctx);await mod.methods.view(f.ctx,{workspaceId:'ws'});
 for(const [type,text,id] of [['user_message_chunk','Message 1','u1'],['agent_message_chunk','Earlier provider-only answer','a1'],['user_message_chunk','Message 2','u2']])
  f.listeners['acp.update']({conversationId:'c',sessionId:'provider',replayed:true,update:{sessionUpdate:type,messageId:id,content:{type:'text',text}}});
 await f.listeners['acp.replayEnded']({conversationId:'c',sessionId:'provider',success:true});
 let view=await mod.methods.view(f.ctx,{workspaceId:'ws'});assert.equal(view.active.messages.length,80);
 while(view.active.hasOlder){await mod.methods.loadOlder(f.ctx,{conversationId:'c'});view=await mod.methods.view(f.ctx,{workspaceId:'ws'});}
 assert.equal(view.active.messages.length,521);assert.deepEqual(view.active.messages.slice(0,3).map(m=>m.text),['Message 1','Earlier provider-only answer','Message 2']);
});

test('tool/plan boundaries do not retire an assistant ID and tool IDs are session-scoped',async()=>{
 const mod=await session(),f=fixture(0);await mod.activate(f.ctx);await mod.methods.view(f.ctx,{workspaceId:'ws'});
 const update=(sessionId,u)=>f.listeners['acp.update']({conversationId:'c',sessionId,update:u});
 await update('one',{sessionUpdate:'agent_message_chunk',messageId:'a',content:{type:'text',text:'Before'}});
 await update('one',{sessionUpdate:'tool_call',toolCallId:'t',title:'Old tool'});
 await update('one',{sessionUpdate:'plan',entries:[{content:'Work',status:'in_progress'}]});
 await update('one',{sessionUpdate:'agent_message_chunk',messageId:'a',content:{type:'text',text:' after'}});
 await update('two',{sessionUpdate:'tool_call',toolCallId:'t',title:'New tool'});
 await update('two',{sessionUpdate:'user_message_chunk',messageId:'u',content:{type:'text',text:'Hello'}});
 await update('two',{sessionUpdate:'user_message_chunk',messageId:'u',content:{type:'text',text:' world'}});
 const view=await mod.methods.view(f.ctx,{workspaceId:'ws'});
 assert.equal(view.active.messages[0].text,'Before after');assert.deepEqual(view.active.messages.filter(m=>m.role==='tool').map(m=>m.title),['Old tool','New tool']);
 assert.equal(view.active.messages.at(-1).text,'Hello world');
});
