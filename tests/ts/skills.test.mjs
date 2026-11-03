import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as esbuild from 'esbuild';
async function load() {
  const r = await esbuild.build({ entryPoints: ['modules/services/files/src/skills.ts'], bundle: true, format: 'esm', write: false });
  return import('data:text/javascript;base64,' + Buffer.from(r.outputFiles[0].text).toString('base64'));
}
const missing = () => Object.assign(new Error('missing'), { code: 'ENOENT' });
test('workspace skill discovery reads only workspace .agents/skills children with SKILL.md', async () => {
  const { workspaceSkills } = await load();
  const read = [], grants = [];
  const ctx = { host: { capabilities: { async request(args) { grants.push(args); return { grant: 'fs' }; } }, fs: {
    async list(_, path) { assert.equal(path, '.agents/skills'); return { entries: [{ name: 'review', kind: 'dir' }, { name: 'empty', kind: 'dir' }, { name: 'README.md', kind: 'file' }, { name: 'build', kind: 'dir' }] }; },
    async read(_, path) {
      read.push(path);
      if (path.includes('/empty/')) throw missing();
      return { binary: false, truncated: false, text: path.includes('/review/') ? '---\nname: "Code review"\ndescription: >-\n  Review code\n  in this workspace.\n---\nInstructions' : '# Build instructions' };
    }
  } } };
  const result = await workspaceSkills(ctx, { id: 'ws', location: 'local', machineId: 'local', rootAbsolutePath: '/workspace' });
  assert.deepEqual(result, [{ name: 'build', description: '', path: '.agents/skills/build/SKILL.md' }, { name: 'Code review', description: 'Review code in this workspace.', path: '.agents/skills/review/SKILL.md' }]);
  assert.equal(grants[0].root, '/workspace');
  assert.ok(read.every(path => /^\.agents\/skills\/[^/]+\/SKILL\.md$/.test(path)));
});
test('missing skills directory is empty; permission and connection errors remain visible', async () => {
  const { workspaceSkills } = await load();
  let error = missing();
  const ctx = { host: { capabilities: { async request() { return { grant: 'fs' }; } }, fs: { async list() { throw error; } } } };
  const desc = { id: 'missing', location: 'local', machineId: 'local', rootAbsolutePath: '/other-workspace' };
  assert.deepEqual(await workspaceSkills(ctx, desc), []);
  error = Object.assign(new Error('permission denied'), { code: 'EACCES' });
  await assert.rejects(workspaceSkills(ctx, desc), /permission denied/);
});
