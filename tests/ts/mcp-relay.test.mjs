import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as esbuild from 'esbuild';

const built = await esbuild.build({ entryPoints: ['sdk/mcp-relay.ts'], bundle: true, format: 'esm', write: false });
const { mcpRelaySource, sha256Hex } = await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64'));

test('sha256Hex matches node crypto, including non-ASCII and multi-block input', () => {
  for (const text of ['', 'abc', 'é漢字🙂', 'x'.repeat(55), 'y'.repeat(56), 'z'.repeat(1000)])
    assert.equal(sha256Hex(text), createHash('sha256').update(text, 'utf8').digest('hex'));
});

/** A fake Hato MCP server: token auth on the first line, then echo-style JSON-RPC. */
function fakeHato(port, log) {
  return new Promise(resolve => {
    const sockets = new Set();
    const server = net.createServer(socket => {
      sockets.add(socket); socket.on('close', () => sockets.delete(socket));
      let buf = '', authed = false;
      socket.setEncoding('utf8');
      socket.on('data', chunk => {
        buf += chunk; let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const msg = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
          if (!authed) { authed = msg.hatoAuth === 'secret'; if (!authed) socket.destroy(); continue; }
          log.push(msg.method || 'response');
          if (msg.id !== undefined && msg.method) socket.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { method: msg.method } }) + '\n');
        }
      });
    });
    server.stop = () => new Promise(r => { server.close(r); for (const s of sockets) s.destroy(); });
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

test('relay keeps the agent session across a Hato restart and replays the handshake invisibly', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hato-relay-'));
  const file = path.join(dir, 'relay.mjs');
  fs.writeFileSync(file, mcpRelaySource({ authKey: 'hatoAuth', format: 'esm', version: 'test' }));
  const log1 = [];
  let server = await fakeHato(0, log1);
  const port = server.address().port;
  const relay = spawn(process.execPath, [file], { env: { ...process.env, HATO_MCP_PORT: String(port), HATO_MCP_TOKEN: 'secret' } });
  const replies = [];
  let out = '';
  relay.stdout.setEncoding('utf8');
  relay.stdout.on('data', chunk => { out += chunk; let i; while ((i = out.indexOf('\n')) >= 0) { replies.push(JSON.parse(out.slice(0, i))); out = out.slice(i + 1); } });
  const send = msg => relay.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
  const until = async (pred, what) => { for (let i = 0; i < 200; i++) { if (pred()) return; await new Promise(r => setTimeout(r, 25)); } assert.fail('timed out waiting for ' + what); };
  try {
    send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
    send({ method: 'notifications/initialized' });
    send({ id: 2, method: 'tools/list' });
    await until(() => replies.some(r => r.id === 2), 'first tools/list');

    // Hato quits: calls fail fast instead of hanging the agent.
    await server.stop();
    await new Promise(r => setTimeout(r, 50));
    send({ id: 3, method: 'tools/call', params: { name: 'x' } });
    await until(() => replies.some(r => r.id === 3), 'offline error');
    assert.match(replies.find(r => r.id === 3).error.message, /not running/);

    // Hato starts again on the same port: the relay reconnects and replays initialize.
    const log2 = [];
    server = await fakeHato(port, log2);
    await until(() => log2.includes('notifications/initialized'), 'replayed handshake');
    assert.deepEqual(log2.slice(0, 2), ['initialize', 'notifications/initialized']);
    send({ id: 4, method: 'tools/list' });
    await until(() => replies.some(r => r.id === 4), 'tools/list after restart');
    assert.ok(!replies.some(r => typeof r.id === 'string'), 'the replayed initialize reply stays hidden from the agent');
    assert.deepEqual(replies.map(r => r.id), [1, 2, 3, 4]);
  } finally {
    relay.stdin.end();
    await new Promise(r => relay.on('exit', r));
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cjs relay source runs under node -e', async () => {
  const source = mcpRelaySource({ authKey: 'token', format: 'cjs', version: 'test' });
  const child = spawn(process.execPath, ['-e', source], { env: { ...process.env, HATO_MCP_PORT: '', HATO_MCP_TOKEN: '' } });
  let err = ''; child.stderr.on('data', d => err += d);
  const code = await new Promise(r => child.on('exit', r));
  assert.equal(code, 2); assert.match(err, /HATO_MCP_PORT/);
  assert.throws(() => mcpRelaySource({ authKey: 'bad key', format: 'cjs', version: 'x' }));
});
