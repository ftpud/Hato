import type {AppModule,ModuleContext,UiNode} from "../../../../sdk/types";
import type {AgentSession} from "../../../../sdk/persistent-agents";
import {uiIcons} from "../../../../sdk/ui-icons";

import {errMsg} from "../../../../sdk/runtime";
let ws:any=null,catalog:any=null,rows:AgentSession[]=[];
let selected:string|null=null,creating=false,error:string|null=null,busy=false,visible=false;
/** Agent being edited in the form (null while creating), and a pending destructive confirmation. */
let editing:string|null=null,confirming:{action:"clear"|"remove";id:string}|null=null;
let name="",profile="",agentFile="",filter="";
/** Agents started by workflow runs (and the workflow configurator) are hidden unless shown. */
let showWorkflow=false;
// Configurators created before the marker existed are recognised by their fixed name.
const isWorkflowAgent=(s:any)=>!!s?.workflow||s?.name==="Workflow configurator";
/** Floating create/edit window geometry. Kept for the session and across module reloads. */
const DEFAULT_EDITOR={x:180,y:90,width:440,height:560};
let editor={...DEFAULT_EDITOR};
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
function editorWindow():UiNode {
  const target=editing?rows.find(s=>s.id===editing):null;
  const title=editing?`Edit ${target?.name||name||"agent"}`:"New background agent";
  return {type:"floating",key:"agent-editor",title,...editor,moveAction:"moveEditor",children:[
    {type:"column",key:"editor-body",padding:10,gap:8,grow:true,children:[
      {type:"row",key:"editor-header",gap:4,align:"center",children:[
        {type:"label",key:"editor-title",text:editing?"Change this agent’s provider, instructions, tools and skills.":"Choose a provider, instructions, tools and skills.",size:"xs",color:"muted",wrap:true,grow:true},
        {type:"button",key:"editor-close",text:"",iconSvg:uiIcons.x,action:"back",small:true,variant:"ghost",tooltip:"Close without saving"},
      ]},
      ...(error?[{type:"status",key:"editor-error",level:"error",text:error} as UiNode]:[]),
      ...(busy?[{type:"progress",key:"editor-busy",indeterminate:true} as UiNode]:[]),
      {type:"column",key:"create-form",gap:8,scroll:true,grow:true,children:[
        {type:"textInput",key:"agent-name",placeholder:"Agent name",value:name,changeAction:"name"},
        {type:"select",key:"provider",label:"Provider",value:profile,options:catalog.profiles.map((p:any)=>({value:p.id,label:p.name})),action:"provider"},
        label("model-note",editing?"Changing the provider starts a new provider session; choose its model in the chat. Changes other than the name restart a connected agent.":"Connect to choose from the provider’s models before sending the first prompt."),
        {type:"select",key:"agent-file",label:"Agent instructions",value:agentFile,options:[{value:"",label:"No agent file"},...catalog.agentFiles.map((f:any)=>({value:f.path,label:f.path}))],action:"agentFile"},
        label("mcp-heading","Allowed MCP servers"),...checks(catalog.mcps,mcps,"mcp"),
        label("skills-heading","Allowed skills"),...checks(catalog.skills,skills,"skill"),
        ...(!catalog.skills.length?[label("no-skills","No workspace skills found in .agents/skills.")]:[]),
        label("scope-note","Selections control supplied instructions, skills and MCP connections. Provider-native tools keep the provider’s permission controls."),
        label("lifetime","Runs on the workspace machine’s daemon, including local workspaces. Closing this panel or Hato does not stop a running turn."),
      ]},
      {type:"row",key:"editor-footer",gap:4,align:"center",children:[
        {type:"label",key:"editor-spacer",text:"",grow:true},
        button("cancel-create","Cancel","back"),
        editing?{type:"button",key:"save",text:"Save changes",action:"save",variant:"primary",small:true,disabled:busy||!profile}:{type:"button",key:"create",text:"Connect and choose model",action:"create",variant:"primary",small:true,disabled:busy||!profile},
      ]},
    ]},
  ]};
}
const workflowCount=()=>rows.filter(isWorkflowAgent).length;
const workflowIcon=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="6" height="6" rx="1"/><rect x="15" y="15" width="6" height="6" rx="1"/><rect x="15" y="3" width="6" height="6" rx="1"/><path d="M9 6h6M18 9v6M6 9v6a3 3 0 0 0 3 3h6"/></svg>`;
const mod:AppModule={id:"agents-panel",moduleApiVersion:1,
 async activate(ctx,prev){
  const saved:any=prev?.editor;
  if(saved&&["x","y","width","height"].every(k=>Number.isFinite(saved[k])))editor={x:saved.x,y:saved.y,width:Math.max(320,saved.width),height:Math.max(320,saved.height)};
  ws=ctx.state.get("workspace.selected")||null;visible=!!(ctx.state.get("workspace-layout.panels") as any)?.agents;
  ctx.state.watch("workspace.selected",(next:any)=>{const changed=next?.id!==ws?.id;ws=next;if(changed)void setup(ctx);});
  ctx.state.watch("workspace-layout.panels",(panels:any)=>{visible=!!panels?.agents;schedule(ctx);if(visible)void refresh(ctx,true);});
  await setup(ctx);
  if(prev&&prev.workspaceId===ws?.id){selected=prev.selected||null;filter=prev.filter||"";showWorkflow=!!prev.showWorkflow;if(visible)await refresh(ctx,true);}
  ctx.events.on("persistent-agents.mcpsChanged",()=>{if(ws&&creating)void call(ctx,"catalog").then(next=>{catalog=next;mcps=new Set([...mcps].filter(id=>next.mcps.some((server:any)=>server.id===id)));ctx.ui.invalidate();}).catch(e=>{error=errMsg(e);ctx.ui.invalidate();});});
  ctx.state.watch("ai.session",(session:any)=>{selected=session?.kind==="background"&&session.workspaceId===ws?.id?session.id:null;ctx.ui.invalidate();});
  schedule(ctx);
 },
 deactivate(){epoch++;if(timer)clearInterval(timer);timer=null;if(animation)clearInterval(animation);animation=null;},
 snapshot:()=>({workspaceId:ws?.id,selected,filter,editor,showWorkflow}),
 render():UiNode {
  const children:UiNode[]=[{type:"row",key:"header",gap:3,children:[
    {type:"textInput",key:"agent-filter",prefixSvg:uiIcons.search,placeholder:"Filter agents",value:filter,changeAction:"filter",grow:true},
    {type:"button",key:"workflow-toggle",text:workflowCount()?String(workflowCount()):"",iconSvg:workflowIcon,action:"toggleWorkflow",small:true,variant:showWorkflow?"primary":"ghost",
      tooltip:showWorkflow?"Showing workflow agents — click to hide them":`Show workflow agents${workflowCount()?` (${workflowCount()} hidden)`:""}`},
    {type:"button",key:"new",text:"",iconSvg:uiIcons.plus,action:"new",small:true,variant:"ghost",tooltip:"Create agent"},
    {type:"button",key:"refresh",text:"",iconSvg:uiIcons.refresh,action:"refresh",small:true,variant:"ghost",tooltip:"Refresh agents"},
  ]},{type:"row",key:"summary",children:[{type:"label",key:"count",text:`${rows.filter(s=>showWorkflow||!isWorkflowAgent(s)).length} agents${!showWorkflow&&workflowCount()?` · ${workflowCount()} workflow hidden`:""}`,size:"xs",color:"muted",grow:true}]}];
  if(!ws)children.push(label("none","Select a workspace to create or open its agents."));
  if(error&&!creating)children.push({type:"status",key:"error",level:"error",text:error});
  if(busy&&!creating)children.push({type:"progress",key:"busy",indeterminate:true});
  if(ws) {
    const query=filter.trim().toLowerCase();
    const agents=rows.filter(s=>(showWorkflow||!isWorkflowAgent(s))&&[s.name,s.profile.name,s.status,s.activity||""].some(v=>v.toLowerCase().includes(query)));
    children.push({type:"tree",key:"agents",rowHeight:42,rowGap:0,iconSize:18,grow:true,selectAction:"open",expandAction:"noop",rows:agents.map(s=>({
      key:s.id,label:s.name,detail:s.activity||`${s.profile.name} · ${s.machineId}`,badge:s.status,
      tooltip:`${s.profile.name} · ${s.machineId}${s.activity?"\n"+s.activity:""}`,
      selected:s.id===selected,depth:0,expandable:false,expanded:false,
      iconSvg:working(s)?spinnerSvg():s.status==="waiting"?uiIcons.warning:uiIcons["message-square"],iconColor:working(s)?"primary":s.status==="error"?"danger":s.status==="waiting"?"warning":"muted",
    }))});
    if(!agents.length)children.push(label("empty",query?"No matching agents.":!showWorkflow&&workflowCount()?"Only workflow agents here — use the workflow button to show them.":"No background agents in this workspace. Create one to begin."));
    const current=rows.find(s=>s.id===selected);
    if(current) {
      const running=["starting","busy","waiting"].includes(current.status);
      children.push({type:"row",key:"agent-actions",gap:4,children:[
        {type:"button",key:"edit",text:"Edit",iconSvg:uiIcons.pencil,action:"edit",value:current.id,small:true,variant:"ghost",disabled:busy,tooltip:`Edit ${current.name}`},
        {type:"button",key:"clear",text:"Clear session",iconSvg:uiIcons.eraser,action:"confirmClear",value:current.id,small:true,variant:"ghost",disabled:busy||running,tooltip:running?"Cancel the running turn first":"Delete this agent’s history and start a fresh provider session"},
        {type:"button",key:"remove",text:"Remove",iconSvg:uiIcons.trash,action:"confirmRemove",value:current.id,small:true,variant:"ghost",disabled:busy,tooltip:`Stop and delete ${current.name}`},
      ]});
    }
    if(confirming) {
      const target=rows.find(s=>s.id===confirming!.id);
      if(target)children.push({type:"modal",key:"confirm",title:confirming.action==="remove"?"Remove agent":"Clear session",closeAction:"dismiss",children:[
        label("confirm-text",confirming.action==="remove"
          ?`Remove “${target.name}”? It is stopped and its conversation history is deleted. Files it changed are kept.`
          :`Clear “${target.name}”? Its conversation history is deleted and the next prompt starts a fresh provider session with the same settings.`),
        {type:"row",key:"confirm-buttons",gap:4,children:[
          {type:"button",key:"confirm-yes",text:confirming.action==="remove"?"Remove":"Clear session",action:confirming.action,value:target.id,variant:"danger",small:true,disabled:busy},
          button("confirm-no","Cancel","dismiss"),
        ]},
      ]});
    }
  }
  if(creating&&catalog&&ws)children.push(editorWindow());
  return {type:"column",key:"agents-root",padding:8,gap:8,grow:true,children};
 },
 async onEvent(ctx,ev) {
  const value=String(ev.value||"");
  if(ev.action==="filter"){filter=value;ctx.ui.invalidate();return;}
  if(ev.action==="toggleWorkflow"){showWorkflow=!showWorkflow;if(!showWorkflow&&isWorkflowAgent(rows.find(s=>s.id===selected)))selected=null;ctx.ui.invalidate();return;}
  if(ev.action==="name"){name=value;return;}
  if(ev.action==="provider"){profile=value;return;}
  if(ev.action==="agentFile"){agentFile=value;return;}
  if(ev.action==="moveEditor") {
    const g:any=ev.value;
    if(g&&["x","y","width","height"].every(k=>Number.isFinite(g[k]))) {
      editor={x:g.x,y:g.y,width:g.width,height:g.height};
      ctx.ui.invalidate();
    }
    return;
  }
  if(ev.action==="skill"||ev.action==="mcp") {const set=ev.action==="skill"?skills:mcps;const id=ev.key.slice(ev.key.indexOf(":")+1);if(set.has(id))set.delete(id);else set.add(id);ctx.ui.invalidate();return;}
  if(busy)return;
  const mine=epoch,workspaceId=ws?.id;
  const actionCall=async(method:string,args:any={})=>{
    const result=await ctx.modules.call("persistent-agents",method,{workspaceId,...args},{timeoutMs:240000});
    if(mine!==epoch)throw new Error("Workspace changed");return result;
  };
  busy=true;error=null;ctx.ui.invalidate();
  try {
    if(ev.action==="new") {catalog=await actionCall("catalog");creating=true;editing=null;name="";profile=catalog.profiles[0]?.id||"";agentFile="";skills=new Set();mcps=new Set(["internal-remote-mcp"]);}
    else if(ev.action==="edit") {
      const s=rows.find(r=>r.id===value);if(!s)throw new Error("Agent is no longer available");
      catalog=await actionCall("catalog");if(mine!==epoch)return;
      editing=s.id;creating=true;name=s.name;profile=s.profile.id;agentFile=s.agentFile||"";skills=new Set(s.skills);
      mcps=new Set([...(s.workspaceMcp?["internal-remote-mcp"]:[]),...s.mcps.map(m=>m.id)]);
    }
    else if(ev.action==="save"&&editing) {
      await actionCall("update",{id:editing,name:ev.inputs["agent-name"]||name,profileId:profile,agentFile,skills:[...skills],mcps:[...mcps]});
      if(mine!==epoch)return;creating=false;editing=null;
    }
    else if(ev.action==="back"){creating=false;editing=null;}
    else if(ev.action==="confirmClear"||ev.action==="confirmRemove"){confirming={action:ev.action==="confirmClear"?"clear":"remove",id:value};}
    else if(ev.action==="dismiss"){confirming=null;}
    else if(ev.action==="clear"){confirming=null;await actionCall("clear",{id:value});ctx.events.emit("agents-panel.agentCleared",{workspaceId,id:value});}
    else if(ev.action==="remove"){confirming=null;await actionCall("remove",{id:value});if(selected===value)selected=null;ctx.events.emit("agents-panel.agentRemoved",{workspaceId,id:value});}
    else if(ev.action==="create") {const s=await actionCall("create",{name:ev.inputs["agent-name"]||name||"Agent",profileId:profile,agentFile,skills:[...skills],mcps:[...mcps]});if(mine!==epoch)return;selected=s.id;creating=false;ctx.events.emit("agents-panel.openChat",{workspaceId,id:s.id});}
    else if(ev.action==="open"){selected=ev.rowKey||value;ctx.events.emit("agents-panel.openChat",{workspaceId,id:selected});}
    if(mine===epoch)await refresh(ctx,true);
  }catch(e){if(mine===epoch)error=errMsg(e);}
  finally{if(mine===epoch)busy=false;ctx.ui.invalidate();}
 },
};export default mod;
