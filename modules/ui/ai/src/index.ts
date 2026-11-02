// ai: ACP chat panel. Layout and control handlers only; conversation state lives in ai-sessions,
// protocol in acp, and approval authority in the kernel's native chrome.
import type { AppModule, ModuleContext, UiNode } from "../../../../sdk/types";
import { debounce, errMsg } from "../../../../sdk/runtime";

let ws: any = null;
let view: any = null;
let error: string | null = null;
let busy: string | null = null;
let draft: string | undefined = undefined;
let refresh: () => void = () => {};

async function load(ctx: ModuleContext) {
  if (!ws) { view = null; ctx.ui.invalidate(); return; }
  try { view = await ctx.modules.call("ai-sessions", "view", { workspaceId: ws.id }); error = null; }
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
  out.push(thought ? sel("cfg-reasoning", "Reasoning", thought) : disabled("cfg-reasoning", "Reasoning"));
  const mode = byCat("mode")[0];
  if (mode) out.push(sel("cfg-mode", "Mode", mode));
  else if (live && live.modes && live.modes.availableModes) out.push({ type: "select", key: "cfg-mode", label: "Mode", options: live.modes.availableModes.map((m: any) => ({ value: m.id, label: m.name || m.id })), value: live.modes.currentModeId, action: "setConfig:__mode" });
  else out.push(disabled("cfg-mode", "Mode"));
  for (const o of opts.filter((o) => !["model", "thought_level", "mode"].includes(o.category) && o.type !== "boolean")) out.push(sel("cfg-" + o.id, o.name || o.id, o));
  return out;
}

const mod: AppModule = {
  id: "ai",
  moduleApiVersion: 1,
  async activate(ctx, prev) {
    if (prev && typeof prev.draft === "string") draft = prev.draft;
    refresh = debounce(() => load(ctx), 40);
    ws = ctx.state.get("workspace.selected") || null;
    ctx.state.watch("workspace.selected", (v: any) => { const changed = (ws && ws.id) !== (v && v.id); ws = v; if (changed) load(ctx); });
    ctx.events.on("ai-sessions.changed", () => refresh());
    ctx.events.on("acp.status", () => refresh());
    await load(ctx);
  },
  snapshot: () => ({ draft }),
  render(): UiNode {
    const kids: UiNode[] = [{ type: "row", key: "hdr", gap: 6, align: "center", children: [
      { type: "label", key: "t", text: "AI / ACP", size: "sm", weight: "bold", color: "muted" },
      { type: "spacer", key: "sp" },
      { type: "button", key: "new", text: "+ New chat", action: "newChat", small: true, disabled: !ws },
    ] }];
    if (!ws) { kids.push({ type: "label", key: "none", text: "Select a project or task to chat with an agent running on its machine.", color: "muted", wrap: true }); return { type: "column", key: "ai-root", gap: 6, padding: 8, grow: true, children: kids }; }
    if (error) kids.push({ type: "status", key: "err", text: error, level: "error" });
    if (!view) { kids.push({ type: "progress", key: "ld", indeterminate: true }); return { type: "column", key: "ai-root", gap: 6, padding: 8, grow: true, children: kids }; }
    const a = view.active;
    const conv = a ? a.conversation : null;
    const live = a ? a.live : null;
    const connected = !!live && ["ready", "busy"].includes(live.status);
    kids.push({ type: "select", key: "conv", label: "Chat", options: view.conversations.map((c: any) => ({ value: c.id, label: `${c.title} · ${c.status}` })), value: view.activeId, action: "selectConv", placeholder: "no conversations" });
    kids.push({ type: "select", key: "agent", label: "Agent", options: view.profiles.map((p: any) => ({ value: p.id, label: p.name })), value: conv ? conv.acpProfileId : null, action: "setProfile", disabled: !conv, placeholder: "—" });
    if (conv) {
      const where = live && live.machineId ? live.machineId : view.workspace.machineId;
      kids.push({ type: "label", key: "loc", text: `Agent location: ${where} · cwd ${view.workspace.root}`, size: "xs", color: "muted", wrap: true });
      const st = live ? `${live.agentInfo ? (live.agentInfo.title || live.agentInfo.name) + " " + (live.agentInfo.version || "") + " · " : ""}${live.status}${live.pid ? " · pid " + live.pid : ""}` : conv.status;
      kids.push({ type: "row", key: "conn", gap: 4, align: "center", children: [
        { type: "label", key: "st", text: st, size: "xs", grow: true, color: live && live.status === "error" ? "danger" : "default" },
        connected ? { type: "button", key: "disc", text: "Disconnect", action: "disconnect", small: true } : { type: "button", key: "connect", text: busy === "connect" ? "Connecting…" : "Connect", action: "connect", small: true, variant: "primary", disabled: busy === "connect" },
      ] });
      if (live && live.error && live.status !== "ready" && live.status !== "busy") kids.push({ type: "status", key: "liveerr", text: live.error, level: "error" });
      kids.push(...selectors(live, connected));
      kids.push({ type: "select", key: "policy", label: "Policy", options: POLICIES, value: conv.approvalPolicy, action: "setPolicy" });
      kids.push({ type: "row", key: "mcp", gap: 8, align: "center", children: [
        { type: "label", key: "l", text: "MCP:", size: "xs", color: "muted" },
        { type: "toggle", key: "mcp-int", label: "Internal", checked: (conv.mcpSelection || []).includes("internal"), action: "toggleMcp" },
        { type: "toggle", key: "mcp-ext", label: "External (coming later)", checked: false, action: "noop", disabled: true },
      ] });
      if (live && live.mcp && live.mcp.enabled) kids.push({ type: "label", key: "mcpst", text: `Internal MCP: ${live.mcp.status}`, size: "xs", color: /unavailable/.test(live.mcp.status) ? "danger" : "muted", wrap: true });
      kids.push({ type: "divider", key: "d1" });
      kids.push({ type: "chatTranscript", key: "transcript", messages: a.messages, grow: true });
      if (a.busy) kids.push({ type: "progress", key: "working", indeterminate: true, label: "Agent is working…" });
      kids.push({ type: "textInput", key: "prompt", placeholder: "Ask the agent… (Enter to send, Shift+Enter for newline)", multiline: true, rows: 3, submitAction: "send", value: draft });
      kids.push({ type: "row", key: "act", gap: 4, children: [
        { type: "spacer", key: "sp" },
        { type: "button", key: "cancel", text: "Cancel", action: "cancel", small: true, disabled: !a.busy },
        { type: "button", key: "send", text: "Send", action: "send", small: true, variant: "primary", disabled: a.busy },
      ] });
    } else {
      kids.push({ type: "label", key: "empty", text: "No conversation for this workspace yet. Each project root and task has its own conversations.", color: "muted", wrap: true });
    }
    return { type: "column", key: "ai-root", gap: 6, padding: 8, grow: true, children: kids };
  },
  async onEvent(ctx, ev) {
    const conv = view && view.active ? view.active.conversation : null;
    const call = (m: string, args: any, timeoutMs = 120000) => ctx.modules.call("ai-sessions", m, args, { timeoutMs });
    try {
      if (ev.action === "newChat" && ws) await call("create", { workspaceId: ws.id });
      else if (ev.action === "selectConv" && ws) await call("select", { workspaceId: ws.id, conversationId: ev.value });
      else if (!conv) return;
      else if (ev.action === "connect") { busy = "connect"; ctx.ui.invalidate(); await call("connect", { conversationId: conv.id }, 600000); }
      else if (ev.action === "disconnect") await call("disconnect", { conversationId: conv.id });
      else if (ev.action === "setProfile") await call("setProfile", { conversationId: conv.id, profileId: ev.value });
      else if (ev.action === "setPolicy") await call("setPolicy", { conversationId: conv.id, policy: ev.value });
      else if (ev.action === "toggleMcp") await call("setMcp", { conversationId: conv.id, internal: !!ev.value });
      else if (ev.action.startsWith("setConfig:")) await call("setConfig", { conversationId: conv.id, configId: ev.action.slice(10), value: ev.value });
      else if (ev.action === "cancel") await call("cancel", { conversationId: conv.id });
      else if (ev.action === "send") {
        const text = (ev.inputs.prompt || "").trim();
        if (!text) return;
        draft = draft === "" ? " " : ""; // changing `value` clears the native input
        ctx.ui.invalidate();
        await call("send", { conversationId: conv.id, text }, 600000);
      }
      error = null;
    } catch (e) { error = errMsg(e); }
    finally { busy = null; await load(ctx); }
  },
};
export default mod;
