import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as esbuild from 'esbuild';
const result = await esbuild.build({ entryPoints: ['sdk/context-usage.ts'], bundle: true, format: 'esm', write: false });
const { contextUsage, reportedUsage } = await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'));
test('context meter uses reported capacity and supports empty context and compaction', () => {
  assert.deepEqual(reportedUsage({ used: 53000, size: 200000, cost: {} }), { used: 53000, size: 200000 });
  assert.equal(contextUsage({ used: 53000, size: 200000 }).value, 0.265);
  assert.match(contextUsage({ used: 53000, size: 200000 }).tooltip, /27%.*53,000 \/ 200,000/);
  assert.equal(contextUsage({ used: 0, size: 200000 }).value, 0);
  assert.equal(contextUsage({ used: 10000, size: 200000 }).value, 0.05);
  assert.equal(contextUsage({ used: 250000, size: 200000 }).value, 1);
});
test('missing and invalid context reports stay unknown instead of looking empty', () => {
  for (const value of [null, {}, { used: null, size: 200000 }, { used: -1, size: 200000 }, { used: Infinity, size: 1 }, { used: 10, size: 0 }, { used: 10, size: NaN }]) assert.equal(contextUsage(value).value, null);
});

test('ACP usage notifications update live state and model changes clear stale usage', async () => {
  const built = await esbuild.build({ entryPoints: ['Hato-plugins/modules/services/acp/src/index.ts'], bundle: true, format: 'esm', write: false });
  const mod = (await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64'))).default;
  let feed;
  const events = [];
  const ctx = { modules: { async call() { return [{ id: 'codex' }, { id: 'claude' }]; } }, log: { info() {}, warn() {} }, state: { get() {}, set() {}, watch() {} }, events: { emit: (topic, value) => events.push({ topic, value }) }, host: {
    streams: { async listen(_, options, callback) { if (options.channel === 'stdout') feed = callback; } },
    process: { async write(_, line) { const request = JSON.parse(line); queueMicrotask(() => feed(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} }) + '\n')); } }
  } };
  await mod.activate(ctx, { conns: [{ conversationId: 'usage', sessionId: 's', proc: 'p', status: 'ready', stderrTail: '', nextId: 1, commands: [], configOptions: null, models: { currentModelId: 'one' } }] });
  const report = update => feed(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'usage_update', ...update } } }) + '\n');
  report({ used: 150000, size: 200000 });
  assert.deepEqual(mod.methods.state(ctx, { conversationId: 'usage' }).usage, { used: 150000, size: 200000 });
  report({ used: 10000, size: 200000 });
  assert.equal(mod.snapshot().conns[0].usage.used, 10000);
  report({ used: null, size: 200000 });
  assert.equal(mod.methods.state(ctx, { conversationId: 'usage' }).usage, null);
  report({ used: 53000, size: 200000 });
  await mod.methods.setConfig(ctx, { conversationId: 'usage', configId: '__model', value: 'two' });
  assert.equal(mod.methods.state(ctx, { conversationId: 'usage' }).usage, null);
  assert.equal(events.filter(e => e.topic === 'acp.status').at(-1).value.usage, null);
});
