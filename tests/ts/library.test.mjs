import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as esbuild from 'esbuild';
let generation=0;
async function load(file){const r=await esbuild.build({entryPoints:[file],bundle:true,format:'esm',write:false});return (await import('data:text/javascript;base64,'+Buffer.from(r.outputFiles[0].text).toString('base64')+'#'+generation++));}
async function fixture(){
 const mod=(await load('Hato-plugins/modules/services/library/src/index.ts')).default;
 const rows=new Map(),listeners={},events=[];
 const ctx={moduleId:'library',generation:1,state:{set(){}},events:{on:(key,fn)=>listeners[key]=fn,emit:(key,p)=>events.push({key,p})},modules:{call:async(_,method,a)=>({projectId:a.workspaceId==='task'?'p1':a.workspaceId})},host:{db:{openNamespace:async()=> 'library',query:async(_,sql,args)=>[...rows.values()].filter(r=>r.project_id===args[0]),exec:async(_,sql,args)=>{if(sql.startsWith('INSERT'))rows.set(args[0],{project_id:args[1],data:args[2]});if(sql.startsWith('DELETE'))rows.delete(args[0]);}}}};
 await mod.activate(ctx);return {mod,ctx,rows,listeners,events};
}
test('Library keeps project/task scope, nested pages and shell text outside workspaces',async()=>{
 const {mod,ctx}=await fixture(),m=mod.methods;
 let e=await m.save(ctx,{scope:'project',workspaceId:'p1',kind:'skill',name:'Review',expectedRevision:null});
 e=await m.save(ctx,{scope:'project',workspaceId:'task',id:e.id,path:'references/deep/guide.md',content:'# Guide',expectedRevision:e.revision});
 e=await m.save(ctx,{scope:'project',workspaceId:'p1',id:e.id,path:'scripts/check.sh',content:'#!/bin/sh\necho check',expectedRevision:e.revision});
 assert.deepEqual(e.paths,['SKILL.md','references/deep/guide.md','scripts/check.sh']);
 assert.equal((await m.read(ctx,{scope:'project',workspaceId:'task',id:e.id,path:'scripts/check.sh'})).content,'#!/bin/sh\necho check');
 assert.equal((await m.list(ctx,{scope:'global'})).length,0);
 await assert.rejects(m.read(ctx,{scope:'project',workspaceId:'p2',id:e.id}),/not found/);
 await assert.rejects(m.save(ctx,{scope:'project',workspaceId:'p2',id:e.id,expectedRevision:e.revision,name:'escape'}),/not found/);
 for(const path of ['../escape.md','/absolute.sh','refs/../../escape.md','scripts/run.exe','refs//bad.md'])await assert.rejects(m.save(ctx,{scope:'project',workspaceId:'p1',id:e.id,path,content:'bad',expectedRevision:e.revision}),/relative/);
});
test('Library revisions reject concurrent edits, preserve root pages and delete entries explicitly',async()=>{
 const {mod,ctx}=await fixture(),m=mod.methods;
 let e=await m.save(ctx,{scope:'global',kind:'agent',name:'Reviewer',expectedRevision:null});
 const edits=await Promise.allSettled([1,2].map(i=>m.save(ctx,{scope:'global',id:e.id,path:'AGENT.md',content:'version '+i,expectedRevision:e.revision})));
 assert.equal(edits.filter(r=>r.status==='fulfilled').length,1);
 assert.equal(edits.filter(r=>r.status==='rejected').length,1);
 e=await m.read(ctx,{scope:'global',id:e.id});
 await assert.rejects(m.save(ctx,{scope:'global',id:e.id,path:'AGENT.md',content:null,expectedRevision:e.revision}),/Keep/);
 await assert.rejects(m.remove(ctx,{scope:'global',id:e.id,expectedRevision:e.revision-1}),/changed/);
 await m.remove(ctx,{scope:'global',id:e.id,expectedRevision:e.revision});
 assert.equal((await m.list(ctx,{scope:'global'})).length,0);
});
test('Library MCP binds project writes to the authenticated workspace, ignoring argument overrides',async()=>{
 const {listeners,events}=await fixture();
 await listeners['internal-mcp.call']({module:'library',generation:1,id:'request',tool:'write',scope:{conversationId:'c',workspaceId:'p1',machineId:'local'},args:{scope:'project',workspaceId:'p2',kind:'skill',name:'Scoped',expectedRevision:null}});
 assert.equal(events.find(e=>e.key==='library.mcp.result').p.result.projectId,'p1');
});
test('handoff bounds original dialogue and excludes thoughts, tool output and images',async()=>{
 const {chatHandoff}=await load('sdk/chat-handoff.ts');
 const text=chatHandoff([{role:'thought',text:'SECRET'},{role:'tool',text:'BIG OUTPUT'},...Array.from({length:50},(_,i)=>({role:i%2?'assistant':'user',text:`message ${i} `+'x'.repeat(8000)}))]);
 assert.ok(text.length<16000);assert.ok(text.includes('message 49'));assert.ok(!text.includes('SECRET'));assert.ok(!text.includes('BIG OUTPUT'));assert.ok(!text.includes('message 0 '));
 assert.equal(chatHandoff([{role:'tool',text:'only logs'}]),'');
});
test('desktop provider handoff is delivered once; stored user messages stay original',async()=>{
 const mod=(await load('Hato-plugins/modules/services/ai-sessions/src/index.ts')).default;
 let row={id:'c',workspaceId:'ws',title:'Build it',acpProfileId:'old',config:{}},live={status:'ready',sessionId:'old-session'};
 const messages=[{id:'u',sequence:1,kind:'user',payload:{text:'Build a release tool'}},{id:'a',sequence:2,kind:'assistant',payload:{text:'The parser is complete'}}];
 const prompts=[],listeners={};
 const ctx={moduleId:'ai-sessions',generation:1,state:{set(){}},events:{on:(k,f)=>listeners[k]=f,emit(){}},log:{warn(){}},modules:{call:async(_,method,a)=>{
  if(method==='conversations.get')return {...row};
  if(method==='messages.list')return structuredClone(messages);
  if(method==='state')return live;
  if(method==='resolve')return {machineId:'local'};
  if(method==='profiles')return [{id:'old'},{id:'new'}];
  if(method==='stop'){live=null;return;}
  if(method==='conversations.update'){Object.assign(row,a.fields);return;}
  if(method==='view.patch'||method==='messages.upsert')return;
  if(method==='settings.get')return [];
  if(method==='start')return live={status:'ready',sessionId:'new-session'};
  if(method==='prompt'){prompts.push(a.text);return {accepted:true};}
  throw new Error(method);
 }}};
 await mod.activate(ctx);
 await mod.methods.setProfile(ctx,{conversationId:'c',profileId:'new'});
 await mod.methods.send(ctx,{conversationId:'c',text:'Continue please'});
 assert.match(prompts[0],/Conversation handoff/);assert.match(prompts[0],/parser is complete/);
 assert.equal(row.config.__hatoHandoff,undefined);
 await listeners['acp.turnEnded']({conversationId:'c',stopReason:'end_turn'});
 await mod.methods.send(ctx,{conversationId:'c',text:'Next step'});
 assert.equal(prompts[1],'Next step');
});
test('workflow chatbox references send only changed excerpts and have an aggregate budget',async()=>{
 const {referenceUpdates}=await load('Hato-plugins/modules/services/workflow-runner/src/context.ts');
 const prompt='Use {{blocks.a.output}} and {{blocks.b.output}}',outputs=new Map([['a','first'],['b','second']]);
 const first=referenceUpdates(prompt,outputs);
 assert.match(first.text,/a: first/);
 assert.equal(referenceUpdates(prompt,outputs,first.values).text,'');
 outputs.set('b','updated');
 const next=referenceUpdates(prompt,outputs,first.values);
 assert.match(next.text,/b: updated/);assert.ok(!next.text.includes('a:'));
 const many=referenceUpdates(Array.from({length:100},(_,i)=>`{{blocks.b${i}.output}}`).join(' '),new Map(Array.from({length:100},(_,i)=>['b'+i,'x'.repeat(8000)])));
 assert.ok(many.text.length<16500);
});
