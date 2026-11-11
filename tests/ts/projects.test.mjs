import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as esbuild from 'esbuild';
const walk = n => [n, ...(n.children || []).flatMap(walk)];
test('project filtering reveals matching tasks under collapsed parents and keeps forms out of the list', async () => {
  const built = await esbuild.build({ entryPoints: ['Hato-plugins/modules/ui/projects-panel/src/index.ts'], bundle: true, format: 'esm', write: false });
  const mod = (await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64'))).default;
  const watchers = new Map();
  const ctx = { state: { set() {}, get: () => ({ id: 'project:p:root' }), watch(key, fn) { watchers.set(key, fn); } }, events: { on() {} }, ui: { invalidate() {} }, modules: { async call() { return [
    { id: 'p', name: 'App', rootPath: '/workspace/app', kind: 'local', isGit: true, tasks: [{ id: 't', name: 'Fix login', branch: 'task/login', status: 'ready' }, { id: 'b', name: 'Fix billing', branch: 'task/billing', status: 'ready' }], expanded: false },
    { id: 'r', name: 'Remote', rootPath: '/srv/code', host: 'devbox', kind: 'ssh', tasks: [], expanded: false },
  ]; } } };
  await mod.activate(ctx);
  const nodes = () => walk(mod.render());
  const rows = () => nodes().find(n => n.type === 'tree').rows;
  assert.deepEqual(rows().map(n => n.key), ['project:p:root', 'project:r:root']);
  assert.equal(mod.render().backgroundImage.mimeType, 'image/png');
  assert.deepEqual(mod.render().backgroundImageStyle, { opacity: 0.12, width: 960, left: -350, top: -60 });
  assert.equal(mod.render().style?.opacity, undefined);
  watchers.get('workspace-layout.projectsBackgroundOpacity')(0);
  assert.equal(mod.render().backgroundImage, undefined);
  assert.deepEqual(rows().map(n => n.key), ['project:p:root', 'project:r:root']);
  watchers.get('workspace-layout.projectsBackgroundOpacity')(0.24);
  assert.equal(mod.render().backgroundImageStyle.opacity, 0.24);
  assert.ok(!nodes().some(n => n.key === 'local-path'));
  await mod.onEvent(ctx, { action: 'filter', value: 'app' });
  assert.equal(rows()[0].badge, '2 tasks');
  assert.deepEqual(rows().slice(1).map(row => row.connector), ['branch', 'last']);
  await mod.onEvent(ctx, { action: 'filter', value: 'login' });
  assert.deepEqual(rows().map(n => n.key), ['project:p:root', 'task:t']);
  assert.equal(rows()[1].connector, 'last');
  await mod.onEvent(ctx, { action: 'filter', value: 'devbox' });
  assert.deepEqual(rows().map(n => n.key), ['project:r:root']);
  await mod.onEvent(ctx, { action: 'filter', value: 'missing' });
  assert.equal(rows().length, 0);
  assert.ok(nodes().some(n => n.key === 'empty'));
  await mod.onEvent(ctx, { action: 'showAdd' });
  assert.ok(nodes().some(n => n.type === 'modal' && n.key === 'add-modal'));
  await mod.onEvent(ctx, { action: 'hideAdd' });
  await mod.onEvent(ctx, { action: 'newTask' });
  assert.ok(nodes().some(n => n.type === 'modal' && n.key === 'task-form'));
});

test('Windows paths into WSL resolve to a distribution and a Linux path', async () => {
  const built = await esbuild.build({ entryPoints: ['sdk/runtime.ts'], bundle: true, format: 'esm', write: false });
  const { wslLocation, sshFromProfile, sshProfileSpec } = await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64'));
  assert.deepEqual(wslLocation('\\\\wsl.localhost\\Ubuntu\\home\\me\\My Project\\'), { distro: 'Ubuntu', remotePath: '/home/me/My Project' });
  assert.deepEqual(wslLocation('\\\\wsl$\\Ubuntu-22.04\\srv'), { distro: 'Ubuntu-22.04', remotePath: '/srv' });
  assert.deepEqual(wslLocation('//wsl.localhost/Ubuntu/home/me'), { distro: 'Ubuntu', remotePath: '/home/me' });
  assert.deepEqual(wslLocation('\\\\?\\UNC\\wsl.localhost\\Ubuntu\\x'), { distro: 'Ubuntu', remotePath: '/x' });
  assert.deepEqual(wslLocation('\\\\wsl.localhost\\Ubuntu'), { distro: 'Ubuntu', remotePath: '/' });
  for (const other of ['C:\\Users\\me', 'C:/Users/me', '\\\\server\\share\\x', '/home/me', '\\\\wsl.localhost.evil\\Ubuntu\\x']) assert.equal(wslLocation(other), null);
  const ssh = sshFromProfile({ id: 'p', host: 'Ubuntu', port: 22, user: 'default', authRef: 'agent', transport: 'wsl' });
  assert.deepEqual(sshProfileSpec(ssh), { profileId: 'p', host: 'Ubuntu', port: 22, user: 'default', identityFile: null, transport: 'wsl' });
  assert.equal(sshFromProfile({ id: 'p', host: 'h', port: 22, user: 'u', authRef: '/k' }).transport, 'ssh');
});

test('on Windows the add form offers WSL projects instead of native local paths', async () => {
  const built = await esbuild.build({ entryPoints: ['Hato-plugins/modules/ui/projects-panel/src/index.ts'], bundle: true, format: 'esm', write: false });
  const mod = (await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text + '\n// windows').toString('base64'))).default;
  const calls = [];
  const ctx = { host: { env: { info: () => ({ platform: 'windows' }) } }, state: { set() {}, get: () => null, watch() {} }, events: { on() {} }, ui: { invalidate() {} }, modules: { async call(target, method, args) {
    calls.push([method, args]);
    if (method === 'wslDistributions') return ['Ubuntu', 'Debian'];
    if (method === 'addWsl') return { id: 'x' };
    return [];
  } } };
  await mod.activate(ctx);
  await mod.onEvent(ctx, { action: 'showAdd', inputs: {} });
  let nodes = walk(mod.render()).map(n => n.key);
  assert.ok(nodes.includes('source:wsl') && nodes.includes('source:ssh'));
  assert.ok(!nodes.includes('source:local') && !nodes.includes('local-path'));
  await mod.onEvent(ctx, { action: 'showWsl', inputs: {} });
  const distro = walk(mod.render()).find(n => n.key === 'wsl-distro');
  assert.deepEqual(distro.options.map(o => o.value), ['Ubuntu', 'Debian']);
  assert.equal(distro.value, 'Ubuntu');
  await mod.onEvent(ctx, { action: 'wslDistro', value: 'Debian', inputs: {} });
  await mod.onEvent(ctx, { action: 'addWsl', inputs: { 'wsl-path': '/srv/app' } });
  assert.deepEqual(calls.find(c => c[0] === 'addWsl')[1], { distro: 'Debian', remotePath: '/srv/app', name: null });
  assert.ok(!walk(mod.render()).some(n => n.key === 'add-modal'));
});

const addProject = async () => {
  const built = await esbuild.build({ entryPoints: ['Hato-plugins/modules/ui/projects-panel/src/add-project.ts'], bundle: true, format: 'esm', write: false });
  return import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64'));
};

test('the SSH form validates per field and never collects a password', async () => {
  const { addProjectModal, parseSshTarget, sshRequest } = await addProject();
  assert.deepEqual(parseSshTarget('me@box:2222'), { host: 'box', user: 'me', port: '2222' });
  assert.deepEqual(parseSshTarget('[::1]:22'), { host: '::1', user: undefined, port: '22' });
  assert.equal(parseSshTarget('::1').host, '::1');
  const empty = sshRequest({}, 'key');
  assert.equal(empty.request, null);
  assert.deepEqual(Object.keys(empty.errors).sort(), ['ssh-host', 'ssh-key', 'ssh-path', 'ssh-user']);
  assert.ok(sshRequest({ 'ssh-host': 'h', 'ssh-user': 'u', 'ssh-path': '/p', 'ssh-port': '70000' }, 'agent').errors['ssh-port']);
  const { request } = sshRequest({ 'ssh-host': 'me@box:2222', 'ssh-path': '/srv', 'ssh-key': '/ignored' }, 'password');
  assert.deepEqual(request, { host: 'box', user: 'me', port: 2222, remotePath: '/srv', identityFile: null, auth: 'password', name: null });
  const view = { windows: false, source: 'ssh', sshAuth: 'password', values: {}, errors: {}, error: null, busy: null, distros: [], distro: '' };
  const nodes = walk(addProjectModal(view));
  assert.ok(nodes.some(n => n.key === 'auth:password' && n.variant === 'primary'));
  assert.ok(!nodes.some(n => n.key === 'ssh-key' || n.secret), 'the kernel prompt is the only place a password is typed');
});

test('locked password projects connect on click, then select', async () => {
  const built = await esbuild.build({ entryPoints: ['Hato-plugins/modules/ui/projects-panel/src/index.ts'], bundle: true, format: 'esm', write: false });
  const mod = (await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64'))).default;
  const calls = [];
  const project = { id: 'r', name: 'Remote', rootPath: '/srv', host: 'me@box', kind: 'ssh', auth: 'password', needsPassword: true, offline: 'Password needed', tasks: [], expanded: false };
  const ctx = { state: { set() {}, get: () => null, watch() {} }, events: { on() {} }, ui: { invalidate() {} }, host: { env: { info: () => ({ platform: 'linux' }) } }, modules: { async call(m, f, a) { calls.push(`${m}.${f}`); return f === 'tree' ? [project] : {}; } } };
  await mod.activate(ctx);
  await mod.onEvent(ctx, { action: 'filter', value: '', inputs: {} });
  const row = walk(mod.render()).find(n => n.type === 'tree').rows[0];
  assert.equal(row.badge, 'Connect');
  calls.length = 0;
  await mod.onEvent(ctx, { action: 'selectWorkspace', rowKey: 'project:r:root', inputs: {} });
  const connect = calls.indexOf('projects.connect'), select = calls.indexOf('workspace.select');
  assert.ok(connect >= 0 && connect < select, calls.join());
});

test('stored password choice reaches the kernel profile without a key path', async () => {
  const built = await esbuild.build({ entryPoints: ['sdk/runtime.ts'], bundle: true, format: 'esm', write: false });
  const { sshFromProfile, sshProfileSpec } = await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64'));
  const spec = sshProfileSpec(sshFromProfile({ id: 'p', host: 'h', port: 22, user: 'u', authRef: 'password' }));
  assert.equal(spec.auth, 'password');
  assert.equal(spec.identityFile, null);
});

test('a failed add keeps its error in the dialog after the tree reloads', async () => {
  const built = await esbuild.build({ entryPoints: ['Hato-plugins/modules/ui/projects-panel/src/index.ts'], bundle: true, format: 'esm', write: false });
  const mod = (await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64'))).default;
  const ctx = { state: { set() {}, get: () => null, watch() {} }, events: { on() {} }, ui: { invalidate() {} }, host: { env: { info: () => ({ platform: 'linux' }) } }, modules: { async call(m, f) { if (f === 'addLocal') throw new Error('no such folder'); return []; } } };
  await mod.activate(ctx);
  await mod.onEvent(ctx, { action: 'showAdd', inputs: {} });
  await mod.onEvent(ctx, { action: 'addLocalPath', inputs: { 'local-path': '/missing' } });
  assert.equal(walk(mod.render()).find(n => n.key === 'add-error')?.text, 'no such folder');
  await mod.onEvent(ctx, { action: 'hideAdd', inputs: {} });
});
