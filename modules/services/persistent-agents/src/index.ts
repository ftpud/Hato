import type { AppModule, ModuleContext, DaemonTarget } from "../../../../sdk/types";
import { sshConnect, workspaceGrant, type WorkspaceDescriptor } from "../../../../sdk/runtime";
import { workspaceSkills } from "../../files/src/skills";
import { agentActivity, relativeAgentPath, type AgentMcp, type AgentSpec } from "../../../../sdk/persistent-agents";

const activityCache=new Map<string,{revision:number;status:string;text:string}>();
const daemonInfo=new Map<string,{bin:string;dir:string}>();
const prepared=new Map<string,Promise<DaemonTarget>>();
async function target(ctx:ModuleContext,workspaceId:string):Promise<DaemonTarget> {
  const d:WorkspaceDescriptor=await ctx.modules.call("workspace","resolve",{workspaceId});
  let pending=prepared.get(d.machineId);
  if(!pending) {
    pending=(async()=>{
      const t:DaemonTarget=d.location==="ssh"?{kind:"ssh",connection:(await sshConnect(ctx,d)).connection}:{kind:"local"};
      const info=await ctx.host.daemon.ensure(t);daemonInfo.set(d.machineId,{bin:info.bin,dir:info.dir});
      const result=await ctx.host.daemon.request(t,"plugins.list");
      const mcp=result.plugins.find((p:any)=>p.id==="internal-remote-mcp");
      if(!mcp?.active)await ctx.host.daemon.request(t,"plugins.push",{id:"internal-remote-mcp"});
      const runtime=result.plugins.find((p:any)=>p.id==="agent-runner");
      // Never push-replace a running runtime: daemon plugin replacement unloads its processes.
      // Updating the runtime is a separate maintenance operation after stopping its sessions.
      if(!runtime?.active) {
        const pushed=await ctx.host.daemon.request(t,"plugins.push",{id:"agent-runner"});
        if(!pushed.active)throw new Error(pushed.error||"Agent runtime did not activate");
      }
      return t;
    })();
    prepared.set(d.machineId,pending);
    // Task requests and agent activity live on daemons this desktop has connected to; poll once there is one.
    if(!daemonPoll){daemonPoll=setInterval(()=>{void pollDaemons(ctx);},2000);(daemonPoll as any).unref?.();}
    void pending.catch(()=>{prepared.delete(d.machineId);});
  }
  return pending;
}
async function invoke(ctx:ModuleContext,workspaceId:string,method:string,args:any={}) {
  const t=await target(ctx,workspaceId);
  try {return await ctx.host.daemon.request(t,"modules.call",{target:"agent-runner",method,args,timeoutMs:180000});}
  catch(e) {const d=await ctx.modules.call("workspace","resolve",{workspaceId});prepared.delete(d.machineId);throw e;}
}
async function mcps(ctx:ModuleContext):Promise<AgentMcp[]> {
  return await ctx.modules.call("persistence","settings.get",{key:"persistent-agents.mcps"})||[];
}
const builtInMcps=[
  {id:"internal-remote-mcp",name:"Workspace tools",builtin:true,description:"Daemon-hosted background agent, terminal and selected-skill tools. Works without the desktop."},
  {id:"internal-remote-mcp-local",name:"Local workspace tools",builtin:true,description:"Workspace tools for ordinary local desktop terminals. Available to local workspaces while the desktop is open."},
  {id:"internal-local-mcp",name:"Desktop tools",builtin:true,description:"UI and application module tools. Requires the desktop to remain open."},
];
let mcpWrites:Promise<any>=Promise.resolve();
function editMcps(ctx:ModuleContext,edit:(list:AgentMcp[])=>AgentMcp[]) {
  const next=mcpWrites.catch(()=>{}).then(async()=>{
    const value=edit(await mcps(ctx));
    await ctx.modules.call("persistence","settings.set",{key:"persistent-agents.mcps",value});
    ctx.events.emit("persistent-agents.mcpsChanged",{});
  });mcpWrites=next;return next;
}
function validateMcp(value:any):AgentMcp {
  if(!value||!value.id||!value.name||typeof value.command!=="string"||!value.command.trim()||!Array.isArray(value.args)||!value.args.every((a:any)=>typeof a==="string")||!Array.isArray(value.env||[])||!(value.env||[]).every((v:any)=>typeof v.name==="string"&&typeof v.value==="string"))throw new Error("MCP requires id, name, command, string args and environment entries");
  if(String(value.id).startsWith("internal-")||String(value.id).length>120)throw new Error("Reserved or invalid MCP server id");
  if(!String(value.name).trim())throw new Error("Server name is required");
  const names=new Set<string>();
  for(const item of value.env||[]){if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(item.name)||names.has(item.name))throw new Error("Environment variable names must be valid and unique");names.add(item.name);}
  if(value.enabled!==undefined&&typeof value.enabled!=="boolean")throw new Error("Enabled must be a boolean");
  return {id:String(value.id),name:String(value.name).trim(),command:value.command.trim(),args:value.args,env:value.env||[],enabled:value.enabled!==false};
}
async function catalog(ctx:ModuleContext,workspaceId:string) {
  const d:WorkspaceDescriptor=await ctx.modules.call("workspace","resolve",{workspaceId});
  const profiles=(await ctx.modules.call("persistence","acpProfiles.list")).filter((p:any)=>p.enabled&&(p.machineId==="*"||p.machineId===d.machineId));
  const skills=await workspaceSkills(ctx,d);
  const grant=await workspaceGrant(ctx,d,"fs");
  const agentFiles:{name:string;path:string}[]=[];
  try {if((await ctx.host.fs.stat(grant.grant,"AGENTS.md")).kind==="file")agentFiles.push({name:"AGENTS.md",path:"AGENTS.md"});}catch{}
  for(const dir of [".agents/agents",".claude/agents"]) {
    let entries;try{entries=(await ctx.host.fs.list(grant.grant,dir)).entries;}catch{continue;}
    for(const e of entries)if(e.kind==="file"&&e.name.endsWith(".md"))agentFiles.push({name:e.name,path:`${dir}/${e.name}`});
  }
  return {workspace:d,profiles,skills,agentFiles,mcps:[
    {id:"internal-remote-mcp",name:"Workspace tools (background agents and terminals)"},
    ...(d.location==="local"?[{id:"internal-remote-mcp-local",name:"Workspace tools · local desktop terminals (online only)"}]:[]),
    {id:"internal-local-mcp",name:"Desktop tools (requires desktop online)"},...(await mcps(ctx)).filter(m=>m.enabled!==false)]};
}
/** MCP selection ids of an existing agent, as offered by `catalog`. */
const agentMcpIds=(s:AgentSpec)=>[...(s.workspaceMcp?["internal-remote-mcp"]:[]),...s.mcps.map(m=>m.id)];
/** Validate a provider/instructions/skills/MCP selection against the workspace catalog and resolve it. */
async function agentConfig(ctx:ModuleContext,c:Awaited<ReturnType<typeof catalog>>,a:any,sessionId:string) {
  const profile=c.profiles.find((p:any)=>p.id===a.profileId);if(!profile)throw new Error("Select an enabled provider for this machine");
  const skills=(Array.isArray(a.skills)?a.skills:[]).map(relativeAgentPath);
  if(skills.some((p:string)=>!c.skills.some(s=>s.path===p)))throw new Error("Selected skill is no longer available");
  const agentFile=a.agentFile?relativeAgentPath(a.agentFile):null;
  if(agentFile&&!c.agentFiles.some(f=>f.path===agentFile))throw new Error("Selected agent file is no longer available");
  const ids:string[]=Array.isArray(a.mcps)?a.mcps:[];
  if(ids.some(id=>!c.mcps.some(m=>m.id===id)))throw new Error("Unknown MCP server");
  await target(ctx,c.workspace.id);
  const servers:any[]=(await mcps(ctx)).filter(m=>m.enabled!==false&&ids.includes(m.id)).map(({enabled,...server})=>server);
  if(ids.includes("internal-remote-mcp-local")) {
    const endpoint=await ctx.modules.call("internal-remote-mcp","endpoint",{workspaceId:c.workspace.id,sessionId,skills});
    servers.push({...endpoint,id:"internal-remote-mcp-local",name:"internal-remote-mcp-local"});
  }
  if(ids.includes("internal-local-mcp")) {
    const endpoint=await ctx.modules.call("internal-local-mcp","endpoint",{conversationId:sessionId,workspaceId:c.workspace.id});
    servers.push({id:"internal-local-mcp",...endpoint.server});
  }
  return {profile,model:String(a.model||""),agentFile,skills,mcps:servers,workspaceMcp:ids.includes("internal-remote-mcp")};
}
// Git task requests from background agents' workspace MCP. The project always comes from the
// agent's own workspace. Creating a task or starting an agent in one needs the user's native
// approval unless the requesting agent runs on autopilot.
const clip=(v:any,n:number)=>typeof v==="string"?v.trim().slice(0,n):"";
function agentRequest(a:any) {
  if(a==null)return null;
  const prompt=clip(a.prompt,128*1024);
  if(!prompt)throw new Error("A background agent needs a prompt");
  return {name:clip(a.name,120)||"Task agent",prompt,model:clip(a.model,200)};
}
async function approve(ctx:ModuleContext,session:any,title:string,detail:string,allowLabel:string,operation:string) {
  if(session.autopilot)return;
  const decision=await ctx.host.approvals.request({title:`${session.name}: ${title}`,detail,operation,timeoutMs:9*60*1000,
    options:[{id:"allow",label:allowLabel,kind:"allow"},{id:"deny",label:"Deny",kind:"deny"}]});
  if(decision.optionId!=="allow")throw new Error(decision.expired?"The request was not approved in time":`The user denied: ${title}`);
}
const agentLines=(agent:{name:string;prompt:string;model:string}|null)=>agent?[`Background agent: ${agent.name}${agent.model?` (${agent.model})`:""}`,`Prompt: ${agent.prompt.length>1500?agent.prompt.slice(0,1500)+"…":agent.prompt}`]:[];
/** Start a background agent in a task workspace, configured like its parent (provider, model,
 *  instructions, skills and MCP servers that exist there), and send it the prompt. */
async function startTaskAgent(ctx:ModuleContext,parent:any,taskWorkspaceId:string,agent:{name:string;prompt:string;model:string}) {
  const c=await catalog(ctx,taskWorkspaceId);
  const mcpIds=[...(parent.workspaceMcp?["internal-remote-mcp"]:[]),...(parent.mcps||[]).map((m:any)=>m.id)].filter((id:string)=>c.mcps.some(m=>m.id===id));
  const created=await mod.methods!.create(ctx,{workspaceId:taskWorkspaceId,name:agent.name,profileId:parent.profile.id,model:agent.model||parent.model,
    agentFile:c.agentFiles.some(f=>f.path===parent.agentFile)?parent.agentFile:null,skills:(parent.skills||[]).filter((p:string)=>c.skills.some(s=>s.path===p)),mcps:mcpIds},{caller:"persistent-agents"});
  if(parent.autopilot)await invoke(ctx,taskWorkspaceId,"setAutopilot",{id:created.id,enabled:true});
  await invoke(ctx,taskWorkspaceId,"send",{id:created.id,text:agent.prompt});
  ctx.events.emit("persistent-agents.changed",{workspaceId:taskWorkspaceId});
  return {id:created.id,name:created.name,workspaceId:taskWorkspaceId,autopilot:!!parent.autopilot};
}
async function performTask(ctx:ModuleContext,r:{sessionId:string;workspaceId:string;op:string;args:any}) {
  const v=await owned(ctx,{workspaceId:String(r.workspaceId),id:String(r.sessionId)});
  const d:WorkspaceDescriptor=await ctx.modules.call("workspace","resolve",{workspaceId:r.workspaceId});
  const tasks=async()=>ctx.modules.call("git-tasks","list",{projectId:d.projectId});
  if(r.op==="list")return (await tasks()).map((t:any)=>({id:t.id,workspaceId:`task:${t.id}`,name:t.name,branch:t.branch,worktreePath:t.worktreePath,status:t.status,current:t.id===d.taskId}));
  if(r.op==="reconcile")return ctx.modules.call("git-tasks","reconcile",{projectId:d.projectId},{timeoutMs:120000});
  const project=`${d.name.split(" / ")[0]} (${d.machineId})`;
  if(r.op==="startAgent") {
    const agent=agentRequest(r.args?.agent)!;
    const task=(await tasks()).find((t:any)=>t.id===r.args?.taskId);
    if(!task)throw new Error("Task is not part of this project");
    if(task.status!=="ready")throw new Error(`Task worktree is ${task.status}; reconcile it first`);
    await approve(ctx,v.session,`start agent in task ${task.name}`,[`Agent: ${v.session.name}`,`Project: ${project}`,`Task: ${task.name} (${task.branch})`,...agentLines(agent)].join("\n"),"Start agent","persistent-agents.create");
    return startTaskAgent(ctx,v.session,`task:${task.id}`,agent);
  }
  if(r.op!=="create")throw new Error("Unknown task operation");
  const name=clip(r.args?.name,100),branch=clip(r.args?.branch,200),agent=agentRequest(r.args?.agent);
  if(!name&&!branch)throw new Error("Provide a task name or a branch");
  await approve(ctx,v.session,agent?"create Git task and start an agent":"create Git task",[`Agent: ${v.session.name}`,`Project: ${project}`,`Task name: ${name||branch}`,
    `Branch: ${branch||"generated task/<name>-<id>"}`,"Creates a linked Git worktree outside the project checkout. Existing branches are checked out, otherwise a new branch starts from HEAD.",...agentLines(agent)].join("\n"),
    agent?"Create and start":"Create task","git-tasks.create");
  const task=await ctx.modules.call("git-tasks","create",{projectId:d.projectId,name:name||branch,branch,select:false},{timeoutMs:300000});
  if(!agent)return task;
  try {return {...task,agent:await startTaskAgent(ctx,v.session,`task:${task.id}`,agent)};}
  catch(e) {return {...task,agentError:`The task was created but the agent did not start: ${e instanceof Error?e.message:String(e)}`};}
}
// Poll the daemons this desktop already talks to: claim queued task requests and publish which
// workspaces have a working background agent (`persistent-agents.busy`, like `ai-sessions.busy`).
let daemonPoll:ReturnType<typeof setInterval>|null=null,polling=false,busySignature="";
const WORKING=new Set(["starting","busy","waiting"]);
async function pollDaemons(ctx:ModuleContext) {
  if(polling)return;polling=true;
  try {
    const busy:Record<string,number>={};
    for(const [machineId,pending] of [...prepared]) {
      let t:DaemonTarget;try{t=await pending;}catch{continue;}
      try {
        const sessions:any[]=await ctx.host.daemon.request(t,"modules.call",{target:"agent-runner",method:"list",args:{},timeoutMs:10000});
        for(const s of sessions||[])if(s.machineId===machineId&&WORKING.has(s.status))busy[s.workspaceId]=(busy[s.workspaceId]||0)+1;
      }catch{ /* daemon unreachable: report nothing for it */ }
      let requests:any[];
      try{requests=await ctx.host.daemon.request(t,"modules.call",{target:"internal-remote-mcp",method:"claimTaskRequests",args:{},timeoutMs:10000});}catch{continue;}
      for(const r of requests||[]) void (async()=>{
        let outcome:{value?:any;error?:string};
        try {
          const d:WorkspaceDescriptor=await ctx.modules.call("workspace","resolve",{workspaceId:String(r.workspaceId)});
          if(d.machineId!==machineId)throw new Error("Workspace does not belong to this machine");
          outcome={value:await performTask(ctx,r)};
        }catch(e){outcome={error:e instanceof Error?e.message:String(e)};}
        await ctx.host.daemon.request(t,"modules.call",{target:"internal-remote-mcp",method:"resolveTaskRequest",args:{id:r.id,...outcome},timeoutMs:10000}).catch(e=>ctx.log.warn("task request reply",String(e)));
      })();
    }
    const sig=JSON.stringify(Object.entries(busy).sort());
    if(sig!==busySignature){busySignature=sig;ctx.state.set("persistent-agents.busy",busy);}
  } finally {polling=false;}
}
const mod:AppModule={id:"persistent-agents",moduleApiVersion:1,
  deactivate() {if(daemonPoll)clearInterval(daemonPoll);daemonPoll=null;},
  activate(ctx) {
    // If the local daemon is already running, connect to it so background activity and task
    // requests are seen without opening the Agents panel first. Never starts a daemon.
    setTimeout(async()=>{
      try {
        if(!await ctx.host.daemon.status({kind:"local"}))return;
        const local=(await ctx.modules.call("persistence","projects.list")).find((p:any)=>p.kind==="local");
        if(local)await target(ctx,`project:${local.id}:root`);
      }catch(e){ctx.log?.warn("local daemon warm-up",e instanceof Error?e.message:String(e));}
    },1500);
    // The AI module owns this request namespace; native event enforcement prevents spoofing it.
    // Keep this UI adapter allowlist narrow instead of exposing arbitrary module calls.
    const allowed=new Set(["view","send","cancel","stop","reconnect","setModel","setAutopilot","reviewPermission","clear"]);
    ctx.events.on("mcp-panel.request",async(request:any)=>{
      if(typeof request?.requestId!=="string"||!["listMcps","saveMcp","removeMcp"].includes(request.method))return;
      try{const value=await mod.methods![request.method](ctx,request.args||{},{caller:"mcp-panel"});ctx.events.emit("persistent-agents.mcpResponse",{requestId:request.requestId,value});}
      catch(e){ctx.events.emit("persistent-agents.mcpResponse",{requestId:request.requestId,error:e instanceof Error?e.message:String(e)});}
    });
    ctx.events.on("ai.persistentRequest",async(request:any)=>{
      if(typeof request?.requestId!=="string"||!allowed.has(request.method))return;
      try {
        const value=await mod.methods![request.method](ctx,request.args,{caller:"ai"});
        ctx.events.emit("persistent-agents.chatResponse",{requestId:request.requestId,value});
      }catch(e){ctx.events.emit("persistent-agents.chatResponse",{requestId:request.requestId,error:e instanceof Error?e.message:String(e)});}
    });
  },
  methods:{
  async taskRequest(ctx,a,meta) {
    if(meta.caller!=="internal-remote-mcp")throw new Error("Task requests come from the workspace MCP server");
    return performTask(ctx,{sessionId:String(a.sessionId),workspaceId:String(a.workspaceId),op:String(a.op),args:a.args||{}});
  },
  workspaceEndpoint:async(ctx,a)=>ctx.modules.call("internal-remote-mcp","endpoint",{workspaceId:String(a.workspaceId),sessionId:String(a.sessionId||crypto.randomUUID()),skills:Array.isArray(a.skills)?a.skills:[]}),
  catalog:(ctx,a)=>catalog(ctx,String(a.workspaceId)),
  async listMcps(ctx) {return [...builtInMcps,...await mcps(ctx)];},
  async saveMcp(ctx,a) {
    const server=validateMcp(a.server);
    await editMcps(ctx,list=>[...list.filter(p=>p.id!==server.id),server]);return null;
  },
  async removeMcp(ctx,a) {
    if(typeof a.id!=="string"||a.id.startsWith("internal-"))throw new Error("Built-in MCP servers cannot be removed");
    await editMcps(ctx,list=>list.filter(m=>m.id!==a.id));return null;
  },
  async create(ctx,a) {
    const c=await catalog(ctx,String(a.workspaceId));
    const id=crypto.randomUUID();
    const config=await agentConfig(ctx,c,a,id);
    const subscription=await ctx.modules.call("persistence","settings.get",{key:"acp.claude.useSubscription"});
    const spec:AgentSpec={id,name:String(a.name||"Agent").trim().slice(0,120),workspaceId:c.workspace.id,workspaceName:c.workspace.name,root:c.workspace.rootAbsolutePath,machineId:c.workspace.machineId,
      ...config,claudeSubscription:subscription!==false,daemon:daemonInfo.get(c.workspace.machineId)};
    return invoke(ctx,c.workspace.id,"create",{spec});
  },
  /** Edit name, provider, instructions, skills and MCP servers. Only a rename leaves a connected agent running. */
  async update(ctx,a) {
    const v=await owned(ctx,a),s=v.session;
    const name=String(a.name||"").trim().slice(0,120);if(!name)throw new Error("Agent name is required");
    const ids=[...new Set<string>(Array.isArray(a.mcps)?a.mcps:[])].sort();
    const skills=[...(Array.isArray(a.skills)?a.skills:[])].map(relativeAgentPath).sort();
    const agentFile=a.agentFile?relativeAgentPath(a.agentFile):null;
    const same=s.profile.id===a.profileId&&(s.agentFile||null)===agentFile&&JSON.stringify([...s.skills].sort())===JSON.stringify(skills)&&JSON.stringify(agentMcpIds(s).sort())===JSON.stringify(ids);
    if(same)return invoke(ctx,a.workspaceId,"update",{id:s.id,patch:{name}});
    const c=await catalog(ctx,String(a.workspaceId));
    // Desktop-hosted endpoints are re-issued for the new selection.
    await ctx.modules.call("internal-local-mcp","revoke",{conversationId:s.id}).catch(()=>{});
    await ctx.modules.call("internal-remote-mcp","revoke",{sessionId:s.id}).catch(()=>{});
    const config=await agentConfig(ctx,c,{...a,mcps:ids,skills,agentFile,model:s.profile.id===a.profileId?s.model:""},s.id);
    return invoke(ctx,a.workspaceId,"update",{id:s.id,patch:{name,...config}});
  },
  async clear(ctx,a) {await owned(ctx,a);return invoke(ctx,a.workspaceId,"clear",{id:a.id});},
  async remove(ctx,a) {
    await owned(ctx,a);const result=await invoke(ctx,a.workspaceId,"remove",{id:a.id});
    await ctx.modules.call("internal-local-mcp","revoke",{conversationId:a.id}).catch(()=>{});
    await ctx.modules.call("internal-remote-mcp","revoke",{sessionId:a.id}).catch(()=>{});
    activityCache.delete(a.id);
    return result;
  },
  async list(ctx,a) {
    const rows=await invoke(ctx,String(a.workspaceId),"list");
    const scoped=rows.filter((s:any)=>s.workspaceId===a.workspaceId);
    // Fetch only revised sessions. This works with already-running daemon runtimes and never
    // replaces their plugins/processes. Limit concurrent SSH control requests on large lists.
    const result:any[]=new Array(scoped.length);
    let cursor=0;
    await Promise.all(Array.from({length:Math.min(4,scoped.length)},async()=>{
      while(cursor<scoped.length) {
        const index=cursor++,s=scoped[index],cached=activityCache.get(s.id);
        let text=cached&&cached.status===s.status?cached.text:undefined;
        if(!cached||cached.revision!==s.revision||cached.status!==s.status) {
          try {
            const detail=await invoke(ctx,String(a.workspaceId),"view",{id:s.id,limit:8});
            if(detail.session.workspaceId!==a.workspaceId)throw new Error("Agent belongs to another workspace");
            text=agentActivity(detail);
            activityCache.set(s.id,{revision:s.revision,status:s.status,text});
          }catch{ /* Keep the previous activity and retry on the next list refresh. */ }
        }
        result[index]={...s,activity:text};
      }
    }));
    return result;
  },
  async fork(ctx,a) {await owned(ctx,{...a,id:a.parentId});return invoke(ctx,a.workspaceId,"fork",{parentId:a.parentId,name:a.name,text:a.text,model:a.model});},
  async view(ctx,a) {const v=await invoke(ctx,String(a.workspaceId),"view",{id:a.id,before:a.before,limit:a.limit});if(v.session.workspaceId!==a.workspaceId)throw new Error("Agent belongs to another workspace");return v;},
  async send(ctx,a) {await owned(ctx,a);return invoke(ctx,a.workspaceId,"send",{id:a.id,text:a.text,steer:!!a.steer});},
  async cancel(ctx,a) {await owned(ctx,a);return invoke(ctx,a.workspaceId,"cancel",{id:a.id});},
  async stop(ctx,a) {await owned(ctx,a);const result=await invoke(ctx,a.workspaceId,"stop",{id:a.id});
    await ctx.modules.call("internal-local-mcp","revoke",{conversationId:a.id}).catch(()=>{});
    await ctx.modules.call("internal-remote-mcp","revoke",{sessionId:a.id}).catch(()=>{});
    return result;},
  async setAutopilot(ctx,a) {await owned(ctx,a);return invoke(ctx,a.workspaceId,"setAutopilot",{id:a.id,enabled:a.enabled===true});},
  async reconnect(ctx,a) {await owned(ctx,a);return invoke(ctx,a.workspaceId,"reconnect",{id:a.id});},
  async setModel(ctx,a) {await owned(ctx,a);return invoke(ctx,a.workspaceId,"setModel",{id:a.id,model:a.model});},
  async reviewPermission(ctx,a) {
    const v=await owned(ctx,a),permission=v.permissions.find((p:any)=>p.id===a.permissionId);
    if(!permission)throw new Error("Permission request is no longer active");
    const options=(permission.request.options||[]).map((o:any)=>({id:o.optionId,label:o.name||o.optionId,kind:String(o.kind).startsWith("allow")?"allow":"deny"}));
    const deny=options.find((o:any)=>o.kind==="deny");if(!deny)throw new Error("Provider supplied no deny option");
    const decision=await ctx.host.approvals.request({title:`${v.session.name}: agent permission`,detail:JSON.stringify(permission.request.toolCall||permission.request,null,2),options});
    return invoke(ctx,a.workspaceId,"permission",{id:a.id,permissionId:a.permissionId,optionId:decision.optionId||deny.id});
  },
}};
async function owned(ctx:ModuleContext,a:any) {
  const v=await invoke(ctx,String(a.workspaceId),"view",{id:a.id,limit:1});
  if(v.session.workspaceId!==a.workspaceId)throw new Error("Agent belongs to another workspace");return v;
}
export default mod;
