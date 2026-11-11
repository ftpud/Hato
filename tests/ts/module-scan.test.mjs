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

test('installed modules with empty sourceDir build their editable checkout without /src entry paths',async()=>{
 const mod=await load();let spec;
 const manifest={id:'explorer',kind:'ui',entry:'src/index.ts'};
 const ctx={events:{emit(){}},host:{capabilities:{request:async()=>({grant:'source'}),release:async()=>{}},modules:{describe:async()=>({sourceDir:'',manifest}),sourceInfo:async()=>({repoRoot:'/runtime/Hato-plugins',buildTool:'/esbuild',sdkRoot:'/runtime/sdk'}),stageArtifact:async()=>({stageId:'stage-test'})},fs:{stat:async(_g,p)=>{assert.equal(p,'ui/explorer/manifest.json');return {kind:'file'};},read:async()=>({text:JSON.stringify(manifest)})},process:{run:async(_g,request)=>{spec=request;return {code:0,stdout:'export default {};',stderr:'',truncated:false};}}}};
 const result=await mod.methods.build(ctx,{id:'explorer'});
 assert.equal(result.ok,true);assert.equal(spec.args[0],'modules/ui/explorer/src/index.ts');assert.equal(spec.cwd,'/runtime/Hato-plugins');
});

test('bundle-only plugins without checkout sources are unavailable rather than broken builds',async()=>{
 const mod=await load();let builds=0;
 const ctx={events:{emit(){}},host:{capabilities:{request:async()=>({grant:'source'}),release:async()=>{}},modules:{list:async()=>[{id:'vendor-plugin',kind:'ui',active:{sha256:'active',label:'vendor-plugin@1'}}],describe:async()=>({sourceDir:'',manifest:{id:'vendor-plugin',kind:'ui',entry:'dist/index.mjs'}}),sourceInfo:async()=>({repoRoot:'/runtime',buildTool:'/esbuild'})},fs:{stat:async()=>{throw Object.assign(Error('not found'),{code:'ENOENT'});}},process:{run:async()=>{builds++;throw Error('must not build');}}}};
 const result=await mod.methods.scanUpdates(ctx,{});
 assert.deepEqual(result.errors,[]);assert.equal(result.modules[0].status,'source-unavailable');assert.equal(builds,0);
});
