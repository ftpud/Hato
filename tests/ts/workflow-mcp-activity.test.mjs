import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as esbuild from 'esbuild';

async function fixture(edgeType = "use", callerType = "chatbox") {
  const built = await esbuild.build({ entryPoints: ['modules/services/workflow-runner/src/engine.ts'], bundle: true, format: 'esm', write: false });
  const E = await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64') + '#' + Math.random());
  E.initEngine({}, () => {});
  const blocks = [{ id: 'agent', type: callerType }, { id: 'server', type: 'mcp', mcp: { serverId: 'configured' } }];
  const run = { id: 'run', status: 'succeeded', definition: { blocks, edges: [{ id: 'use', from: 'agent', to: 'server', ...(edgeType ? { type: edgeType } : {}) }] }, blocks: [{ blockId: 'agent', sessionId: 'session', status: 'succeeded', runs: 1, log: [] }] };
  const x = E.newExec(run, { mcpServers: [{ id: 'configured', name: 'MyServer' }] });
  const update = u => E.recordMcpActivity(x, 'agent', 'session', u);
  return { E, x, update, state: () => E.stateOf(x, 'server') };
}

test('MCP activity traces real calls, concurrent completions, failures, and matching return edges', async () => {
  const { x, update, state } = await fixture();
  update({ toolCallId: '1', title: 'Search', rawInput: { server: 'MyServer', tool: 'search', arguments: { query: 'hello' } }, status: 'in_progress' });
  assert.equal(state().status, 'running');
  assert.match(state().log[0].text, /hello/);
  update({ toolCallId: '2', title: 'mcp__MyServer__read', status: 'in_progress' });
  update({ toolCallId: '1', status: 'completed', content: [{ content: { text: 'Found result' } }] });
  assert.equal(state().status, 'running');
  update({ toolCallId: '2', status: 'failed', content: [{ text: 'Connection refused' }] });
  assert.equal(state().status, 'failed');
  assert.equal(state().error, 'Connection refused');
  assert.equal(state().runs, 2);
  assert.deepEqual(x.run.transfers.map(t => t.phase), ['send', 'send', 'return', 'return']);
  assert.equal(x.run.transfers[0].callId, x.run.transfers[2].callId);
  assert.equal(x.run.transfers[3].error, true);
  assert.equal(x.run.status, 'succeeded', 'observability does not reopen the completed workflow');
  const count = state().log.length;
  update({ toolCallId: '2', status: 'failed' });
  assert.equal(state().log.length, count);
});

test('MCP tracing ignores unrelated tools and sessions, and successful calls finish the block', async () => {
  const { E, x, update, state } = await fixture();
  update({ toolCallId: 'native', title: 'Read file', status: 'completed' });
  E.recordMcpActivity(x, 'agent', 'other-session', { toolCallId: 'wrong', title: 'mcp__MyServer__read' });
  assert.equal(x.run.transfers, undefined);
  update({ toolCallId: 'ok', title: 'mcp__MyServer__read', status: 'completed' });
  assert.equal(state().status, 'succeeded');
  assert.equal(state().runs, 1);
  assert.equal(state().log.length, 2);
});

for (const edge of [undefined, 'follow', 'use']) test(`Chatbox MCP activity follows ${edge || 'ordinary'} outgoing connections`, async () => {
  const { x, update, state } = await fixture(edge === undefined ? null : edge);
  update({ toolCallId: 'call', title: 'mcp__MyServer__search', status: 'in_progress' });
  update({ toolCallId: 'call', status: 'completed' });
  assert.equal(state().status, 'succeeded');
  assert.deepEqual(x.run.transfers.map(t => [t.edgeId, t.phase]), [['use', 'send'], ['use', 'return']]);
});
test('ordinary AI follow connections do not expose MCP servers as tools', async () => {
  const { x, update } = await fixture('follow', 'ai');
  update({ toolCallId: 'call', title: 'mcp__MyServer__search' });
  assert.equal(x.run.transfers, undefined);
});
