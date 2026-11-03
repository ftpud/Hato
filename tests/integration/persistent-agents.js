export default {id:"__driver",moduleApiVersion:1,async activate(ctx){
 const call=(m,f,a={})=>ctx.modules.call(m,f,a,{timeoutMs:240000});
 try {
  await T("test.approvals",{policy:"allow"});
  const root=await T("test.env",{name:"HATO_T_AGENTS_ROOT"});
  const fixture=await T("test.env",{name:"HATO_T_AGENT_FIXTURE"});
  const node=await T("test.env",{name:"HATO_T_NODE"});
  const phase=await T("test.env",{name:"HATO_T_PHASE"});
  let project=(await call("projects","tree")).find(p=>p.rootPath===root);
  const ssh=await T("test.env",{name:"HATO_T_AGENTS_SSH"});
  if(!project){
    if(ssh==="1")project=await call("projects","addSsh",{host:"127.0.0.1",port:2222,user:await T("test.env",{name:"HATO_T_SSH_USER"}),identityFile:await T("test.env",{name:"HATO_T_SSH_KEY"}),remotePath:root,name:"Remote agents fixture"});
    else project=await call("projects","addLocal",{path:root});
  }
  const workspaceId=`project:${project.id}:root`;
  await call("workspace","select",{workspaceId});
  if(phase==="1") {
   await call("persistence","acpProfiles.upsert",{profile:{id:"fixture-persistent",machineId:"*",provider:"fixture",name:"Fixture",executable:node,args:[fixture],envRefs:{},enabled:true}});
   const writeGrant=await ctx.host.capabilities.request({kind:"fs",root,write:true,target:project.kind==="ssh"?{kind:"ssh",...(await ctx.host.ssh.connect({profileId:"fixture-context",host:"127.0.0.1",port:2222,user:await T("test.env",{name:"HATO_T_SSH_USER"}),identityFile:await T("test.env",{name:"HATO_T_SSH_KEY"})}))}:{kind:"local"}});
   for(const path of [".agents",".agents/skills",".agents/skills/chosen"])await ctx.host.fs.mkdir(writeGrant.grant,path);
   await ctx.host.fs.writeAtomic(writeGrant.grant,"AGENTS.md","agent-file-context");
   await ctx.host.fs.writeAtomic(writeGrant.grant,".agents/skills/chosen/SKILL.md","---\nname: chosen\ndescription: Fixture\n---\nskill-context-chosen");
   const s=await call("persistent-agents","create",{workspaceId,name:"Background fixture",profileId:"fixture-persistent",mcps:["internal-remote-mcp"],skills:[".agents/skills/chosen/SKILL.md"],agentFile:"AGENTS.md"});
   check("independent agent created on local daemon",s.status==="ready"&&s.id,s);
   await call("persistent-agents","setModel",{workspaceId,id:s.id,model:"model-b"});
   check("model selected",(await call("persistent-agents","view",{workspaceId,id:s.id})).session.model==="model-b");
   await call("persistent-agents","send",{workspaceId,id:s.id,text:"first"});
   check("agent completes prompt",await until(async()=>{const v=await call("persistent-agents","view",{workspaceId,id:s.id});return v.session.status==="ready"&&v.messages.some(m=>m.text.includes("finished:")&&m.text.includes("skill-context-chosen")&&m.text.includes("agent-file-context"));}));
   await call("persistent-agents","send",{workspaceId,id:s.id,text:"offline original"});
   await call("persistent-agents","send",{workspaceId,id:s.id,text:"steered",steer:true});
   check("steer cancels and follows with new prompt",await until(async()=>{const v=await call("persistent-agents","view",{workspaceId,id:s.id});return v.session.status==="ready"&&v.messages.some(m=>m.text.includes("finished:steered"));}));
   await call("persistent-agents","send",{workspaceId,id:s.id,text:"ask-permission"});
   const pending=await until(async()=>{const v=await call("persistent-agents","view",{workspaceId,id:s.id});return v.permissions.length?v:null;});
   check("permissions wait durably for desktop review",pending?.session.status==="waiting");
   await call("persistent-agents","reviewPermission",{workspaceId,id:s.id,permissionId:pending.permissions[0].id});
   check("trusted approval completes permission",await until(async()=>(await call("persistent-agents","view",{workspaceId,id:s.id})).session.status==="ready"));
   const child=await call("persistent-agents","fork",{workspaceId,parentId:s.id,name:"Child worker",text:"child-task"});
   check("child agent inherits selected workspace and skills",child.workspaceId===workspaceId&&child.skills.includes(".agents/skills/chosen/SKILL.md"));
   await call("persistent-agents","stop",{workspaceId,id:child.id});
   await call("persistent-agents","send",{workspaceId,id:s.id,text:"offline completion"});
   await call("persistence","settings.set",{key:"fixture.persistent-id",value:s.id});
   check("background turn started before desktop exits",(await call("persistent-agents","view",{workspaceId,id:s.id})).session.status==="busy");
  } else {
   const id=await call("persistence","settings.get",{key:"fixture.persistent-id"});
   const v=await until(async()=>{const v=await call("persistent-agents","view",{workspaceId,id});return v.session.status==="ready"?v:null;});
   check("turn completed while desktop was absent",v?.messages.some(m=>m.text.includes("finished:offline completion")),v);
   check("history survives desktop restart",v?.messages.some(m=>m.role==="user"&&m.text==="first"));
   check("agent configuration is separate from chat conversations",(await call("persistence","conversations.list",{workspaceId})).every(c=>c.id!==id));
   await call("persistent-agents","stop",{workspaceId,id});
   check("explicit stop ends background agent",(await call("persistent-agents","view",{workspaceId,id})).session.status==="stopped");
  }
 }catch(e){check("uncaught",false,`${e.message}\n${e.stack}`);}
 await finish();
}};
