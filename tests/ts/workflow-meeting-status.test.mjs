import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as esbuild from 'esbuild';
let generation = 0;
async function fixture() {
  const built = await esbuild.build({ entryPoints: ['Hato-plugins/modules/services/workflow-runner/src/engine.ts'], bundle: true, format: 'esm', write: false });
  const E = await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64') + '#' + generation++);
  let saves = 0;
  E.initEngine({ modules: { call: async () => null }, host: { process: { terminate: async () => {} } } }, () => { saves++; });
  const B = (id, type, label = id) => ({ id, type, label, prompt: '', position: { x: 0, y: 0 } });
  const definition = { id: 'test', name: 'Rooms', blocks: [B('alice', 'ai', 'Alice'), B('bob', 'chatbox', 'Bob'), B('outside', 'ai'), B('room-a', 'meeting'), B('room-b', 'meeting')], edges: [
    { id: 'alice-a', from: 'alice', to: 'room-a', type: 'use' },
    { id: 'bob-a', from: 'bob', to: 'room-a', type: 'follow' },
    { id: 'bob-b', from: 'bob', to: 'room-b', type: 'use' },
    { id: 'bob-b-again', from: 'bob', to: 'room-b', type: 'follow' },
  ] };
  const run = { id: 'run', definition, status: 'running', blocks: definition.blocks.map(b => ({ blockId: b.id, status: 'idle', runs: 0, log: [] })) };
  const x = E.newExec(run, {});
  const state = id => E.stateOf(x, id);
  const messages = id => state(id).meeting?.messages || [];
  return { E, x, state, messages, saves: () => saves };
}

test('participant transitions post once to connected rooms, preserving unread cursors and output', async () => {
  const { E, x, state, messages, saves } = await fixture();
  E.touch(x);
  assert.deepEqual(messages('room-a'), [], 'initial idle participants produce no stale notices');
  for (const status of ['running', 'awaiting_permission', 'running', 'succeeded', 'running', 'failed']) {
    state('alice').status = status; E.touch(x); E.touch(x);
  }
  assert.deepEqual(messages('room-a').map(m => m.text), [
    '[Status] Alice started activity.', '[Status] Alice is waiting for permission.',
    '[Status] Alice started activity.', '[Status] Alice is idle.',
    '[Status] Alice started activity.', '[Status] Alice stopped with an error.',
  ]);
  assert.deepEqual(messages('room-a').map(m => m.seq), [1, 2, 3, 4, 5, 6]);
  assert.ok(messages('room-a').every(m => m.kind === 'status' && m.blockId === 'alice' && m.author === 'Alice'));
  assert.ok(state('room-a').output.includes('Alice is idle'));
  assert.equal(x.outputs.get('room-a'), state('room-a').output);
  assert.ok(saves() > 0);
  state('outside').status = 'running'; E.touch(x);
  assert.equal(messages('room-a').length, 6, 'unconnected agents never post here');
  assert.deepEqual(messages('room-b'), []);
  state('bob').status = 'running'; E.touch(x);
  assert.equal(messages('room-a').at(-1).author, 'Bob', 'Chatbox outgoing follow edges also expose rooms');
  assert.equal(messages('room-b').length, 1, 'duplicate links do not duplicate announcements');
  assert.equal(state('room-a').meeting.cursors.bob, undefined, 'automatic notices cannot consume the participant cursor');
  const unread = await E.useMeeting(x, 'room-a', 'bob', { action: 'diff' });
  assert.equal(unread.meeting.messages.length, 7);
  assert.deepEqual((await E.useMeeting(x, 'room-a', 'bob', { action: 'diff' })).meeting.messages, []);
});

test('a work-to-idle status change wakes a room waiter without any status query', async () => {
  const { E, x, state } = await fixture();
  state('alice').status = 'running'; E.touch(x);
  await E.useMeeting(x, 'room-a', 'bob', { action: 'diff' });
  const pending = E.useMeeting(x, 'room-a', 'bob', { action: 'wait', timeout_seconds: 1 });
  state('alice').status = 'succeeded'; E.touch(x);
  const result = await pending;
  assert.equal(result.meeting.status, 'updated');
  assert.deepEqual(result.meeting.messages.map(m => m.text), ['[Status] Alice is idle.']);
  assert.equal(x.meetingWaiters.size, 0);
});

test('room notifications are isolated and publishing does not discard unread notices', async () => {
  const { E, x, state } = await fixture();
  let woke = false;
  const pending = E.useMeeting(x, 'room-b', 'bob', { action: 'wait', timeout_seconds: 1 }).then(result => { woke = true; return result; });
  state('alice').status = 'running'; E.touch(x);
  await new Promise(r => setImmediate(r));
  assert.equal(woke, false, 'a room-a status change cannot wake room-b');
  await E.useMeeting(x, 'room-b', 'bob', { action: 'publish', message: 'Room B message' });
  const result = await pending;
  assert.deepEqual(result.meeting.messages.map(m => m.text), ['Room B message']);
  await E.useMeeting(x, 'room-a', 'bob', { action: 'publish', message: 'A reply before reading' });
  const unread = await E.useMeeting(x, 'room-a', 'bob', { action: 'diff' });
  assert.ok(unread.meeting.messages.some(m => m.text === '[Status] Alice started activity.'));
});

test('restoring execution does not replay prior transitions; cancellation announces stop and clears waits', async () => {
  const { E, x, state, messages } = await fixture();
  state('alice').status = 'running'; E.touch(x);
  const restored = E.newExec(structuredClone(x.run), {});
  E.touch(restored);
  assert.equal(E.stateOf(restored, 'room-a').meeting.messages.length, 1);
  const pending = E.useMeeting(x, 'room-b', 'bob', { action: 'wait', timeout_seconds: 1 });
  const rejected = assert.rejects(pending, /cancelled/);
  await E.cancel(x);
  await rejected;
  assert.equal(messages('room-a').at(-1).text, '[Status] Alice was stopped.');
  assert.equal(x.meetingWaiters.size, 0);
});

test('status traffic respects the retained Meeting history limit', async () => {
  const { E, x, state, messages } = await fixture();
  for (let i = 0; i < 1005; i++) { state('alice').status = i % 2 ? 'succeeded' : 'running'; E.touch(x); }
  assert.equal(messages('room-a').length, 1000);
  assert.equal(messages('room-a')[0].seq, 6);
  assert.equal(messages('room-a').at(-1).seq, 1005);
  assert.ok(state('room-a').log.length <= 200);
});
