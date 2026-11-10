import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as esbuild from 'esbuild';
const load = async () => {
  const b = await esbuild.build({ entryPoints: ['Hato-plugins/modules/services/module-dev/src/index.ts'], bundle: true, format: 'esm', write: false });
  return (await import('data:text/javascript;base64,' + Buffer.from(b.outputFiles[0].text).toString('base64'))).default;
};

test('truncated compiler output is an error, is cached for polling, and is never staged', async () => {
  const mod = await load();
  let compiles = 0, staged = 0;
  const ctx = { events: { emit() {} }, host: {
    capabilities: { request: async () => ({ grant: 'grant' }), release: async () => {} },
    modules: { list: async () => [{ id: 'probe', kind: 'service', active: { sha256: 'old', label: 'probe@0001' } }],
      describe: async () => ({ sourceDir: 'modules/services/probe', manifest: { entry: 'src/index.ts' } }),
      sourceInfo: async () => ({ repoRoot: '/runtime', buildTool: '/esbuild' }),
      stageArtifact: async () => { staged++; } },
    fs: { list: async () => ({ entries: [{ name: 'index.ts', kind: 'file' }] }), stat: async () => ({ size: 20, mtime: 1 }) },
    process: { run: async () => { compiles++; return { code: 0, stdout: 'partial bundle', stderr: '', truncated: true }; } },
  } };
  let result = await mod.methods.scanUpdates(ctx, {});
  assert.deepEqual(result.errors, ['probe']);
  assert.match(result.modules[0].diagnostics, /capture limit/);
  assert.equal(result.modules[0].builtHash, null);
  await mod.methods.scanUpdates(ctx, {});
  assert.equal(compiles, 1, 'unchanged failed source is not retried by the background poll');
  const built = await mod.methods.build(ctx, { id: 'probe' });
  assert.equal(built.ok, false);
  assert.equal(staged, 0);
});

test('Windows module source directories use module-relative forward slashes', async () => {
  const mod = await load();
  const listed = [];
  const ctx = { host: {
    capabilities: { request: async () => ({ grant: 'grant' }) },
    modules: { describe: async () => ({ sourceDir: 'modules\\ui\\viewer' }) },
    fs: {
      list: async (_grant, path) => {
        listed.push(path);
        assert.equal(path, 'ui/viewer');
        return { entries: [{ name: 'index.ts', kind: 'file' }] };
      },
    },
  } };
  const result = await mod.methods.readSource(ctx, { id: 'viewer' });
  assert.deepEqual(listed, ['ui/viewer']);
  assert.equal(result.root, 'modules/ui/viewer');
  assert.deepEqual(result.files, ['modules/ui/viewer/index.ts']);
});
