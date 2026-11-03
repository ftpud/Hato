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
const mod:AppModule={id:"persistent-agents",moduleApiVersion:1,
  activate(ctx) {
    // The AI module owns this request namespace; native event enforcement prevents spoofing it.
    // Keep this UI adapter allowlist narrow instead of exposing arbitrary module calls.
    const allowed=new Set(["view","send","cancel","stop","reconnect","setModel","reviewPermission"]);
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
    const profile=c.profiles.find((p:any)=>p.id===a.profileId);if(!profile)throw new Error("Select an enabled provider for this machine");
    const selectedSkills=(Array.isArray(a.skills)?a.skills:[]).map(relativeAgentPath);
    if(selectedSkills.some((p:string)=>!c.skills.some(s=>s.path===p)))throw new Error("Selected skill is no longer available");
    const agentFile=a.agentFile?relativeAgentPath(a.agentFile):null;
    if(agentFile&&!c.agentFiles.some(f=>f.path===agentFile))throw new Error("Selected agent file is no longer available");
    const ids:string[]=Array.isArray(a.mcps)?a.mcps:[];
    if(ids.some(id=>!c.mcps.some(m=>m.id===id)))throw new Error("Unknown MCP server");
    const subscription=await ctx.modules.call("persistence","settings.get",{key:"acp.claude.useSubscription"});
    const spec:AgentSpec={id:crypto.randomUUID(),name:String(a.name||"Agent").trim().slice(0,120),workspaceId:c.workspace.id,workspaceName:c.workspace.name,root:c.workspace.rootAbsolutePath,machineId:c.workspace.machineId,
      profile,model:String(a.model||""),agentFile,skills:selectedSkills,mcps:[],claudeSubscription:subscription!==false};
    await target(ctx,c.workspace.id);
    spec.daemon=daemonInfo.get(c.workspace.machineId);
    spec.workspaceMcp=ids.includes("internal-remote-mcp");
    spec.mcps=(await mcps(ctx)).filter(m=>m.enabled!==false&&ids.includes(m.id)).map(({enabled,...server})=>server);
    if(ids.includes("internal-remote-mcp-local")) {
      const endpoint=await ctx.modules.call("internal-remote-mcp","endpoint",{workspaceId:spec.workspaceId,sessionId:spec.id,skills:spec.skills});
      spec.mcps.push({...endpoint,id:"internal-remote-mcp-local",name:"internal-remote-mcp-local"});
    }
    if(ids.includes("internal-local-mcp")) {
      const endpoint=await ctx.modules.call("internal-local-mcp","endpoint",{conversationId:spec.id,workspaceId:spec.workspaceId});
      spec.mcps.push({id:"internal-local-mcp",...endpoint.server});
    }
    return invoke(ctx,c.workspace.id,"create",{spec});
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
