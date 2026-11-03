import type {AppModule,ModuleContext,UiNode} from "../../../../sdk/types";
import type {AgentSession} from "../../../../sdk/persistent-agents";
import {uiIcons} from "../../../../sdk/ui-icons";

import {errMsg} from "../../../../sdk/runtime";
let ws:any=null,catalog:any=null,rows:AgentSession[]=[];
let selected:string|null=null,creating=false,error:string|null=null,busy=false,visible=false;
let name="",profile="",agentFile="",filter="";
let skills=new Set<string>(),mcps=new Set<string>(["internal-remote-mcp"]);
let timer:ReturnType<typeof setInterval>|null=null,epoch=0,refreshing:null|number=null;
let animation:ReturnType<typeof setInterval>|null=null,frame=0;
const working=(s:AgentSession)=>s.status==="starting"||s.status==="busy";
function spinnerSvg(){return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="8" opacity="0.2"/><path d="M12 4a8 8 0 0 1 8 8" stroke-linecap="round" transform="rotate(${frame*30} 12 12)"/></svg>`;}
function animate(ctx:ModuleContext){
  if(visible&&rows.some(working)) {
    if(!animation)animation=setInterval(()=>{frame=(frame+1)%12;ctx.ui.invalidate();},80);
  }else if(animation){clearInterval(animation);animation=null;}
}
const call=(ctx:ModuleContext,method:string,args:any={})=>ctx.modules.call("persistent-agents",method,{workspaceId:ws?.id,...args},{timeoutMs:240000});
const button=(key:string,text:string,action:string,value?:string):UiNode=>({type:"button",key,text,action,value,small:true});
async function refresh(ctx:ModuleContext,force=false) {
  if(!ws||refreshing===epoch||(!visible&&!force))return;
  const mine=epoch,id=ws.id;refreshing=mine;
  try {
    const next:AgentSession[]=await call(ctx,"list");
    if(mine!==epoch||id!==ws?.id)return;
    rows=next;animate(ctx);
    error=null;
  }catch(e){if(mine===epoch)error=errMsg(e);}
  finally{if(refreshing===mine)refreshing=null;ctx.ui.invalidate();}
}
async function setup(ctx:ModuleContext) {
  const mine=++epoch;
  busy=false;error=null;rows=[];animate(ctx);selected=null;catalog=null;creating=false;
  if(!ws){ctx.ui.invalidate();return;}
  try{const c=await call(ctx,"catalog");if(mine!==epoch)return;catalog=c;profile=c.profiles[0]?.id||"";}
  catch(e){if(mine===epoch)error=errMsg(e);}
  if(visible)await refresh(ctx,true);
}
function schedule(ctx:ModuleContext){animate(ctx);if(timer)clearInterval(timer);timer=visible?setInterval(()=>{void refresh(ctx);},1500):null;}
function checks(items:any[],set:Set<string>,action:string):UiNode[]{return items.map(item=>({type:"toggle",key:`${action}:${item.path||item.id}`,label:item.name||item.id,checked:set.has(item.path||item.id),action,value:item.path||item.id} as UiNode));}
const label=(key:string,text:string):UiNode=>({type:"label",key,text,wrap:true,color:"muted",size:"sm"});
const mod:AppModule={id:"agents-panel",moduleApiVersion:1,
 async activate(ctx,prev){
  ws=ctx.state.get("workspace.selected")||null;visible=!!(ctx.state.get("workspace-layout.panels") as any)?.agents;
  ctx.state.watch("workspace.selected",(next:any)=>{const changed=next?.id!==ws?.id;ws=next;if(changed)void setup(ctx);});
  ctx.state.watch("workspace-layout.panels",(panels:any)=>{visible=!!panels?.agents;schedule(ctx);if(visible)void refresh(ctx,true);});
  await setup(ctx);
  if(prev&&prev.workspaceId===ws?.id){selected=prev.selected||null;filter=prev.filter||"";if(visible)await refresh(ctx,true);}
  ctx.events.on("persistent-agents.mcpsChanged",()=>{if(ws&&creating)void call(ctx,"catalog").then(next=>{catalog=next;mcps=new Set([...mcps].filter(id=>next.mcps.some((server:any)=>server.id===id)));ctx.ui.invalidate();}).catch(e=>{error=errMsg(e);ctx.ui.invalidate();});});
  ctx.state.watch("ai.session",(session:any)=>{selected=session?.kind==="background"&&session.workspaceId===ws?.id?session.id:null;ctx.ui.invalidate();});
  schedule(ctx);
 },
 deactivate(){epoch++;if(timer)clearInterval(timer);timer=null;if(animation)clearInterval(animation);animation=null;},
 snapshot:()=>({workspaceId:ws?.id,selected,filter}),
 render():UiNode {
  const children:UiNode[]=[{type:"row",key:"header",gap:3,children:[
    {type:"textInput",key:"agent-filter",prefixSvg:uiIcons.search,placeholder:"Filter agents",value:filter,changeAction:"filter",grow:true},
    {type:"button",key:"new",text:"",iconSvg:uiIcons.plus,action:"new",small:true,variant:"ghost",tooltip:"Create agent"},
    {type:"button",key:"refresh",text:"",iconSvg:uiIcons.refresh,action:"refresh",small:true,variant:"ghost",tooltip:"Refresh agents"},
  ]},{type:"row",key:"summary",children:[{type:"label",key:"count",text:`${rows.length} agents`,size:"xs",color:"muted",grow:true},button("mcps","MCP servers","mcps")]}];
  if(!ws)children.push(label("none","Select a workspace to create or open its agents."));
  if(error)children.push({type:"status",key:"error",level:"error",text:error});
  if(busy)children.push({type:"progress",key:"busy",indeterminate:true});
  if(creating&&catalog) {
    children.push({type:"column",key:"create-form",gap:8,scroll:true,children:[
      {type:"textInput",key:"agent-name",placeholder:"Agent name",value:name,changeAction:"name"},
      {type:"select",key:"provider",label:"Provider",value:profile,options:catalog.profiles.map((p:any)=>({value:p.id,label:p.name})),action:"provider"},
      label("model-note","Connect to choose from the provider’s models before sending the first prompt."),
      {type:"select",key:"agent-file",label:"Agent instructions",value:agentFile,options:[{value:"",label:"No agent file"},...catalog.agentFiles.map((f:any)=>({value:f.path,label:f.path}))],action:"agentFile"},
      label("mcp-heading","Allowed MCP servers"),...checks(catalog.mcps,mcps,"mcp"),
      label("skills-heading","Allowed skills"),...checks(catalog.skills,skills,"skill"),
      ...(!catalog.skills.length?[label("no-skills","No workspace skills found in .agents/skills.")]:[]),
      label("scope-note","Selections control supplied instructions, skills and MCP connections. Provider-native tools keep the provider’s permission controls."),
      label("lifetime","Runs on the workspace machine’s daemon, including local workspaces. Closing this panel or Hato does not stop a running turn."),
      {type:"button",key:"create",text:"Connect and choose model",action:"create",disabled:busy||!profile},button("cancel-create","Cancel","back"),
    ]});
  } else if(ws) {
    const query=filter.trim().toLowerCase();
    const agents=rows.filter(s=>[s.name,s.profile.name,s.status,s.activity||""].some(v=>v.toLowerCase().includes(query)));
    children.push({type:"tree",key:"agents",rowHeight:42,rowGap:0,iconSize:18,grow:true,selectAction:"open",expandAction:"noop",rows:agents.map(s=>({
      key:s.id,label:s.name,detail:s.activity||`${s.profile.name} · ${s.machineId}`,badge:s.status,
      tooltip:`${s.profile.name} · ${s.machineId}${s.activity?"\n"+s.activity:""}`,
      selected:s.id===selected,depth:0,expandable:false,expanded:false,
      iconSvg:working(s)?spinnerSvg():s.status==="waiting"?uiIcons.warning:uiIcons["message-square"],iconColor:working(s)?"primary":s.status==="error"?"danger":s.status==="waiting"?"warning":"muted",
    }))});
    if(!agents.length)children.push(label("empty",query?"No matching agents.":"No background agents in this workspace. Create one to begin."));
  }
  return {type:"column",key:"agents-root",padding:8,gap:8,grow:true,children};
 },
 async onEvent(ctx,ev) {
  const value=String(ev.value||"");
  if(ev.action==="filter"){filter=value;ctx.ui.invalidate();return;}
  if(ev.action==="name"){name=value;return;}
  if(ev.action==="provider"){profile=value;return;}
  if(ev.action==="agentFile"){agentFile=value;return;}
  if(ev.action==="skill"||ev.action==="mcp") {const set=ev.action==="skill"?skills:mcps;const id=ev.key.slice(ev.key.indexOf(":")+1);if(set.has(id))set.delete(id);else set.add(id);ctx.ui.invalidate();return;}
  if(busy)return;
  const mine=epoch,workspaceId=ws?.id;
  const actionCall=async(method:string,args:any={})=>{
    const result=await ctx.modules.call("persistent-agents",method,{workspaceId,...args},{timeoutMs:240000});
    if(mine!==epoch)throw new Error("Workspace changed");return result;
  };
  busy=true;error=null;ctx.ui.invalidate();
  try {
    if(ev.action==="new") {catalog=await actionCall("catalog");creating=true;name="";agentFile="";skills=new Set();mcps=new Set(["internal-remote-mcp"]);}
    else if(ev.action==="back"){creating=false;}
    else if(ev.action==="mcps")ctx.events.emit("agents-panel.openMcps",{});
    else if(ev.action==="create") {const s=await actionCall("create",{name:ev.inputs["agent-name"]||name||"Agent",profileId:profile,agentFile,skills:[...skills],mcps:[...mcps]});if(mine!==epoch)return;selected=s.id;creating=false;ctx.events.emit("agents-panel.openChat",{workspaceId,id:s.id});}
    else if(ev.action==="open"){selected=ev.rowKey||value;creating=false;ctx.events.emit("agents-panel.openChat",{workspaceId,id:selected});}
    if(mine===epoch)await refresh(ctx,true);
  }catch(e){if(mine===epoch)error=errMsg(e);}
  finally{if(mine===epoch)busy=false;ctx.ui.invalidate();}
 },
};export default mod;
