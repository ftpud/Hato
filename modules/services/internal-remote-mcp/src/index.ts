import type { AppModule,ModuleContext,Handle } from "../../../../sdk/types";
import { JsonRpcPeer,errMsg,rpcError } from "../../../../sdk/runtime";
interface Scope {sessionId:string;workspaceId:string;root:string;skills:string[];daemon?:{bin:string;dir:string};token:string}
let db:Handle;
let listener:{handle:string;port:number}|null=null;
const scopes=new Map<string,Scope>();
const connections=new Map<string,{token:string|null;buffer:string;peer:JsonRpcPeer|null}>();
const proxy=`const net=require('node:net');const s=net.connect({host:'127.0.0.1',port:Number(process.env.HATO_MCP_PORT)},()=>{s.write(JSON.stringify({token:process.env.HATO_MCP_TOKEN})+'\\n');process.stdin.pipe(s)});s.pipe(process.stdout);s.on('error',e=>{console.error(e.message);process.exit(1)});s.on('close',()=>process.exit(0));process.stdin.on('end',()=>s.end());`;
const object=(properties:any,required:string[]=[])=>({type:"object",properties,required,additionalProperties:false});
const AGENT={type:"object",description:"Background agent to start in the task",properties:{name:{type:"string",maxLength:120},prompt:{type:"string",description:"First prompt for the agent"},model:{type:"string",description:"Model id; defaults to this agent's model"}},required:["prompt"],additionalProperties:false};
const tools=[
  {name:"agents_create",description:"Create a background worker inheriting this agent’s provider, workspace, instructions, MCP and skill permissions",inputSchema:object({name:{type:"string"},text:{type:"string"},model:{type:"string"}},["name"])},
  {name:"agents_stop",description:"Stop a background agent process",inputSchema:object({id:{type:"string"}},["id"])},
  {name:"agents_list",description:"List background agents in this workspace",inputSchema:object({})},
  {name:"agents_history",description:"Read bounded agent history",inputSchema:object({id:{type:"string"},before:{type:"number"}},["id"])},
  {name:"agents_prompt",description:"Prompt or steer a background agent in this workspace",inputSchema:object({id:{type:"string"},text:{type:"string"},steer:{type:"boolean"}},["id","text"])},
  {name:"agents_cancel",description:"Cancel a background agent turn",inputSchema:object({id:{type:"string"}},["id"])},
  {name:"terminals_list",description:"List terminals belonging to this workspace",inputSchema:object({})},
  {name:"terminals_read",description:"Read bounded terminal output",inputSchema:object({key:{type:"string"},cursor:{type:"number"}},["key"])},
  {name:"terminals_write",description:"Write input to a workspace terminal, including commands ending with a newline",inputSchema:object({key:{type:"string"},text:{type:"string"}},["key","text"])},
  {name:"tasks_list",description:"List the Git tasks (branch + linked worktree) of this workspace's project. Requires the Hato desktop to be open.",inputSchema:object({})},
  {name:"tasks_create",description:"Create a Git task in this workspace's project, optionally starting a background agent in it with a prompt. Needs the user's approval in the Hato desktop unless this agent runs on autopilot. With `branch`, an existing local branch is checked out, a branch on exactly one remote is tracked, otherwise a new branch is created from HEAD; without it a task/<name>-<id> branch is generated. The new agent inherits this agent's provider, model, instructions, skills, MCP servers and autopilot.",inputSchema:object({name:{type:"string",maxLength:100},branch:{type:"string",maxLength:200},agent:AGENT})},
  {name:"tasks_start_agent",description:"Start a background agent with a prompt in an existing Git task of this project (task ids come from tasks_list). Needs the user's approval in the Hato desktop unless this agent runs on autopilot. The agent inherits this agent's provider, model, instructions, skills, MCP servers and autopilot.",inputSchema:object({taskId:{type:"string"},agent:AGENT},["taskId","agent"])},
  {name:"tasks_reconcile",description:"Refresh task statuses for this workspace's project against `git worktree list`. Never deletes anything. Requires the Hato desktop to be open.",inputSchema:object({})},
  {name:"skills_list",description:"List skills selected for this agent",inputSchema:object({})},
  {name:"skills_read",description:"Read a selected skill",inputSchema:object({path:{type:"string"}},["path"])},
];
async function ctl(ctx:ModuleContext,scope:Scope,op:string,args:any={}) {
  if(!scope.daemon)throw new Error("No daemon for this endpoint");
  const grant=await ctx.host.capabilities.request({kind:"process",root:scope.root});
  try {
    const r=await ctx.host.process.run(grant.grant,{executable:scope.daemon.bin,args:["daemon","ctl","--dir",scope.daemon.dir],cwd:scope.root},{stdin:JSON.stringify({op,args})+"\n",timeoutMs:30000});
    if(r.code!==0)throw new Error(r.stderr||"Daemon control failed");
    const v=JSON.parse(r.stdout);if(!v.ok)throw new Error(v.error?.message||"Daemon request failed");return v.value;
  }finally{await ctx.host.capabilities.release(grant.grant);}
}
async function agentCall(ctx:ModuleContext,s:Scope,method:string,args:any) {
  return s.daemon ? ctx.modules.call("agent-runner",method,args) : ctx.modules.call("persistent-agents",method,{...args,workspaceId:s.workspaceId});
}
// Git tasks are desktop state (project/task records), so task tools are executed by the desktop's
// persistent-agents gateway, which also owns the native approval. A desktop-hosted endpoint calls it
// directly; a daemon-hosted one queues the request here until the desktop claims and resolves it.
const TASK_OPS:Record<string,string>={tasks_list:"list",tasks_create:"create",tasks_reconcile:"reconcile",tasks_start_agent:"startAgent"};
const TASK_TIMEOUT_MS=10*60*1000, CLAIM_RETRY_MS=60*1000;
interface TaskRequest {id:string;sessionId:string;workspaceId:string;op:string;args:any;createdAt:number;claimedAt:number|null;resolve:(v:any)=>void;reject:(e:Error)=>void;timer:ReturnType<typeof setTimeout>}
const taskRequests=new Map<string,TaskRequest>();
function agentArg(a:any) {
  if(a==null)return undefined;
  if(typeof a!=="object"||typeof a.prompt!=="string"||!a.prompt.trim())throw new Error("agent.prompt is required");
  if(a.prompt.length>128*1024)throw new Error("agent.prompt is too large");
  return {name:typeof a.name==="string"?a.name.slice(0,120):"",prompt:a.prompt,model:typeof a.model==="string"?a.model.slice(0,200):""};
}
function taskArgs(op:string,a:any) {
  if(op==="startAgent") {
    if(typeof a.taskId!=="string"||!a.taskId)throw new Error("taskId is required");
    const agent=agentArg(a.agent);if(!agent)throw new Error("agent is required");
    return {taskId:a.taskId,agent};
  }
  if(op!=="create")return {};
  const name=typeof a.name==="string"?a.name.trim().slice(0,100):"",branch=typeof a.branch==="string"?a.branch.trim().slice(0,200):"";
  if(!name&&!branch)throw new Error("Provide a task name or a branch");
  return {name,branch,agent:agentArg(a.agent)};
}
function queueTask(s:Scope,op:string,args:any) {
  return new Promise((resolve,reject)=>{
    const id=crypto.randomUUID();
    const timer=setTimeout(()=>{taskRequests.delete(id);reject(new Error("The Hato desktop did not handle this request in time (is it open and was the request approved?)"));},TASK_TIMEOUT_MS);
    taskRequests.set(id,{id,sessionId:s.sessionId,workspaceId:s.workspaceId,op,args,createdAt:Date.now(),claimedAt:null,resolve,reject,timer});
  });
}
function finishTask(id:string,outcome:{value?:any;error?:string}) {
  const r=taskRequests.get(id);if(!r)return false;
  taskRequests.delete(id);clearTimeout(r.timer);
  if(typeof outcome.error==="string")r.reject(new Error(outcome.error));else r.resolve(outcome.value??null);
  return true;
}
async function call(ctx:ModuleContext,s:Scope,name:string,a:any) {
  if(TASK_OPS[name]) {
    const op=TASK_OPS[name],args=taskArgs(op,a);
    if(!s.daemon)return ctx.modules.call("persistent-agents","taskRequest",{sessionId:s.sessionId,workspaceId:s.workspaceId,op,args},{timeoutMs:TASK_TIMEOUT_MS});
    return queueTask(s,op,args);
  }
  if(name.startsWith("agents_")) {
    const list=await agentCall(ctx,s,"list",{});
    const permitted=list.filter((r:any)=>r.workspaceId===s.workspaceId&&r.root===s.root);
    if(name==="agents_list")return permitted;
    if(name==="agents_create") {
      if(!permitted.some((r:any)=>r.id===s.sessionId))throw new Error("This endpoint is not attached to a background agent");
      return agentCall(ctx,s,"fork",{parentId:s.sessionId,name:a.name,text:a.text,model:a.model});
    }
    if(!permitted.some((r:any)=>r.id===a.id))throw new Error("Agent is outside this workspace");
    if(name==="agents_history")return agentCall(ctx,s,"view",{id:a.id,before:a.before,limit:100});
    if(name==="agents_prompt")return agentCall(ctx,s,"send",{id:a.id,text:a.text,steer:a.steer});
    if(name==="agents_cancel")return agentCall(ctx,s,"cancel",{id:a.id});
    if(name==="agents_stop")return agentCall(ctx,s,"stop",{id:a.id});
  }
  if(name.startsWith("terminals_")) {
    if(!s.daemon) {
      const map:any={terminals_list:"list_tabs",terminals_read:"tail",terminals_write:"send"};
      return ctx.modules.call("terminals","workspaceControl",{tool:map[name],args:{...a,tab:a.key},scope:{workspaceId:s.workspaceId,conversationId:s.sessionId,machineId:"local"}});
    }
    const list=await ctl(ctx,s,"resources.list");
    const allowed=(list.ptys||[]).filter((p:any)=>p.cwd===s.root||p.cwd.startsWith(s.root.replace(/\/$/,"")+"/"));
    if(name==="terminals_list")return allowed;
    if(!allowed.some((p:any)=>p.key===a.key))throw new Error("Terminal is outside this workspace");
    return ctl(ctx,s,name==="terminals_read"?"pty.read":"pty.write",{key:a.key,cursor:a.cursor,limitBytes:65536,text:a.text});
  }
  if(name==="skills_list")return s.skills;
  if(name==="skills_read") {
    if(!s.skills.includes(a.path))throw new Error("Skill is not enabled for this session");
    const g=await ctx.host.capabilities.request({kind:"fs",root:s.root});
    try {return await ctx.host.fs.read(g.grant,a.path,128*1024);}finally{await ctx.host.capabilities.release(g.grant);}
  }
  throw new Error("Unknown workspace tool");
}
async function connection(ctx:ModuleContext,handle:string) {
  const c={token:null as string|null,buffer:"",peer:null as JsonRpcPeer|null};connections.set(handle,c);
  await ctx.host.streams.listen(handle,{},chunk=>{
    if(c.peer){c.peer.feed(chunk);return;}
    c.buffer+=chunk;const i=c.buffer.indexOf("\n");
    if(i<0){if(c.buffer.length>4096)void ctx.host.net.close(handle);return;}
    let token;try{token=JSON.parse(c.buffer.slice(0,i)).token;}catch{}
    if(typeof token!=="string"||!scopes.has(token)){void ctx.host.net.close(handle);return;}
    c.token=token;
    c.peer=new JsonRpcPeer(line=>ctx.host.net.write(handle,line+"\n"));
    c.peer.onRequest=async(method,params)=>{
      const s=scopes.get(c.token!);if(!s)throw rpcError(-32001,"MCP access revoked");
      if(method==="initialize")return {protocolVersion:["2024-11-05","2025-03-26","2025-06-18"].includes(params?.protocolVersion)?params.protocolVersion:"2024-11-05",capabilities:{tools:{}},serverInfo:{name:"internal-remote-mcp",version:"0.1.0"}};
      if(method==="ping")return {};
      if(method==="tools/list")return {tools};
      if(method==="tools/call") {
        try {const value=await call(ctx,s,params.name,params.arguments||{});return {content:[{type:"text",text:JSON.stringify(value)}]};}
        catch(e){return {content:[{type:"text",text:errMsg(e)}],isError:true};}
      }
      throw rpcError(-32601,"Unknown MCP method");
    };
    const rest=c.buffer.slice(i+1);c.buffer="";if(rest)c.peer.feed(rest);
  },()=>{connections.delete(handle);void ctx.host.net.close(handle).catch(()=>{});});
}
async function listen(ctx:ModuleContext) {
  if(listener)return listener;
  listener=await ctx.host.net.listenLoopback();let pending="";
  await ctx.host.streams.listen(listener.handle,{},chunk=>{
    pending+=chunk;let i;
    while((i=pending.indexOf("\n"))>=0){const line=pending.slice(0,i);pending=pending.slice(i+1);try{const e=JSON.parse(line);if(e.connection)void connection(ctx,e.connection);}catch{}}
  });return listener;
}
const mod:AppModule={id:"internal-remote-mcp",moduleApiVersion:1,
 async activate(ctx){db=await ctx.host.db.openNamespace("internal-remote-mcp");await ctx.host.db.exec(db,"CREATE TABLE IF NOT EXISTS scopes(token TEXT PRIMARY KEY,data TEXT NOT NULL)");for(const r of await ctx.host.db.query<any>(db,"SELECT data FROM scopes")){const s:Scope=JSON.parse(r.data);scopes.set(s.token,s);}},
 canSwap:()=>({ok:scopes.size===0&&taskRequests.size===0,reason:"Workspace MCP endpoints are active"}),
 methods:{
  /** Desktop gateway (over the daemon link): take unclaimed task requests. A claim that was not resolved is offered again later. */
  async claimTaskRequests(ctx,_a,meta){
    if(meta.caller!=="daemon-client")throw new Error("Only the desktop gateway handles task requests");
    const now=Date.now(),out:any[]=[];
    for(const r of taskRequests.values())if(r.claimedAt===null||now-r.claimedAt>CLAIM_RETRY_MS){r.claimedAt=now;out.push({id:r.id,sessionId:r.sessionId,workspaceId:r.workspaceId,op:r.op,args:r.args,createdAt:r.createdAt});}
    return out;
  },
  async resolveTaskRequest(ctx,a,meta){
    if(meta.caller!=="daemon-client")throw new Error("Only the desktop gateway handles task requests");
    return finishTask(String(a.id),{value:a.value,error:typeof a.error==="string"?a.error:undefined});
  },
  async endpoint(ctx,a,meta){
    if(!["agent-runner","persistent-agents","daemon-client"].includes(meta.caller))throw new Error("Only the session controller can issue workspace endpoints");
    let root=String(a.root||"");
    if(!a.daemon){const d=await ctx.modules.call("workspace","resolve",{workspaceId:a.workspaceId});if(d.location!=="local")throw new Error("Standalone endpoint requires a local workspace");root=d.rootAbsolutePath;}
    const g=await ctx.host.capabilities.request({kind:"fs",root});await ctx.host.capabilities.release(g.grant);
    const scope:Scope={sessionId:String(a.sessionId),workspaceId:String(a.workspaceId),root:g.root,skills:Array.isArray(a.skills)?a.skills:[],daemon:a.daemon,token:crypto.randomUUID()+crypto.randomUUID()};
    scopes.set(scope.token,scope);await ctx.host.db.exec(db,"INSERT INTO scopes(token,data) VALUES(?,?)",[scope.token,JSON.stringify(scope)]);
    const l=await listen(ctx);
    return {id:"internal-remote-mcp",name:"internal-remote-mcp",command:"node",args:["-e",proxy],env:[{name:"HATO_MCP_PORT",value:String(l.port)},{name:"HATO_MCP_TOKEN",value:scope.token}]};
  },
  async revoke(ctx,a,meta){if(!["agent-runner","persistent-agents","daemon-client"].includes(meta.caller))throw new Error("Only session controllers revoke endpoints");for(const r of [...taskRequests.values()])if(r.sessionId===a.sessionId)finishTask(r.id,{error:"Agent endpoint was revoked"});for(const [t,s]of scopes)if(s.sessionId===a.sessionId){scopes.delete(t);await ctx.host.db.exec(db,"DELETE FROM scopes WHERE token=?",[t]);for(const [h,c]of connections)if(c.token===t)await ctx.host.net.close(h).catch(()=>{});}return null;},
 }};
export default mod;
