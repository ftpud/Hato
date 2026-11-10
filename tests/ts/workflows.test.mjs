import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as esbuild from 'esbuild';
import { spawnSync } from 'node:child_process';
let generation = 0;
const load = async path => import('data:text/javascript;base64,' + Buffer.from((await esbuild.build({ entryPoints: [path], bundle: true, format: 'esm', write: false, loader: { '.md': 'text', '.sql': 'text' } })).outputFiles[0].text).toString('base64') + '#' + generation++);
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 15000) { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out waiting'); await sleep(40); } }

// ---------------------------------------------------------------- fake daemon host

function fakeDb() {
  const t = { definitions: new Map(), runs: new Map(), scopes: new Map() };
  const rows = (sql, p) => {
    if (/^SELECT data FROM scopes/.test(sql)) return [...t.scopes.values()].map(data => ({ data }));
    if (/^SELECT id, data FROM runs/.test(sql)) return [...t.runs.values()].map(r => ({ id: r.id, data: r.data }));
    if (/^SELECT data, env FROM runs WHERE id=\?/.test(sql)) { const r = t.runs.get(p[0]); return r ? [{ data: r.data, env: r.env }] : []; }
    if (/^SELECT id FROM runs WHERE project=\? AND workflow=\? ORDER BY created DESC LIMIT -1 OFFSET (\d+)/.test(sql)) { const n = Number(sql.match(/OFFSET (\d+)/)[1]); return [...t.runs.values()].filter(r => r.project === p[0] && r.workflow === p[1]).sort((a, b) => b.created.localeCompare(a.created)).slice(n).map(r => ({ id: r.id })); }
    if (/^SELECT data FROM runs WHERE project=\? AND workflow=\?/.test(sql)) return [...t.runs.values()].filter(r => r.project === p[0] && r.workflow === p[1]).sort((a, b) => b.created.localeCompare(a.created)).map(r => ({ data: r.data }));
    if (/^SELECT data FROM runs WHERE project=\?/.test(sql)) return [...t.runs.values()].filter(r => r.project === p[0]).map(r => ({ data: r.data }));
    if (/^SELECT data, revision FROM definitions WHERE id=\? AND project=\?/.test(sql)) { const d = t.definitions.get(p[0]); return d && d.project === p[1] ? [d] : []; }
    if (/^SELECT revision, data, project FROM definitions WHERE id=\?/.test(sql)) { const d = t.definitions.get(p[0]); return d ? [d] : []; }
    if (/^SELECT data, revision FROM definitions WHERE project=\?/.test(sql)) return [...t.definitions.values()].filter(d => d.project === p[0]);
    throw new Error('unexpected query ' + sql);
  };
  const exec = (sql, p) => {
    if (/^CREATE/.test(sql)) return;
    if (/^INSERT INTO scopes/.test(sql)) return void t.scopes.set(p[0], p[1]);
    if (/^DELETE FROM scopes/.test(sql)) return void t.scopes.delete(p[0]);
    if (/^INSERT INTO runs/.test(sql)) return void t.runs.set(p[0], { id: p[0], project: p[1], workflow: p[2], created: p[3], data: p[4], env: p[5] });
    if (/^UPDATE runs SET data=\? WHERE id=\?/.test(sql)) { const r = t.runs.get(p[1]); if (r) r.data = p[0]; return; }
    if (/^DELETE FROM runs/.test(sql)) return void t.runs.delete(p[0]);
    if (/^INSERT INTO definitions/.test(sql)) return void t.definitions.set(p[0], { id: p[0], project: p[1], revision: p[2], data: p[3] });
    if (/^DELETE FROM definitions/.test(sql)) { const d = t.definitions.get(p[0]); if (d?.project === p[1]) t.definitions.delete(p[0]); return; }
    throw new Error('unexpected exec ' + sql);
  };
  return { t, api: { openNamespace: async () => 'db', query: async (_db, sql, p = []) => rows(sql.trim(), p), exec: async (_db, sql, p = []) => { exec(sql.trim(), p); return { changes: 1 }; } } };
}

function fakeHost() {
  const listeners = new Map(), procs = new Map(), netOut = new Map();
  let n = 0;
  const emit = (h, channel, chunk) => { for (const l of listeners.get(h) || []) if (!l.channel || l.channel === channel) l.onData(chunk); };
  const host = {
    env: { info: () => ({ platform: 'linux', sharedDir: '/tmp/hato-test-shared' }) },
    capabilities: { request: async r => ({ grant: 'g' + ++n, root: r.root }), release: async () => {} },
    fs: { writeAtomic: async () => ({}), read: async (_g, path) => ({ path, binary: false, truncated: false, text: `# Skill at ${path}` }) },
    resources: { release: async () => {} },
    streams: { listen: async (h, opts, onData, onEnd) => { const l = { channel: opts?.channel, onData, onEnd }; listeners.set(h, [...(listeners.get(h) || []), l]); return { subId: 's', close: async () => {} }; } },
    process: {
      spawn: async (_g, req) => { const h = 'p' + ++n; procs.set(h, { req, stdin: '' }); return { handle: h, pid: n }; },
      write: async (h, text) => { procs.get(h).stdin += text; },
      closeStdin: async () => {},
      terminate: async h => { const p = procs.get(h); if (p) p.killed = true; },
      wait: async h => {
        const p = procs.get(h);
        const r = spawnSync('/bin/sh', ['-c', p.req.args[1]], { input: p.stdin, env: { ...process.env, ...p.req.env }, encoding: 'utf8' });
        if (r.stdout) emit(h, 'stdout', r.stdout); if (r.stderr) emit(h, 'stderr', r.stderr);
        return { code: p.killed ? null : r.status, signal: null };
      },
    },
    net: { listenLoopback: async () => ({ handle: 'listener', port: 4321 }), write: async (h, line) => { (netOut.get(h) || netOut.set(h, []).get(h)).push(line); }, close: async () => {} },
  };
  // A fake MCP client: connect, authenticate with the endpoint token and call a tool.
  let rpc = 0;
  async function mcp(token, name, args) {
    const conn = 'conn' + ++n;
    for (const l of listeners.get('listener') || []) l.onData(JSON.stringify({ connection: conn }) + '\n');
    await sleep(5);
    const id = ++rpc;
    for (const l of listeners.get(conn) || []) l.onData(JSON.stringify({ token }) + '\n' + JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) + '\n');
    const reply = await until(() => (netOut.get(conn) || []).map(l => JSON.parse(l)).find(m => m.id === id));
    const text = reply.result.content[0].text;
    if (reply.result.isError) throw new Error(text);
    try { return JSON.parse(text); } catch { return text; }
  }
  return { host, mcp, procs };
}

/** agent-runner stand-in: every prompt is answered by `respond(spec, text, tools)`. */
function fakeAgents(mcp, respond) {
  const sessions = new Map(); let seq = 0;
  const push = (s, role, text) => s.messages.push({ key: `agent-msg-${++seq}`, role, text });
  return {
    sessions,
    async call(method, a) {
      if (method === 'create') { sessions.set(a.spec.id, { spec: a.spec, status: 'ready', messages: [] }); return { id: a.spec.id }; }
      const s = sessions.get(a.id); if (!s) throw new Error('no session');
      if (method === 'view') return { session: { status: s.status, error: null }, messages: s.messages.slice(-(a.limit || 100)), permissions: [] };
      if (method === 'cancel') { s.status = 'ready'; push(s, 'system', 'Turn ended: cancelled'); return null; }
      if (method === 'send') {
        if (s.status === 'busy') { push(s, 'user', a.text); return { steered: true }; }
        s.status = 'busy'; push(s, 'user', a.text);
        const token = s.spec.mcps[0].env.find(e => e.name === 'HATO_MCP_TOKEN').value;
        void (async () => {
          try { push(s, 'assistant', String(await respond(s.spec, a.text, (name, args) => mcp(token, name, args)))); }
          catch (e) { push(s, 'error', e.message); }
          s.status = 'ready'; push(s, 'system', 'Turn ended: end_turn');
        })();
        return { accepted: true };
      }
      throw new Error('unexpected agent-runner call ' + method);
    },
  };
}

async function runtime(respond = async () => 'ok') {
  const mod = (await load('Hato-plugins/modules/services/workflow-runner/src/index.ts')).default;
  const { host, mcp } = fakeHost(), db = fakeDb();
  host.db = db.api;
  const agents = fakeAgents(mcp, respond);
  const events = [];
  const ctx = { moduleId: 'workflow-runner', host, log: { info() {}, warn() {}, error: (...a) => console.error(...a) }, events: { emit: (t, v) => events.push([t, v]), on() {} },
    modules: { call: (target, method, args) => { assert.equal(target, 'agent-runner'); return agents.call(method, args); } } };
  await mod.activate(ctx);
  const meta = { caller: 'daemon-client' };
  const m = (name, args = {}) => mod.methods[name](ctx, args, meta);
  const env = { projectId: 'p1', workspaceId: 'ws', workspaceName: 'WS', root: '/tmp', machineId: 'local', profiles: [{ id: 'claude', provider: 'claude', name: 'Claude', executable: 'x', args: [] }], defaultProfileId: 'claude', claudeSubscription: true, mcpServers: [] };
  const start = async (definition, input = '', startBlockId) => {
    await m('save', { projectId: 'p1', definition, expectedRevision: null });
    const r = await m('start', { projectId: 'p1', workflowId: definition.id, input, startBlockId, env });
    return r.id;
  };
  const finished = id => until(async () => { const r = await m('run', { id }); return ['succeeded', 'failed', 'cancelled'].includes(r.status) && r; });
  return { mod, m, start, finished, agents, events, db, env };
}
const B = (id, type, extra = {}) => ({ id, type, label: id, prompt: '', position: { x: 0, y: 0 }, ...extra });
const out = (run, id) => run.blocks.find(b => b.blockId === id);

// ---------------------------------------------------------------- shared definition helpers

test('definitions normalize, validate and render templates', async () => {
  const W = await load('sdk/workflows.ts');
  const { WORKFLOW_TEMPLATES } = await load('sdk/workflow-templates.ts');
  assert.deepEqual(WORKFLOW_TEMPLATES.map(t => t.id), ['blank', 'multi-agent-setup']);
  const team = WORKFLOW_TEMPLATES.find(t => t.id === 'multi-agent-setup').graph();
  assert.ok(team.blocks.some(b => b.type === 'start_input'));
  for (const agent of team.blocks.filter(b => b.type === 'ai')) assert.ok(team.edges.some(e => e.from === agent.id && e.to === 'meeting' && e.type === 'use'));
  assert.equal(team.edges.filter(e => e.from === 'coordinator' && e.type === 'use' && e.to !== 'meeting').length, 3);
  for (const t of WORKFLOW_TEMPLATES.filter(t => t.id !== 'blank')) {
    const d = W.normalizeDefinition({ id: t.id, name: t.name, ...t.graph() });
    assert.deepEqual(W.blockingIssues(W.validateWorkflow(d, { profiles: [{ id: 'c', provider: 'claude' }] })), [], t.id);
  }
  const bad = W.normalizeDefinition({ name: 'x', blocks: [B('a', 'text'), B('b', 'script'), B('c', 'review'), B('d', 'ai')], edges: [{ id: 'e', from: 'a', to: 'b', type: 'use' }, { id: 'f', from: 'a', to: 'zz' }] });
  const codes = W.validateWorkflow(bad, { profiles: [] }).map(i => i.code);
  for (const c of ['empty-command', 'unsupported-type', 'invalid-use', 'missing-endpoint', 'empty-prompt', 'unavailable-provider']) assert.ok(codes.includes(c), c);
  assert.equal(W.renderPrompt('In: {{input}} / {{ blocks.a.output }} / {{blocks.none.output}}', 'X', new Map([['a', 'A']])), 'In: X / A / ');
  assert.match(W.renderPrompt('{{blocks.a.output}}', '', { a: 'z'.repeat(30000) }), /characters omitted/);
  // HatoPad workspace agent references map to workspace instruction files.
  assert.equal(W.normalizeDefinition({ blocks: [B('a', 'ai', { agent: { scope: 'workspace', name: 'r.md' } })] }).blocks[0].agentFile, '.agents/agents/r.md');
});

test('revisions protect definitions from concurrent edits', async () => {
  const { m, mod } = await runtime();
  const def = { id: 'wf', name: 'WF', blocks: [B('t', 'text', { prompt: 'hi' })], edges: [] };
  const first = await m('save', { projectId: 'p1', definition: def, expectedRevision: null });
  assert.equal(first.revision, 1);
  await assert.rejects(m('save', { projectId: 'p1', definition: def, expectedRevision: null }), /already exists/);
  await assert.rejects(m('save', { projectId: 'p1', definition: def, expectedRevision: 7 }), /Revision conflict/);
  assert.equal((await m('save', { projectId: 'p1', definition: { ...def, name: 'Renamed' }, expectedRevision: 1 })).revision, 2);
  await assert.rejects(m('save', { projectId: 'other', definition: def, expectedRevision: 2 }), /another project/);
  assert.deepEqual((await m('list', { projectId: 'p1' })).map(w => [w.id, w.name, w.revision]), [['wf', 'Renamed', 2]]);
  // Only the desktop gateway (over the daemon link) may mutate definitions and runs.
  await assert.rejects(Promise.resolve().then(() => mod.methods.save({}, { projectId: 'p1', definition: def }, { caller: 'some-module' })), /gateway/);
});

test('follow connections pass outputs through scripts, templates and joins', async () => {
  const { start, finished } = await runtime();
  const id = await start({ id: 'flow', name: 'Flow', blocks: [
    B('start', 'start_button', { prompt: 'hello' }),
    B('upper', 'script', { command: 'tr a-z A-Z' }),
    B('env', 'script', { command: 'printf "%s!" "$HATO_WORKFLOW_INPUT"' }),
    B('joined', 'text', { prompt: '{{input}}|{{blocks.upper.output}}' }),
  ], edges: [
    { id: 'a', from: 'start', to: 'upper' }, { id: 'b', from: 'start', to: 'env' },
    { id: 'c', from: 'upper', to: 'joined' }, { id: 'd', from: 'env', to: 'joined' },
  ] });
  const run = await finished(id);
  assert.equal(run.status, 'succeeded', run.error);
  assert.equal(out(run, 'upper').output, 'HELLO');
  assert.equal(out(run, 'env').output, 'hello!');
  assert.equal(out(run, 'joined').runs, 1, 'a join runs once');
  assert.match(out(run, 'joined').output, /## upper \(upper\)\nHELLO[\s\S]*## env \(env\)\nhello!\|HELLO/);
});

test('a failing script fails the run; cancelled runs stop waiting', async () => {
  const { start, finished, m } = await runtime();
  const failed = await finished(await start({ id: 'f', name: 'F', blocks: [B('s', 'script', { command: 'echo nope >&2; exit 3' }), B('after', 'text', { prompt: 'x' })], edges: [{ id: 'e', from: 's', to: 'after' }] }));
  assert.equal(failed.status, 'failed');
  assert.match(out(failed, 's').error, /exited with 3: nope/);
  assert.equal(out(failed, 'after').status, 'idle');
  const id = await start({ id: 'q', name: 'Q', blocks: [B('ask', 'user_prompt', { prompt: 'Name?' })], edges: [] });
  await until(async () => out(await m('run', { id }), 'ask').status === 'awaiting_user_input');
  await m('cancel', { id });
  assert.equal((await finished(id)).status, 'cancelled');
});

test('user prompts pause until answered and yes/no prompts select a path', async () => {
  const { start, finished, m } = await runtime();
  const id = await start({ id: 'yn', name: 'YN', blocks: [
    B('ask', 'yes_no_prompt', { prompt: 'Ship {{input}}?' }), B('yes', 'text', { prompt: 'shipping' }), B('no', 'text', { prompt: 'holding' }),
  ], edges: [{ id: 'y', from: 'ask', to: 'yes', type: 'path', label: 'yes' }, { id: 'n', from: 'ask', to: 'no', type: 'path', label: 'no' }] }, 'v2');
  const waiting = await until(async () => { const r = await m('run', { id }); return out(r, 'ask').status === 'awaiting_user_input' && r; });
  assert.equal(waiting.status, 'waiting');
  assert.equal(out(waiting, 'ask').question, 'Ship v2?');
  await assert.rejects(m('answer', { runId: id, blockId: 'ask', pauseId: 'stale', answer: 'yes' }), /no longer waiting/);
  await m('answer', { runId: id, blockId: 'ask', pauseId: out(waiting, 'ask').pauseId, answer: 'Yes' });
  const run = await finished(id);
  assert.equal(run.status, 'succeeded');
  assert.equal(out(run, 'yes').output, 'shipping');
  assert.equal(out(run, 'no').status, 'idle');
});

test('timers pass their input to followers after waiting', async () => {
  const { start, finished } = await runtime();
  const run = await finished(await start({ id: 't', name: 'T', blocks: [B('s', 'start_input'), B('wait', 'timer', { seconds: 0 }), B('done', 'text', { prompt: 'after {{input}}' })],
    edges: [{ id: 'a', from: 's', to: 'wait' }, { id: 'b', from: 'wait', to: 'done' }] }, 'tick'));
  assert.equal(run.status, 'succeeded');
  assert.equal(out(run, 'done').output, 'after tick');
});

test('AI agents use connected blocks through the workflow MCP endpoint and choose paths', async () => {
  const seen = [];
  const { start, finished, agents } = await runtime(async (spec, text, tool) => {
    seen.push({ name: spec.name, text });
    if (spec.workflow.blockId === 'helper') return `helper saw: ${text.split('Input:\n').pop()}`;
    const connections = await tool('workflow_connections', {});
    assert.deepEqual(connections.map(c => c.block_id).sort(), ['helper', 'status', 'tips']);
    const status = await tool('workflow_use_block', { block_id: 'status', input: 'ignored' });
    const tips = await tool('workflow_use_block', { block_id: 'tips' });
    const help = await tool('workflow_use_block', { block_id: 'helper', input: 'question' });
    await assert.rejects(tool('workflow_use_block', { block_id: 'good' }), /not connected/);
    await assert.rejects(tool('workflow_choose_path', { path: 'nowhere' }), /Unknown path/);
    await tool('workflow_choose_path', { path: 'bad' });
    return `${status.output.trim()} / ${tips.output} / ${help.output}`;
  });
  const id = await start({ id: 'ai', name: 'AI', blocks: [
    B('start', 'start_button', { prompt: 'review' }),
    B('lead', 'ai', { prompt: 'Lead: {{input}}', autopilot: true }),
    B('helper', 'ai', { prompt: 'Help' }),
    B('status', 'script', { command: 'echo clean' }),
    B('tips', 'text', { prompt: 'be brief' }),
    B('good', 'text', { prompt: 'G {{input}}' }), B('bad', 'text', { prompt: 'B {{input}}' }),
  ], edges: [
    { id: 's', from: 'start', to: 'lead' },
    { id: 'u1', from: 'lead', to: 'status', type: 'use' }, { id: 'u2', from: 'lead', to: 'tips', type: 'use' }, { id: 'u3', from: 'lead', to: 'helper', type: 'use' },
    { id: 'p1', from: 'lead', to: 'good', type: 'path', label: 'good' }, { id: 'p2', from: 'lead', to: 'bad', type: 'path', label: 'bad' },
  ] });
  const run = await finished(id);
  assert.equal(run.status, 'succeeded', run.error);
  assert.equal(out(run, 'lead').output, 'clean / be brief / helper saw: question');
  assert.equal(out(run, 'lead').selectedRoute, 'bad');
  assert.equal(out(run, 'bad').output, 'B clean / be brief / helper saw: question');
  assert.equal(out(run, 'good').status, 'idle');
  const calls = run.transfers.filter(t => t.phase === 'send');
  assert.deepEqual(calls.map(t => t.edgeId), ['u1', 'u2', 'u3']);
  for (const call of calls) {
    const response = run.transfers.find(t => t.callId === call.callId && t.phase === 'return');
    assert.equal(response.edgeId, call.edgeId);
    assert.ok(response.seq > call.seq);
    assert.ok(response.chars > 0);
  }
  assert.ok(run.transfers.some(t => t.edgeId === 'p2' && t.phase === 'flow'));
  assert.ok(!run.transfers.some(t => t.edgeId === 'p1'), 'unchosen paths have no transfer');

  const lead = [...agents.sessions.values()].find(s => s.spec.workflow.blockId === 'lead').spec;
  assert.equal(lead.autopilot, true);
  assert.equal(lead.root, '/tmp');
  assert.equal(lead.mcps[0].name, 'hato-workflow');
  assert.match(seen.find(s => s.name === 'AI · lead').text, /Available paths: \["good","bad"\][\s\S]*Lead: review/);
});

test('an agent that skips a required path fails; chatbox turns reuse their session after the run', async () => {
  const { start, finished, m, agents } = await runtime(async (spec, text, tool) => {
    if (spec.workflow.blockId === 'chat') { const r = await tool('workflow_use_block', { block_id: 'calc', input: text.split('\n').pop() }); return `= ${r.output.trim()}`; }
    return 'no route chosen';
  });
  const failed = await finished(await start({ id: 'np', name: 'NP', blocks: [B('a', 'ai', { prompt: 'x' }), B('t', 'text', { prompt: 'y' })], edges: [{ id: 'p', from: 'a', to: 't', type: 'path', label: 'go' }] }));
  assert.equal(failed.status, 'failed');
  assert.match(out(failed, 'a').error, /without choosing a path/);

  const id = await start({ id: 'cb', name: 'CB', blocks: [B('chat', 'chatbox', { prompt: 'You compute.' }), B('calc', 'script', { command: 'cat | wc -c | tr -d " "' })], edges: [{ id: 'c', from: 'chat', to: 'calc' }] });
  assert.equal((await finished(id)).status, 'succeeded', 'a chatbox-only run is ready for chat');
  await m('chat', { runId: id, blockId: 'chat', text: 'abcd' });
  const one = await until(async () => { const r = await m('run', { id }); return out(r, 'chat').chat?.length === 2 && r.status === 'succeeded' && r; });
  assert.equal(out(one, 'chat').chat[1].text, '= 4');
  await m('chat', { runId: id, blockId: 'chat', text: 'abcdefgh' });
  const two = await until(async () => { const r = await m('run', { id }); return out(r, 'chat').chat?.length === 4 && r.status === 'succeeded' && r; });
  assert.equal(out(two, 'chat').chat[3].text, '= 8');
  assert.equal([...agents.sessions.values()].filter(s => s.spec.workflow.runId === id).length, 1, 'one session per chatbox');
});

test('meetings keep attributed transcripts and per-participant cursors', async () => {
  const { start, finished } = await runtime(async (spec, _text, tool) => {
    if (spec.workflow.blockId === 'alice') { await tool('workflow_use_block', { block_id: 'room', action: 'publish', message: 'proposal A' }); return 'posted'; }
    const status = await tool('workflow_use_block', { block_id: 'room', action: 'status' });
    assert.deepEqual(status.meeting.peers.map(p => p.block_id).sort(), ['alice', 'bob']);
    const diff = await tool('workflow_use_block', { block_id: 'room', action: 'diff' });
    const again = await tool('workflow_use_block', { block_id: 'room' });
    return `${diff.meeting.messages.filter(m => m.kind !== "status").map(m => `${m.author}: ${m.text}`).join(';')} | unread after: ${again.meeting.messages.length}`;
  });
  const run = await finished(await start({ id: 'm', name: 'M', blocks: [
    B('go', 'start_button', { prompt: 'discuss' }), B('alice', 'ai', { prompt: 'a' }), B('bob', 'ai', { prompt: 'b' }), B('room', 'meeting'),
  ], edges: [{ id: 'g', from: 'go', to: 'alice' }, { id: 'h', from: 'alice', to: 'bob' }, { id: 'u1', from: 'alice', to: 'room', type: 'use' }, { id: 'u2', from: 'bob', to: 'room', type: 'use' }] }));
  assert.equal(run.status, 'succeeded', run.error);
  assert.equal(out(run, 'bob').output, 'alice: proposal A | unread after: 0');
  assert.equal(out(run, 'room').status, 'idle');
  assert.ok(out(run, 'room').log.some(entry => entry.kind === 'tool' && entry.text.includes('publish')));
  assert.ok(out(run, 'room').log.some(entry => entry.kind === 'response' && entry.text.includes('proposal A')));
  const { blockRunView } = await load('Hato-plugins/modules/ui/workflows-panel/src/runs.ts');
  const nodes = blockRunView(run, run.definition.blocks.find(b => b.id === 'room'), out(run, 'room'), 'test');
  assert.ok(nodes.some(n => n.key.endsWith(':transcript') && n.scroll));
  assert.ok(nodes.some(n => n.key.endsWith(':activity-section') && n.children.some(c => c.action === 'toggleActivity')));
});

test('configurator endpoints read and write only their own project', async () => {
  const { m, mod } = await runtime();
  const W = await load('sdk/workflows.ts');
  await m('save', { projectId: 'p2', definition: { id: 'other', name: 'Other', blocks: [], edges: [] }, expectedRevision: null });
  const endpoint = await m('configEndpoint', { projectId: 'p1', sessionId: 's', profiles: [{ id: 'claude', provider: 'claude' }] });
  assert.equal(endpoint.name, 'hato-workflow');
  assert.ok(W.WORKFLOW_REFERENCE.includes('workflow_use_block'));
  void mod;
});

test('workflows panel renders the designer canvas and edits a draft', async () => {
  const mod = (await load('Hato-plugins/modules/ui/workflows-panel/src/index.ts')).default;
  const calls = [], emitted = [], watchers = new Map();
  let delayedGet;
  const def = { id: 'wf', name: 'WF', version: 1, createdAt: '', updatedAt: '', blocks: [B('start', 'start_button', { prompt: 'go', position: { x: 10, y: 10 } }), B('lead', 'ai', { prompt: '{{input}}', position: { x: 300, y: 10 } })], edges: [] };
  const ctx = { events: { on() {}, emit: (t, v) => emitted.push([t, v]) }, state: { get: k => k === 'workspace.selected' ? { id: 'ws', name: 'WS', location: 'local' } : { workflows: true }, watch(k, fn) { watchers.set(k, fn); } }, ui: { invalidate() {} },
    modules: { async call(module, method, args) {
      calls.push([module, method, args]); assert.equal(module, 'workflows');
      if (method === 'providerOptions') return { models: [{ value: 'model-one', label: 'Model one' }], reasoning: [{ value: 'high', label: 'High' }] };
      if (method === 'catalog') return { profiles: [{ id: 'claude', name: 'Claude', provider: 'claude' }], skills: [], agentFiles: [], mcps: [], templates: [{ id: 'blank', name: 'Blank' }] };
      if (method === 'list') return [{ id: 'wf', name: 'WF', revision: 3, blocks: 2 }];
      if (method === 'get') { if (delayedGet) await delayedGet; return { definition: structuredClone(def), revision: 3, issues: [] }; }
      if (method === 'runs') return [];
      if (method === 'save') return { revision: 4, definition: args.definition, issues: [] };
      throw new Error('unexpected ' + method);
    } } };
  await mod.activate(ctx);
  const event = (action, value = '', key = action, inputs = {}) => mod.onEvent(ctx, { action, key, value, inputs });
  await event('openDesigner', 'wf');
  const walk = n => [n, ...(n.children || []).flatMap(walk), ...(n.items || []).flatMap(i => (i.children || []).flatMap(walk))];
  const nodes = () => walk(mod.render());
  const canvas = () => nodes().find(n => n.type === 'canvas' && n.moveAction === 'moveBlock');
  assert.ok(nodes().some(n => n.type === 'window'), 'designer opens in its own window');
  assert.equal(nodes().find(n => n.type === 'window').titlebar, false);
  assert.ok(nodes().some(n => n.windowDrag === true));
  assert.deepEqual(canvas().items.map(i => [i.key, i.x, i.port]), [['start', 10, true], ['lead', 300, true]]);
  await event('connect', { from: 'start', to: 'lead' });
  assert.deepEqual(canvas().edges.map(e => [e.from, e.to, e.label]), [['start', 'lead', 'follow']]);
  await event('selectBlock', { key: 'lead' });
  assert.ok(nodes().some(n => n.type === 'select' && n.key === 'f:lead:model'));
  assert.ok(nodes().some(n => n.type === 'select' && n.key === 'f:lead:reasoning'));
  await event('field', 'model-one', 'f:lead:model');
  await event('field', 'high', 'f:lead:reasoning');
  assert.equal(mod.snapshot().draft.blocks.find(b => b.id === 'lead').reasoning, 'high');
  await event('field', 'claude', 'f:lead:profileId');
  assert.equal(mod.snapshot().draft.blocks.find(b => b.id === 'lead').reasoning, undefined, 'provider changes clear incompatible choices');
  await event('field', 'model-one', 'f:lead:model');
  await event('field', 'high', 'f:lead:reasoning');
  await event('addBlock', 'script');
  assert.ok(canvas().edges.some(e => e.from === 'lead' && e.to === 'script-1' && e.label === 'follow'), 'adding after a selected block connects it');
  await event('mode', 'use');
  await event('connect', { from: 'lead', to: 'script-1' });
  assert.ok(canvas().edges.some(e => e.from === 'lead' && e.to === 'script-1' && e.dashed));
  await event('moveBlock', { key: 'lead', x: 405, y: 97 });
  assert.deepEqual([canvas().items[1].x, canvas().items[1].y], [408, 96], 'positions snap to the grid');
  await event('undo');
  assert.equal(canvas().items[1].x, 300);
  await event('save');
  const saved = calls.find(c => c[1] === 'save')[2];
  assert.equal(saved.expectedRevision, 3);
  assert.equal(saved.definition.blocks.length, 3);
  assert.equal(saved.definition.blocks.find(b => b.id === 'lead').reasoning, 'high');
  await event('confirmBlock', 'script-1');
  const windowNode = nodes().find(n => n.type === 'window');
  assert.ok(walk(windowNode).some(n => n.key === 'delete-block-confirmation'), 'delete confirmation belongs to the designer window');
  assert.ok(!mod.render().children.some(n => n.type === 'modal'), 'block confirmation does not open in the main window');
  await event('confirmNo');
  assert.ok(canvas().items.some(b => b.key === 'script-1'));
  await event('confirmBlock', 'script-1');
  await event('confirmYes');
  assert.ok(!canvas().items.some(b => b.key === 'script-1'));
  assert.ok(!canvas().edges.some(e => e.from === 'script-1' || e.to === 'script-1'));
  await event('undo');
  assert.ok(canvas().items.some(b => b.key === 'script-1'), 'undo restores the block');
  assert.ok(canvas().edges.some(e => e.to === 'script-1'), 'undo restores its connections');

  await event('openChat', 'session-1');
  assert.deepEqual(emitted.at(-1), ['workflows-panel.openChat', { workspaceId: 'ws', id: 'session-1' }]);
  await event('field', 'Edited in WS', 'f:lead:label');
  const workspaceChanged = watchers.get('workspace.selected');
  workspaceChanged({ id: 'other', name: 'Other', location: 'local' });
  await until(() => mod.snapshot().workspaceId === 'other');
  assert.equal(mod.snapshot().draft, null, 'the previous workspace draft is isolated');
  workspaceChanged({ id: 'ws', name: 'WS', location: 'local' });
  assert.equal(mod.snapshot().draft.blocks.find(b => b.id === 'lead').label, 'Edited in WS');
  assert.equal(mod.snapshot().dirty, true, 'returning to a workspace restores its unsaved draft');
  const restored = mod.snapshot();
  assert.ok(restored.undo.length, 'reload snapshots retain undo history');
  workspaceChanged({ id: 'third', name: 'Third', location: 'local' });
  await event('refresh');
  let release;
  delayedGet = new Promise(resolve => { release = resolve; });
  const opening = event('openDesigner', 'wf');
  workspaceChanged({ id: 'fourth', name: 'Fourth', location: 'local' });
  delayedGet = null;
  release();
  await opening;
  assert.equal(mod.snapshot().workspaceId, 'fourth');
  assert.equal(mod.snapshot().draft, null, 'a delayed designer load cannot replace the new workspace draft');
  assert.equal(mod.snapshot().designerOpen, false);
  mod.deactivate();
});

test('pulses follow exact send/return boundaries once, on the matching connection', async () => {
  const { transferEdges } = await load('Hato-plugins/modules/ui/workflows-panel/src/transfers.ts');
  const now = Date.now();
  const edges = [{ key: 'call', from: 'agent', to: 'tool' }, { key: 'unused', from: 'agent', to: 'other' }];
  const run = { id: 'pulse-run', transfers: [
    { seq: 1, callId: 'c1', edgeId: 'call', phase: 'send', at: new Date(now).toISOString() },
    { seq: 2, callId: 'c1', edgeId: 'call', phase: 'return', at: new Date(now).toISOString() },
  ] };
  const active = time => transferEdges(edges, run, time).filter(e => e.active);
  assert.deepEqual(active(now).map(e => [e.from, e.to]), [['agent', 'tool']]);
  assert.deepEqual(active(now + 1400).map(e => [e.from, e.to]), [['tool', 'agent']]);
  assert.deepEqual(active(now + 2800), [], 'waiting does not keep a connection pulsing');
  assert.deepEqual(active(now + 2900), [], 'rerenders do not replay consumed events');
  assert.deepEqual(transferEdges(edges, { id: 'legacy-run', blocks: [{ status: 'running' }] }, now), edges, 'status alone never produces pulses');
  assert.deepEqual(transferEdges(edges, { id: 'old', transfers: run.transfers }, now + 10000), edges, 'opening old history never replays it');
});

test('workflow reports scroll within a bounded output area and retain supplied text', async () => {
  const { blockRunView } = await load('Hato-plugins/modules/ui/workflows-panel/src/runs.ts');
  const output = '# Report\n\n' + 'Evidence line\n'.repeat(700);
  const nodes = blockRunView({ id: 'run', status: 'succeeded' }, B('report', 'markdown'), { blockId: 'report', status: 'succeeded', runs: 1, output }, 'test');
  const box = nodes.find(n => n.key.endsWith(':out'));
  assert.equal(box.scroll, true);
  assert.equal(box.maxHeight, 320);
  assert.equal(box.children[0].text, output);
});

test('Terminal Control uses scoped daemon PTYs and rejects other workspace terminals', async () => {
  const { terminalAction } = await load('Hato-plugins/modules/services/workflow-runner/src/terminal.ts');
  const ops = [], released = [];
  const ctx = { host: {
    capabilities: { request: async () => ({ grant: 'g' }), release: async g => released.push(g) },
    process: { run: async (_g, request, opts) => {
      assert.deepEqual(request.args, ['daemon', 'ctl', '--dir', '/daemon']);
      const command = JSON.parse(opts.stdin); ops.push(command);
      const value = command.op === 'resources.list'
        ? { ptys: [{ key: 'inside', cwd: '/workspace/sub' }, { key: 'outside', cwd: '/workspace-other' }] }
        : { text: 'terminal evidence' };
      return { code: 0, stdout: JSON.stringify({ ok: true, value }) };
    } },
  } };
  const env = { root: '/workspace', daemon: { bin: '/hatod', dir: '/daemon' } };
  assert.deepEqual((await terminalAction(ctx, env, 'list', {})).map(p => p.key), ['inside']);
  assert.equal((await terminalAction(ctx, env, 'read', { key: 'inside', cursor: 8 })).text, 'terminal evidence');
  await terminalAction(ctx, env, 'write', { key: 'inside', text: 'echo test\n' });
  assert.equal(ops.at(-1).args.text, 'echo test\n');
  await assert.rejects(terminalAction(ctx, env, 'read', { key: 'outside' }), /outside this workspace/);
  assert.equal(ops.filter(o => o.op === 'pty.read').length, 1);
  assert.equal(released.length, ops.length);
});

test('Terminal Control errors appear on the called block and return on its exact edge', async () => {
  const { start, finished, agents } = await runtime(async (_spec, _text, tool) => {
    await assert.rejects(tool('workflow_use_block', { block_id: 'terminal', action: 'list' }), /requires the workspace daemon/);
    return 'checked error';
  });
  const run = await finished(await start({ id: 'terminal-log', name: 'Terminal logging', blocks: [
    B('go', 'start_button', { prompt: 'test' }), B('agent', 'ai', { prompt: 'list' }), B('terminal', 'terminal_control'),
  ], edges: [{ id: 'start', from: 'go', to: 'agent' }, { id: 'terminal-call', from: 'agent', to: 'terminal', type: 'use' }] }));
  assert.equal(run.status, 'succeeded');
  const logs = out(run, 'terminal').log;
  assert.ok(logs.some(l => l.kind === 'tool' && l.text.includes('list')));
  assert.ok(logs.some(l => l.kind === 'error' && l.text.includes('requires the workspace daemon')));
  assert.ok(run.transfers.some(t => t.edgeId === 'terminal-call' && t.phase === 'return' && t.error));
  assert.equal([...agents.sessions.values()][0].spec.workspaceMcp, false, 'terminal-only agents use the logged workflow tool');
});

test('library selection shows logs for idle Meeting and Terminal blocks', async t => {
  const mod = (await load('Hato-plugins/modules/ui/workflows-panel/src/index.ts')).default;
  t.after(() => mod.deactivate());
  const def = { id: 'logs', name: 'Logs', blocks: [B('room', 'meeting'), B('term', 'terminal_control')], edges: [] };
  const at = new Date().toISOString();
  const run = { id: 'logs-run', workflowId: 'logs', status: 'succeeded', createdAt: at, definition: def, blocks: [
    { blockId: 'room', status: 'idle', runs: 0, log: [{ at, kind: 'tool', text: 'meeting call' }], meeting: { messages: [{ seq: 1, at, blockId: 'alice', author: 'Alice', text: 'proposal' }] } },
    { blockId: 'term', status: 'idle', runs: 0, log: [{ at, kind: 'response', text: 'terminal list evidence' }] },
  ] };
  const ctx = { events: { on() {} }, state: { get: k => k === 'workspace.selected' ? { id: 'ws' } : { workflows: true }, watch() {} }, ui: { invalidate() {} }, modules: { call: async (_module, method) => {
    if (method === 'catalog') return {};
    if (method === 'list') return [{ id: 'logs', name: 'Logs', blocks: 2 }];
    if (method === 'runs') return [run];
    if (method === 'get') return { definition: def };
    if (method === 'runDetail') return run;
    throw new Error(method);
  } } };
  await mod.activate(ctx);
  const walk = n => [n, ...(n.children || []).flatMap(walk)];
  await mod.onEvent(ctx, { action: 'previewSelect', key: 'preview:logs', value: { key: 'room' } });
  let texts = walk(mod.render()).map(n => n.text);
  assert.ok(texts.includes('Meeting transcript'));
  assert.ok(texts.includes('proposal'));
  await mod.onEvent(ctx, { action: 'previewSelect', key: 'preview:logs', value: { key: 'term' } });
  texts = walk(mod.render()).map(n => n.text);
  assert.ok(texts.some(text => text?.startsWith('Activity log')));
  assert.ok(!texts.includes('terminal list evidence'), 'logs start collapsed');
  const toggle = walk(mod.render()).find(n => n.action === 'toggleActivity');
  await mod.onEvent(ctx, { action: 'toggleActivity', value: toggle.value });
  let tree = mod.render();
  assert.ok(walk(tree).some(n => n.text === 'terminal list evidence'));
  const log = walk(tree).find(n => n.key.endsWith(':activity'));
  assert.equal(log.scroll, true);
  assert.equal(log.height, 220);
  const workflowCard = walk(tree).find(n => n.key === 'card:logs');
  assert.ok(workflowCard.children.some(n => n.key.endsWith(':activity-section')), 'activity is a separate card below details');
  await mod.onEvent(ctx, { action: 'maximize', value: 'logs' });
  tree = mod.render();
  assert.ok(walk(tree).some(n => n.key === 'card-content' && n.grow && n.scroll), 'maximized workflow has its own bounded scrolling body');
  await mod.onEvent(ctx, { action: 'toggleActivity', value: toggle.value });
  assert.ok(!walk(mod.render()).some(n => n.key.endsWith(':activity')), 'log body disappears when collapsed');
});

test('Meeting shake requires a specific message and delivers it to the selected participant', async () => {
  const message = 'Review proposal B and publish the missing test cases.';
  const { start, finished, agents } = await runtime(async (spec, _text, tool) => {
    if (spec.workflow.blockId === 'peer') return 'received';
    for (const payload of [{}, { message: '   ' }, { message: 'x'.repeat(10001) }]) {
      await assert.rejects(tool('workflow_use_block', { block_id: 'room', action: 'shake', peer_block_id: 'peer', ...payload }), /specific message/);
    }
    assert.ok(![...agents.sessions.values()].some(s => s.spec.workflow.blockId === 'peer'), 'invalid shakes cannot start the peer');
    const result = await tool('workflow_use_block', { block_id: 'room', action: 'shake', peer_block_id: 'peer', message });
    assert.equal(result.meeting.shake.delivery, 'started');
    return 'sent';
  });
  const run = await finished(await start({ id: 'shake-message', name: 'Shake message', blocks: [
    B('go', 'start_button', { prompt: 'notify' }), B('lead', 'ai', { prompt: '{{input}}' }), B('peer', 'ai', { prompt: '{{input}}' }), B('room', 'meeting'),
  ], edges: [{ id: 'go-lead', from: 'go', to: 'lead' }, { id: 'lead-room', from: 'lead', to: 'room', type: 'use' }, { id: 'peer-room', from: 'peer', to: 'room', type: 'use' }] }));
  assert.equal(run.status, 'succeeded', run.error);
  assert.equal(out(run, 'peer').input, message);
  assert.ok(out(run, 'room').log.some(entry => entry.kind === 'tool' && entry.text.includes(message)));
});


test('workflow MCP blocks send provider HTTP configs instead of an empty local command', async () => {
  const { start, finished, agents, env } = await runtime();
  env.mcpServers = [{ id: 'github', name: 'GitHub', transport: 'http', command: '', args: [], env: [], url: 'https://example.com/mcp', auth: { type: 'oauth' } }];
  env.mcpConfigs = { github: { type: 'http', name: 'GitHub', url: 'https://example.com/mcp', headers: [{ name: 'Authorization', value: 'Bearer fixture-token' }] } };
  const id = await start({ id: 'http-mcp', name: 'HTTP MCP', blocks: [B('chat', 'chatbox'), B('github', 'mcp', { mcp: { serverId: 'github' } })], edges: [{ id: 'edge', from: 'chat', to: 'github' }] }, 'List repositories');
  assert.equal((await finished(id)).status, 'succeeded');
  const config = [...agents.sessions.values()][0].spec.mcps.find(m => m.id === 'github');
  assert.equal(config.type, 'http');
  assert.equal(config.url, 'https://example.com/mcp');
  assert.equal(config.headers[0].value, 'Bearer fixture-token');
  assert.equal(config.command, undefined);
  assert.equal(config.auth, undefined);
});

test('workflow remote MCP fallback converts bearer configs and rejects unprepared OAuth clearly', async () => {
  for (const auth of [{ type: 'bearer', token: 'fixture' }, { type: 'oauth' }]) {
    const { start, finished, agents, env } = await runtime();
    env.mcpServers = [{ id: 'remote', name: 'Remote', transport: 'http', command: '', args: [], env: [], url: 'https://example.com/mcp', auth }];
    const id = await start({ id: 'remote-' + auth.type, name: 'Remote MCP', blocks: [B('chat', 'chatbox'), B('remote', 'mcp', { mcp: { serverId: 'remote' } })], edges: [{ id: 'edge', from: 'chat', to: 'remote', type: 'use' }] }, 'Hello');
    const run = await finished(id);
    if (auth.type === 'oauth') {
      assert.equal(run.status, 'failed');
      assert.match(out(run, 'chat').error, /fresh authorization/);
      assert.equal(agents.sessions.size, 0);
    } else {
      assert.equal(run.status, 'succeeded');
      const config = [...agents.sessions.values()][0].spec.mcps[1];
      assert.equal(config.type, 'http');
      assert.equal(config.command, undefined);
      assert.deepEqual(config.headers, [{ name: 'Authorization', value: 'Bearer fixture' }]);
    }
  }
});

test('agents discover MCP blocks in both initial instructions and the connections tool without exposing credentials', async () => {
  for (const type of ['ai', 'chatbox']) {
    let inspected = false;
    const { start, finished, env } = await runtime(async (_spec, text, tool) => {
      assert.match(text, /Connected workflow blocks and capabilities/);
      assert.match(text, /"server_name":"GitHub"/);
      assert.match(text, /Call workflow_connections/);
      assert.match(text, /tool discovery\/search/);
      assert.ok(!text.includes('No workflow blocks are connected'));
      const connections = await tool('workflow_connections', {});
      assert.deepEqual(connections.map(c => c.block_id), ['github', 'script']);
      assert.equal(connections[0].invocation, 'provider_mcp_tools');
      assert.equal(connections[0].server_name, 'GitHub');
      assert.equal(connections[1].invocation, 'workflow_use_block');
      assert.ok(!JSON.stringify(connections).includes('secret-token'));
      const guidance = await tool('workflow_use_block', { block_id: 'github' });
      assert.equal(guidance.invocation, 'provider_mcp_tools');
      assert.match(guidance.usage, /does not call the MCP server/);
      inspected = true;
      return 'Discovered GitHub tools';
    });
    env.mcpServers = [{ id: 'github-config', name: 'GitHub', transport: 'http', command: '', args: [], env: [], url: 'https://example.com/mcp', auth: { type: 'bearer', token: 'secret-token' } }];
    const id = await start({ id: 'discover-' + type, name: 'Discovery', blocks: [B('agent', type, { prompt: 'Use connected capabilities to answer the user.' }), B('github', 'mcp', { mcp: { serverId: 'github-config' } }), B('script', 'script', { command: 'echo ok' }), B('unconnected', 'mcp', { mcp: { serverId: 'github-config' } })], edges: [{ id: 'mcp', from: 'agent', to: 'github', ...(type === 'ai' ? { type: 'use' } : {}) }, { id: 'script', from: 'agent', to: 'script', type: 'use' }] }, 'List my repositories');
    const run = await finished(id);
    assert.equal(run.status, 'succeeded', out(run, 'agent').error);
    assert.equal(inspected, true);
  }
});
