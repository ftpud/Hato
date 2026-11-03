// Standalone ACP controller. No dependency on desktop workspace/chat services. This plugin runs
// in hatod, so protocol requests, permissions and history survive desktop disconnection.
import type { AppModule, ModuleContext, Handle, ChatMessage, StreamSubscription } from "../../../../sdk/types";
import { JsonRpcPeer, errMsg, rpcError } from "../../../../sdk/runtime";
import { modelChoices, relativeAgentPath, type AgentSpec, type AgentSession, type AgentPermission } from "../../../../sdk/persistent-agents";

interface Live {
  session: AgentSession; peer: JsonRpcPeer; process: Handle; subscriptions: StreamSubscription[];
  permissions: Map<string, { value: AgentPermission; resolve:(v:any)=>void }>;
  queued: string[]; cancelSent: boolean; stopping: boolean; context: string; firstPrompt: boolean;
  turn: number; stderr: string;
}
let db: Handle;
const sessions = new Map<string,AgentSession>();
const live = new Map<string,Live>();
const locks = new Map<string,Promise<any>>();
const now=()=>new Date().toISOString();
let writes: Promise<any> = Promise.resolve();
function serialize<T>(id:string, f:()=>Promise<T>):Promise<T> {
  const p=(locks.get(id)||Promise.resolve()).catch(()=>{}).then(f); locks.set(id,p);
  void p.finally(()=>{if(locks.get(id)===p)locks.delete(id);}).catch(()=>{}); return p;
}
function enqueue<T>(f:()=>Promise<T>):Promise<T> {
  const p=writes.catch(()=>{}).then(f); writes=p; return p;
}
function persist(ctx:ModuleContext,s:AgentSession) {
  s.updatedAt=now(); s.revision++;
  const json=JSON.stringify(s);
  return enqueue(()=>ctx.host.db.exec(db,"INSERT INTO sessions(id, data) VALUES(?, ?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",[s.id,json]));
}
function message(ctx:ModuleContext,s:AgentSession,role:ChatMessage["role"],text:string,title?:string,status?:string) {
  // Persist each protocol chunk before turn completion; read projections merge adjacent chunks.
  s.revision++;
  const turn=live.get(s.id)?.turn||0;
  return enqueue(async()=>{
    if(role==="assistant"||role==="thought") {
      const last=(await ctx.host.db.query<any>(db,"SELECT seq,role,turn FROM messages WHERE session_id=? ORDER BY seq DESC LIMIT 1",[s.id]))[0];
      if(last?.role===role&&last.turn===turn)return ctx.host.db.exec(db,"UPDATE messages SET text=text||? WHERE seq=?",[text,last.seq]);
    }
    return ctx.host.db.exec(db,"INSERT INTO messages(session_id, role, text, title, status, turn) VALUES(?,?,?,?,?,?)",[s.id,role,text,title||null,status||null,turn]);
  });
}
function publicSession(s:AgentSession) {
  return {...s,profile:{...s.profile,envRefs:{}},mcps:s.mcps.map(m=>({...m,env:[]}))};
}
function session(id:any):AgentSession { const s=sessions.get(String(id)); if(!s)throw new Error("Unknown persistent agent");return s; }
async function request(c:Live,method:string,args:any,ms=120000):Promise<any> {
  let timer:ReturnType<typeof setTimeout>;
  try { return await Promise.race([c.peer.request(method,args),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(`${method} timed out`)),ms);})]); }
  finally { clearTimeout(timer!); }
}
async function config(ctx:ModuleContext,c:Live,id:string,value:string) {
  if(c.session.status!=="ready")throw new Error("Agent must be idle to change model");
  if(id==="__model") {
    await request(c,"session/set_model",{sessionId:c.session.sessionId,modelId:value});
    c.session.models={...c.session.models,currentModelId:value};
  } else {
    const r=await request(c,"session/set_config_option",{sessionId:c.session.sessionId,configId:id,value});
    if(r.configOptions)c.session.configOptions=r.configOptions;
  }
  c.session.model=value; await persist(ctx,c.session);
}
function update(ctx:ModuleContext,c:Live,u:any) {
  const kind=u.sessionUpdate;
  if(kind==="agent_message_chunk" || kind==="agent_thought_chunk") {
    if(u.content?.type==="text")void message(ctx,c.session,kind==="agent_thought_chunk"?"thought":"assistant",String(u.content.text||"")).catch(e=>ctx.log.error(errMsg(e)));
  } else if(kind==="tool_call" || kind==="tool_call_update") {
    const text=(u.content||[]).map((x:any)=>x.content?.text||x.text||"").join("\n");
    void message(ctx,c.session,"tool",text,u.title||u.toolCallId||"Tool",u.status).catch(e=>ctx.log.error(errMsg(e)));
  } else if(kind==="plan") {
    void message(ctx,c.session,"plan",(u.entries||[]).map((e:any)=>`- ${e.content} (${e.status})`).join("\n")).catch(e=>ctx.log.error(errMsg(e)));
  } else if(kind==="config_option_update") { c.session.configOptions=u.configOptions||[];void persist(ctx,c.session); }
}
async function readContext(ctx:ModuleContext,s:AgentSession):Promise<string> {
  if(!s.agentFile && !s.skills.length)return "";
  const grant=await ctx.host.capabilities.request({kind:"fs",root:s.root,target:{kind:"local"}});
  try {
    const parts:string[]=[];
    for(const path of [s.agentFile,...s.skills].filter(Boolean) as string[]) {
      relativeAgentPath(path);
      const file=await ctx.host.fs.read(grant.grant,path,128*1024);
      if(file.binary||file.truncated)throw new Error(`Instruction file is binary or too large: ${path}`);
      parts.push(`Instructions from ${path}:\n${file.text||""}`);
    }
    return parts.join("\n\n");
  } finally { await ctx.host.capabilities.release(grant.grant); }
}
async function stop(ctx:ModuleContext,id:string) {
  const s=session(id), c=live.get(id);
  if(c) {
    c.stopping=true; c.queued=[];
    for(const p of c.permissions.values())p.resolve({outcome:{outcome:"cancelled"}});
    c.permissions.clear();
    await ctx.host.process.closeStdin(c.process).catch(()=>{});
    await ctx.host.resources.release(c.process).catch(()=>{});
    for(const sub of c.subscriptions)await sub.close().catch(()=>{});
    c.peer.failAll("Agent stopped"); live.delete(id);
  }
  await ctx.modules.call("internal-remote-mcp","revoke",{sessionId:s.id}).catch(()=>{});
  await ctx.host.db.exec(db,"UPDATE sessions SET queue_json='[]' WHERE id=?",[id]);
  await ctx.host.db.exec(db,"UPDATE permissions SET resolved=1 WHERE session_id=?",[id]);
  s.status="stopped"; await persist(ctx,s); return s;
}
async function start(ctx:ModuleContext,s:AgentSession) {
  if(live.has(s.id))return live.get(s.id)!;
  s.status="starting";s.error=null;await persist(ctx,s);
  let c:Live|undefined;
  try {
    const context=await readContext(ctx,s);
    const grant=await ctx.host.capabilities.request({kind:"process",root:s.root,target:{kind:"local"}});
    let spawned:{handle:string};
    try {
      const env={...(s.profile.envRefs||{})};
      const envRemove=s.profile.provider==="claude"&&s.claudeSubscription?["ANTHROPIC_API_KEY","ANTHROPIC_AUTH_TOKEN"]:[];
      envRemove.forEach(k=>delete env[k]);
      // A login shell resolves the adapter on the daemon machine, including GUI-launched local
      // daemons with a minimal PATH. All user arguments remain positional, never shell source.
      spawned=await ctx.host.process.spawn(grant.grant,{target:{kind:"local"},executable:ctx.host.env.info().platform==="macos"?"/bin/zsh":"/bin/sh",
        args:["-lc",envRemove.length?'exec /usr/bin/env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN "$@"':'exec "$@"',"hato-agent",s.profile.executable,...s.profile.args],cwd:s.root,env,envRemove});
    } finally { await ctx.host.capabilities.release(grant.grant); }
    c={session:s,process:spawned.handle,peer:null as any,subscriptions:[],permissions:new Map(),queued:[],cancelSent:false,stopping:false,context,firstPrompt:!s.contextSent,turn:Date.now(),stderr:""};
    const connection=c;
    c.peer=new JsonRpcPeer(line=>ctx.host.process.write(connection.process,line+"\n"));
    live.set(s.id,c);
    c.peer.onNotification=(method,params)=>{if(method==="session/update" && params?.sessionId===s.sessionId)update(ctx,connection,params.update||{});};
    c.peer.onRequest=async(method,params)=>{
      if(method!=="session/request_permission")throw rpcError(-32601,"Unsupported agent request");
      if(params.sessionId!==s.sessionId)throw rpcError(-32602,"Wrong session");
      const id=crypto.randomUUID();
      const value={id,request:params,createdAt:now()};
      await ctx.host.db.exec(db,"INSERT INTO permissions(id,session_id,data) VALUES(?,?,?)",[id,s.id,JSON.stringify(value)]);
      s.status="waiting";await persist(ctx,s);
      return new Promise(resolve=>connection.permissions.set(id,{value,resolve}));
    };
    c.subscriptions.push(await ctx.host.streams.listen(c.process,{channel:"stdout"},chunk=>connection.peer.feed(chunk),error=>{
      if(connection.stopping)return;
      s.status="interrupted";s.error=error?errMsg(error):`Agent exited${connection.stderr?": "+connection.stderr.slice(-600):""}`;
      connection.peer.failAll(s.error);live.delete(s.id);
      for(const p of connection.permissions.values())p.resolve({outcome:{outcome:"cancelled"}});
      void persist(ctx,s);
    }));
    c.subscriptions.push(await ctx.host.streams.listen(c.process,{channel:"stderr"},chunk=>{connection.stderr=(connection.stderr+chunk).slice(-4000);}));
    const init=await request(c,"initialize",{protocolVersion:1,clientCapabilities:{fs:{readTextFile:false,writeTextFile:false},terminal:false},clientInfo:{name:"hato-agents",version:"0.1.0"}});
    if(init.protocolVersion!==1)throw new Error("Unsupported ACP version");
    let mcpServers=s.mcps.map(({id,...server})=>server);
    if(s.workspaceMcp) {
      await ctx.modules.call("internal-remote-mcp","revoke",{sessionId:s.id});
      const server=await ctx.modules.call("internal-remote-mcp","endpoint",{sessionId:s.id,workspaceId:s.workspaceId,root:s.root,skills:s.skills,daemon:s.daemon});
      const {id,...config}=server;mcpServers=[...mcpServers,config];
    }
    let result:any;
    if(s.sessionId) {
      if(!init.agentCapabilities?.loadSession)throw new Error("Provider cannot reload this session; create a new agent to avoid losing its context");
      result=await request(c,"session/load",{sessionId:s.sessionId,cwd:s.root,mcpServers});
    } else {
      result=await request(c,"session/new",{cwd:s.root,mcpServers});
      if(typeof result.sessionId!=="string"||!result.sessionId)throw new Error("Provider did not return a session id");
      s.sessionId=result.sessionId;
    }
    s.configOptions=result.configOptions||[];s.models=result.models||null;s.status="ready";
    if(s.model) {
      const choice=modelChoices(s).find(m=>m.id===s.model);
      if(!choice)throw new Error(`Provider does not advertise model ${s.model}`);
      await config(ctx,c,choice.configId,choice.id);
    }
    await persist(ctx,s); return c;
  } catch(e) {
    if(c) { await stop(ctx,s.id); }
    s.status="error";s.error=errMsg(e);await persist(ctx,s);throw e;
  }
}
async function prompt(ctx:ModuleContext,c:Live,text:string) {
  const s=c.session;
  if(s.status!=="ready")throw new Error("Agent is not idle");
  c.turn=Date.now();c.cancelSent=false;s.status="busy";s.error=null;
  await message(ctx,s,"user",text);await persist(ctx,s);
  const context=c.firstPrompt?c.context:""; c.firstPrompt=false;s.contextSent=true;await persist(ctx,s);
  void c.peer.request("session/prompt",{sessionId:s.sessionId,prompt:[{type:"text",text:context?`${context}\n\nUser request:\n${text}`:text}]}).then(async r=>{
    await enqueue(()=>ctx.host.db.exec(db,"UPDATE permissions SET resolved=1 WHERE session_id=?",[s.id]));
    for(const pending of c.permissions.values())pending.resolve({outcome:{outcome:"cancelled"}});
    c.permissions.clear();
    if(c.stopping || live.get(s.id)!==c)return;
    s.status="ready";await message(ctx,s,"system",`Turn ended: ${r.stopReason||"complete"}`);await persist(ctx,s);
    if(c.queued.length) {
      const next=c.queued.join("\n\n");c.queued=[];
      await ctx.host.db.exec(db,"UPDATE sessions SET queue_json='[]' WHERE id=?",[s.id]);
      await prompt(ctx,c,next);
    }
  },async e=>{
    if(c.stopping)return;
    if(live.get(s.id)!==c)return;
    s.status="ready";s.error=errMsg(e);await message(ctx,s,"error",s.error);await persist(ctx,s);
  }).catch(e=>ctx.log.error(errMsg(e)));
  return {accepted:true};
}
const mod:AppModule={
  id:"agent-runner",moduleApiVersion:1,
  async activate(ctx) {
    db=await ctx.host.db.openNamespace("agent-runner");
    await ctx.host.db.exec(db,"CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, data TEXT NOT NULL, queue_json TEXT NOT NULL DEFAULT '[]'); CREATE TABLE IF NOT EXISTS messages(seq INTEGER PRIMARY KEY AUTOINCREMENT,session_id TEXT NOT NULL,role TEXT NOT NULL,text TEXT NOT NULL,title TEXT,status TEXT,turn INTEGER); CREATE INDEX IF NOT EXISTS messages_session ON messages(session_id,seq); CREATE TABLE IF NOT EXISTS permissions(id TEXT PRIMARY KEY,session_id TEXT NOT NULL,data TEXT NOT NULL,resolved INTEGER NOT NULL DEFAULT 0)");
    for(const row of await ctx.host.db.query<any>(db,"SELECT data FROM sessions")) {
      const s:AgentSession=JSON.parse(row.data);
      if(["starting","ready","busy","waiting"].includes(s.status)) {s.status="interrupted";s.error="Runtime restarted; reconnect to resume. An interrupted turn is never replayed automatically.";await persist(ctx,s);}
      sessions.set(s.id,s);
    }
    await ctx.host.db.exec(db,"UPDATE permissions SET resolved=1 WHERE resolved=0");
  },
  canSwap:()=>({ok:live.size===0,reason:"Stop persistent agents before replacing their runtime"}),
  methods:{
    health:()=>({ok:true}),
    async fork(ctx,a,meta) {
      if(!["internal-remote-mcp","daemon-client"].includes(meta.caller))throw new Error("Only workspace controllers can create child agents");
      const parent=session(a.parentId);
      const spec:AgentSession={...parent,id:crypto.randomUUID(),name:String(a.name||"Background worker").slice(0,120),model:String(a.model||parent.model),sessionId:null,contextSent:false,status:"starting",error:null,createdAt:now(),updatedAt:now(),revision:0,configOptions:[],models:null};
      sessions.set(spec.id,spec);await persist(ctx,spec);
      const c=await serialize(spec.id,()=>start(ctx,spec));
      if(a.text)await prompt(ctx,c,String(a.text));
      return publicSession(spec);
    },
    list:()=>[...sessions.values()].sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).map(publicSession),
    async create(ctx,a) {
      const spec=a.spec as AgentSpec;
      if(!spec||typeof spec.id!=="string"||!spec.name?.trim()||!spec.root?.startsWith("/")||!spec.profile?.executable||!Array.isArray(spec.profile.args)||!Array.isArray(spec.skills)||!Array.isArray(spec.mcps))throw new Error("Invalid agent configuration");
      if(sessions.has(spec.id))throw new Error("Agent already exists");
      const s:AgentSession={...spec,status:"starting",sessionId:null,createdAt:now(),updatedAt:now(),error:null,configOptions:[],models:null,revision:0};
      sessions.set(s.id,s);await persist(ctx,s);
      await serialize(s.id,()=>start(ctx,s)); return publicSession(s);
    },
    async view(ctx,a) {
      const s=session(a.id); await writes;
      const limit=Math.min(Math.max(Number(a.limit)||100,1),200);
      const rows=await ctx.host.db.query<any>(db,"SELECT * FROM messages WHERE session_id=? AND seq < ? ORDER BY seq DESC LIMIT ?",[s.id,Number(a.before)||Number.MAX_SAFE_INTEGER,limit+1]);
      const older=rows.length>limit; if(older)rows.pop(); rows.reverse();
      const messages:ChatMessage[]=[];
      for(const r of rows) {
        const last=messages[messages.length-1];
        if(last && (r.role==="assistant"||r.role==="thought") && last.role===r.role && (last as any).turn===r.turn)last.text+=r.text;
        else messages.push({key:`agent-msg-${r.seq}`,role:r.role,text:r.text,title:r.title,status:r.status,...{turn:r.turn}});
      }
      const permissions=await ctx.host.db.query<any>(db,"SELECT data FROM permissions WHERE session_id=? AND resolved=0 ORDER BY rowid",[s.id]);
      const queue=await ctx.host.db.query<any>(db,"SELECT queue_json FROM sessions WHERE id=?",[s.id]);
      return {session:publicSession(s),messages,before:older?rows[0].seq:null,permissions:permissions.map(p=>JSON.parse(p.data)),queued:JSON.parse(queue[0]?.queue_json||"[]")};
    },
    send:(ctx,a)=>serialize(String(a.id),async()=>{
      const s=session(a.id),text=String(a.text||"").trim();if(!text||text.length>128*1024)throw new Error("Prompt is empty or too large");
      const c=await start(ctx,s);
      if(s.status==="busy"||s.status==="waiting") {
        if(a.steer!==true)throw new Error("Agent is busy; use Steer");
        c.queued.push(text);
        await ctx.host.db.exec(db,"UPDATE sessions SET queue_json=? WHERE id=?",[JSON.stringify(c.queued),s.id]);
        if(!c.cancelSent) {
          c.cancelSent=true;
          for(const p of c.permissions.values())p.resolve({outcome:{outcome:"cancelled"}});
          c.permissions.clear();
          await ctx.host.db.exec(db,"UPDATE permissions SET resolved=1 WHERE session_id=?",[s.id]);
          await c.peer.notify("session/cancel",{sessionId:s.sessionId});}
        return {queued:true};
      }
      return prompt(ctx,c,text);
    }),
    reconnect:(ctx,a)=>serialize(String(a.id),async()=>{const s=session(a.id);await start(ctx,s);return s;}),
    stop:(ctx,a)=>serialize(String(a.id),()=>stop(ctx,String(a.id))),
    async cancel(ctx,a) {const c=live.get(String(a.id));if(c){
      for(const p of c.permissions.values())p.resolve({outcome:{outcome:"cancelled"}});c.permissions.clear();
      await ctx.host.db.exec(db,"UPDATE permissions SET resolved=1 WHERE session_id=?",[c.session.id]);
      await c.peer.notify("session/cancel",{sessionId:c.session.sessionId});}return null;},
    setModel:(ctx,a)=>serialize(String(a.id),async()=>{const c=live.get(String(a.id));if(!c)throw new Error("Reconnect agent first");const choice=modelChoices(c.session).find(m=>m.id===a.model);if(!choice)throw new Error("Unknown model");await config(ctx,c,choice.configId,choice.id);return c.session;}),
    async permission(ctx,a) {
      const c=live.get(String(a.id)),p=c?.permissions.get(String(a.permissionId));if(!c||!p)throw new Error("Permission request is no longer active");
      const option=p.value.request.options?.find((o:any)=>o.optionId===a.optionId);
      if(!option)throw new Error("Invalid permission option");
      await ctx.host.db.exec(db,"UPDATE permissions SET resolved=1 WHERE id=?",[p.value.id]);
      c.permissions.delete(p.value.id);c.session.status=c.permissions.size?"waiting":"busy";await persist(ctx,c.session);
      p.resolve({outcome:{outcome:"selected",optionId:option.optionId}});return null;
    },
  },
};
export default mod;
