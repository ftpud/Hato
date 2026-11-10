import type { ModuleContext, PluginInfo, UiNode } from '../../../../sdk/types';
import bundled from '../../../../plugins.catalogue.json';
export const REPOSITORY = 'ftpud/Hota-plugins';
export interface Package { id:string; name:string; type:string; core:boolean; author:string; description:string; version:string; coreVersion:string; dependencies:Record<string,string>; modules:string[]; artifacts?: {id:string; manifest:string; bundle:string}[] }
export function satisfies(version:string, range:string):boolean {
  const parse=(s:string)=> /^\d+\.\d+\.\d+$/.test(s) ? s.split('.').map(Number) : null;
  const v=parse(version), r=parse(range.replace(/^[\^~]/,''));
  if(!v||!r)return false;
  const cmp=v[0]-r[0]||v[1]-r[1]||v[2]-r[2];
  if(range[0]==='~')return cmp>=0&&v[0]===r[0]&&v[1]===r[1];
  if(range[0]==='^')return cmp>=0&&v[0]===r[0]&&(r[0]>0||v[1]===r[1])&&(r[0]>0||r[1]>0||v[2]===r[2]);
  return cmp===0;
}
export function plan(packages:Package[], id:string, coreVersion:string):Package[] {
  const done=new Set<string>(), visiting=new Set<string>(), result:Package[]=[];
  const visit=(key:string)=>{
    if(done.has(key))return;
    if(visiting.has(key))throw Error(`Cyclic package dependency: ${key}`);
    const p=packages.find(p=>p.id===key);if(!p)throw Error(`Missing package: ${key}`);
    if(!satisfies(coreVersion,p.coreVersion))throw Error(`${p.name} requires Hato ${p.coreVersion}`);
    visiting.add(key);
    for(const [dep,range] of Object.entries(p.dependencies)){
      const d=packages.find(x=>x.id===dep);if(!d||!satisfies(d.version,range))throw Error(`Unsatisfied dependency: ${dep} ${range}`);
      visit(dep);
    }
    visiting.delete(key);done.add(key);result.push(p);
  };visit(id);return result;
}
let packages:Package[]=bundled.packages as Package[];
let base='';
let receipts:Record<string,string>={};
let tab='installed';
export async function refreshMarket(ctx:ModuleContext){
  receipts=(await ctx.modules.call('persistence','settings.get',{key:'plugins.receipts.v1'}))||{};
  const get=async(url:string)=>{const r=await ctx.host.net.fetch({url,maxBytes:2*1024*1024});if(r.status!==200)throw Error(`Marketplace HTTP ${r.status}`);return JSON.parse(r.body);};
  const commit=await get(`https://api.github.com/repos/${REPOSITORY}/commits/main`);
  if(!/^[a-f0-9]{40}$/.test(commit.sha))throw Error('Invalid repository revision');
  const nextBase=`https://raw.githubusercontent.com/${REPOSITORY}/${commit.sha}/`;
  const cat=await get(nextBase+'catalogue.json');
  if(cat.schemaVersion!==1||!Array.isArray(cat.packages))throw Error('Unsupported catalogue');
  const ids=new Set<string>(), modules=new Set<string>();
  for(const p of cat.packages){
    if(!/^[a-z0-9][a-z0-9-]{0,47}$/.test(p.id)||ids.has(p.id)||typeof p.author!=='string'||typeof p.type!=='string'||!Array.isArray(p.modules)||!p.dependencies||!Array.isArray(p.artifacts))throw Error('Invalid package metadata');
    ids.add(p.id);
    for(const id of p.modules){if(!/^[a-z0-9][a-z0-9-]{0,47}$/.test(id)||modules.has(id))throw Error('Invalid or duplicate module');modules.add(id);}
  }
  for(const p of cat.packages)plan(cat.packages,p.id,bundled.coreVersion);
  packages=cat.packages;base=nextBase;
}
function installed(p:Package,plugins:PluginInfo[]){return p.modules.every(id=>plugins.some(m=>m.id===id));}
function version(p:Package,plugins:PluginInfo[]){return receipts[p.id]||(installed(p,plugins)&&p.modules.every(id=>plugins.find(m=>m.id===id)?.source==='builtin')?bundled.packages.find(b=>b.id===p.id)?.version:undefined);}
export function marketNodes(plugins:PluginInfo[],busy:boolean):UiNode[]{
 const visible=packages.filter(p=>tab==='marketplace'||installed(p,plugins));
 return [
 {type:'row',key:'market-tabs',gap:8,children:[...['installed','marketplace'].map(t=>({type:'button',key:t,text:t==='installed'?'Installed packages':'Marketplace',action:'plugin:marketTab',value:t,variant:tab===t?'primary':undefined} as UiNode)),{type:'button',key:'refresh-market',text:'Check for updates',action:'plugin:marketRefresh',disabled:busy}]},
 ...Array.from(new Set(visible.map(p=>p.type))).sort().map(type=>({type:'column',key:`group-${type}`,gap:8,children:[
 {type:'label',key:'group-title',text:type,weight:'semibold',color:'muted'},
 ...visible.filter(p=>p.type===type).map(p=>{const has=installed(p,plugins),v=version(p,plugins);return {type:'column',key:p.id,padding:12,gap:6,border:true,children:[
 {type:'row',key:'title',gap:8,children:[{type:'label',key:'name',text:p.name,weight:'semibold',grow:true},{type:'label',key:'version',text:`${p.version}${p.core?' · Bundled core':''}`,color:'muted',size:'xs'}]},
 {type:'label',key:'description',text:p.description,wrap:true,size:'sm'},
 {type:'label',key:'author',text:`By ${p.author} · Hato ${p.coreVersion} · ${p.modules.length} modules`,color:'muted',size:'xs'},
 {type:'label',key:'dependencies',text:`Dependencies: ${Object.keys(p.dependencies).join(', ')||'none'}`,color:'muted',size:'xs'},
 {type:'button',key:'install',text:!has?'Download & install':v===p.version?'Reinstall':'Update',action:'plugin:marketInstall',value:p.id,disabled:busy||!base,small:true},
 ]} as UiNode;})]} as UiNode))];
}
export function marketTab(value:string){tab=value==='marketplace'?value:'installed';}
export async function installPackage(ctx:ModuleContext,id:string,plugins:PluginInfo[]){
 if(!base)await refreshMarket(ctx);
 const selected=plan(packages,id,bundled.coreVersion);
 // Download and validate every artifact before requesting installation of any module.
 const files:{id:string;manifest:string;code:string}[]=[];
 for(const p of selected){
  if(p.id!==id&&version(p,plugins)===p.version)continue;
  for(const moduleId of p.modules){
   const a=p.artifacts?.find(a=>a.id===moduleId);if(!a)throw Error(`Missing artifact: ${moduleId}`);
   const read=async(path:string)=>{if(!/^packages\/[a-z0-9/._-]+$/.test(path)||path.includes('..'))throw Error('Unsafe artifact path');const r=await ctx.host.net.fetch({url:base+path,maxBytes:16*1024*1024});if(r.status!==200)throw Error(`Download failed: ${path}`);return r.body;};
   const manifest=await read(a.manifest),m=JSON.parse(manifest);
   if(m.id!==moduleId||m.version!==p.version||m.moduleApiVersion!==1||m.pluginPackage!==p.id)throw Error('Artifact metadata mismatch');
   files.push({id:moduleId,manifest,code:await read(a.bundle)});
  }
 }
 let pendingRestart=false;
 const root=ctx.host.env.info().dataDir+'/marketplace-downloads';
 const grant=await ctx.host.capabilities.request({kind:'fs',root:ctx.host.env.info().dataDir,write:true,purpose:'Download plugin packages'});
 try{
  await ctx.host.fs.mkdir(grant.grant,root);
  for(const f of files){const dir=root+'/'+f.id;await ctx.host.fs.mkdir(grant.grant,dir);await ctx.host.fs.mkdir(grant.grant,dir+'/dist');await ctx.host.fs.writeAtomic(grant.grant,dir+'/manifest.json',f.manifest);await ctx.host.fs.writeAtomic(grant.grant,dir+'/dist/'+f.id+'.mjs',f.code);const result=await ctx.host.plugins.install(dir);pendingRestart ||= !!(result as {pendingRestart?:boolean}).pendingRestart;}
  for(const p of selected){receipts[p.id]=p.version;await ctx.modules.call('persistence','settings.set',{key:'plugins.receipts.v1',value:receipts});}
 }finally{await ctx.host.capabilities.release(grant.grant);}
 return `Installed ${id}.${pendingRestart?" Restart Hato to load the updated plugin manager.":""} Enable new modules below to approve their permissions.`;
}
