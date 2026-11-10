import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as esbuild from 'esbuild';

const exec = promisify(execFile);

test('SSH ACP detects interactive-only tools and carries their PATH into npm installation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hato-acp-path-'));
  try {
    const bin = join(dir, 'node version bin');
    await mkdir(bin);
    await writeFile(join(bin, 'npm'), '#!/bin/sh\nprintf "npm:%s" "$*"\n', { mode: 0o755 });
    await writeFile(join(bin, 'codex-acp'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const rc = join(dir, 'bashrc');
    await writeFile(rc, `case $- in *i*) ;; *) return ;; esac\nexport PATH='${bin}':/usr/bin:/bin\necho startup-noise\n`);
    const shell = join(dir, 'shell');
    await writeFile(shell, `#!/bin/sh\nexec /bin/bash --noprofile --rcfile '${rc}' "$@"\n`, { mode: 0o755 });
    const built = await esbuild.build({ entryPoints: ['Hato-plugins/modules/services/acp/src/index.ts'], bundle: true, format: 'esm', write: false });
    const { detect, default: mod } = await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64'));
    const desc = { id: 'acp-test', location: 'ssh', machineId: 'ssh:acp-test', rootAbsolutePath: dir, ssh: { profileId: 'acp-test', host: 'test', port: 22, user: 'test' } };
    const calls = [];
    const ctx = {
      modules: { call: async () => desc }, events: { emit() {} },
      host: {
        ssh: { connect: async () => ({ connection: 'ssh', machineId: desc.machineId }) },
        capabilities: { request: async () => ({ grant: 'grant' }) },
        process: { run: async (_grant, spec) => {
          calls.push(spec);
          const env = { HOME: dir, SHELL: shell, PATH: '/usr/bin:/bin', ...spec.env };
          try {
            const r = await exec(spec.executable, spec.args, { cwd: spec.cwd, env });
            return { code: 0, ...r };
          } catch (e) { return { code: e.code, stdout: e.stdout || '', stderr: e.stderr || '' }; }
        } },
      },
    };
    const adapter = await detect(ctx, desc, 'codex-acp');
    assert.equal(adapter.found, true);
    assert.equal(adapter.path, join(bin, 'codex-acp'));
    assert.equal(adapter.pathEnv, `${bin}:/usr/bin:/bin`);
    const result = await mod.methods.installAdapter(ctx, { workspaceId: desc.id, adapterId: 'codex' }, { caller: 'ai-sessions' });
    assert.equal(result.ok, true);
    assert.match(result.output, /npm:install -g @agentclientprotocol\/codex-acp@latest/);
    assert.equal(calls.at(-1).env.PATH, adapter.pathEnv);
    assert.equal((await detect(ctx, desc, 'missing; touch injected')).found, false);
    assert.equal((await detect(ctx, desc, '/bin/sh')).found, true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
