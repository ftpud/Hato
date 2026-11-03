import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as esbuild from 'esbuild';
let generation=0;
async function load(path){return(await import('data:text/javascript;base64,'+Buffer.from((await esbuild.build({entryPoints:[path],bundle:true,format:'esm',write:false})).outputFiles[0].text).toString('base64')+'#'+generation++)).default;}
function store(){let list=[];const handlers={},events=[];return{handlers,events,get list(){return list;},ctx:{events:{on:(key,fn)=>handlers[key]=fn,emit:(key,data)=>{events.push({key,data});handlers[key]?.(data);}},modules:{async call(module,method,args){assert.equal(module,'persistence');assert.equal(args.key,'persistent-agents.mcps');if(method==='settings.get')return structuredClone(list);if(method==='settings.set'){list=structuredClone(args.value);return null;}throw Error(method);}}}};}
test('MCP configurations retain ids, validate settings and serialize simultaneous edits',async()=>{
 const service=await load('modules/services/persistent-agents/src/index.ts'),s=store();
 const server=id=>({id,name:id,command:'npx',args:['-y',id],env:[{name:'TOKEN',value:'secret'}]});
 await Promise.all(['one','two'].map(id=>service.methods.saveMcp(s.ctx,{server:server(id)})));
 assert.deepEqual(s.list.map(v=>v.id),['one','two']);
 await service.methods.saveMcp(s.ctx,{server:{...server('one'),name:'Changed',enabled:false}});
 assert.equal(s.list.find(v=>v.id==='one').enabled,false);
 assert.equal((await service.methods.listMcps(s.ctx,{})).find(v=>v.id==='one').name,'Changed');
 await assert.rejects(service.methods.saveMcp(s.ctx,{server:{...server('bad'),env:[{name:'NOT VALID',value:'x'}]}}),/Environment/);
 await assert.rejects(service.methods.removeMcp(s.ctx,{id:'internal-remote-mcp'}),/Built-in/);
 await service.methods.removeMcp(s.ctx,{id:'one'});assert.deepEqual(s.list.map(v=>v.id),['two']);
});
test('separate MCP panel adds, edits and removes configurations without a selected workspace',async()=>{
 const service=await load('modules/services/persistent-agents/src/index.ts'),panel=await load('modules/ui/mcp-panel/src/index.ts'),s=store();
 service.activate(s.ctx);
 const ctx={events:s.ctx.events,ui:{invalidate(){}}};
 const event=(action,inputs={},extra={})=>panel.onEvent(ctx,{action,key:action,inputs,...extra});
 const walk=n=>[n,...(n.children||[]).flatMap(walk)];
 try{
  await panel.activate(ctx);await new Promise(setImmediate);
  assert.equal(walk(panel.render()).find(n=>n.type==='tree').rows.length,3);
  await event('add');await event('save',{name:'Test server',command:'npx',args:'["-y","test"]',env:'{"TOKEN":"value"}'});
  assert.equal(s.list.length,1);const id=s.list[0].id;
  await event('select',{}, {rowKey:id});await event('configure');
  assert.equal(walk(panel.render()).find(n=>n.key==='command').value,'npx');
  await event('enabled',{}, {value:false});await event('save',{name:'Renamed',command:'node',args:'["server.js"]',env:'{}'});
  assert.equal(s.list[0].id,id);assert.equal(s.list[0].name,'Renamed');assert.equal(s.list[0].enabled,false);
  assert.ok(!JSON.stringify(panel.snapshot()).includes('TOKEN'));
  await event('remove');assert.ok(walk(panel.render()).some(n=>n.key==='confirm-remove'));
  await event('confirmRemove');assert.equal(s.list.length,0);
 }finally{panel.deactivate();}
});
test('invalid MCP JSON keeps the editor open and does not save',async()=>{
 const service=await load('modules/services/persistent-agents/src/index.ts'),panel=await load('modules/ui/mcp-panel/src/index.ts'),s=store();service.activate(s.ctx);
 const ctx={events:s.ctx.events,ui:{invalidate(){}}};
 try{await panel.activate(ctx);await new Promise(setImmediate);await panel.onEvent(ctx,{action:'add',inputs:{}});await panel.onEvent(ctx,{action:'save',inputs:{name:'X',command:'node',args:'{}',env:'{}'}});assert.equal(s.list.length,0);assert.ok(panel.render().children.some(n=>n.key==='editor'));}finally{panel.deactivate();}
});
