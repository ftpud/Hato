import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const result = await build({ entryPoints: ['sdk/chat-replay.ts'], bundle: true, format: 'esm', write: false });
const { reconcileReplay } = await import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].text).toString('base64'));
const row=(id,text,extra={})=>({id,kind:'user',payload:{text,...extra}});
test('replay reconciles full persisted history and inserts missing runs beside known anchors',()=>{
 const rows=Array.from({length:520},(_,i)=>row('m'+i,'message '+i));
 const incoming=[row('provider0','message 0',{providerMessageId:'u0',providerSessionId:'s'}),row('missing','Provider-only message',{providerSessionId:'s'}),row('provider1','message 1',{providerSessionId:'s'})];
 const merged=reconcileReplay(rows,incoming);
 assert.equal(merged.length,521);assert.deepEqual(merged.slice(0,4).map(m=>m.id),['m0','missing','m1','m2']);
 assert.equal(merged[0].payload.providerMessageId,'u0');
 assert.deepEqual(merged.filter(m=>m.id!=='missing').map(m=>m.id),rows.map(m=>m.id));
 assert.deepEqual(merged.map(m=>m.sequence),Array.from({length:521},(_,i)=>i+1));
 assert.deepEqual(reconcileReplay(merged,incoming).map(m=>m.id),merged.map(m=>m.id));
});
test('ID matches consume fingerprint occurrences without consuming another identical user turn',()=>{
 const rows=[row('a','repeat',{providerMessageId:'id',providerSessionId:'s'}),row('b','repeat',{providerSessionId:'s'})];
 const merged=reconcileReplay(rows,[row('x','repeat',{providerMessageId:'id',providerSessionId:'s'}),row('y','repeat',{providerSessionId:'s'}),row('z','repeat',{providerSessionId:'s'})]);
 assert.deepEqual(merged.map(m=>m.id),['a','b','z']);
});
test('actual outgoing prompt correlates replay while keeping the original local user text',()=>{
 const merged=reconcileReplay([row('a','Continue',{outgoingText:'Instructions\n\nHandoff\nContinue'})],[row('x','Instructions\n\nHandoff\nContinue',{providerMessageId:'u',providerSessionId:'s'})]);
 assert.equal(merged.length,1);assert.equal(merged[0].payload.text,'Continue');assert.equal(merged[0].payload.providerMessageId,'u');
});
test('provider message and tool identities are scoped to their session',()=>{
 for(const kind of ['assistant','tool']){
  const payload={text:'same',providerMessageId:'same-id',toolCallId:'same-tool'};
  const merged=reconcileReplay([{id:'a',kind,payload:{...payload,providerSessionId:'old'}}],[{id:'b',kind,payload:{...payload,providerSessionId:'new'}}]);
  assert.deepEqual(merged.map(m=>m.id),['a','b']);
 }
});
