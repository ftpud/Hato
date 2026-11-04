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
const panelCtx=s=>({events:s.ctx.events,ui:{invalidate(){}},state:{get(){},set(){},watch(){}}});
const walk=n=>[n,...(n.children||[]).flatMap(walk)];
test('MCP panel adds, edits and removes a local server without a selected workspace',async()=>{
 const service=await load('modules/services/persistent-agents/src/index.ts'),panel=await load('modules/ui/mcp-panel/src/index.ts'),s=store();
 service.activate(s.ctx);
 const ctx=panelCtx(s);
 const event=(action,inputs={},extra={})=>panel.onEvent(ctx,{action,key:action,inputs,...extra});
 try{
  await panel.activate(ctx);await new Promise(setImmediate);
  assert.ok(walk(panel.render()).some(n=>n.key==='empty'),'first run shows the empty state with quick-add presets');
  await event('toggleBuiltin');
  assert.equal(walk(panel.render()).find(n=>n.key==='builtin').rows.length,3);
  await event('add');await event('kind',{}, {value:'local'});
  await event('save',{'f-name':'Test server','f-command':'npx','f-args':'-y\ntest\n','f-env':'TOKEN=value'});
  assert.equal(s.list.length,1);const id=s.list[0].id;
  assert.deepEqual([s.list[0].transport,s.list[0].args,s.list[0].env],['stdio',['-y','test'],[{name:'TOKEN',value:'value'}]]);
  await event('select',{}, {rowKey:id});await event('edit');
  assert.equal(walk(panel.render()).find(n=>n.key==='f-command').value,'npx');
  await event('draftEnabled',{}, {value:false});await event('save',{'f-name':'Renamed','f-command':'node','f-args':'server.js','f-env':''});
  assert.equal(s.list[0].id,id);assert.equal(s.list[0].name,'Renamed');assert.equal(s.list[0].enabled,false);
  assert.ok(!JSON.stringify(panel.snapshot()).includes('TOKEN'));
  await event('toggleEnabled',{}, {value:true});assert.equal(s.list[0].enabled,true,'the detail switch saves immediately');
  await event('duplicate');await event('save',{});assert.equal(s.list.length,2);assert.equal(s.list[1].name,'Renamed copy');
  await event('select',{}, {rowKey:id});await event('remove');assert.ok(walk(panel.render()).some(n=>n.key==='confirm-remove'));
  await event('confirmRemove');assert.deepEqual(s.list.map(v=>v.name),['Renamed copy']);
 }finally{panel.deactivate();}
});
test('invalid MCP fields keep the editor open and do not save',async()=>{
 const service=await load('modules/services/persistent-agents/src/index.ts'),panel=await load('modules/ui/mcp-panel/src/index.ts'),s=store();service.activate(s.ctx);
 const ctx=panelCtx(s);
 try{
  await panel.activate(ctx);await new Promise(setImmediate);
  await panel.onEvent(ctx,{action:'add',inputs:{}});await panel.onEvent(ctx,{action:'kind',inputs:{},value:'local'});
  await panel.onEvent(ctx,{action:'save',inputs:{'f-name':'X','f-command':'node','f-env':'NOT VALID'}});
  assert.equal(s.list.length,0);assert.ok(panel.render().children.some(n=>n.key==='editor'));
  await panel.onEvent(ctx,{action:'kind',inputs:{},value:'remote'});
  await panel.onEvent(ctx,{action:'save',inputs:{'f-url':'http://example.com/mcp'}});
  assert.equal(s.list.length,0,'plain http is rejected for non-loopback hosts');
  assert.match(walk(panel.render()).find(n=>n.key==='save-error').text,/https/);
 }finally{panel.deactivate();}
});
test('remote presets and pasted configs become remote servers; OAuth tokens stay out of the config',async()=>{
 const service=await load('modules/services/persistent-agents/src/index.ts'),panel=await load('modules/ui/mcp-panel/src/index.ts'),s=store();service.activate(s.ctx);
 const ctx=panelCtx(s);
 const event=(action,inputs={},extra={})=>panel.onEvent(ctx,{action,key:action,inputs,...extra});
 try{
  await panel.activate(ctx);await new Promise(setImmediate);
  await event('add');await event('preset',{}, {value:'linear'});await event('save',{});
  assert.deepEqual([s.list[0].name,s.list[0].transport,s.list[0].url,s.list[0].auth.type],['Linear','http','https://mcp.linear.app/mcp','oauth']);
  assert.ok(!('token' in s.list[0].auth));
  await event('addImport');
  await event('import',{'f-importText':JSON.stringify({mcpServers:{files:{command:'npx',args:['-y','fs'],env:{ROOT:'/'}},api:{url:'https://api.example.com/mcp',headers:{Authorization:'Bearer abc','X-Team':'7'}}}})});
  assert.equal(s.list.length,3);
  const api=s.list.find(v=>v.name==='api');
  assert.deepEqual([api.auth.type,api.auth.token,api.headers],['bearer','abc',[{name:'X-Team',value:'7'}]]);
 }finally{panel.deactivate();}
});
