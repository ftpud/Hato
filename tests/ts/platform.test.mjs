import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as esbuild from 'esbuild';

const built = await esbuild.build({ entryPoints: ['sdk/platform.ts'], bundle: true, format: 'esm', write: false });
const P = await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64'));

const win = (extra = {}) => ({ host: { env: { info: () => ({ platform: 'windows', windows: { systemRoot: 'C:\\Windows', programFiles: 'C:\\Program Files', localAppData: 'C:\\Users\\me\\AppData\\Local', appData: 'C:\\Users\\me\\AppData\\Roaming' } }) }, ...extra } });
const mac = { host: { env: { info: () => ({ platform: 'macos' }) } } };

test('paths: absolute forms, base names and Windows-insensitive comparison', () => {
  for (const p of ['/x', 'C:/x', 'c:\\x', '//server/share', '\\\\server\\share']) assert.ok(P.isAbsolutePath(p), p);
  for (const p of ['x', './x', 'C:x', '']) assert.ok(!P.isAbsolutePath(p), p);
  assert.equal(P.baseName('C:\\Users\\me\\proj\\'), 'proj');
  assert.equal(P.dirName('C:/proj'), 'C:/');
  assert.ok(P.samePath('C:/Users/Me/', 'c:\\users\\me', 'windows'));
  assert.ok(!P.samePath('/Home', '/home', 'posix'));
  assert.equal(P.workspaceOs(win(), { location: 'local' }), 'windows');
  assert.equal(P.workspaceOs(win(), { location: 'ssh' }), 'posix');
  assert.equal(P.hostOs({ host: {} }), 'posix');
});

test('npm cmd shims resolve to node and the entry script', () => {
  const cmdShim = '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@agentclientprotocol\\claude-agent-acp\\dist\\index.js" %*\r\n';
  assert.deepEqual(P.parseCmdShim(cmdShim, 'C:\\Users\\me\\AppData\\Roaming\\npm\\claude-agent-acp.cmd', 'C:\\nodejs\\node.exe'),
    { executable: 'C:\\nodejs\\node.exe', args: ['C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@agentclientprotocol\\claude-agent-acp\\dist\\index.js'] });
  const local = cmdShim.replace('%dp0%\\node_modules\\@agentclientprotocol\\claude-agent-acp\\dist\\index.js', '%dp0%\\..\\typescript\\bin\\tsc');
  assert.deepEqual(P.parseCmdShim(local, 'C:/p/node_modules/.bin/tsc.cmd', 'node.exe').args, ['C:\\p\\node_modules\\typescript\\bin\\tsc']);
  const npm = ':: Created by npm\r\n@ECHO OFF\r\nSETLOCAL\r\nSET "NODE_EXE=%~dp0\\node.exe"\r\nSET "NPM_PREFIX_JS=%~dp0\\node_modules\\npm\\bin\\npm-prefix.js"\r\nSET "NPM_CLI_JS=%~dp0\\node_modules\\npm\\bin\\npm-cli.js"\r\nSET "NPX_CLI_JS=%~dp0\\node_modules\\npm\\bin\\npx-cli.js"\r\n"%NODE_EXE%" "%NPM_CLI_JS%" %*\r\n';
  assert.deepEqual(P.parseCmdShim(npm, 'C:\\Program Files\\nodejs\\npm.cmd', 'C:\\Program Files\\nodejs\\node.exe').args, ['C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js']);
  assert.deepEqual(P.parseCmdShim(npm, 'C:\\Program Files\\nodejs\\npx.cmd', 'node.exe').args, ['C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npx-cli.js']);
  // Batch files that are not node shims, or no node: not resolvable (started by path instead).
  assert.equal(P.parseCmdShim('@echo off\r\n"%~dp0\\mvn.bat" %*\r\n', 'C:/m/mvn.cmd', 'node.exe'), null);
  assert.equal(P.parseCmdShim(cmdShim, 'C:/x.cmd', null), null);
});

test('user commands use the chosen shell with reproducible flags', () => {
  const ctx = win();
  const ps = P.userCommand(ctx, 'windows', { kind: 'pwsh' }, 'npm test');
  assert.equal(ps.executable, 'C:\\Program Files\\PowerShell\\7\\pwsh.exe');
  assert.deepEqual(ps.args.slice(0, 4), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command']);
  assert.ok(ps.args[4].includes('\nnpm test\n') && ps.args[4].includes('exit $LASTEXITCODE') && ps.args[4].startsWith('[Console]::InputEncoding'));
  assert.ok(!ps.args.includes('-ExecutionPolicy'), 'never overrides the execution policy');
  assert.equal(P.userCommand(ctx, 'windows', { kind: 'auto' }, 'x').executable, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.deepEqual(P.userCommand(ctx, 'windows', { kind: 'cmd' }, 'echo "a b" & dir'),
    { executable: 'C:\\Windows\\System32\\cmd.exe', args: ['/d', '/s', '/c', '"echo "a b" & dir"'], verbatimArgs: true });
  assert.deepEqual(P.userCommand(ctx, 'windows', { kind: 'wsl', distro: 'Ubuntu' }, 'ls').args, ['-d', 'Ubuntu', '--exec', '/bin/sh', '-lc', 'ls']);
  assert.deepEqual(P.userCommand(mac, 'posix', { kind: 'login' }, 'ls'), { executable: '/bin/zsh', args: ['-lc', 'ls'] });
  assert.equal(P.userCommand(mac, 'posix', { kind: 'login' }, 'ls', '/bin/sh').executable, '/bin/sh');
});

test('terminal candidates follow the automatic order and fall back from a missing choice', () => {
  const ctx = win();
  const auto = P.terminalCandidates(ctx, { kind: 'auto' });
  assert.deepEqual(auto.map(c => c.program), ['C:\\Program Files\\PowerShell\\7\\pwsh.exe', 'pwsh.exe', 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', 'C:\\Windows\\System32\\cmd.exe']);
  assert.deepEqual(auto[0].args, ['-NoLogo', '-NoExit', '-Command', P.PWSH_UTF8]);
  assert.deepEqual(auto[3].args, ['/K', 'chcp 65001>nul']);
  const bash = P.terminalCandidates(ctx, { kind: 'git-bash' });
  assert.equal(bash[0].program, 'C:\\Program Files\\Git\\bin\\bash.exe');
  assert.deepEqual(bash[0].args, ['--login', '-i']);
  assert.ok(bash.some(c => c.program.endsWith('cmd.exe')), 'a missing Git Bash still leaves a working shell');
  assert.deepEqual(P.terminalCandidates(ctx, { kind: 'wsl', distro: 'Debian' })[0], { program: 'C:\\Windows\\System32\\wsl.exe', args: ['-d', 'Debian'] });
});

test('shell choices parse, round-trip and resolve per workspace scope', async () => {
  assert.deepEqual(P.parseShellChoice('wsl:Ubuntu'), { kind: 'wsl', distro: 'Ubuntu' });
  assert.deepEqual(P.parseShellChoice('bogus'), { kind: 'auto' });
  assert.equal(P.shellChoiceValue({ kind: 'wsl', distro: 'Ubuntu' }), 'wsl:Ubuntu');
  let scopes;
  const ctx = win({}); ctx.modules = { call: async (_t, _m, a) => { scopes = a.scopes; return { value: 'cmd' }; } };
  assert.deepEqual(await P.shellChoiceFor(ctx, { id: 'w', machineId: 'local', location: 'local' }), { kind: 'cmd' });
  assert.deepEqual(scopes, ['workspace:w', 'machine:local', 'user']);
  assert.deepEqual(await P.shellChoiceFor(ctx, { id: 'w', machineId: 'ssh:x', location: 'ssh' }), { kind: 'login' });
  assert.ok(P.shellOptions(['Ubuntu']).some(o => o.value === 'wsl:Ubuntu'));
});

test('execution-policy failures get a hint that does not change the policy', () => {
  const hint = P.executionPolicyHint('npm : File C:\\nodejs\\npm.ps1 cannot be loaded because running scripts is disabled on this system.');
  assert.match(hint, /Set-ExecutionPolicy -Scope CurrentUser RemoteSigned/);
  assert.equal(P.executionPolicyHint('ok'), null);
});

test('Windows resolution reads the registry PATH through PowerShell and starts shims with node', async () => {
  const calls = [];
  const ctx = win({ process: { run: async (_g, req) => {
    calls.push(req);
    const name = req.env.HATO_RESOLVE || req.env.HATO_PROBE;
    if (req.env.HATO_PROBE) return { code: 1, stdout: '', stderr: '' };
    const found = name === 'npm'
      ? { path: 'C:\\nodejs\\npm.cmd', pathEnv: 'C:\\nodejs;C:\\Windows', shim: 'SET "NPM_CLI_JS=%~dp0\\node_modules\\npm\\bin\\npm-cli.js"', nodeNext: true, node: null }
      : name === 'mvn' ? { path: 'C:\\maven\\bin\\mvn.cmd', pathEnv: 'P', shim: '@echo off', nodeNext: false, node: 'C:\\nodejs\\node.exe' }
      : name === 'git' ? { path: 'C:\\Git\\cmd\\git.exe', pathEnv: 'P' } : { path: null, pathEnv: 'P' };
    return { code: 0, stdout: 'noise\r\n__HATO_RESOLVE__=' + JSON.stringify(found), stderr: '' };
  } } });
  const npm = await P.resolveWindowsExecutable(ctx, 'g', 'C:/p', 'npm');
  assert.deepEqual(npm.launch, { executable: 'C:\\nodejs\\node.exe', args: ['C:\\nodejs\\node_modules\\npm\\bin\\npm-cli.js'] });
  assert.equal(calls[0].executable, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.ok(calls[0].args.includes('-NoProfile') && calls[0].env.HATO_RESOLVE === 'npm', 'the name travels in the environment, not the script');
  assert.deepEqual((await P.resolveWindowsExecutable(ctx, 'g', 'C:/p', 'mvn')).launch, { executable: 'C:\\maven\\bin\\mvn.cmd', args: [] });
  assert.equal(await P.resolveWindowsExecutable(ctx, 'g', 'C:/p', 'missing'), null);
  await assert.rejects(P.resolveWindowsExecutable(ctx, 'g', 'C:/p', 'x; Remove-Item *'), /Unsupported executable name/);
  const launched = await P.windowsLaunch(ctx, 'g', { executable: 'npm', args: ['run', 'dev'], cwd: 'C:/p', env: { A: '1' } });
  assert.deepEqual(launched, { executable: 'C:\\nodejs\\node.exe', args: ['C:\\nodejs\\node_modules\\npm\\bin\\npm-cli.js', 'run', 'dev'], cwd: 'C:/p', env: { PATH: 'C:\\nodejs;C:\\Windows', A: '1' } });
  await assert.rejects(P.windowsLaunch(ctx, 'g', { executable: './gradlew', args: [], cwd: 'C:/p' }), /not found in C:\/p/);
});

test('firstExistingFile probes all paths in one PowerShell start and maps the exit code back', async () => {
  const calls = [];
  const ctx = win({ process: { run: async (_g, req) => {
    calls.push(req);
    const i = req.env.HATO_PROBE.split('\n').indexOf('C:/p/gradlew.bat');
    return { code: i >= 0 ? 10 + i : 1, stdout: '', stderr: '' };
  } } });
  assert.equal(await P.firstExistingFile(ctx, 'g', 'C:/p', ['C:/p/gradlew.cmd', 'C:/p/gradlew.bat', 'relative.exe']), 'C:/p/gradlew.bat');
  assert.equal(calls.length, 1);
  assert.ok(!calls[0].env.HATO_PROBE.includes('relative.exe'), 'only absolute paths are probed');
  assert.equal(await P.firstExistingFile(ctx, 'g', 'C:/p', ['C:/x.exe']), null);
  assert.equal(await P.firstExistingFile(ctx, 'g', 'C:/p', ['bare']), null);
  const launched = await P.windowsLaunch(ctx, 'g', { executable: './gradlew', args: ['build'], cwd: 'C:/p' }).catch(e => e);
  assert.equal(calls.length, 4, 'one probe for the ./gradlew variants, then the PATH lookup');
  assert.ok(launched instanceof Error || launched.executable);
});
