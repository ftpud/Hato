import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as esbuild from 'esbuild';
const exec = promisify(execFile);

test('daemon ACP resolves interactive version-manager tools and preserves PATH for child executables', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hato-agent-path-'));
  try {
    const bin = join(dir, 'node bin');
    await mkdir(bin);
    const name = "adapter 'quoted'";
    await writeFile(join(bin, name), '#!/bin/sh\nexec node "$@"\n', { mode: 0o755 });
    await writeFile(join(bin, 'node'), '#!/bin/sh\nprintf "node:%s" "$*"\n', { mode: 0o755 });
    const rc = join(dir, 'bashrc');
    await writeFile(rc, `export PATH='${bin}':/usr/bin:/bin\necho startup-noise\n`);
    const shell = join(dir, 'shell');
    await writeFile(shell, `#!/bin/sh\nexec /bin/bash --noprofile --rcfile '${rc}' "$@"\n`, { mode: 0o755 });
    const env = { HOME: dir, SHELL: shell, PATH: '/usr/bin:/bin' };
    const built = await esbuild.build({ entryPoints: ['sdk/agent-executable.ts'], bundle: true, format: 'esm', write: false });
    const { agentExecutable } = await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64'));
    const modes = [];
    const ctx = { host: { process: { run: async (_grant, spec) => {
      modes.push(spec.args[3]);
      try { return { code: 0, ...await exec(spec.executable, spec.args, { env, cwd: spec.cwd }) }; }
      catch (e) { return { code: e.code, stdout: e.stdout || '', stderr: e.stderr || '' }; }
    } } } };
    const resolved = await agentExecutable(ctx, 'grant', dir, name);
    assert.deepEqual(modes, ['-lc', '-ic']);
    assert.equal(resolved.path, join(bin, name));
    assert.equal(resolved.pathEnv, `${bin}:/usr/bin:/bin`);
    const launched = await exec('/bin/sh', ['-lc', 'exec /usr/bin/env "$@"', 'hato-agent', `PATH=${resolved.pathEnv}`, resolved.path, 'argument with spaces'], { env });
    assert.equal(launched.stdout, 'node:argument with spaces');
    await assert.rejects(agentExecutable(ctx, 'grant', dir, 'missing; touch injected'), /not found in the daemon user/);
    assert.equal((await agentExecutable(ctx, 'grant', dir, '/bin/sh')).path, '/bin/sh');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
