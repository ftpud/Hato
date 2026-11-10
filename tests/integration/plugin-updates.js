// Isolated native lifecycle coverage: prepared sets, rollback, metadata, and self replacement.
export default {
  id: '__driver', moduleApiVersion: 1,
  async activate(ctx) {
    try {
      await T('test.approvals', {policy:'allow'});
      const source = await ctx.modules.call('module-dev','describe',{id:'claude-usage'});
      check('module tools resolve the independent source checkout',source.runtime.modulesRoot.includes('/Hato-plugins/modules'),source.runtime);
      const built = await ctx.modules.call('module-dev','buildAndActivate',{id:'claude-usage'},{timeoutMs:120000});
      check('existing in-app build and activate path works',built.ok,built);
      const root = ctx.host.env.info().dataDir + '/fixtures';
      const write = async (id, version, broken = false, self = false) => {
        const path = `${root}/${version}/${id}`;
        const manifest = {schemaVersion:2,id,kind:'service',entry:'index.mjs',moduleApiVersion:1,
          capabilities:self ? ['plugins.manage'] : [],version,pluginType:'Fixture'};
        const code = `let count=0; export default {id:${JSON.stringify(id)},moduleApiVersion:1,
          activate(ctx,prev){count=prev?.count||0},snapshot:()=>({count}),methods:{
          health(){${broken ? "throw Error('fixture failed health')" : 'return {ok:true}'}},
          read(){return {version:${JSON.stringify(version)},count}},bump(){return ++count},
          update(ctx,a){return ctx.host.plugins.install(a.path)} }};`;
        await T('test.writeFile',{path:path+'/manifest.json',text:JSON.stringify(manifest)});
        await T('test.writeFile',{path:path+'/index.mjs',text:code});
        return path;
      };
      const read = id => ctx.modules.call(id,'read',{});
      const a = await write('fixture-a','1.0.0'), b = await write('fixture-b','1.0.0');
      await T('test.pluginInstallMany',{paths:[a,b]});
      await T('test.pluginEnable',{id:'fixture-a'}); await T('test.pluginEnable',{id:'fixture-b'});
      await ctx.modules.call('fixture-a','bump',{});
      const a2 = await write('fixture-a','1.0.1'), b2 = await write('fixture-b','1.0.1',true);
      let failed = false;
      try {await T('test.pluginInstallMany',{paths:[a2,b2]});} catch {failed = true;}
      check('batch rejects failing candidate',failed);
      check('healthy earlier module restored with snapshot',(await read('fixture-a')).version==='1.0.0' && (await read('fixture-a')).count===1,await read('fixture-a'));
      check('failed module keeps its old generation',(await read('fixture-b')).version==='1.0.0');
      const disk = JSON.parse(await T('test.readFile',{path:ctx.host.env.info().dataDir+'/plugins/fixture-a/manifest.json'}));
      check('failed batch restores installed files',disk.version==='1.0.0');
      await T('test.pluginInstallMany',{paths:[a2]});
      check('successful update preserves state',(await read('fixture-a')).count===1);
      check('manifest version reaches plugin UI',(await ctx.host.plugins.list()).plugins.find(p=>p.id==='fixture-a').metadata.version==='1.0.1');
      await T('test.pluginRollback',{id:'fixture-a'});
      check('explicit rollback restores previous version',(await read('fixture-a')).version==='1.0.0');
      const self1 = await write('fixture-self','1.0.0',false,true);
      await T('test.pluginInstall',{path:self1}); await T('test.pluginEnable',{id:'fixture-self'});
      await ctx.modules.call('fixture-self','bump',{});
      const self2 = await write('fixture-self','1.0.1',false,true);
      const queued = await ctx.modules.call('fixture-self','update',{path:self2});
      check('self update replies without restart',queued.pendingActivation===true && queued.pendingRestart===false,queued);
      const active = await until(async()=>{const r=await read('fixture-self');return r.version==='1.0.1'?r:null;});
      check('self update activates after request and retains snapshot',active?.count===1,active);
      const bad = await write('fixture-self','1.0.2',true,true);
      await ctx.modules.call('fixture-self','update',{path:bad});
      const restored = await until(async()=>{
        const text=await T('test.readFile',{path:ctx.host.env.info().dataDir+'/plugins/fixture-self/manifest.json'});
        return JSON.parse(text).version==='1.0.1';
      });
      check('failed self update restores disk and keeps previous generation',restored && (await read('fixture-self')).version==='1.0.1');
      await finish();
    } catch(e) {check('unexpected error',false,{message:e.message,stack:e.stack});await finish();}
  }
};
