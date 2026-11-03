// ai: ACP chat panel. Layout and control handlers only; conversation state lives in ai-sessions,
// protocol in acp, and approval authority in the kernel's native chrome.
import { contextUsage } from "../../../../sdk/context-usage";
import { imageAttachments } from "../../../../sdk/images";
import type { AppModule, ModuleContext, UiNode, ImageAttachment } from "../../../../sdk/types";
import { debounce, errMsg } from "../../../../sdk/runtime";

let ws: any = null;
let view: any = null;
let error: string | null = null;
let busy: string | null = null;
let settingsOpen = false;
let mcpOpen = false;
let modelsOpen = false;
let historyOpen = false;
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
  try {
    const workspaceId = ws.id;
    const next = await ctx.modules.call("ai-sessions", "view", { workspaceId });
    if (ws?.id !== workspaceId) return;
    view = next; error = null;
    const active = view.active;
    if (active && !connectionAttempts.has(active.conversation.id)) {
      const id = active.conversation.id;
      connectionAttempts.add(id);
      if (!active.live || !["ready", "busy", "starting", "connecting"].includes(active.live.status)) {
        ctx.ui.invalidate();
        await ctx.modules.call("ai-sessions", "connect", { conversationId: id }, { timeoutMs: 600000 });
        if (ws?.id === workspaceId) view = await ctx.modules.call("ai-sessions", "view", { workspaceId });
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
    ctx.state.watch("workspace.selected", (v: any) => { const changed = (ws && ws.id) !== (v && v.id); ws = v; if (changed) load(ctx); });
    ctx.events.on("ai-sessions.changed", () => refresh());
    ctx.events.on("acp.status", () => refresh());
    ctx.events.on("acp.adaptersChanged", () => { if (adaptersOpen) loadAdapters(ctx); });
    ctx.events.on("acp.authChanged", () => refresh());
    await load(ctx);
  },
  snapshot: () => ({ draft, attachments }),
  render(): UiNode {
    const active = view?.active;
    const conv = active?.conversation;
    const live = active?.live;
    const context = contextUsage(live?.usage);
    const connected = !!live && ["ready", "busy"].includes(live.status);
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
    const iconButton = (key: string, icon: "sliders-horizontal" | "message-square" | "plus" | "x", action: string, tooltip: string): UiNode => ({ type: "button", key, text: "", icon, action, tooltip, surface: "chat-control", disabled: !ws });
    const header: UiNode = { type: "row", key: "hdr", surface: "chat-toolbar", padding: 8, gap: 6, align: "center", children: [
      { type: "column", key: "provider-field", grow: true, minWidth: 100, gap: 0, children: [
        { type: "select", key: "agent", surface: "chat-control", tooltip: "Provider", options: (view?.profiles || []).map((p: any) => ({ value: p.id, label: p.name.replace(/\s*\([^)]*\)$/, "") })), value: conv?.acpProfileId || null, action: "setProfile", disabled: !conv, placeholder: "Choose provider", grow: true },
      ] },
      { type: "column", key: "model-field", grow: true, minWidth: 100, gap: 0, children: [
        { type: "button", key: "cfg-model", surface: "chat-control", text: modelName + "  ⌄", action: "toggleModels", disabled: model.disabled, tooltip: "Choose model", grow: true },
      ] },
      { type: "switch", key: "auto", surface: "chat-control", label: "Auto", checked: conv?.approvalPolicy === "autopilot", action: "toggleAuto", disabled: !conv, tooltip: "Automatically approve agent tool permissions. Module changes still require native approval." },
      iconButton("settings-toggle", "sliders-horizontal", "toggleSettings", "Agent settings"),
      iconButton("new", "plus", "newChat", "New chat"),
      iconButton("history-toggle", "message-square", "toggleHistory", "Chat history"),
    ] };
    const kids: UiNode[] = [header];
    if (!ws) kids.push({ type: "label", key: "none", text: "Select a project or task to start chatting.", color: "muted", padding: 16, wrap: true });
    else if (!view) kids.push({ type: "progress", key: "ld", indeterminate: true });
    if (error) kids.push({ type: "status", key: "err", text: error, level: "error" });
    if (live?.error && !connected) kids.push({ type: "status", key: "liveerr", text: live.error, level: "error" });
    if (adaptersOpen && ws) kids.push(adapterWindow());
    if (historyOpen && view) kids.push({ type: "modal", key: "history", title: "Chat history", closeAction: "toggleHistory", children: [
      { type: "button", key: "new-chat", text: "New chat", icon: "plus", action: "newChat", surface: "chat-control" },
      ...view.conversations.map((c: any): UiNode => ({ type: "button", key: c.id, text: (c.id === view.activeId ? "✓ " : "") + c.title, action: "selectConv", value: c.id, surface: "chat-result" })),
    ] });
    if (conv) {
      if (settingsOpen) {
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
            fields.push({ ...field, label: undefined, surface: "chat-control" });
          } else fields.push(field);
          if (option?.description) fields.push({ type: "label", key: field.key + "-hint", text: option.description, size: "sm", color: "muted", wrap: true });
        }
        fields.push({ type: "select", key: "policy", label: "Approval policy", options: POLICIES, value: conv.approvalPolicy, action: "setPolicy", surface: "chat-control" });
        if (profile?.provider === "claude") fields.push({ type: "toggle", key: "claude-sub", label: "Use Claude subscription", checked: view.auth?.claudeSubscription !== false, action: "toggleClaudeSub", tooltip: "Uses your Claude login instead of the shell API key. Applies on reconnect." });
        fields.push({ type: "label", key: "loc", text: `${live?.machineId || view.workspace.machineId} · ${view.workspace.root}`, size: "xs", color: "muted", wrap: true });
        fields.push({ type: "row", key: "connection", gap: 8, children: [
          { type: "button", key: "connect", text: connected ? "Disconnect" : "Connect", action: connected ? "disconnect" : "connect", surface: "chat-control" },
          { type: "button", key: "adapters", text: "Manage agents…", action: "openAdapters", surface: "chat-control" },
        ] });
        kids.push({ type: "column", key: "settings", surface: "chat-settings", grow: true, scroll: true, gap: 10, padding: 12, children: fields });
      } else {
        kids.push({ type: "chatTranscript", key: "transcript", conversationId: conv.id, hasOlder: !!active.hasOlder, loadingOlder: !!active.historyLoading, historyError: active.historyError, loadOlderAction: "loadOlder", messages: active.messages, agentLabel: providerName + (model.value ? " · " + modelName : ""), grow: true });
        const composer: UiNode[] = [];
        if (attachments.length) composer.push({ type: "row", key: "attachments", gap: 8, children: attachments.map((image, index): UiNode => ({ type: "column", key: "attachment-" + index, gap: 4, children: [
          { type: "image", key: "preview", image, width: 80, height: 64 },
          { type: "button", key: "remove", text: "× " + image.name, action: "removeImage", value: index, small: true, tooltip: "Remove picture" },
        ] })) });
        composer.push({ type: "textInput", key: "prompt", surface: "chat-control", pasteImageAction: "attachImages", placeholder: active.busy ? "Steer " + providerName + "…" : "Ask " + providerName + "…", multiline: true, rows: 2, submitAction: "send", value: draft });
        if (mcpOpen) composer.push({ type: "column", key: "mcp-picker", gap: 8, padding: 12, border: true, children: [
          { type: "label", key: "title", text: "MCP servers", weight: "bold", size: "sm" },
          ...(view.mcpServers || [{ id: "internal", name: "Hato" }]).map((server: any): UiNode => ({ type: "toggle", key: "mcp-" + server.id, label: server.name, tooltip: server.description, checked: (conv.mcpSelection || []).includes(server.id), action: "toggleMcp:" + server.id })),
          { type: "button", key: "apply", text: "Reconnect to apply", action: "reconnect", small: true, disabled: active.busy },
        ] });
        if (skillsOpen) kids.push({ type: "column", key: "skills-picker", scroll: true, maxHeight: 220, padding: 12, gap: 8, border: true, children: skills.length ? skills.map((skill): UiNode => ({ type: "button", key: skill.path, text: skill.name + (skill.description ? " · " + skill.description : ""), tooltip: skill.path, action: "useSkill", value: skill.path, surface: "chat-result" })) : [{ type: "label", key: "none", text: skillState?.loading ? "Loading workspace skills…" : skillState?.error ? "Could not load workspace skills: " + skillState.error : "No workspace skills in .agents/skills.", color: "muted", wrap: true }] });
        composer.push({ type: "row", key: "act", gap: 6, children: [
          { type: "imagePicker", key: "attach", action: "attachImages", surface: "chat-control", disabled: busy === "send" },
          { type: "button", key: "mcp-toggle", text: "MCP", action: "toggleMcpPicker", surface: "chat-control", tooltip: "MCP servers" },
          { type: "button", key: "skills-toggle", text: "Skills " + skills.length, icon: "graduation-cap", action: "toggleSkills", surface: "chat-control" },
          { type: "label", key: "chat-status", grow: true, text: active.steering ? "Steering…" : active.busy ? "Working…" : connected ? "" : live?.status || conv.status || "Offline", size: "xs", color: "muted", tooltip: `${providerName} · ${live?.status || conv.status || "offline"}` },
          { type: "usageMeter", key: "context-usage", value: context.value, tooltip: context.tooltip },
          ...(active.busy ? [{ type: "button", key: "cancel", text: "Stop", action: "cancel", surface: "chat-control" } as UiNode] : []),
          { type: "button", key: "send", text: "", icon: "send", action: "send", surface: "chat-primary", variant: "primary", width: 32, height: 32, disabled: busy === "send", tooltip: active.busy ? "Steer agent" : "Send message" },
        ] });
        kids.push({ type: "column", key: "composer", surface: "chat-composer", gap: 6, padding: 8, children: composer });
      }
      if (modelsOpen) {
        const filtered = model.options.filter((o) => `${o.label} ${modelDetails(o.value)?.description || ""}`.toLowerCase().includes(modelQuery.toLowerCase()));
        kids.push({ type: "popover", key: "model-picker", closeAction: "toggleModels", surface: "chat-picker", children: [
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
      { type: "button", key: "start", text: "New chat", icon: "plus", action: "newChat", surface: "chat-primary", variant: "primary" },
    ] });
    return { type: "column", key: "ai-root", surface: "chat", gap: 0, grow: true, children: kids };
  },
  async onEvent(ctx, ev) {
    const conv = view && view.active ? view.active.conversation : null;
    const call = (m: string, args: any, timeoutMs = 120000) => ctx.modules.call("ai-sessions", m, args, { timeoutMs });
    try {
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
      else if (ev.action === "loadOlder") await call("loadOlder", { conversationId: conv.id });
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
    finally { if (ev.action !== "loadOlder") busy = null; await load(ctx); }
  },
};
export default mod;
