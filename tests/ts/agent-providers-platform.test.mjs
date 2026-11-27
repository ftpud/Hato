import { test } from 'node:test';
import * as esbuild from 'esbuild';
import assert from 'node:assert/strict';
const b = await esbuild.build({ entryPoints: ['sdk/agent-providers.ts'], bundle: true, format: 'esm', write: false });
const A = await import('data:text/javascript;base64,' + Buffer.from(b.outputFiles[0].text).toString('base64'));

test('provider platform support is declared per OS with generic tool requirements', () => {
  const plugin = (platforms) => ({ id: 'p', enabled: true, contributes: { agentProviders: [{ id: 'x', name: 'X', profile: { id: 'x', name: 'X', executable: 'x', args: [] }, adapter: { pkg: 'x', bin: 'x' }, platforms }] } });
  const [p] = A.agentProviders([plugin({ windows: { status: 'unsupported', note: 'n', requires: [{ tool: 'git-bash', env: 'BASH_PATH' }, { tool: 'Bad Tool' }] }, linux: { status: 'untested' }, beos: { status: 'supported' } })]);
  assert.deepEqual(p.platforms, { windows: { status: 'unsupported', note: 'n', requires: [{ tool: 'git-bash', env: 'BASH_PATH' }] }, linux: { status: 'untested' } });
  assert.equal(A.platformSupportOf(p, 'linux').status, 'untested');
  assert.equal(A.platformSupportOf(p, 'macos').status, 'supported');
  assert.equal(A.platformSupportOf(undefined, 'windows').status, 'untested');
  assert.ok(A.REQUIRED_TOOLS['git-bash']);
});
