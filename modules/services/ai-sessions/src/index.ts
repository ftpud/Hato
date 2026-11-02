// ai-sessions: conversations per workspace, transcript projection of ACP updates, persistence of
// cached history, and the requested approval policy. Policy here only decides *agent* permission
// requests; module patch/build/activate approvals are enforced by the kernel regardless.
import type { AppModule, ChatMessage, ModuleContext } from "../../../../sdk/types";
import { debounce, errMsg } from "../../../../sdk/runtime";

type Policy = "ask" | "auto-low" | "autopilot";
interface Msg { id: string; kind: string; payload: any }
interface Conv {
  row: any;
  messages: Msg[];
  loaded: boolean;
  current: { assistant: string | null; thought: string | null };
  tools: Map<string, string>;
  dirty: Set<string>;
  live: any;
  busy: boolean;
}

const convs = new Map<string, Conv>();
const LOW_RISK_KINDS = new Set(["read", "search", "think", "fetch"]);
let notify: () => void = () => {};
let flushSoon: () => void = () => {};

async function load(ctx: ModuleContext, id: string): Promise<Conv> {
  let c = convs.get(id);
  if (c && c.loaded) return c;
  const row = await ctx.modules.call("persistence", "conversations.get", { id });
  if (!row) throw new Error(`unknown conversation ${id}`);
  const msgs = await ctx.modules.call("persistence", "messages.list", { conversationId: id, limit: 1000 });
  c = { row, messages: msgs.map((m: any) => ({ id: m.id, kind: m.kind, payload: m.payload })), loaded: true, current: { assistant: null, thought: null }, tools: new Map(), dirty: new Set(), live: null, busy: false };
  for (const m of c.messages) if (m.kind === "tool" && m.payload.toolCallId) c.tools.set(m.payload.toolCallId, m.id);
  try { c.live = await ctx.modules.call("acp", "state", { conversationId: id }); } catch { c.live = null; }
  if (c.live) c.busy = c.live.status === "busy";
  convs.set(id, c);
  return c;
}

function add(c: Conv, kind: string, payload: any): Msg {
  const m = { id: crypto.randomUUID(), kind, payload };
  c.messages.push(m);
  c.dirty.add(m.id);
  return m;
}
const byId = (c: Conv, id: string | null) => (id ? c.messages.find((m) => m.id === id) : undefined);

async function flush(ctx: ModuleContext) {
  for (const c of convs.values()) {
    if (!c.dirty.size) continue;
    const ids = Array.from(c.dirty);
    c.dirty.clear();
    for (const id of ids) {
      const m = byId(c, id);
      if (m) await ctx.modules.call("persistence", "messages.upsert", { id: m.id, conversationId: c.row.id, kind: m.kind, payload: m.payload }).catch((e) => ctx.log.warn("persist message", errMsg(e)));
    }
  }
}

function textOf(content: any): string {
  if (!content) return "";
  if (Array.isArray(content)) return content.map(textOf).filter(Boolean).join("\n");
  if (content.type === "text") return content.text || "";
  if (content.type === "content") return textOf(content.content);
  if (content.type === "diff") return `diff ${content.path}${content.newText ? ` (+${String(content.newText).split("\n").length} lines)` : ""}`;
  if (content.type === "terminal") return `terminal ${content.terminalId}`;
  if (content.type === "resource_link") return content.uri || "";
  return "";
}

function project(c: Conv, u: any) {
  switch (u.sessionUpdate) {
    case "agent_message_chunk": {
      let m = byId(c, c.current.assistant);
      if (!m) { m = add(c, "assistant", { text: "" }); c.current.assistant = m.id; }
      m.payload.text += textOf(u.content);
      c.dirty.add(m.id);
      c.current.thought = null;
      break;
    }
    case "agent_thought_chunk": {
      let m = byId(c, c.current.thought);
      if (!m) { m = add(c, "thought", { text: "" }); c.current.thought = m.id; }
      m.payload.text += textOf(u.content);
      c.dirty.add(m.id);
      break;
    }
    case "user_message_chunk": {
      add(c, "user", { text: textOf(u.content), replayed: true });
      break;
    }
    case "tool_call": {
      const m = add(c, "tool", { toolCallId: u.toolCallId, title: u.title || u.kind || "tool", kind: u.kind, status: u.status || "pending", text: textOf(u.content) });
      c.tools.set(u.toolCallId, m.id);
      c.current.assistant = null; c.current.thought = null;
      break;
    }
    case "tool_call_update": {
      const m = byId(c, c.tools.get(u.toolCallId) || null);
      if (!m) { project(c, { ...u, sessionUpdate: "tool_call" }); break; }
      if (u.status) m.payload.status = u.status;
      if (u.title) m.payload.title = u.title;
      const t = textOf(u.content);
      if (t) m.payload.text = t.slice(0, 4000);
      c.dirty.add(m.id);
      break;
    }
    case "plan": {
      const text = (u.entries || []).map((e: any) => `${e.status === "completed" ? "✓" : e.status === "in_progress" ? "→" : "·"} ${e.content}`).join("\n");
      const last = c.messages[c.messages.length - 1];
      if (last && last.kind === "plan") { last.payload.text = text; c.dirty.add(last.id); } else add(c, "plan", { text });
      break;
    }
    case "_hato_notice": add(c, "system", { text: u.text }); break;
    default: break; // config/mode/commands/usage updates are reflected through acp state
  }
}

function toChat(m: Msg): ChatMessage {
  const p = m.payload || {};
  switch (m.kind) {
    case "user": return { key: m.id, role: "user", text: p.text || "" };
    case "assistant": return { key: m.id, role: "assistant", text: p.text || "" };
    case "thought": return { key: m.id, role: "thought", text: (p.text || "").slice(-1500) };
    case "tool": return { key: m.id, role: "tool", title: p.title, status: p.status, text: (p.text || "").slice(0, 1500) };
    case "plan": return { key: m.id, role: "plan", text: p.text || "" };
    case "error": return { key: m.id, role: "error", text: p.text || "" };
    default: return { key: m.id, role: "system", text: p.text || "" };
  }
}

async function update(ctx: ModuleContext, id: string, fields: any) {
  await ctx.modules.call("persistence", "conversations.update", { id, fields });
  const c = convs.get(id);
  if (c) c.row = { ...c.row, ...fields };
}

async function connect(ctx: ModuleContext, id: string) {
  const c = await load(ctx, id);
  await update(ctx, id, { status: "connecting" });
  notify();
  try {
    const st = await ctx.modules.call("acp", "start", {
      conversationId: id, workspaceId: c.row.workspaceId, profileId: c.row.acpProfileId,
      mcp: (c.row.mcpSelection || []).includes("internal"), resumeSessionId: c.row.providerSessionId,
    }, { timeoutMs: 600000 });
    c.live = st;
    await update(ctx, id, { status: "online", providerSessionId: st.sessionId });
    // Re-apply remembered selections (model/mode/reasoning) when the agent advertises them.
    const saved = c.row.config || {};
    for (const [configId, value] of Object.entries(saved)) {
      const known = (st.configOptions || []).some((o: any) => o.id === configId && (o.options || []).some((x: any) => x.value === value || (x.options || []).some((y: any) => y.value === value)));
      if (known && (st.configOptions || []).find((o: any) => o.id === configId)?.currentValue !== value) {
        try { c.live = await ctx.modules.call("acp", "setConfig", { conversationId: id, configId, value }); } catch (e) { ctx.log.warn("re-apply config", configId, errMsg(e)); }
      }
    }
    return st;
  } catch (e) {
    await update(ctx, id, { status: "error" });
    add(c, "error", { text: errMsg(e) });
    flushSoon();
    throw e;
  } finally { notify(); }
}

const mod: AppModule = {
  id: "ai-sessions",
  moduleApiVersion: 1,
  async activate(ctx) {
    notify = debounce(() => ctx.events.emit("ai-sessions.changed", {}), 60);
    flushSoon = debounce(() => { flush(ctx); }, 1200);
    ctx.events.on("acp.update", (p: any) => {
      const c = convs.get(p.conversationId);
      if (!c) return;
      project(c, p.update);
      flushSoon();
      notify();
    });
    ctx.events.on("acp.turnEnded", async (p: any) => {
      const c = convs.get(p.conversationId);
      if (!c) return;
      c.busy = false;
      c.current = { assistant: null, thought: null };
      if (p.error) add(c, "error", { text: `Turn failed: ${p.error}` });
      else if (p.stopReason && p.stopReason !== "end_turn") add(c, "system", { text: `Turn ended: ${p.stopReason}` });
      await flush(ctx);
      notify();
    });
    ctx.events.on("acp.status", (s: any) => {
      const c = convs.get(s.conversationId);
      if (!c) return;
      c.live = s;
      c.busy = s.status === "busy";
      if (s.status === "exited" || s.status === "error") update(ctx, s.conversationId, { status: s.status === "exited" ? "offline" : "error" }).catch(() => {});
      notify();
    });
  },
  async deactivate(ctx) { await flush(ctx); },
  methods: {
    async list(ctx, a) { return ctx.modules.call("persistence", "conversations.list", { workspaceId: a.workspaceId }); },

    async create(ctx, a) {
      const desc = await ctx.modules.call("workspace", "resolve", { workspaceId: a.workspaceId });
      const profiles = await ctx.modules.call("acp", "profiles", { machineId: desc.machineId });
      const profileId = a.profileId || (profiles[0] && profiles[0].id);
      if (!profileId) throw new Error(`no agent profile configured for ${desc.machineId}`);
      const id = crypto.randomUUID();
      const existing = await ctx.modules.call("persistence", "conversations.list", { workspaceId: desc.id });
      await ctx.modules.call("persistence", "conversations.insert", { conversation: { id, workspaceId: desc.id, acpProfileId: profileId, title: a.title || `Chat ${existing.length + 1}`, approvalPolicy: "ask", mcpSelection: ["internal"] } });
      await ctx.modules.call("workspace", "view.patch", { workspaceId: desc.id, patch: { activeConversationId: id } });
      notify();
      return ctx.modules.call("persistence", "conversations.get", { id });
    },

    async select(ctx, a) {
      await ctx.modules.call("workspace", "view.patch", { workspaceId: a.workspaceId, patch: { activeConversationId: a.conversationId } });
      notify();
      return null;
    },

    /** Everything the AI panel needs for the given workspace, in one call. */
    async view(ctx, a) {
      const desc = await ctx.modules.call("workspace", "resolve", { workspaceId: a.workspaceId });
      const list = await ctx.modules.call("persistence", "conversations.list", { workspaceId: desc.id });
      const v = await ctx.modules.call("workspace", "view.get", { workspaceId: desc.id });
      const activeId = list.some((x: any) => x.id === v.activeConversationId) ? v.activeConversationId : list[0] ? list[0].id : null;
      const profiles = await ctx.modules.call("acp", "profiles", { machineId: desc.machineId });
      let active: any = null;
      if (activeId) {
        const c = await load(ctx, activeId);
        active = { conversation: c.row, messages: c.messages.slice(-400).map(toChat), live: c.live, busy: c.busy };
      }
      return { workspace: { id: desc.id, name: desc.name, machineId: desc.machineId, root: desc.rootAbsolutePath, location: desc.location }, conversations: list.map((x: any) => ({ id: x.id, title: x.title, status: x.status })), activeId, active, profiles };
    },

    connect: (ctx, a) => connect(ctx, a.conversationId),

    async disconnect(ctx, a) {
      await ctx.modules.call("acp", "stop", { conversationId: a.conversationId });
      await update(ctx, a.conversationId, { status: "offline" });
      const c = convs.get(a.conversationId);
      if (c) { c.live = null; c.busy = false; }
      notify();
      return null;
    },

    async send(ctx, a) {
      const text = String(a.text || "").trim();
      if (!text) throw new Error("empty prompt");
      const c = await load(ctx, a.conversationId);
      if (c.busy) throw new Error("the agent is still working on the previous prompt (cancel it first)");
      add(c, "user", { text });
      c.current = { assistant: null, thought: null };
      if (c.row.title.startsWith("Chat ") && c.messages.filter((m) => m.kind === "user").length === 1) await update(ctx, c.row.id, { title: text.slice(0, 60) });
      await flush(ctx);
      notify();
      if (!c.live || !["ready", "busy"].includes(c.live.status)) await connect(ctx, c.row.id);
      c.busy = true;
      notify();
      try { await ctx.modules.call("acp", "prompt", { conversationId: c.row.id, text }); }
      catch (e) { c.busy = false; add(c, "error", { text: errMsg(e) }); flushSoon(); notify(); throw e; }
      return { accepted: true };
    },

    async cancel(ctx, a) { await ctx.modules.call("acp", "cancel", { conversationId: a.conversationId }); return null; },

    async setConfig(ctx, a) {
      const c = await load(ctx, a.conversationId);
      c.live = await ctx.modules.call("acp", "setConfig", { conversationId: a.conversationId, configId: a.configId, value: a.value });
      await update(ctx, a.conversationId, { config: { ...(c.row.config || {}), [a.configId]: a.value } });
      notify();
      return c.live;
    },

    async setPolicy(ctx, a) {
      const p: Policy = a.policy === "autopilot" ? "autopilot" : a.policy === "auto-low" ? "auto-low" : "ask";
      await load(ctx, a.conversationId);
      await update(ctx, a.conversationId, { approvalPolicy: p });
      add(convs.get(a.conversationId)!, "system", { text: p === "autopilot" ? "Autopilot enabled: agent tool permissions are approved automatically. Module patch/build/activate/rollback still require native approval." : p === "auto-low" ? "Auto-approving low-risk agent actions (read/search/think/fetch); others ask." : "All agent permission requests ask for approval." });
      flushSoon(); notify();
      return null;
    },

    async setMcp(ctx, a) {
      await load(ctx, a.conversationId);
      await update(ctx, a.conversationId, { mcpSelection: a.internal ? ["internal"] : [] });
      notify();
      return { reconnectRequired: true };
    },

    async setProfile(ctx, a) {
      const c = await load(ctx, a.conversationId);
      if (c.live && ["ready", "busy"].includes(c.live.status)) await ctx.modules.call("acp", "stop", { conversationId: a.conversationId });
      c.live = null;
      await update(ctx, a.conversationId, { acpProfileId: a.profileId, providerSessionId: null, status: "offline", config: {} });
      notify();
      return null;
    },

    /** Called by `acp` for session/request_permission. */
    async permissionRequest(ctx, a) {
      const c = await load(ctx, a.conversationId);
      const req = a.request || {};
      const options: any[] = req.options || [];
      const tool = req.toolCall || {};
      const policy: Policy = c.row.approvalPolicy || "ask";
      const allowOnce = options.find((o) => o.kind === "allow_once") || options.find((o) => String(o.kind).startsWith("allow"));
      const reject = options.find((o) => o.kind === "reject_once") || options.find((o) => String(o.kind).startsWith("reject"));
      let chosen: string | null = null;
      let how = "";
      if (policy === "autopilot" && allowOnce) { chosen = allowOnce.optionId; how = "autopilot"; }
      else if (policy === "auto-low" && allowOnce && LOW_RISK_KINDS.has(tool.kind)) { chosen = allowOnce.optionId; how = "auto (low-risk)"; }
      else {
        const detail = [`Agent: ${c.live?.agentInfo?.title || c.live?.agentInfo?.name || c.row.acpProfileId} on ${c.live?.machineId || "?"}`, `Workspace: ${c.row.workspaceId}`, `Tool: ${tool.title || "(untitled)"} [${tool.kind || "other"}]`,
          tool.rawInput ? `Input: ${JSON.stringify(tool.rawInput).slice(0, 4000)}` : "", textOf(tool.content).slice(0, 4000)].filter(Boolean).join("\n");
        const r = await ctx.host.approvals.request({
          title: `Agent requests permission: ${tool.title || tool.kind || "tool call"}`, detail, operation: "agent-permission",
          options: options.map((o) => ({ id: o.optionId, label: o.name || o.optionId, kind: String(o.kind).startsWith("allow") ? "allow" : String(o.kind).startsWith("reject") ? "deny" : "neutral" })),
        });
        chosen = r.optionId; how = r.expired ? "expired" : "user";
      }
      const label = options.find((o) => o.optionId === chosen)?.name || (chosen ? chosen : "cancelled");
      add(c, "system", { text: `Permission for "${tool.title || tool.kind || "tool"}": ${label} (${how})` });
      flushSoon(); notify();
      if (!chosen) return { outcome: { outcome: "cancelled" } };
      if (reject && chosen === reject.optionId) return { outcome: { outcome: "selected", optionId: chosen } };
      return { outcome: { outcome: "selected", optionId: chosen } };
    },
  },
};
export default mod;
