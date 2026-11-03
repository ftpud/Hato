// Agent list selection must open the existing AI chatbox, not another embedded chat UI.
export default {id:"__driver",moduleApiVersion:1,async activate(ctx){
 const call=(m,f,a={})=>ctx.modules.call(m,f,a,{timeoutMs:240000});let id,workspaceId;
 try{
  await T("test.approvals",{policy:"allow"});
  const root=await T("test.env",{name:"HATO_T_AGENTS_ROOT"}),node=await T("test.env",{name:"HATO_T_NODE"}),fixture=await T("test.env",{name:"HATO_T_AGENT_FIXTURE"});
  const p=await call("projects","addLocal",{path:root});workspaceId=`project:${p.id}:root`;
  await call("workspace","select",{workspaceId});
  await call("persistence","acpProfiles.upsert",{profile:{id:"ui-fixture",machineId:"*",provider:"fixture",name:"Fixture",executable:node,args:[fixture],envRefs:{},enabled:true}});
  const session=await call("persistent-agents","create",{workspaceId,name:"UI worker",profileId:"ui-fixture",skills:[],mcps:[]});id=session.id;
  await ev("workspace-layout","dock",{value:"agents"});
  const list=await until(async()=>find(await T("test.render",{module:"agents-panel"}),n=>n.type==="tree"&&n.rows.some(r=>r.key===id)));
  check("agents are tree rows like projects",list?.rowHeight===42);
  check("list contains no second chatbox",!find(await T("test.render",{module:"agents-panel"}),n=>n.type==="transcript"));
  await ev("workspace-layout","hide",{value:"ai"});
  await ev("agents-panel","open",{rowKey:id});
  const chat=await until(async()=>find(await T("test.render",{module:"ai"}),n=>n.type==="transcript"&&n.scrollKey===id));
  check("agent selection opens exact existing chatbox",!!chat);
  check("AI panel revealed",(await T("test.state",{key:"workspace-layout.panels"})).ai);
  await ev("ai","send",{inputs:{prompt:"from existing chatbox"}});
  check("existing composer prompts selected background session",await until(async()=>{const v=await call("persistent-agents","view",{workspaceId,id});return v.messages.some(m=>m.role==="assistant"&&m.text.includes("finished:from existing chatbox"));}));
  await ev("ai","backToChats");
  check("returning to chats leaves background agent running",(await call("persistent-agents","view",{workspaceId,id})).session.status==="ready");
 }catch(e){check("uncaught",false,`${e.message}\n${e.stack}`);}
 finally{if(id)await call("persistent-agents","stop",{workspaceId,id}).catch(()=>{});}
 await finish();
}};
