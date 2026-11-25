import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as esbuild from 'esbuild';
import { randomBytes } from 'node:crypto';
// Hato's module runtime adds crypto.randomHex.
globalThis.crypto.randomHex ??= bytes => randomBytes(bytes || 16).toString('hex');
let n = 0;
const load = async entry => (await import('data:text/javascript;base64,' + Buffer.from((await esbuild.build({ entryPoints: [entry], bundle: true, format: 'esm', write: false, loader: { '.md': 'text' } })).outputFiles[0].text).toString('base64') + '#' + (++n))).default;

/** One Hato process: a fresh module instance sharing the persisted settings of earlier ones. */
function hato(settings, { portTaken = false } = {}) {
  const streams = new Map(), writes = [], closed = [], listens = [];
  const ctx = { moduleId: 'internal-mcp', log: { info() {}, warn() {}, error() {} }, events: { on() {}, emit() {} },
    state: { watch() {}, get() {}, set() {} },
    modules: { async call(service, method, args) {
      if (service === 'persistence' && method === 'settings.get') return settings.has(args.key) ? structuredClone(settings.get(args.key)) : null;
      if (service === 'persistence' && method === 'settings.set') { settings.set(args.key, structuredClone(args.value)); return null; }
      if (service === 'workspace') return { id: 'ws', machineId: 'local', location: 'local' };
      throw new Error(service + ':' + method);
    } },
    host: {
      modules: { list: async () => [] },
      env: { info: () => ({ sharedDir: '/shared' }) },
      capabilities: { request: async () => ({ grant: 'g' }), release: async () => {} },
      fs: { mkdir: async () => {}, writeAtomic: async (_g, rel) => ({ path: '/shared/' + rel }) },
      net: {
        listenLoopback: async opts => { listens.push(opts?.port ?? 0); if (opts?.port && portTaken) throw new Error('EADDRINUSE'); return { handle: 'listener', port: opts?.port || 40000 + n }; },
        write: async (h, line) => { writes.push([h, line]); }, close: async h => { closed.push(h); },
      },
      streams: { listen: async (h, _o, onData) => { streams.set(h, onData); return { close: async () => {} }; } },
    } };
  const connect = async (handle, line) => {
    streams.get('listener')(JSON.stringify({ connection: handle }) + '\n');
    await new Promise(setImmediate);
    streams.get(handle)(line + '\n');
    await new Promise(setImmediate);
  };
  return { ctx, connect, writes, closed, listens };
}

test('internal MCP keeps its port and accepts the same token after a Hato restart, storing only hashes', async () => {
  const settings = new Map();
  const first = hato(settings);
  const mod1 = await load('Hato-plugins/modules/services/internal-mcp/src/index.ts');
  await mod1.activate(first.ctx);
  const ep = await mod1.methods.endpoint(first.ctx, { conversationId: 'chat', workspaceId: 'ws' });
  const env = Object.fromEntries(ep.server.env.map(e => [e.name, e.value]));
  assert.match(ep.server.args[0], /hato-mcp-proxy-v2\.mjs$/);
  const saved = JSON.stringify(settings.get('internal-mcp.tokens'));
  assert.ok(!saved.includes(env.HATO_MCP_TOKEN), 'raw tokens are never persisted');

  // A new process: no snapshot, only persisted settings.
  const second = hato(settings);
  const mod2 = await load('Hato-plugins/modules/services/internal-mcp/src/index.ts');
  await mod2.activate(second.ctx);
  assert.equal(second.listens[0], Number(env.HATO_MCP_PORT), 'listens on the previous port');
  await second.connect('relay', JSON.stringify({ hatoAuth: env.HATO_MCP_TOKEN }));
  assert.deepEqual(second.closed, [], 'the old token is accepted');
  await second.connect('intruder', JSON.stringify({ hatoAuth: 'nope' }));
  assert.ok(second.writes.some(([h, l]) => h === 'intruder' && /unauthorized/.test(l)));

  // Revoking removes the persisted entry too.
  await mod2.methods.revoke(second.ctx, { conversationId: 'chat' });
  assert.deepEqual(settings.get('internal-mcp.tokens'), []);
});

test('internal MCP falls back to a new port when the old one is taken', async () => {
  const settings = new Map([['internal-mcp.port', 45678]]);
  const h = hato(settings, { portTaken: true });
  const mod = await load('Hato-plugins/modules/services/internal-mcp/src/index.ts');
  await mod.activate(h.ctx);
  assert.deepEqual(h.listens, [45678, 0]);
  assert.notEqual(settings.get('internal-mcp.port'), 45678);
});
