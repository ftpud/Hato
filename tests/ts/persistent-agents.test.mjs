import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as esbuild from 'esbuild';
let generation=0;
const load=async path=>import('data:text/javascript;base64,'+Buffer.from((await esbuild.build({entryPoints:[path],bundle:true,format:'esm',write:false})).outputFiles[0].text).toString('base64')+'#'+generation++);
test('persistent agent models support negotiated option groups and legacy models',async()=>{
 const {modelChoices,relativeAgentPath}=await load('sdk/persistent-agents.ts');
 assert.deepEqual(modelChoices({configOptions:[{id:'m',category:'model',options:[{name:'Group',options:[{value:'a',name:'A'}]}]}]}),[{id:'a',label:'A',configId:'m'}]);
 assert.equal(modelChoices({models:{availableModels:[{modelId:'b',name:'B'}]}})[0].configId,'__model');
 for(const path of ['/secret','../secret','foo/../secret','foo\\secret'])assert.throws(()=>relativeAgentPath(path));
 assert.equal(relativeAgentPath('.agents/agents/test.md'),'.agents/agents/test.md');
});
test('background panel boots with no selection and never starts or stops chat sessions',async()=>{
 const mod=(await load('modules/ui/agents-panel/src/index.ts')).default;
 const calls=[];
 const ctx={state:{get(){},watch(){}},events:{on(){}},ui:{invalidate(){}},modules:{call:(...a)=>{calls.push(a);throw Error('unexpected call');}}};
 await mod.activate(ctx);
 assert.equal(mod.render().key,'agents-root');
 assert.deepEqual(calls,[]);
 mod.deactivate();assert.deepEqual(calls,[]);
});
test('background panel selects provider, skill, MCP and agent file independently of chatbox',async()=>{
 const mod=(await load('modules/ui/agents-panel/src/index.ts')).default;
 const calls=[],emitted=[];let created=false;
 const session={id:'a',name:'Worker',activity:'Running the current tests',profile:{name:'Fixture',provider:'fixture'},machineId:'local',workspaceName:'WS',status:'ready',configOptions:[],models:{currentModelId:'x',availableModels:[{modelId:'x'}]},revision:1};
 const ctx={events:{on(){},emit:(topic,value)=>emitted.push({topic,value})},state:{get:k=>k==='workspace.selected'?{id:'ws',name:'WS'}:{agents:false},watch(){}},ui:{invalidate(){}},modules:{async call(module,method,args){
  calls.push({module,method,args});
  if(method==='catalog')return{profiles:[{id:'fixture',name:'Fixture'}],skills:[{path:'.agents/skills/test/SKILL.md',name:'Test'}],agentFiles:[{path:'AGENTS.md'}],mcps:[{id:'internal-remote-mcp',name:'Workspace'}]};
  if(method==='list')return created?[session]:[];
  if(method==='create'){created=true;return session;}
  if(method==='view')return{session,messages:[],permissions:[],queued:[],before:null};
 }}};
 await mod.activate(ctx);
 const event=(action,key=action,value='',inputs={})=>mod.onEvent(ctx,{action,key,value,inputs});
 await event('new');await event('provider','provider','fixture');await event('agentFile','agent-file','AGENTS.md');await event('skill','skill:.agents/skills/test/SKILL.md',true);
 await event('create','create','',{'agent-name':'Worker'});
 const a=calls.find(c=>c.method==='create').args;
 assert.deepEqual(a.skills,['.agents/skills/test/SKILL.md']);assert.deepEqual(a.mcps,['internal-remote-mcp']);assert.equal(a.agentFile,'AGENTS.md');assert.equal(a.profileId,'fixture');
 assert.equal(mod.snapshot().selected,'a');assert.ok(emitted.some(e=>e.topic==='agents-panel.openChat'&&e.value.id==='a'));assert.ok(!JSON.stringify(mod.render()).includes('transcript'));assert.equal(mod.render().children.find(n=>n.type==='tree').rows[0].key,'a');assert.equal(mod.render().children.find(n=>n.type==='tree').rows[0].detail,'Running the current tests');assert.ok(calls.every(c=>c.module==='persistent-agents'));
 mod.deactivate();assert.ok(!calls.some(c=>c.method==='stop'));
});
test('agents panel edits, clears and removes the selected agent without an MCP shortcut',async()=>{
 const mod=(await load('modules/ui/agents-panel/src/index.ts')).default;
 const calls=[],emitted=[];let removed=false;
 const session={id:'a',name:'Worker',profile:{id:'fixture',name:'Fixture'},machineId:'local',status:'ready',agentFile:'AGENTS.md',skills:['.agents/skills/test/SKILL.md'],mcps:[],workspaceMcp:true,revision:1};
 const ctx={events:{on(){},emit:(topic,value)=>emitted.push({topic,value})},state:{get:k=>k==='workspace.selected'?{id:'ws',name:'WS'}:{agents:true},watch(){}},ui:{invalidate(){}},modules:{async call(module,method,args){
  calls.push({module,method,args});
  if(method==='catalog')return{profiles:[{id:'fixture',name:'Fixture'},{id:'other',name:'Other'}],skills:[{path:'.agents/skills/test/SKILL.md',name:'Test'}],agentFiles:[{path:'AGENTS.md'}],mcps:[{id:'internal-remote-mcp',name:'Workspace'}]};
  if(method==='list')return removed?[]:[session];
  if(method==='remove'){removed=true;return null;}
  return session;
 }}};
 await mod.activate(ctx);
 try {
  const event=(action,value='',inputs={})=>mod.onEvent(ctx,{action,key:action,value,inputs});
  const nodes=()=>{const walk=n=>[n,...(n.children||[]).flatMap(walk)];return walk(mod.render());};
  assert.ok(!nodes().some(n=>n.key==='mcps'));
  assert.ok(!nodes().some(n=>n.key==='agent-actions'));
  await event('open','a');
  assert.deepEqual(nodes().find(n=>n.key==='agent-actions').children.map(n=>n.key),['edit','clear','remove']);
  // Edit pre-fills the form from the agent and saves through `update`.
  await event('edit','a');
  assert.ok(nodes().some(n=>n.key==='save')&&!nodes().some(n=>n.key==='create'));
  assert.equal(nodes().find(n=>n.key==='agent-name').value,'Worker');
  await event('provider','other');
  await event('save','',{'agent-name':'Renamed'});
  assert.deepEqual(calls.find(c=>c.method==='update').args,{workspaceId:'ws',id:'a',name:'Renamed',profileId:'other',agentFile:'AGENTS.md',skills:['.agents/skills/test/SKILL.md'],mcps:['internal-remote-mcp']});
  assert.ok(!nodes().some(n=>n.key==='save'));
  // Clear and remove ask first.
  await event('confirmClear','a');
  assert.equal(nodes().find(n=>n.type==='modal').title,'Clear session');
  assert.ok(!calls.some(c=>c.method==='clear'));
  await event('clear','a');
  assert.equal(calls.find(c=>c.method==='clear').args.id,'a');
  assert.ok(emitted.some(e=>e.topic==='agents-panel.agentCleared'&&e.value.id==='a'));
  await event('confirmRemove','a');await event('dismiss');
  assert.ok(!nodes().some(n=>n.type==='modal'));
  await event('confirmRemove','a');await event('remove','a');
  assert.equal(calls.find(c=>c.method==='remove').args.id,'a');
  assert.ok(emitted.some(e=>e.topic==='agents-panel.agentRemoved'&&e.value.id==='a'));
  assert.equal(mod.snapshot().selected,null);
  assert.ok(!nodes().some(n=>n.key==='agent-actions'));
 } finally { mod.deactivate(); }
});

test('existing chatbox binds background session and routes prompts without using regular chat service',async()=>{
 const mod=(await load('modules/ui/ai/src/index.ts')).default;
 const handlers={},calls=[],requests=[],published=[];
 const normal={profiles:[],conversations:[],active:null};
 const page={session:{id:'worker',name:'Worker',workspaceId:'ws',profile:{id:'fixture',name:'Fixture'},status:'ready',mcps:[],skills:[],models:{currentModelId:'x',availableModels:[{modelId:'x',name:'X'}]},configOptions:[]},messages:[{key:'m',role:'assistant',text:'Background history'}],before:null,queued:[],permissions:[]};
 const ctx={events:{on(){},emit:(topic,value)=>emitted.push({topic,value})},state:{get:k=>k==='workspace.selected'?{id:'ws'}:null,set:(k,v)=>published.push([k,v]),watch(){}},ui:{invalidate(){}},events:{on:(k,fn)=>handlers[k]=fn,emit:(topic,payload)=>{
   if(topic==='ai.persistentRequest'){requests.push(payload);queueMicrotask(()=>handlers['persistent-agents.chatResponse']({requestId:payload.requestId,value:payload.method==='view'?page:{accepted:true}}));}
 }},modules:{call:async(m,f)=>{calls.push([m,f]);return normal;}}};
 await mod.activate(ctx);
 try {
  await mod.onEvent(ctx,{action:'draftChanged',value:'Unsent regular prompt',inputs:{}});
  handlers['agents-panel.openChat']({workspaceId:'ws',id:'worker'});
  await new Promise(setImmediate);
  const walk=n=>[n,...(n.children||[]).flatMap(walk)];
  let nodes=walk(mod.render());
  assert.ok(nodes.some(n=>n.key==='background-session'));
  assert.equal(nodes.find(n=>n.type==='transcript').scrollKey,'worker');
  assert.ok(!nodes.some(n=>n.key==='attach'));
  const auto=nodes.find(n=>n.key==='auto');
  assert.ok(auto&&!auto.checked&&/even while Hato is closed/.test(auto.tooltip));
  const before=calls.length;
  await mod.onEvent(ctx,{action:'send',inputs:{prompt:'For this worker'}});
  assert.equal(requests.find(r=>r.method==='send').args.id,'worker');
  await mod.onEvent(ctx,{action:'toggleAuto',value:true,inputs:{}});
  const toggle=requests.find(r=>r.method==='setAutopilot');
  assert.equal(toggle.args.id,'worker');
  assert.equal(toggle.args.enabled,true);
  assert.equal(calls.length,before);
  await mod.onEvent(ctx,{action:'backToChats',inputs:{}});
  assert.ok(!walk(mod.render()).some(n=>n.key==='background-session'));
  assert.ok(published.some(([k,v])=>k==='ai.session'&&v.kind==='chat'));
  assert.equal(mod.snapshot().draft,'Unsent regular prompt');
 }finally{mod.deactivate();}
});
test('agent activity shows current output, tool status and approval waits instead of turn bookkeeping',async()=>{
 const {agentActivity}=await load('sdk/persistent-agents.ts');
 const view={session:{status:'busy',error:null},permissions:[],messages:[{role:'assistant',text:'Examining the project\n  and checking tests.'},{role:'system',text:'Turn ended: complete'}]};
 assert.equal(agentActivity(view),'Examining the project and checking tests.');
 view.messages.push({role:'tool',title:'Run tests',status:'in_progress',text:''});
 assert.equal(agentActivity(view),'Run tests · in_progress');
 view.messages.push({role:'thought',text:'Investigating the failure'});
 assert.equal(agentActivity(view),'Thinking: Investigating the failure');
 view.session.status='waiting';view.permissions=[{request:{toolCall:{title:'Apply patch'}}}];
 assert.equal(agentActivity(view),'Awaiting approval: Apply patch');
 view.session.error='Provider disconnected';assert.equal(agentActivity(view),'Error: Provider disconnected');
 view.session={status:'busy'};view.messages=[{role:'assistant',text:'old '.repeat(100)+'Newest activity'}];
 assert.ok(agentActivity(view).endsWith('Newest activity'));assert.ok(agentActivity(view).length<=180);
});
test('list activity refreshes revised sessions without replacing the daemon runtime',async()=>{
 const mod=(await load('modules/services/persistent-agents/src/index.ts')).default;
 let revision=1,reads=0,text='Inspecting source';
 const row=()=>({id:'worker',workspaceId:'ws',status:'busy',revision});
 const ctx={modules:{call:async()=>({id:'ws',machineId:'local',location:'local'})},host:{daemon:{ensure:async()=>({bin:'/hato',dir:'/runtime'}),request:async(_target,operation,args)=>{
  if(operation==='plugins.list')return{plugins:[{id:'agent-runner',active:true},{id:'internal-remote-mcp',active:true}]};
  assert.equal(operation,'modules.call');
  if(args.method==='list')return[row()];
  if(args.method==='view'){reads++;return{session:row(),permissions:[],messages:[{role:'assistant',text}]};}
  assert.fail('Unexpected daemon operation');
 }}}};
 assert.equal((await mod.methods.list(ctx,{workspaceId:'ws'}))[0].activity,'Inspecting source');
 await mod.methods.list(ctx,{workspaceId:'ws'});assert.equal(reads,1);
 revision++;text='Running tests';
 assert.equal((await mod.methods.list(ctx,{workspaceId:'ws'}))[0].activity,'Running tests');assert.equal(reads,2);
});
test('working agent icon rotates while visible and stops after panel deactivation',async()=>{
 const mod=(await load('modules/ui/agents-panel/src/index.ts')).default;
 let invalidations=0;
 const ctx={events:{on(){}},state:{get:k=>k==='workspace.selected'?{id:'ws'}:{agents:true},watch(){}},ui:{invalidate(){invalidations++;}},modules:{async call(_module,method){
  if(method==='catalog')return{profiles:[]};
  if(method==='list')return[{id:'worker',name:'Worker',profile:{name:'Fixture'},machineId:'local',status:'busy'}];
 }}};
 await mod.activate(ctx);
 const icon=()=>mod.render().children.find(n=>n.type==='tree').rows[0].iconSvg;
 try {
  const first=icon();await new Promise(r=>setTimeout(r,110));
  assert.notEqual(icon(),first);assert.match(icon(),/rotate\(/);
 }finally{mod.deactivate();}
 const count=invalidations;await new Promise(r=>setTimeout(r,110));assert.equal(invalidations,count);
});
