import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as esbuild from 'esbuild';
let generation = 0;
async function panel() {
  const file = 'modules/ui/workflows-panel/src/index.ts';
  const built = await esbuild.build({ stdin: { contents: (await readFile(file, 'utf8')) + '\nexport { S, rememberChatHistory };', resolveDir: process.cwd() + '/modules/ui/workflows-panel/src', loader: 'ts' }, bundle: true, format: 'esm', write: false });
  return import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64') + '#' + generation++);
}
const message = n => ({ key: `agent-msg-${n}`, role: 'user', text: `Message ${n}` });
const detail = (messages, before = 41, sessionId = 'session') => ({ id: 'run', blocks: [{ blockId: 'chat', sessionId, agentMessages: messages, agentHistoryBefore: before }] });

test('Chatbox loads older pages once, preserves loaded history through polling, and stops at the oldest page', async () => {
  const { default: mod, S, rememberChatHistory } = await panel();
  const ref = JSON.stringify(['run', 'chat']);
  const calls = [];
  let release;
  const ctx = { ui: { invalidate() {} }, modules: { async call(_module, method, args) {
    calls.push({ method, args });
    await new Promise(resolve => { release = resolve; });
    return { sessionId: 'session', messages: Array.from({ length: 40 }, (_, i) => message(i + 1)), before: null };
  } } };
  S.ws = { id: 'ws' };
  rememberChatHistory(detail(Array.from({ length: 40 }, (_, i) => message(i + 41))));
  assert.equal(S.chatHistory.get(ref).messages.length, 40);
  const event = { action: 'chatHistoryOlder', key: `chat-history:${ref}`, value: null };
  const pending = mod.onEvent(ctx, event);
  await mod.onEvent(ctx, event);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args.before, 41);
  // A live refresh while the older page is in flight must not reset its loading state.
  rememberChatHistory(detail([message(80), message(81)], 80));
  release(); await pending;
  const history = S.chatHistory.get(ref);
  assert.equal(history.messages.length, 81);
  assert.equal(history.messages[0].key, 'agent-msg-1');
  assert.equal(history.messages.at(-1).key, 'agent-msg-81');
  assert.equal(history.before, null);
  rememberChatHistory(detail([message(81), message(82)], 81));
  assert.equal(history.messages.length, 82);
  await mod.onEvent(ctx, event);
  assert.equal(calls.length, 1, 'no request after reaching oldest page');
  rememberChatHistory(detail([message(100)], null, 'replacement'));
  assert.deepEqual(S.chatHistory.get(ref).messages, [message(100)], 'a replacement session cannot inherit old history');
});

test('failed older-page requests retain the cursor and can be retried', async () => {
  const { default: mod, S, rememberChatHistory } = await panel();
  const ref = JSON.stringify(['run', 'chat']);
  S.ws = { id: 'ws' };
  rememberChatHistory(detail([message(41)]));
  let fail = true;
  const ctx = { ui: { invalidate() {} }, modules: { async call() {
    if (fail) throw new Error('Disconnected');
    return { sessionId: 'session', messages: [message(40)], before: 40 };
  } } };
  const event = { action: 'chatHistoryOlder', value: ref };
  await mod.onEvent(ctx, event);
  assert.equal(S.chatHistory.get(ref).error, 'Disconnected');
  assert.equal(S.chatHistory.get(ref).before, 41);
  assert.equal(S.chatHistory.get(ref).loading, false);
  fail = false; await mod.onEvent(ctx, event);
  assert.equal(S.chatHistory.get(ref).error, undefined);
  assert.deepEqual(S.chatHistory.get(ref).messages.map(m => m.key), ['agent-msg-40', 'agent-msg-41']);
});
