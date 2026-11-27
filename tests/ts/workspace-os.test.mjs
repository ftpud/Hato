import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as esbuild from 'esbuild';

const built = await esbuild.build({ entryPoints: ['Hato-plugins/modules/services/workspace/src/index.ts'], bundle: true, format: 'esm', write: false });
const mod = (await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64'))).default;

test('workspace descriptors carry the machine OS: host, WSL, detected SSH platform and live updates', async () => {
  const projects = {
    'a': { id: 'a', kind: 'local', name: 'L', rootPath: 'C:/p' },
    'b': { id: 'b', kind: 'ssh', name: 'S', rootPath: '/srv', sshProfileId: 's1' },
    'c': { id: 'c', kind: 'ssh', name: 'W', rootPath: '/home/me', sshProfileId: 'w1' },
    'd': { id: 'd', kind: 'ssh', name: 'N', rootPath: '/x', sshProfileId: 'n1' },
  };
  const profiles = { s1: { id: 's1', host: 'h', port: 22, user: 'u' }, w1: { id: 'w1', host: 'Ubuntu', port: 0, user: 'me', transport: 'wsl' }, n1: { id: 'n1', host: 'n', port: 22, user: 'u' } };
  const settings = { 'machine.platform.ssh:s1': { os: 'macos', arch: 'aarch64' } };
  const listeners = {};
  const state = {};
  const ctx = {
    host: { env: { info: () => ({ platform: 'windows' }) } },
    modules: { call: async (_m, method, a) => {
      if (method === 'projects.get') return projects[a.id] || null;
      if (method === 'ssh.get') return profiles[a.id] || null;
      if (method === 'settings.get') return settings[a.key] ?? null;
      if (method === 'views.get') return {};
      return null;
    } },
    events: { on: (t, f) => { listeners[t] = f; return () => {}; }, emit() {} },
    state: { set: (k, v) => { state[k] = v; }, get: k => state[k], watch() {} },
    log: console,
  };
  await mod.activate(ctx);
  const os = async id => (await mod.methods.resolve(ctx, { workspaceId: `project:${id}:root` })).os;
  assert.equal(await os('a'), 'windows');
  assert.equal(await os('c'), 'linux');
  assert.equal(await os('b'), 'macos');
  assert.equal(await os('d'), undefined, 'unknown until the first connection');
  listeners['projects.machinePlatform']({ machineId: 'ssh:n1', os: 'linux', arch: 'x86_64' });
  assert.equal(await os('d'), 'linux');
});
