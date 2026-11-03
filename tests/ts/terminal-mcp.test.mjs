import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import * as esbuild from 'esbuild';
Object.defineProperty(globalThis.crypto, 'randomHex', { value: n => randomBytes(n).toString('hex'), configurable: true });
const result = await esbuild.build({ entryPoints: ['modules/services/terminals/src/tools.ts'], bundle: true, format: 'esm', write: false });
const { terminalTools } = await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'));
const scope = { workspaceId: 'ws', machineId: 'local', conversationId: 'c' };
function fixture() {
  let output = '', lastWrite = '';
  const handles = new Map([['pty:ws:main', 'main-handle'], ['pty:ws:second', 'second-handle'], ['pty:other:foreign', 'foreign-handle']]);
  const ctx = { modules: { async call(_, method, args) {
    assert.equal(args.workspaceId, 'ws');
    if (method === 'resolve') return { machineId: 'local' };
    return { ui: { terminalLayout: { kind: 'split', children: [
      { kind: 'block', id: 'a', keys: ['main'], active: 'main' },
      { kind: 'block', id: 'b', keys: ['second'], active: 'second' },
    ] } } };
  } }, host: { resources: { lookup: async key => handles.get(key) || null }, pty: {
    info: async () => ({ machineId: 'local', cwd: '/tmp', exit: null }),
    async read(_, opts) {
      const cursor = opts.cursor === undefined ? Math.max(0, output.length - opts.limitBytes) : opts.cursor;
      return { text: output.slice(cursor, cursor + opts.limitBytes), cursor: Math.min(output.length, cursor + opts.limitBytes), endCursor: output.length, truncated: false, exit: null };
    },
    async write(_, text) {
      lastWrite = text;
      if (text.startsWith('sh -c ')) {
        // PTY echo contains literal escape sequences; it must not be mistaken for command completion.
        output += text;
        const child = spawn('/bin/sh', ['-c', text.replace(/\r$/, '\n')]);
        child.stdout.on('data', data => { output += data.toString(); });
        child.stderr.on('data', data => { output += data.toString(); });
      } else output += text;
    },
  } } };
  const api = terminalTools(ctx);
  return { api, tool: name => api.tools.find(tool => tool.name === name), write: () => lastWrite, output: text => { output += text; } };
}
test('terminal MCP lists split tabs, scopes targets and returns bounded readable output', async () => {
  const f = fixture();
  const tabs = await f.tool('list_tabs').handler({}, scope);
  assert.deepEqual(tabs.map(tab => [tab.key, tab.blockId]), [['main', 'a'], ['second', 'b']]);
  await assert.rejects(() => f.tool('tail').handler({ tab: 'foreign' }, scope), /Unknown terminal/);
  await assert.rejects(() => f.tool('tail').handler({}, { ...scope, machineId: 'ssh:other' }), /machine has changed/);
  f.output('\x1b[31mfirst\x1b[0m\nsecond\nthird');
  const tail = await f.tool('tail').handler({ lines: 2 }, scope);
  assert.equal(tail.text, 'second\nthird'); assert.equal(tail.truncated, true);
  await f.tool('send').handler({ tab: 'second', text: 'echo hello', enter: true }, scope);
  assert.equal(f.write(), 'echo hello\r');
});
test('run_and_wait safely quotes commands, ignores echoed marker source and reports the exit code', async () => {
  const f = fixture();
  const answer = await f.tool('run_and_wait_for_answer').handler({ command: `sleep 0.05; printf '%s\\n' "a'b"; exit 7`, timeoutMs: 5000 }, scope);
  assert.equal(answer.exitCode, 7);
  assert.equal(answer.text.trim(), "a'b");
  assert.equal(answer.timedOut, false);
  assert.equal(f.api.running(), 0);
});
test('a timed-out terminal command remains reserved until it completes', async () => {
  const f = fixture();
  const answer = await f.tool('run_and_wait_for_answer').handler({ command: 'sleep 0.4; printf done', timeoutMs: 100 }, scope);
  assert.equal(answer.timedOut, true); assert.equal(f.api.running(), 1);
  await assert.rejects(() => f.tool('run_and_wait_for_answer').handler({ command: 'echo another' }, scope), /already running/);
  await new Promise(resolve => setTimeout(resolve, 600));
  assert.equal(f.api.running(), 0);
});
