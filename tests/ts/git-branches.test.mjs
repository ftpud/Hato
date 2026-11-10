import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

let loaded = 0;
async function load(entry) {
  const built = await esbuild.build({ entryPoints: [entry], bundle: true, format: 'esm', write: false });
  return (await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64') + '#' + ++loaded)).default;
}
function fixture(t, { commit = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hato-branches-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'repo'); fs.mkdirSync(dir);
  const exec = (args, cwd = dir) => {
    const r = spawnSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
    return { code: r.status, stdout: r.stdout, stderr: r.stderr, truncated: false };
  };
  const git = (...args) => { const r = exec(args); assert.equal(r.code, 0, r.stderr); return r.stdout.trim(); };
  git('init', '-q', '--initial-branch=main'); git('config', 'user.email', 'test@example.com'); git('config', 'user.name', 'Test');
  fs.writeFileSync(path.join(dir, 'readme'), 'original\n');
  if (commit) { git('add', '.'); git('commit', '-qm', 'Initial'); }
  const events = [], requests = [];
  const ctx = { modules: { async call(service, method) {
    assert.equal(service, 'workspace'); assert.equal(method, 'resolve');
    return { id: root, machineId: 'local', location: 'local', rootAbsolutePath: dir };
  } }, host: { capabilities: { async request() { return { grant: 'test' }; } }, process: { async run(_, spec) { requests.push(spec); return exec(spec.args, spec.cwd); } } }, events: { emit(topic, event) { events.push([topic, event]); } } };
  return { root, dir, git, ctx, requests, events, remote() {
    git('remote', 'add', 'origin', path.join(root, 'unused-origin'));
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    git('update-ref', 'refs/remotes/origin/feature/welcome', 'HEAD');
    git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  } };
}

test('branch catalog excludes remote HEAD aliases and checks out remote tracking branches', async t => {
  const mod = await load('Hato-plugins/modules/services/git/src/index.ts'), f = fixture(t); f.remote();
  let list = await mod.methods.branches(f.ctx, { workspaceId: f.root });
  assert.equal(list.current, 'main'); assert.equal(list.local[0].current, true);
  assert.deepEqual(list.remote.map(b => b.name), ['origin/feature/welcome', 'origin/main']);
  list = await mod.methods.checkout(f.ctx, { workspaceId: f.root, ref: 'refs/remotes/origin/feature/welcome' });
  assert.equal(list.current, 'feature/welcome');
  assert.equal(f.git('rev-parse', '--abbrev-ref', '@{upstream}'), 'origin/feature/welcome');
  assert.ok(f.events.some(([topic]) => topic === 'git.changed'));
  await mod.methods.checkout(f.ctx, { workspaceId: f.root, ref: 'refs/heads/main' });
  await mod.methods.checkout(f.ctx, { workspaceId: f.root, ref: 'refs/remotes/origin/feature/welcome' });
  assert.equal(f.git('branch', '--show-current'), 'feature/welcome', 'reuse the matching local tracking branch');
  assert.ok(f.requests.every(spec => spec.executable === 'git' && spec.target.kind === 'local'));
});

test('checkout preserves conflicting local edits and other worktrees', async t => {
  const mod = await load('Hato-plugins/modules/services/git/src/index.ts'), f = fixture(t);
  f.git('switch', '-qc', 'feature'); fs.writeFileSync(path.join(f.dir, 'readme'), 'feature\n'); f.git('commit', '-qam', 'Feature'); f.git('switch', '-q', 'main');
  fs.writeFileSync(path.join(f.dir, 'readme'), 'uncommitted\n');
  await assert.rejects(mod.methods.checkout(f.ctx, { workspaceId: f.root, ref: 'refs/heads/feature' }), /overwritten|local changes/i);
  assert.equal(f.git('branch', '--show-current'), 'main');
  assert.equal(fs.readFileSync(path.join(f.dir, 'readme'), 'utf8'), 'uncommitted\n');
  fs.writeFileSync(path.join(f.dir, 'readme'), 'original\n');
  f.git('worktree', 'add', '-q', path.join(f.root, 'other'), 'feature');
  const list = await mod.methods.branches(f.ctx, { workspaceId: f.root });
  assert.ok(list.local.find(b => b.name === 'feature').worktree.endsWith('/other'));
  await assert.rejects(mod.methods.checkout(f.ctx, { workspaceId: f.root, ref: 'refs/heads/feature' }), /already.*(used|checked out)/i);
  assert.equal(f.git('branch', '--show-current'), 'main');
});

test('remote name conflicts cannot overwrite local branches; create-from supports another name', async t => {
  const mod = await load('Hato-plugins/modules/services/git/src/index.ts'), f = fixture(t); f.remote(); f.git('branch', 'feature/welcome');
  await assert.rejects(mod.methods.checkout(f.ctx, { workspaceId: f.root, ref: 'refs/remotes/origin/feature/welcome' }), /different upstream/);
  assert.equal(f.git('branch', '--show-current'), 'main');
  const list = await mod.methods.createBranch(f.ctx, { workspaceId: f.root, name: 'feature/alternate', from: 'refs/remotes/origin/feature/welcome' });
  assert.equal(list.current, 'feature/alternate'); assert.equal(f.git('rev-parse', '--abbrev-ref', '@{upstream}'), 'origin/feature/welcome');
  await assert.rejects(mod.methods.createBranch(f.ctx, { workspaceId: f.root, name: 'main' }), /already exists/);
  await assert.rejects(mod.methods.checkout(f.ctx, { workspaceId: f.root, ref: '--discard-changes' }), /no longer available/);
  for (const name of ['--force', 'bad name', '@{-1}', 'a..b']) await assert.rejects(mod.methods.createBranch(f.ctx, { workspaceId: f.root, name }), /valid branch name/i);
});

test('branch catalog and creation support unborn HEAD and detached HEAD', async t => {
  const mod = await load('Hato-plugins/modules/services/git/src/index.ts'), f = fixture(t, { commit: false });
  let list = await mod.methods.branches(f.ctx, { workspaceId: f.root });
  assert.equal(list.current, 'main'); assert.equal(list.local[0].unborn, true);
  list = await mod.methods.createBranch(f.ctx, { workspaceId: f.root, name: 'initial' });
  assert.equal(list.current, 'initial');
  f.git('add', '.'); f.git('commit', '-qm', 'Initial'); f.git('switch', '--detach', '-q');
  list = await mod.methods.branches(f.ctx, { workspaceId: f.root });
  assert.equal(list.current, null); assert.ok(list.head);
  list = await mod.methods.createBranch(f.ctx, { workspaceId: f.root, name: 'from-detached' });
  assert.equal(list.current, 'from-detached');
});

test('SSH branch mutations stay on the selected workspace machine', async () => {
  const mod = await load('Hato-plugins/modules/services/git/src/index.ts'); const calls = [];
  const ctx = { modules: { async call() { return { id: 'ssh', machineId: 'ssh:branch-test', location: 'ssh', rootAbsolutePath: '/srv/repo', ssh: { profileId: 'branch-test', host: 'host', port: 22, user: 'user' } }; } },
    host: { ssh: { async connect() { return { connection: 'ssh-connection', machineId: 'ssh:branch-test' }; } }, capabilities: { async request(a) { assert.equal(a.target.kind, 'ssh'); return { grant: 'ssh-grant' }; } }, process: { async run(_, spec) {
      calls.push(spec); assert.equal(spec.target.kind, 'ssh'); assert.equal(spec.target.connection, 'ssh-connection'); assert.equal(spec.cwd, '/srv/repo'); assert.equal(spec.loginShell, true);
      const args = spec.args;
      if (args.includes('--is-inside-work-tree')) return { code: 0, stdout: 'true\n' };
      if (args.includes('symbolic-ref')) return { code: 0, stdout: 'refs/heads/main\n' };
      if (args.includes('--short')) return { code: 0, stdout: 'abcd123\n' };
      if (args.includes('for-each-ref')) return { code: 0, stdout: 'refs/heads/main\0abcd123\0\0\0/srv/repo\0\nrefs/heads/feature\0abcd123\0\0\0\0\n' };
      if (args.includes('check-ref-format')) return { code: 0, stdout: 'feature\n' };
      return { code: 0, stdout: '' };
    } } }, events: { emit() {} } };
  await mod.methods.checkout(ctx, { workspaceId: 'ssh', ref: 'refs/heads/feature' });
  assert.ok(calls.some(spec => spec.args.includes('switch')));
});

test('branch actions rename, publish and track explicit refs, and only delete merged local branches', async t => {
  const mod = await load('Hato-plugins/modules/services/git/src/index.ts'), f = fixture(t);
  f.git('branch', 'feature');
  let list = await mod.methods.renameBranch(f.ctx, { workspaceId: f.root, ref: 'refs/heads/feature', name: 'renamed' });
  assert.ok(list.local.some(branch => branch.name === 'renamed'));
  await assert.rejects(mod.methods.deleteBranch(f.ctx, { workspaceId: f.root, ref: 'refs/heads/main' }), /Switch to another branch/);
  list = await mod.methods.deleteBranch(f.ctx, { workspaceId: f.root, ref: 'refs/heads/renamed' });
  assert.ok(!list.local.some(branch => branch.name === 'renamed'));
  f.git('switch', '-qc', 'unmerged');
  fs.writeFileSync(path.join(f.dir, 'new-file'), 'keep this commit\n'); f.git('add', '.'); f.git('commit', '-qm', 'Unmerged work'); f.git('switch', '-q', 'main');
  await assert.rejects(mod.methods.deleteBranch(f.ctx, { workspaceId: f.root, ref: 'refs/heads/unmerged' }), /not fully merged/);
  assert.ok(f.git('rev-parse', 'refs/heads/unmerged'));
  const remote = path.join(f.root, 'origin.git'); f.git('init', '--bare', '-q', remote); f.git('remote', 'add', 'origin', remote);
  list = await mod.methods.publishBranch(f.ctx, { workspaceId: f.root, ref: 'refs/heads/main', remote: 'origin' });
  assert.equal(list.local.find(branch => branch.name === 'main').upstream, 'refs/remotes/origin/main');
  f.git('branch', 'tracking');
  list = await mod.methods.setUpstream(f.ctx, { workspaceId: f.root, ref: 'refs/heads/tracking', upstream: 'refs/remotes/origin/main' });
  assert.equal(list.local.find(branch => branch.name === 'tracking').upstream, 'refs/remotes/origin/main');
  await assert.rejects(mod.methods.publishBranch(f.ctx, { workspaceId: f.root, ref: 'refs/heads/main', remote: '--force' }), /available remote/);
  await assert.rejects(mod.methods.setUpstream(f.ctx, { workspaceId: f.root, ref: 'refs/heads/main', upstream: '--force' }), /remote-tracking branch/);
  assert.ok(f.requests.every(request => !request.args.includes('--force') && !request.args.includes('-D')));
});
