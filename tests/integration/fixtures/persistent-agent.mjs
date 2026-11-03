// Deterministic ACP provider: exercises background streaming, model choice, cancellation and permission requests.
import readline from 'node:readline';
let current=null,permission=null,session='fixture-session';
const send=v=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...v})+'\n');
const update=(text,role='agent_message_chunk')=>send({method:'session/update',params:{sessionId:session,update:{sessionUpdate:role,content:{type:'text',text}}}});
for await(const line of readline.createInterface({input:process.stdin})) {
 const r=JSON.parse(line);
 if(!r.method){if(permission&&r.id===permission.id){update('permission:'+r.result?.outcome?.outcome);send({id:permission.prompt,result:{stopReason:'end_turn'}});permission=null;}continue;}
 if(r.method==='initialize')send({id:r.id,result:{protocolVersion:1,agentCapabilities:{loadSession:true}}});
 else if(['session/new','session/load'].includes(r.method))send({id:r.id,result:{sessionId:session,models:{currentModelId:'model-a',availableModels:[{modelId:'model-a',name:'Model A'},{modelId:'model-b',name:'Model B'}]}}});
 else if(r.method==='session/set_model')send({id:r.id,result:{}});
 else if(r.method==='session/cancel') {if(current){clearTimeout(current.timer);send({id:current.id,result:{stopReason:'cancelled'}});current=null;}if(permission){send({id:permission.prompt,result:{stopReason:'cancelled'}});permission=null;}}
 else if(r.method==='session/prompt') {
  const text=r.params.prompt.map(b=>b.text||'').join('\n');
  update('started:'+text);
  if(text.includes('ask-permission')){permission={id:900,prompt:r.id};send({id:900,method:'session/request_permission',params:{sessionId:session,toolCall:{title:'Fixture action'},options:[{optionId:'yes',name:'Allow once',kind:'allow_once'},{optionId:'no',name:'Deny',kind:'reject_once'}]}});}
  else {const id=r.id;current={id,timer:setTimeout(()=>{update('finished:'+text);send({id,result:{stopReason:'end_turn'}});current=null;},text.includes('offline')?3500:200)};}
 } else send({id:r.id,error:{code:-32601,message:'unsupported'}});
}
