// Core-only first run and package-wide provider install/enable/disable/uninstall.
export default {id:'__driver',moduleApiVersion:1,async activate(ctx){
 try {
  await T('test.approvals',{policy:'allow'});
  const repo=await T('test.env',{name:'HATO_PACKAGE_SOURCE_ROOT'}), env=ctx.host.env.info();
  const installed=()=>ctx.host.plugins.list();
  let list=(await installed()).plugins;
  check('fresh core runtime contains no providers or workflow modules',!list.some(p=>['codex-provider','codex-usage','claude-provider','claude-usage','workflows','persistent-agents'].includes(p.id)));
  check('shared ACP starts with no provider profiles',(await ctx.modules.call('acp','profiles',{})).length===0);
  await ctx.modules.call('settings','open',{category:'plugins'});
  let tree=find(await T('test.render',{module:'settings'}),n=>n.type==='tree');
  check('marketplace offers complete feature plugins',['codex-acp','claude-acp','automation','agents'].every(id=>tree.rows.some(r=>r.key==='package:'+id)));
  const paths=[];
  for(const [id,kind] of [['acp','services'],['codex-provider','services'],['codex-usage','ui']]) {
   const dir=env.dataDir+'/import/'+id;
   await T('test.writeFile',{path:dir+'/manifest.json',text:await T('test.readFile',{path:repo+'/Hato-plugins/modules/'+kind+'/'+id+'/manifest.json'})});
   await T('test.writeFile',{path:dir+'/dist/'+id+'.mjs',text:await T('test.readFile',{path:repo+'/Hato-plugins/build/modules/'+id+'.mjs'})});
   paths.push(dir);
  }
  await T('test.pluginInstallMany',{paths});
  await ctx.modules.call('settings','open',{category:'plugins'});
  await ev('settings','plugin:packageEnable',{value:'codex-acp'});
  list=(await installed()).plugins;
  check('one enable action starts provider and usage bar',['codex-provider','codex-usage'].every(id=>list.find(p=>p.id===id)?.active));
  const profiles=await ctx.modules.call('acp','profiles',{});
  check('Codex install exposes Codex without adding Claude',profiles.length===1&&profiles[0].provider==='codex',profiles);
  await ctx.modules.call('settings','open',{category:'plugins'});
  await ev('settings','plugin:marketTab',{value:'installed'});
  tree=find(await T('test.render',{module:'settings'}),n=>n.type==='tree');
  check('Installed shows one Codex plugin rather than separate modules',tree.rows.filter(r=>r.depth===1).some(r=>r.key==='package:codex-acp')&&!tree.rows.some(r=>r.depth===1&&r.key==='module:codex-usage'));
  await ev('settings','plugin:packageDisable',{value:'codex-acp'});
  list=(await installed()).plugins;
  check('disabling Codex hides the profile and its usage bar',!list.find(p=>p.id==='codex-provider').enabled&&!list.find(p=>p.id==='codex-usage').enabled&&(await ctx.modules.call('acp','profiles',{})).length===0);
  await ctx.modules.call('settings','open',{category:'plugins'});
  await ev('settings','plugin:packageUninstall',{value:'codex-acp'});
  list=(await installed()).plugins;
  check('uninstall removes both Codex modules',!list.some(p=>p.id==='codex-provider'||p.id==='codex-usage'));
  await finish();
 }catch(e){check('unexpected error',false,{message:e.message,stack:e.stack});await finish();}
}};
