// ai: ACP chat panel. Layout and control handlers only; conversation state lives in ai-sessions,
// protocol in acp, and approval authority in the kernel's native chrome.
import { CHAT_MESSAGE_LIMIT, CHAT_HISTORY_LIMIT, messageWindow } from "../../../../sdk/chat-window";
import { contextUsage, usagePieSvg } from "../../../../sdk/context-usage";
import { chatStyle } from "../../../../sdk/chat-style";
import { followKey, transcriptItems } from "../../../../sdk/chat-transcript";
import { uiIcons } from "../../../../sdk/ui-icons";
import { imageAttachments } from "../../../../sdk/images";
import type { AppModule, ModuleContext, UiNode, ImageAttachment } from "../../../../sdk/types";
import { debounce, errMsg } from "../../../../sdk/runtime";
import { resolveWorkspaceLink } from "../../../../sdk/links";

import type { AgentView } from "../../../../sdk/persistent-agents";
let background:{workspaceId:string;id:string}|null=null;
let backgroundPage:AgentView|null=null;
let backgroundTimer:ReturnType<typeof setInterval>|null=null;
let normalDraft:string|undefined;
let normalAttachments:ImageAttachment[]=[];
const backgroundDrafts=new Map<string,string>();
const requests=new Map<string,{resolve:(value:any)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
function persistent(ctx:ModuleContext,method:string,args:any={}) {
  const selection=background;
  if(!selection)return Promise.reject(new Error("No background session selected"));
  const requestId=crypto.randomUUID();
  return new Promise<any>((resolve,reject)=>{
    const timer=setTimeout(()=>{requests.delete(requestId);reject(new Error("Background session request timed out"));},240000);
    requests.set(requestId,{resolve,reject,timer});
    ctx.events.emit("ai.persistentRequest",{requestId,method,args:{...selection,...args}});
  });
}
function resetChatWindows(){historyBefore=[];historyLimit=CHAT_MESSAGE_LIMIT;settingsOpen=false;modelsOpen=false;historyOpen=false;mcpOpen=false;skillsOpen=false;error=null;}
function publishSession(ctx:ModuleContext){ctx.state.set("ai.session",background?{kind:"background",...background}:{kind:"chat"});}
async function openBackground(ctx:ModuleContext,selection:any) {
  if(!ws||selection?.workspaceId!==ws.id||typeof selection.id!=="string")return;
  if(background)backgroundDrafts.set(background.id,draft||"");
  else {normalDraft=draft;normalAttachments=attachments;}
  background={workspaceId:selection.workspaceId,id:selection.id};backgroundPage=null;view=null;
  draft=backgroundDrafts.get(selection.id)||"";attachments=[];resetChatWindows();publishSession(ctx);
  if(backgroundTimer)clearInterval(backgroundTimer);
  backgroundTimer=setInterval(()=>{void load(ctx);},1500);
  ctx.events.emit("ai.chatOpened",{});await load(ctx);
}
function leaveBackground(ctx:ModuleContext) {
  if(background)backgroundDrafts.set(background.id,draft||"");
  background=null;backgroundPage=null;view=null;draft=normalDraft;attachments=normalAttachments;
  if(backgroundTimer)clearInterval(backgroundTimer);backgroundTimer=null;resetChatWindows();publishSession(ctx);
}
let ws: any = null;
let view: any = null;
let error: string | null = null;
let busy: string | null = null;
let settingsOpen = false;
let mcpOpen = false;
let modelsOpen = false;
let historyOpen = false;
let historyConversationId: string | null = null;
let historyBefore: string[] = [];
let pagingHistory = false;
let historyLimit = CHAT_MESSAGE_LIMIT;
let preserveHistoryScroll = false;
let historyScrollReset = 0;
let skillsOpen = false;
let modelQuery = "";
let workspaceSkillState: any = null;
let attachments: ImageAttachment[] = [];
const connectionAttempts = new Set<string>();
let draft: string | undefined = undefined;
let refresh: () => void = () => {};
// ACP adapter install/update window
let adaptersOpen = false;
let adapters: any[] | null = null;
let adaptersBusy: string | null = null;
let adaptersMsg: { level: "success" | "error"; text: string } | null = null;

async function loadAdapters(ctx: ModuleContext) {
  if (!ws) return;
  adaptersBusy = "check"; ctx.ui.invalidate();
  try { adapters = await ctx.modules.call("ai-sessions", "adapters", { workspaceId: ws.id }, { timeoutMs: 300000 }); }
  catch (e) { adaptersMsg = { level: "error", text: errMsg(e) }; }
  finally { adaptersBusy = null; ctx.ui.invalidate(); }
}

function adapterWindow(): UiNode {
  const rows: UiNode[] = (adapters || []).map((a: any) => {
    const upToDate = a.installed && a.latest && a.installed === a.latest;
    const label = !a.installed ? "Install" : upToDate ? "Reinstall" : "Update";
    const status = a.error ? a.error : !a.installed ? `not installed · latest ${a.latest || "?"}` : `installed ${a.installed}${a.latest ? upToDate ? " · up to date" : ` · update available: ${a.latest}` : ""}`;
    return { type: "row", key: "ad-" + a.id, gap: 8, align: "center", border: true, padding: 6, children: [
      { type: "column", key: "info", grow: true, gap: 2, children: [
        { type: "label", key: "n", text: a.name, weight: "bold", size: "sm" },
        { type: "label", key: "p", text: `${a.pkg}${a.path ? " → " + a.path : ""}`, size: "xs", color: "muted" },
        { type: "label", key: "s", text: status, size: "xs", color: a.error ? "danger" : upToDate ? "success" : a.installed ? "warning" : "muted", wrap: true },
      ] },
      { type: "button", key: "b", text: adaptersBusy === a.id ? "Working…" : label, action: "installAdapter", value: a.id, small: true, variant: upToDate ? "default" : "primary", disabled: !!adaptersBusy },
    ] } as UiNode;
  });
  return { type: "modal", key: "adapters-modal", title: `ACP adapters on ${ws ? ws.machineId : "?"}`, closeAction: "closeAdapters", children: [
    { type: "label", key: "hint", text: "Agents run on the workspace's machine. Install or update an adapter there with npm (you will be asked to confirm). Authenticate it afterwards (e.g. `claude` login or `codex login`).", size: "xs", color: "muted", wrap: true },
    ...(adaptersMsg ? [{ type: "status", key: "msg", text: adaptersMsg.text, level: adaptersMsg.level } as UiNode] : []),
    ...(adaptersBusy ? [{ type: "progress", key: "busy", indeterminate: true, label: adaptersBusy === "check" ? "Checking installed and latest versions…" : `Installing ${adaptersBusy}… (npm install -g)` } as UiNode] : []),
    ...(adapters ? rows : []),
    { type: "row", key: "foot", gap: 6, children: [
      { type: "spacer", key: "sp" },
      { type: "button", key: "recheck", text: "Check versions", action: "checkAdapters", small: true, disabled: !!adaptersBusy },
      { type: "button", key: "close", text: "Close", action: "closeAdapters", small: true },
    ] },
  ] };
}

async function load(ctx: ModuleContext) {
  if (!ws) { view = null; ctx.ui.invalidate(); return; }
  if(background) {
    const selection=background;
    try {
      const page:AgentView=await persistent(ctx,"view",{limit:Math.min(historyLimit,200),before:Number(historyBefore[historyBefore.length-1])||undefined});
      if(background!==selection||ws?.id!==selection.workspaceId)return;
      backgroundPage=page;
      const session=page.session;
      view={profiles:[session.profile],conversations:[],activeId:session.id,active:{
        conversation:{id:session.id,title:session.name,acpProfileId:session.profile.id,status:session.status,approvalPolicy:"ask",mcpSelection:session.mcps.map(m=>m.id)},
        live:{...session,profileId:session.profile.id},messages:page.messages,windowed:true,hasOlder:page.before!==null,hasLoadedOlder:false,hasNewer:historyBefore.length>0,
        busy:["busy","waiting"].includes(session.status),steering:page.queued.length,
      }};
      error=null;
    }catch(e){if(background===selection)error=errMsg(e);}
    ctx.ui.invalidate();return;
  }
  try {
    const workspaceId = ws.id;
    const next = await ctx.modules.call("ai-sessions", "view", { workspaceId, messageLimit: historyLimit,
      windowConversationId: historyConversationId, beforeMessageId: historyBefore[historyBefore.length - 1] });
    if (ws?.id !== workspaceId || background) return;
    if (historyConversationId !== next.active?.conversation?.id) { historyBefore = []; historyLimit = CHAT_MESSAGE_LIMIT; preserveHistoryScroll = false; historyConversationId = next.active?.conversation?.id || null; }
    view = next; error = null;
    const active = view.active;
    if (active && !connectionAttempts.has(active.conversation.id)) {
      const id = active.conversation.id;
      connectionAttempts.add(id);
      if (!active.live || !["ready", "busy", "starting", "connecting"].includes(active.live.status)) {
        ctx.ui.invalidate();
        await ctx.modules.call("ai-sessions", "connect", { conversationId: id }, { timeoutMs: 600000 });
        if(ws?.id===workspaceId&&!background) {
          const resumed=await ctx.modules.call("ai-sessions","view",{workspaceId,messageLimit:historyLimit,windowConversationId:historyConversationId,beforeMessageId:historyBefore[historyBefore.length-1]});
          if(ws?.id===workspaceId&&!background)view=resumed;
        }
      }
    }
  }
  catch (e) { error = errMsg(e); }
  ctx.ui.invalidate();
}

const POLICIES = [
  { value: "ask", label: "Ask (default)" },
  { value: "auto-low", label: "Auto-approve low-risk" },
  { value: "autopilot", label: "Autopilot (explicit opt-in)" },
];

function flattenOptions(o: any): { value: string; label: string }[] {
  const out: { value: string; label: string }[] = [];
  for (const x of o.options || []) {
    if (Array.isArray(x.options)) for (const y of x.options) out.push({ value: String(y.value), label: `${x.name || x.group}: ${y.name}` });
    else out.push({ value: String(x.value), label: x.name || String(x.value) });
  }
  return out;
}

function selectors(live: any, connected: boolean): UiNode[] {
  const out: UiNode[] = [];
  const reason = connected ? "not advertised by this agent" : "connect to read the agent's advertised options";
  const opts: any[] = live && Array.isArray(live.configOptions) ? live.configOptions : [];
  const byCat = (cat: string) => opts.filter((o) => o.category === cat && o.type !== "boolean");
  const sel = (key: string, label: string, o: any): UiNode => ({ type: "select", key, label, options: flattenOptions(o), value: o.currentValue === undefined ? null : String(o.currentValue), action: "setConfig:" + o.id, placeholder: "—" });
  const disabled = (key: string, label: string, why = reason): UiNode => ({ type: "select", key, label, options: [], value: null, action: "noop", disabled: true, placeholder: "n/a", disabledReason: why, tooltip: why });
  const model = byCat("model")[0];
  if (model) out.push(sel("cfg-model", "Model", model));
  else if (live && live.models && live.models.availableModels) out.push({ type: "select", key: "cfg-model", label: "Model", options: live.models.availableModels.map((m: any) => ({ value: m.modelId, label: m.name || m.modelId })), value: live.models.currentModelId, action: "setConfig:__model" });
  else out.push(disabled("cfg-model", "Model"));
  const thought = byCat("thought_level")[0];
  out.push(thought ? sel("cfg-reasoning", "Reasoning effort", thought) : disabled("cfg-reasoning", "Reasoning effort"));
  const mode = byCat("mode")[0];
  if (mode) out.push(sel("cfg-mode", "Collaboration mode", mode));
  else if (live && live.modes && live.modes.availableModes) out.push({ type: "select", key: "cfg-mode", label: "Mode", options: live.modes.availableModes.map((m: any) => ({ value: m.id, label: m.name || m.id })), value: live.modes.currentModeId, action: "setConfig:__mode" });
  else out.push(disabled("cfg-mode", "Mode"));
  for (const o of opts.filter((o) => !["model", "thought_level", "mode"].includes(o.category) && o.type !== "boolean")) out.push(sel("cfg-" + o.id, o.name || o.id, o));
  for (const o of opts.filter((o) => o.type === "boolean")) out.push({ type: "toggle", key: "cfg-" + o.id, label: o.name || o.id, checked: !!o.currentValue, action: "setConfig:" + o.id, tooltip: o.description });
  return out;
}

function visibleHistory(active: any) {
  const window = messageWindow<any>(active?.messages || [], historyLimit,
    active?.windowed ? undefined : historyBefore[historyBefore.length - 1]);
  return { messages: window.messages, hasOlder: !!active?.hasOlder || window.hasLoadedOlder,
    hasLoadedOlder: window.hasLoadedOlder || !!(active?.windowed && active.hasLoadedOlder),
    hasNewer: active?.windowed ? !!active.hasNewer : window.hasNewer };
}

const mod: AppModule = {
  id: "ai",
  moduleApiVersion: 1,
  async activate(ctx, prev) {
    if (prev?.attachments) attachments = imageAttachments(prev.attachments);
    if (prev && typeof prev.draft === "string") draft = prev.draft;
    refresh = debounce(() => load(ctx), 40);
    ws = ctx.state.get("workspace.selected") || null;
    workspaceSkillState = ctx.state.get("files.skills") || null;
    ctx.state.watch("files.skills", (value: any) => { workspaceSkillState = value; ctx.ui.invalidate(); });
    ctx.state.watch("workspace.selected", (v: any) => { const changed = ws?.id !== v?.id; ws = v; if(changed){if(background)leaveBackground(ctx);void load(ctx);} });
    ctx.events.on("persistent-agents.chatResponse",(response:any)=>{
      const pending=requests.get(response?.requestId);if(!pending)return;
      requests.delete(response.requestId);clearTimeout(pending.timer);
      if(response.error)pending.reject(new Error(response.error));else pending.resolve(response.value);
    });
    ctx.events.on("agents-panel.openChat",(selection:any)=>{void openBackground(ctx,selection);});
    ctx.events.on("ai-sessions.changed", () => refresh());
    ctx.events.on("acp.status", () => refresh());
    ctx.events.on("acp.adaptersChanged", () => { if (adaptersOpen) loadAdapters(ctx); });
    ctx.events.on("acp.authChanged", () => refresh());
    if(prev?.background&&prev.background.workspaceId===ws?.id) {
      normalDraft=prev.normalDraft;normalAttachments=prev.normalAttachments||[];
      await openBackground(ctx,prev.background);
      normalDraft=prev.normalDraft;normalAttachments=prev.normalAttachments||[];
      draft=prev.draft||"";
    }else await load(ctx);
  },
  deactivate(){if(backgroundTimer)clearInterval(backgroundTimer);backgroundTimer=null;for(const p of requests.values()){clearTimeout(p.timer);p.reject(new Error("Chat module reloaded"));}requests.clear();},
  snapshot: () => background ? ({ draft, attachments, background, normalDraft, normalAttachments }) : ({draft,attachments}),
  render(): UiNode {
    const active = view?.active;
    const conv = active?.conversation;
    const live = active?.live;
    const context = contextUsage(live?.usage);
    const connected = !!live && ["ready", "busy", ...(background?["waiting"]:[])].includes(live.status);
    const profile = view?.profiles.find((p: any) => p.id === conv?.acpProfileId);
    const providerName = profile?.name?.replace(/\s*\([^)]*\)$/, "") || "Agent";
    const skillState = workspaceSkillState?.workspaceId === ws?.id ? workspaceSkillState : null;
    const skills: { name: string; description: string; path: string }[] = skillState?.skills || [];
    const config = selectors(live, connected);
    const model = config.find((n) => n.key === "cfg-model") as Extract<UiNode, { type: "select" }>;
    const modelName = model.options.find((o) => o.value === model.value)?.label || (connected ? "Choose model" : "Connect to choose");
    const modelOption = (live?.configOptions || []).find((o: any) => o.category === "model");
    const advertised = (modelOption?.options || []).flatMap((o: any) => o.options || [o]);
    const modelDetails = (id: string) => advertised.find((o: any) => String(o.value) === id) || live?.models?.availableModels?.find((o: any) => o.modelId === id);
    const iconButton = (key: string, icon: "sliders-horizontal" | "message-square" | "plus" | "x", action: string, tooltip: string): UiNode => ({ type: "button", key, text: "", iconSvg: uiIcons[icon], action, tooltip, style: chatStyle.iconControl, disabled: !ws });
    const header: UiNode = { type: "row", key: "hdr", style: chatStyle.toolbar, padding: 8, gap: 6, align: "center", children: [
      { type: "column", key: "provider-field", grow: true, minWidth: 100, gap: 0, children: [
        { type: "select", key: "agent", buttonStyle: chatStyle.fieldControl, tooltip: "Provider", options: (view?.profiles || []).map((p: any) => ({ value: p.id, label: p.name.replace(/\s*\([^)]*\)$/, "") })), value: conv?.acpProfileId || null, action: "setProfile", disabled: !conv || !!background, placeholder: "Choose provider", grow: true },
      ] },
      { type: "column", key: "model-field", grow: true, minWidth: 100, gap: 0, children: [
        { type: "button", key: "cfg-model", style: { ...chatStyle.control, fullWidth: true }, text: modelName + "  ⌄", action: "toggleModels", disabled: model.disabled, tooltip: "Choose model", grow: true },
      ] },
      { type: "switch", key: "auto", style: { radius: 8, color: "muted" }, label: "Auto", checked: conv?.approvalPolicy === "autopilot", action: "toggleAuto", disabled: !conv, tooltip: "Automatically approve agent tool permissions. Module changes still require native approval." },
      iconButton("settings-toggle", "sliders-horizontal", "toggleSettings", "Agent settings"),
      iconButton("new", "plus", "newChat", "New chat"),
      iconButton("history-toggle", "message-square", "toggleHistory", "Chat history"),
    ] };
    if(background)header.children=header.children.filter(n=>!["auto","new","history-toggle"].includes(n.key));
    const kids: UiNode[] = [header];
    if(background) {
      kids.push({type:"row",key:"background-session",padding:8,gap:6,children:[
        {type:"label",key:"name",text:conv?.title||"Background agent",grow:true,weight:"semibold"},
        {type:"button",key:"back-to-chats",text:"Chats",action:"backToChats",small:true,variant:"ghost"},
        {type:"button",key:"stop-agent",text:"Stop agent",action:"stopBackground",small:true,variant:"ghost"},
      ]});
      if(live&&["stopped","interrupted","error"].includes(live.status))kids.push({type:"button",key:"reconnect-background",text:"Reconnect saved agent",action:"reconnect",small:true});
      for(const permission of backgroundPage?.permissions||[])kids.push({type:"button",key:permission.id,text:"Review: "+(permission.request.toolCall?.title||"Agent permission"),action:"reviewBackgroundPermission",value:permission.id,small:true});
    }
    if (!ws) kids.push({ type: "label", key: "none", text: "Select a project or task to start chatting.", color: "muted", padding: 16, wrap: true });
    else if (!view) kids.push({ type: "progress", key: "ld", indeterminate: true });
    if (error) kids.push({ type: "status", key: "err", text: error, level: "error" });
    if (live?.error && !connected) kids.push({ type: "status", key: "liveerr", text: live.error, level: "error" });
    if (adaptersOpen && ws) kids.push(adapterWindow());
    if (historyOpen && view) kids.push({ type: "modal", key: "history", title: "Chat history", closeAction: "toggleHistory", children: [
      { type: "button", key: "new-chat", text: "New chat", iconSvg: uiIcons.plus, action: "newChat", style: chatStyle.control },
      ...view.conversations.map((c: any): UiNode => ({ type: "button", key: c.id, text: (c.id === view.activeId ? "✓ " : "") + c.title, action: "selectConv", value: c.id, variant: "ghost", style: chatStyle.result })),
    ] });
    if (conv) {
      if(settingsOpen&&background&&backgroundPage) {
        const session=backgroundPage.session;
        kids.push({type:"column",key:"settings",padding:12,gap:8,children:[
          {type:"label",key:"workspace",text:session.workspaceName+" · "+session.machineId},
          {type:"label",key:"instructions",text:"Instructions: "+(session.agentFile||"None"),wrap:true},
          {type:"label",key:"skills",text:"Skills: "+(session.skills.join(", ")||"None"),wrap:true},
          {type:"label",key:"mcp",text:"MCP: "+[...(session.workspaceMcp?["Workspace tools"]:[]),...session.mcps.map(m=>m.name)].join(", "),wrap:true},
        ]});
      } else if (settingsOpen) {
        const fields: UiNode[] = [
          { type: "row", key: "heading", gap: 8, children: [
            { type: "label", key: "title", text: providerName + " settings", weight: "bold", grow: true },
            iconButton("close", "x", "toggleSettings", "Close settings"),
          ] },
          { type: "divider", key: "divider" },
          ...(modelDetails(model.value || "")?.description ? [{ type: "label", key: "model-description", text: modelDetails(model.value || "").description, wrap: true, color: "muted" } as UiNode] : []),
        ];
        for (const field of config.filter((n) => n.key !== "cfg-model")) {
          const option = (live?.configOptions || []).find((o: any) => "cfg-" + o.id === field.key);
          if (field.type === "select") {
            fields.push({ type: "label", key: field.key + "-label", text: field.label || "Option", color: "muted" });
            fields.push({ ...field, label: undefined, buttonStyle: chatStyle.fieldControl } as UiNode);
          } else fields.push(field);
          if (option?.description) fields.push({ type: "label", key: field.key + "-hint", text: option.description, size: "sm", color: "muted", wrap: true });
        }
        fields.push({ type: "select", key: "policy", label: "Approval policy", options: POLICIES, value: conv.approvalPolicy, action: "setPolicy", buttonStyle: chatStyle.fieldControl });
        if (profile?.provider === "claude") fields.push({ type: "toggle", key: "claude-sub", label: "Use Claude subscription", checked: view.auth?.claudeSubscription !== false, action: "toggleClaudeSub", tooltip: "Uses your Claude login instead of the shell API key. Applies on reconnect." });
        fields.push({ type: "label", key: "loc", text: `${live?.machineId || view.workspace.machineId} · ${view.workspace.root}`, size: "xs", color: "muted", wrap: true });
        fields.push({ type: "row", key: "connection", gap: 8, children: [
          { type: "button", key: "connect", text: connected ? "Disconnect" : "Connect", action: connected ? "disconnect" : "connect", style: chatStyle.control },
          { type: "button", key: "adapters", text: "Manage agents…", action: "openAdapters", style: chatStyle.control },
        ] });
        kids.push({ type: "column", key: "settings", style: chatStyle.settings, grow: true, scroll: true, gap: 10, padding: 12, children: fields });
      } else {
        const history = visibleHistory(active);
        if (history.hasOlder || historyBefore.length || historyLimit > CHAT_MESSAGE_LIMIT) kids.push({ type: "row", key: "message-history", gap: 6, children: [
          { type: "button", key: "older-messages", text: pagingHistory ? "Loading…" : "Older", action: "revealOlder", small: true, variant: "ghost", disabled: pagingHistory || !history.hasOlder },
          { type: "label", key: "history-window", text: historyBefore.length ? "Older messages" : `Latest ${history.messages.length} messages`, size: "xs", color: "muted", grow: true },
          ...(historyBefore.length ? [{ type: "button", key: "newer-messages", text: "Newer", action: "revealNewer", small: true, variant: "ghost", disabled: pagingHistory } as UiNode] : []),
          ...(historyBefore.length || historyLimit > CHAT_MESSAGE_LIMIT ? [{ type: "button", key: "latest-messages", text: "Latest", action: "latestMessages", small: true, variant: "ghost", disabled: pagingHistory } as UiNode] : []),
        ] });
        if (active.historyError) kids.push({ type: "status", key: "history-error", text: active.historyError, level: "error" });
        const loadingOlder = pagingHistory || !!active.historyLoading;
        kids.push({ type: "transcript", key: "transcript", scrollKey: conv.id, followKey: followKey(history.messages),
          hasOlder: history.hasOlder, loadingOlder, loadOlderAction: "revealOlder",
          bottomAction: history.hasNewer ? "revealNewer" : historyLimit > CHAT_MESSAGE_LIMIT ? "collapseHistory" : undefined,
          preserveScrollOnChange: preserveHistoryScroll, scrollReset: historyScrollReset, grow: true,
          children: transcriptItems(history.messages, { agentLabel: providerName + (model.value ? " · " + modelName : ""), linkAction: "openLink",
            hasOlder: history.hasOlder, loadingOlder, historyError: active.historyError, loadOlderAction: "revealOlder" }) });
        const composer: UiNode[] = [];
        if (attachments.length) composer.push({ type: "row", key: "attachments", gap: 8, children: attachments.map((image, index): UiNode => ({ type: "column", key: "attachment-" + index, gap: 4, children: [
          { type: "image", key: "preview", image, width: 80, height: 64 },
          { type: "button", key: "remove", text: "× " + image.name, action: "removeImage", value: index, small: true, tooltip: "Remove picture" },
        ] })) });
        composer.push({ type: "textInput", key: "prompt", style: chatStyle.textarea, changeAction:"draftChanged", pasteImageAction: background?undefined:"attachImages", maxFiles: 4, maxBytes: 5 * 1024 * 1024, placeholder: active.busy ? "Steer " + providerName + "…" : "Ask " + providerName + "…", multiline: true, rows: 2, submitAction: "send", value: draft });
        if (mcpOpen) composer.push({ type: "column", key: "mcp-picker", gap: 8, padding: 12, border: true, children: [
          { type: "label", key: "title", text: "MCP servers", weight: "bold", size: "sm" },
          ...(view.mcpServers || [{ id: "internal", name: "Hato" }]).map((server: any): UiNode => ({ type: "toggle", key: "mcp-" + server.id, label: server.name, tooltip: server.description, checked: (conv.mcpSelection || []).includes(server.id), action: "toggleMcp:" + server.id })),
          { type: "button", key: "apply", text: "Reconnect to apply", action: "reconnect", small: true, disabled: active.busy },
        ] });
        if (skillsOpen) kids.push({ type: "column", key: "skills-picker", scroll: true, maxHeight: 220, padding: 12, gap: 8, border: true, children: skills.length ? skills.map((skill): UiNode => ({ type: "button", key: skill.path, text: skill.name + (skill.description ? " · " + skill.description : ""), tooltip: skill.path, action: "useSkill", value: skill.path, variant: "ghost", style: chatStyle.result })) : [{ type: "label", key: "none", text: skillState?.loading ? "Loading workspace skills…" : skillState?.error ? "Could not load workspace skills: " + skillState.error : "No workspace skills in .agents/skills.", color: "muted", wrap: true }] });
        composer.push({ type: "row", key: "act", gap: 6, children: [
          { type: "imagePicker", key: "attach", action: "attachImages", iconSvg: uiIcons.paperclip, style: chatStyle.attach, maxFiles: 4, maxBytes: 5 * 1024 * 1024,
            dialogTitle: "Attach pictures", tooltip: "Attach pictures (PNG, JPEG, WebP or GIF)", disabled: busy === "send" },
          { type: "button", key: "mcp-toggle", text: "MCP", action: "toggleMcpPicker", style: chatStyle.control, tooltip: "MCP servers" },
          { type: "button", key: "skills-toggle", text: "Skills " + skills.length, iconSvg: uiIcons["graduation-cap"], action: "toggleSkills", style: chatStyle.control },
          { type: "label", key: "chat-status", grow: true, text: active.steering ? "Steering…" : active.busy ? "Working…" : connected ? "" : live?.status || conv.status || "Offline", size: "xs", color: "muted", tooltip: `${providerName} · ${live?.status || conv.status || "offline"}` },
          { type: "button", key: "context-usage", text: context.value === null ? "—" : `${Math.round(context.value * 100)}%`, iconSvg: usagePieSvg(context.value), iconSize: 18,
            action: "", variant: "ghost", small: true, tooltip: context.tooltip, style: { height: 32, paddingX: 4, gap: 4, noShrink: true, color: "muted" } },
          ...(active.busy ? [{ type: "button", key: "cancel", text: "Stop", action: "cancel", style: chatStyle.control } as UiNode] : []),
          { type: "button", key: "send", text: "", iconSvg: uiIcons.send, action: "send", style: chatStyle.iconPrimary, variant: "primary", disabled: busy === "send", tooltip: active.busy ? "Steer agent" : "Send message" },
        ] });
        if(background){const actions=composer.find(n=>n.key==="act");if(actions&&"children" in actions)actions.children=(actions.children||[]).filter(n=>!["attach","mcp-toggle","skills-toggle","context-usage"].includes(n.key));}
        kids.push({ type: "column", key: "composer", style: chatStyle.composer, gap: 6, padding: 8, children: composer });
      }
      if (modelsOpen) {
        const filtered = model.options.filter((o) => `${o.label} ${modelDetails(o.value)?.description || ""}`.toLowerCase().includes(modelQuery.toLowerCase()));
        kids.push({ type: "popover", key: "model-picker", closeAction: "toggleModels", style: chatStyle.picker, children: [
          { type: "row", key: "search-row", gap: 8, padding: 10, children: [
            { type: "textInput", key: "model-search", value: modelQuery, placeholder: "Search models", changeAction: "searchModels", grow: true },
            iconButton("close", "x", "toggleModels", "Close models"),
          ] },
          { type: "divider", key: "divider" },
          { type: "column", key: "results", scroll: true, grow: true, gap: 3, padding: 6, children: filtered.length ? filtered.map((o): UiNode => ({
            type: "choice", key: o.value, text: o.label, description: modelDetails(o.value)?.description, selected: o.value === model.value, action: "chooseModel", value: o.value,
          })) : [{ type: "label", key: "none", text: "No matching models", padding: 16, color: "muted" }] },
          { type: "label", key: "model-count", text: `${filtered.length} model${filtered.length === 1 ? "" : "s"} available`, size: "xs", color: "muted", padding: 10 },
        ] });
      }
    } else if (ws && view) kids.push({ type: "column", key: "empty", padding: 24, gap: 12, grow: true, children: [
      { type: "label", key: "title", text: "Start a conversation", size: "lg", weight: "bold" },
      { type: "label", key: "hint", text: "Ask your agent to build, explore or fix something in this workspace.", wrap: true, color: "muted" },
      { type: "button", key: "start", text: "New chat", iconSvg: uiIcons.plus, action: "newChat", style: chatStyle.primary, variant: "primary" },
    ] });
    return { type: "column", key: "ai-root", style: chatStyle.root, gap: 0, grow: true, children: kids };
  },
  async onEvent(ctx, ev) {
    if(ev.action==="draftChanged"){draft=String(ev.value||"");ctx.ui.invalidate();return;}
    if(ev.action==="backToChats"){leaveBackground(ctx);await load(ctx);return;}
    if(background && !["toggleModels","searchModels","toggleSettings","openLink"].includes(ev.action)) {
      const selection=background;
      let actionError:string|null=null;
      try {
        if(ev.action==="send") {
          const text=(ev.inputs.prompt||draft||"").trim();if(!text||busy==="send")return;
          busy="send";ctx.ui.invalidate();await persistent(ctx,"send",{text,steer:!!view?.active?.busy});
          if(background===selection){draft="";historyBefore=[];historyLimit=CHAT_MESSAGE_LIMIT;}
        }else if(ev.action==="chooseModel") {await persistent(ctx,"setModel",{model:ev.value});modelsOpen=false;}
        else if(ev.action==="cancel")await persistent(ctx,"cancel");
        else if(ev.action==="stopBackground")await persistent(ctx,"stop");
        else if(ev.action==="reconnect"||ev.action==="connect")await persistent(ctx,"reconnect");
        else if(ev.action==="reviewBackgroundPermission")await persistent(ctx,"reviewPermission",{permissionId:ev.value});
        else if(["revealOlder","loadOlder","olderMessages"].includes(ev.action)) {
          if(historyLimit<200)historyLimit=Math.min(200,historyLimit+CHAT_MESSAGE_LIMIT);
          else if(backgroundPage?.before)historyBefore.push(String(backgroundPage.before));
          preserveHistoryScroll=true;
        }else if(["revealNewer","newerMessages"].includes(ev.action)){historyBefore.pop();preserveHistoryScroll=true;}
        else if(["latestMessages","collapseHistory"].includes(ev.action)){historyBefore=[];historyLimit=CHAT_MESSAGE_LIMIT;preserveHistoryScroll=false;historyScrollReset++;}
        error=null;
      }catch(e){actionError=errMsg(e);}
      finally{busy=null;if(background===selection){await load(ctx);if(actionError)error=actionError;}ctx.ui.invalidate();}
      return;
    }
    const conv = view && view.active ? view.active.conversation : null;
    const call = (m: string, args: any, timeoutMs = 120000) => ctx.modules.call("ai-sessions", m, args, { timeoutMs });
    try {
      if (ev.action === "openLink") {
        const path = ws && resolveWorkspaceLink(String(ev.value || ""), ws.rootAbsolutePath);
        if (!path) throw new Error(`Cannot open link outside the workspace: ${ev.value}`);
        await ctx.modules.call("workspace", "view.patch", { workspaceId: ws.id, patch: { previewPath: path } });
        return;
      }
      if (ev.action === "toggleModels") { modelsOpen = !modelsOpen; modelQuery = ""; ctx.ui.invalidate(); return; }
      if (ev.action === "searchModels") { modelQuery = String(ev.value || ""); ctx.ui.invalidate(); return; }
      if (ev.action === "toggleHistory") { historyOpen = !historyOpen; ctx.ui.invalidate(); return; }
      if (ev.action === "toggleSkills") { skillsOpen = !skillsOpen; mcpOpen = false; if (skillsOpen) ctx.events.emit("ai.skillsRequested", {}); ctx.ui.invalidate(); return; }
      if (ev.action === "useSkill") {
        const skill = workspaceSkillState?.workspaceId === ws?.id && workspaceSkillState.skills?.find((s: any) => s.path === ev.value);
        if (!skill) return;
        draft = `Use the workspace skill at ${skill.path}.\n` + (ev.inputs.prompt || draft || "");
        skillsOpen = false; ctx.ui.invalidate(); return;
      }
      if (ev.action === "chooseModel" && conv) {
        const model = selectors(view.active.live, true).find((n) => n.key === "cfg-model") as Extract<UiNode, { type: "select" }>;
        await call("setConfig", { conversationId: conv.id, configId: model.action.slice(10), value: ev.value });
        modelsOpen = false; return;
      }
      if (ev.action === "attachImages") {
        const result = ev.value as any;
        if (result?.error) throw new Error(result.error);
        attachments = imageAttachments([...attachments, ...imageAttachments(result)]);
        ctx.ui.invalidate(); return;
      }
      if (ev.action === "removeImage") { attachments.splice(Number(ev.value), 1); ctx.ui.invalidate(); return; }
      if (ev.action === "toggleMcpPicker") { mcpOpen = !mcpOpen; skillsOpen = false; ctx.ui.invalidate(); return; }
      if (ev.action === "toggleSettings") { settingsOpen = !settingsOpen; ctx.ui.invalidate(); return; }
      if (ev.action === "openAdapters" && ws) { adaptersOpen = true; adaptersMsg = null; await loadAdapters(ctx); return; }
      if (ev.action === "closeAdapters") { adaptersOpen = false; return; }
      if (ev.action === "checkAdapters") { adaptersMsg = null; await loadAdapters(ctx); return; }
      if (ev.action === "installAdapter" && ws) {
        adaptersBusy = String(ev.value); adaptersMsg = null; ctx.ui.invalidate();
        try {
          const r = await call("installAdapter", { workspaceId: ws.id, adapterId: ev.value }, 17 * 60 * 1000);
          adaptersMsg = { level: "success", text: `✓ ${r.adapterId} installed/updated on ${r.machineId}` };
        } catch (e) { adaptersMsg = { level: "error", text: errMsg(e) }; }
        adaptersBusy = null;
        await loadAdapters(ctx);
        return;
      }
      if (ev.action === "toggleClaudeSub") { await ctx.modules.call("acp", "setAuthSettings", { claudeSubscription: !!ev.value }); return; }
      if (ev.action === "newChat" && ws) { await call("create", { workspaceId: ws.id, profileId: conv?.acpProfileId }); historyOpen = false; settingsOpen = false; modelsOpen = false; }
      else if (ev.action === "selectConv" && ws) { await call("select", { workspaceId: ws.id, conversationId: ev.value }); historyOpen = false; settingsOpen = false; modelsOpen = false; }
      else if (!conv) return;
      else if (ev.action === "olderMessages" || ev.action === "loadOlder" || ev.action === "revealOlder") {
        if (pagingHistory) return;
        const history = visibleHistory(view.active);
        if (!history.hasOlder || !history.messages.length) return;
        const first = history.messages[0].key, conversationId = conv.id;
        pagingHistory = true; ctx.ui.invalidate();
        try {
          if (!history.hasLoadedOlder) { const result = await call("loadOlder", { conversationId }); if (result?.loaded === 0) return; }
          if (historyConversationId === conversationId) {
            preserveHistoryScroll = true;
            if (ev.action === "revealOlder" && historyLimit < CHAT_HISTORY_LIMIT) historyLimit = Math.min(CHAT_HISTORY_LIMIT, historyLimit + CHAT_MESSAGE_LIMIT);
            else historyBefore.push(ev.action === "revealOlder" ? history.messages[Math.max(0, history.messages.length - CHAT_MESSAGE_LIMIT)].key : first);
          }
        } finally { pagingHistory = false; }
      }
      else if (ev.action === "newerMessages" || ev.action === "revealNewer") { historyBefore.pop(); preserveHistoryScroll = true; }
      else if (ev.action === "latestMessages" || ev.action === "collapseHistory") {
        historyBefore = []; historyLimit = CHAT_MESSAGE_LIMIT; preserveHistoryScroll = false; historyScrollReset++;
      }
      else if (ev.action === "connect") { busy = "connect"; ctx.ui.invalidate(); await call("connect", { conversationId: conv.id }, 600000); }
      else if (ev.action === "reconnect") { await call("disconnect", { conversationId: conv.id }); await call("connect", { conversationId: conv.id }, 600000); }
      else if (ev.action === "disconnect") await call("disconnect", { conversationId: conv.id });
      else if (ev.action === "setProfile") { await call("setProfile", { conversationId: conv.id, profileId: ev.value }); connectionAttempts.delete(conv.id); }
      else if (ev.action === "toggleAuto") await call("setPolicy", { conversationId: conv.id, policy: ev.value ? "autopilot" : "ask" });
      else if (ev.action === "setPolicy") await call("setPolicy", { conversationId: conv.id, policy: ev.value });
      else if (ev.action === "toggleMcp:internal") await call("setMcp", { conversationId: conv.id, internal: !!ev.value });
      else if (ev.action.startsWith("setConfig:")) await call("setConfig", { conversationId: conv.id, configId: ev.action.slice(10), value: ev.value });
      else if (ev.action === "cancel") await call("cancel", { conversationId: conv.id });
      else if (ev.action === "send") {
        historyBefore = []; historyLimit = CHAT_MESSAGE_LIMIT; preserveHistoryScroll = false; historyScrollReset++;
        const text = (ev.inputs.prompt || "").trim();
        if (!text && !attachments.length) return;
        if (busy === "send") return;
        busy = "send"; ctx.ui.invalidate();
        await call("send", { conversationId: conv.id, text, images: attachments }, 600000);
        attachments = [];
        draft = draft === "" ? " " : ""; // Clear only after the service accepts the message.
        ctx.ui.invalidate();
      }
      error = null;
    } catch (e) { error = errMsg(e); }
    finally { if (!["loadOlder", "olderMessages", "newerMessages", "latestMessages", "revealOlder", "revealNewer", "collapseHistory"].includes(ev.action)) busy = null; await load(ctx); }
  },
};
export default mod;
