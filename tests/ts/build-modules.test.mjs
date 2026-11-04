import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const root = new URL('../../', import.meta.url);
function build(...args) {
  return spawnSync(process.execPath, ['tools/build-modules.mjs', ...args], {
    cwd: root, encoding: 'utf8', timeout: 30000,
  });
}

test('builder rejects unknown modules instead of reporting success', () => {
  const result = build('not-a-hato-module');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown module\(s\): not-a-hato-module/);
});

test('builder only builds the selected module', () => {
  const result = build('files');
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trim().split('\n');
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^(built|same)\s+files\s+\d+ bytes$/);
});
