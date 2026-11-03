import type {AppModule,ModuleContext,UiNode} from "../../../../sdk/types";
import type {AgentMcp} from "../../../../sdk/persistent-agents";
import {uiIcons} from "../../../../sdk/ui-icons";
import {errMsg} from "../../../../sdk/runtime";
interface Server extends Partial<AgentMcp>{id:string;name:string;builtin?:boolean;description?:string}
interface Draft{id:string;name:string;command:string;args:string;env:string;enabled:boolean}
let servers:Server[]=[],selected:string|null=null,filter="",draft:Draft|null=null;
let error:string|null=null,busy=false,removeId:string|null=null,alive=true;
const pending=new Map<string,{resolve:(value:any)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
function request(ctx:ModuleContext,method:string,args:any={}) {
  const requestId=crypto.randomUUID();
  return new Promise<any>((resolve,reject)=>{
    const timer=setTimeout(()=>{pending.delete(requestId);reject(new Error("MCP configuration request timed out"));},15000);
    pending.set(requestId,{resolve,reject,timer});
    ctx.events.emit("mcp-panel.request",{requestId,method,args});
  });
}
async function refresh(ctx:ModuleContext){
  try{const next=await request(ctx,"listMcps");if(alive){servers=next;error=null;}}
  catch(e){if(alive)error=errMsg(e);}
  if(alive)ctx.ui.invalidate();
}
function edit(server?:Server){
  draft={id:server?.id||crypto.randomUUID(),name:server?.name||"",command:server?.command||"",args:JSON.stringify(server?.args||[],null,2),env:JSON.stringify(Object.fromEntries((server?.env||[]).map(e=>[e.name,e.value])),null,2),enabled:server?.enabled!==false};error=null;
}
const btn=(key:string,text:string,action:string,value?:string):UiNode=>({type:"button",key,text,action,value,small:true,disabled:busy});
const mod:AppModule={id:"mcp-panel",moduleApiVersion:1,
 async activate(ctx,previous){
  alive=true;filter=previous?.filter||"";selected=previous?.selected||null;
  ctx.events.on("persistent-agents.mcpResponse",(response:any)=>{const p=pending.get(response?.requestId);if(!p)return;pending.delete(response.requestId);clearTimeout(p.timer);if(response.error)p.reject(new Error(response.error));else p.resolve(response.value);});
  ctx.events.on("persistent-agents.mcpsChanged",()=>{void refresh(ctx);});
  // Event responses are fenced until activation cuts over; load asynchronously.
  void refresh(ctx);
 },
 deactivate(){alive=false;for(const p of pending.values()){clearTimeout(p.timer);p.reject(new Error("MCP panel reloaded"));}pending.clear();},
 snapshot:()=>({filter,selected}),
 render():UiNode{
  const query=filter.trim().toLowerCase(),visible=servers.filter(s=>[s.name,s.command||"",s.description||""].join(" ").toLowerCase().includes(query));
  const current=servers.find(s=>s.id===selected);
  const children:UiNode[]=[{type:"row",key:"toolbar",gap:3,children:[
    {type:"textInput",key:"filter",prefixSvg:uiIcons.search,placeholder:"Filter MCP servers",value:filter,changeAction:"filter",grow:true},
    {type:"button",key:"add",text:"",iconSvg:uiIcons.plus,action:"add",tooltip:"Add MCP server",small:true,variant:"ghost",disabled:busy},
    {type:"button",key:"refresh",text:"",iconSvg:uiIcons.refresh,action:"refresh",tooltip:"Refresh servers",small:true,variant:"ghost",disabled:busy},
  ]},{type:"label",key:"count",text:`${servers.length} MCP servers`,size:"xs",color:"muted"}];
  if(error)children.push({type:"status",key:"error",level:"error",text:error});
  if(busy)children.push({type:"progress",key:"busy",indeterminate:true});
  children.push({type:"tree",key:"servers",rowHeight:42,rowGap:0,iconSize:18,grow:true,selectAction:"select",expandAction:"noop",rows:visible.map(s=>({
    key:s.id,label:s.name,detail:s.builtin?s.description:s.command||"",badge:s.builtin?"Built-in":s.enabled===false?"Disabled":"Enabled",depth:0,expanded:false,expandable:false,selected:s.id===selected,
    iconSvg:uiIcons.terminal,iconColor:s.enabled===false?"muted":"primary",
  }))});
  if(!visible.length)children.push({type:"label",key:"empty",text:"No matching MCP servers.",color:"muted",padding:8});
  if(current)children.push({type:"column",key:"selection",gap:6,children:[
    {type:"label",key:"name",text:current.name,weight:"semibold"},
    {type:"label",key:"description",text:current.builtin?current.description||"Built-in endpoint":"Runs on the agent’s machine. Changes apply to newly created agents.",color:"muted",size:"sm",wrap:true},
    ...(!current.builtin?[{type:"row",key:"actions",gap:6,children:[btn("configure","Configure","configure"),btn("remove","Remove","remove")]} as UiNode]:[]),
  ]});
  if(draft)children.push({type:"modal",key:"editor",title:servers.some(s=>s.id===draft!.id)?"Configure MCP server":"Add MCP server",closeAction:"closeEditor",children:[
    {type:"textInput",key:"name",placeholder:"Server name",value:draft.name,changeAction:"field:name"},
    {type:"textInput",key:"command",placeholder:"Command, e.g. npx or /path/to/server",value:draft.command,changeAction:"field:command"},
    {type:"label",key:"args-label",text:"Arguments (JSON string array)",size:"sm"},
    {type:"textInput",key:"args",value:draft.args,multiline:true,rows:3,changeAction:"field:args"},
    {type:"label",key:"env-label",text:"Environment (JSON object)",size:"sm"},
    {type:"textInput",key:"env",value:draft.env,multiline:true,rows:3,secret:true,changeAction:"field:env"},
    {type:"toggle",key:"enabled",label:"Available to new agents",checked:draft.enabled,action:"enabled"},
    {type:"label",key:"hint",text:"Commands run on the selected agent’s machine. Existing sessions keep their current configuration.",color:"muted",wrap:true,size:"sm"},
    ...(error?[{type:"status",key:"save-error",level:"error",text:error} as UiNode]:[]),
    {type:"row",key:"buttons",gap:6,children:[btn("save","Save","save"),btn("cancel","Cancel","closeEditor")]},
  ]});
  if(removeId)children.push({type:"modal",key:"confirm-remove",title:"Remove MCP server?",closeAction:"cancelRemove",children:[
    {type:"label",key:"message",text:`Remove ${servers.find(s=>s.id===removeId)?.name||"this server"} from available configurations? Running agents will keep their existing connection.`,wrap:true},
    {type:"row",key:"buttons",gap:6,children:[btn("confirm","Remove","confirmRemove"),btn("cancel","Cancel","cancelRemove")]},
  ]});
  return {type:"column",key:"mcp-root",padding:8,gap:6,grow:true,children};
 },
 async onEvent(ctx,event){
  if(event.action==="filter"){filter=String(event.value||"");ctx.ui.invalidate();return;}
  if(event.action.startsWith("field:")&&draft){const key=event.action.slice(6);if(["name","command","args","env"].includes(key))(draft as any)[key]=String(event.value||"");return;}
  if(event.action==="enabled"&&draft){draft.enabled=!!event.value;ctx.ui.invalidate();return;}
  if(busy)return;
  try{
    if(event.action==="add")edit();
    else if(event.action==="select"){selected=event.rowKey||String(event.value||"");}
    else if(event.action==="configure"){const server=servers.find(s=>s.id===selected);if(server&&!server.builtin)edit(server);}
    else if(event.action==="closeEditor"){draft=null;error=null;}
    else if(event.action==="remove"){const server=servers.find(s=>s.id===selected);if(server&&!server.builtin)removeId=server.id;}
    else if(event.action==="cancelRemove")removeId=null;
    else if(event.action==="confirmRemove"&&removeId){busy=true;ctx.ui.invalidate();await request(ctx,"removeMcp",{id:removeId});selected=null;removeId=null;await refresh(ctx);}
    else if(event.action==="save"&&draft){
      const fields=event.inputs;
      const args=JSON.parse(fields.args??draft.args),environment=JSON.parse(fields.env??draft.env);
      if(!Array.isArray(args)||!args.every(v=>typeof v==="string"))throw new Error("Arguments must be a JSON string array");
      if(!environment||Array.isArray(environment)||typeof environment!=="object"||Object.values(environment).some(v=>typeof v!=="string"))throw new Error("Environment must be a JSON object with string values");
      const server={id:draft.id,name:fields.name??draft.name,command:fields.command??draft.command,args,env:Object.entries(environment).map(([name,value])=>({name,value})),enabled:draft.enabled};
      busy=true;ctx.ui.invalidate();await request(ctx,"saveMcp",{server});selected=draft.id;draft=null;await refresh(ctx);
    }else if(event.action==="refresh")await refresh(ctx);
  }catch(e){error=errMsg(e);}
  finally{busy=false;if(alive)ctx.ui.invalidate();}
 },
};export default mod;
