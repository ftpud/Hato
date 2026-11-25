// Activity sidebars: the Halo rails on both sides of the workspace (presentation in halo-rail.ts).
// Left = Workspace: project switcher, run controls, panels and the machine menu.
// Right = Assistant: new chat, recent chats, agent panels and plan usage.
// Panels come from plugin contributions; user placement (top/bottom of either side) decides which
// rail and section a panel button lands in.
//
// State read from other modules (all optional):
//   <module>.panelBadge.<panel>     positive count → orange dot + count
//   <module>.panelChildren.<panel>  [{ id, label, count?, selected? }] → inline navigation; clicks emit `<sidebar>.panelChild`
//   <module>.panelTasks.<panel>     [{ id, label, progress?, state? }] → progress rows
//   projects-panel.rail             projects, tasks, selection (selected via projects-panel.selectWorkspace)
//   ai.rail                         this workspace's chats (driven via ai.newChat / selectConversation / openHistory)
//   acp.limits                      Claude/Codex plan usage
//   ai-sessions.busy, persistent-agents.busy   workspaceId → working agents
//   workspace-layout.appearance / moduleUpdates
import type { AppModule, ModuleContext, UiColor, UiNode } from "./types";
import { normalizeSidebarButtons, normalizeSidebarOrder, orderedSidebarItems, sidebarPanels, type SidebarButtons, type SidebarOrder } from "./sidebar-placement";
import { sidebarIcons } from "./sidebar-icons";
import { loadContributions, watchContributions, type Contributions } from "./plugins";
import { surfaceEffectsOf, type SurfaceEffects } from "./halo-glass";
import { haloIcons, haloRail, haloSlotWidth, haloUsage, type HaloChild, type HaloItem, type HaloModel, type HaloSection, type HaloTask } from "./halo-rail";

const fallbackIcon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="3"/></svg>`;
const CHAT_LIMIT = 6;

const initialsOf = (name: string) => name.split(/[\s/_.@-]+/).filter(Boolean).slice(0, 2).map(w => w[0]!.toUpperCase()).join("") || "H";
const sum = (v: unknown) => v && typeof v === "object" ? Object.values(v as Record<string, unknown>).reduce((n: number, c) => n + (Number.isFinite(Number(c)) ? Math.max(0, Number(c)) : 0), 0) : 0;
const statText = (s: any) => s && (s.added || s.removed) ? `+${s.added} −${s.removed}` : undefined;
const taskDot = (status: string, busy: number): UiColor => busy ? "primary" : status === "ready" ? "success" : status === "error" || status === "failed" ? "danger" : "warning";

export function activitySidebar(id: string, side: "left" | "right"): AppModule {
  let visible: Record<string, boolean> = {};
  let choices: SidebarButtons = {};
  let order: SidebarOrder = {};
  let contributions: Contributions | null = null;
  let stop: (() => void) | null = null;
  const stops: (() => void)[] = [];
  const badges: Record<string, unknown> = {};
  const children: Record<string, unknown> = {};
  const tasks: Record<string, unknown> = {};
  const panelStops = new Map<string, () => void>();
  const syncPanels = (ctx: ModuleContext) => {
    const panels = Object.values(contributions?.panels || {});
    const wanted = new Set(panels.map(p => p.id));
    for (const [pid, stopIt] of panelStops) if (!wanted.has(pid)) { stopIt(); panelStops.delete(pid); delete badges[pid]; delete children[pid]; delete tasks[pid]; }
    for (const panel of panels) if (!panelStops.has(panel.id)) {
      const watches = ([["panelBadge", badges], ["panelChildren", children], ["panelTasks", tasks]] as const).map(([kind, into]) => {
        const key = `${panel.module}.${kind}.${panel.id}`;
        into[panel.id] = ctx.state.get(key);
        return ctx.state.watch(key, value => { into[panel.id] = value; ctx.ui.invalidate(); });
      });
      panelStops.set(panel.id, () => watches.forEach(w => typeof w === "function" && w()));
    }
  };

  let theme = "ember";
  let colorMode = "system";
  let effects: SurfaceEffects = "reduced";
  let expanded = false;
  let query = "";
  let focused: string | null = null;
  let accountOpen = false;
  const open: Record<string, boolean> = {};
  let ws: any = null;
  let limits: any = null;
  let busyAi: unknown = null;
  let busyAgents: unknown = null;
  let projects: { selected: string | null; activeGroup?: string; groups?: { id: string; name: string; projectIds: string[] }[]; projects: any[] } | null = null;
  let workingChats: any[] | null = null;
  let workingAgents: any[] | null = null;
  /** conversationId → { percent, note } from chats' report_progress calls. */
  let chatProgress: Record<string, any> | null = null;
  let chats: any = null;
  let updates = 0;
  let error: string | null = null;
  const busyCount = () => sum(busyAi) + sum(busyAgents);
  const publishWidth = (ctx: ModuleContext) => ctx.state.set(`${id}.preferredWidth`, haloSlotWidth(side, expanded));
  const enabled = (module: string) => !!contributions && (Object.values(contributions.panels).some(p => p.module === module) || (contributions.barItems || []).some(b => b.module === module));

  /** Finished tasks linger briefly as "Done" before collapsing away. */
  const finished = new Map<string, { task: HaloTask; until: number }>();
  let lastTasks: Record<string, HaloTask[]> = {};
  const asChildren = (v: unknown): { id: string; label: string; count?: number; selected?: boolean }[] => Array.isArray(v) ? v.filter((c: any) => c && typeof c.id === "string" && typeof c.label === "string").slice(0, 50).map((c: any) => ({ id: c.id, label: c.label, selected: c.selected === true, ...(Number.isFinite(c.count) ? { count: c.count } : {}) })) : [];
  const asTasks = (v: unknown): HaloTask[] => Array.isArray(v) ? v.filter((t: any) => t && typeof t.id === "string" && typeof t.label === "string").slice(0, 5)
    .map((t: any) => ({ id: t.id, label: t.label, progress: Number.isFinite(t.progress) ? t.progress : null, state: t.state === "done" || t.state === "error" ? t.state : "running" })) : [];
  const tasksFor = (ctx: ModuleContext, panel: string): HaloTask[] => {
    const live = asTasks(tasks[panel]);
    const now = Date.now();
    for (const t of lastTasks[panel] || []) if (t.state === "running" && !live.some(l => l.id === t.id) && !finished.has(`${panel}:${t.id}`)) {
      finished.set(`${panel}:${t.id}`, { task: { ...t, state: "done", progress: 1 }, until: now + 1600 });
      setTimeout(() => ctx.ui.invalidate(), 1650);
    }
    lastTasks[panel] = live;
    const lingering = [...finished].filter(([k, f]) => k.startsWith(`${panel}:`) && (f.until > now || (finished.delete(k), false))).map(([, f]) => f.task);
    return [...live, ...lingering.filter(t => !live.some(l => l.id === t.id))];
  };

  const buttons = () => contributions ? sidebarPanels(contributions, choices, side) : [];
  const panelItems = (ctx: ModuleContext, pos: string, skip: string[] = []): HaloItem[] => {
    if (!contributions) return [];
    const panels = buttons();
    const q = query.trim().toLowerCase();
    return orderedSidebarItems(contributions, choices, order, pos).flatMap((pid): HaloItem[] => {
      if (pid.startsWith("@spacer:") || skip.includes(pid)) return [];
      const panel = panels.find(p => p.id === pid); if (!panel) return [];
      const title = panel.activity?.title || panel.title;
      if (q && !title.toLowerCase().includes(q)) return [];
      const count = badges[panel.id];
      const kids = asChildren(children[panel.id]);
      const navigation = Array.isArray(children[panel.id]);
      return [{
        id: panel.id, title, action: "toggle", value: panel.id, groupAction: "toggle", active: navigation ? !!open[panel.id] : !!visible[panel.id],
        iconSvg: panel.activity?.iconSvg || (panel.activity?.icon && (sidebarIcons as Record<string, string>)[panel.activity.icon]) || fallbackIcon,
        badge: typeof count === "number" && Number.isFinite(count) && count > 0 ? Math.floor(count) : undefined,
        children: kids.map((c): HaloChild => ({ id: c.id, label: c.label, selected: c.selected, detail: c.count != null ? String(c.count) : undefined, action: "child", value: { panel: panel.id, child: c.id } })),
        open: !!open[panel.id], expandable: navigation, tasks: tasksFor(ctx, panel.id),
        tooltip: `${navigation ? open[panel.id] ? "Collapse" : "Expand" : visible[panel.id] && !panel.pinned ? "Hide" : "Show"} ${title}`,
      }];
    });
  };

  const projectsSection = (): HaloSection | null => {
    if (!projects) return null;
    const q = query.trim().toLowerCase();
    const sel = projects.selected;
    const all = projects.projects;
    const match = (p: any) => !q || String(p.name).toLowerCase().includes(q) || p.tasks.some((t: any) => `${t.name} ${t.branch}`.toLowerCase().includes(q));
    const isActive = (p: any) => p.id === sel || p.tasks.some((t: any) => t.id === sel);
    const groups = projects.groups || [];
    const group = groups.find(g => g.id === projects!.activeGroup);
    const inGroup = (p: any) => !group || group.projectIds.includes(p.projectId);
    const list = all.filter(p => match(p) && (!!q || inGroup(p)));
    const items: HaloItem[] = list.map((p): HaloItem => {
      const busy = p.busy + p.tasks.reduce((n: number, t: any) => n + t.busy, 0);
      const tasksShown = q ? p.tasks.filter((t: any) => `${t.name} ${t.branch}`.toLowerCase().includes(q) || String(p.name).toLowerCase().includes(q)) : p.tasks;
      return {
        id: `project:${p.id}`, title: p.name, tile: String(p.name || "?")[0]!.toUpperCase(), action: "workspace", value: p.id, groupAction: "group",
        active: isActive(p), busy: busy > 0,
        detail: p.needsPassword ? "Connect" : p.offline ? "Offline" : busy ? `AI working${busy > 1 ? ` · ${busy}` : ""}` : statText(p.stats) || (p.kind === "local" ? undefined : p.kind === "cloud" ? "Cloud" : "Remote"),
        tooltip: `${p.name}${p.tasks.length ? ` · ${p.tasks.length} task${p.tasks.length === 1 ? "" : "s"}` : ""}`,
        children: tasksShown.map((t: any): HaloChild => ({ id: t.id, label: t.name, detail: statText(t.stats), selected: t.id === sel, busy: t.busy > 0,
          dot: taskDot(t.status, t.busy), action: "workspace", value: t.id })),
        open: !!q || (open[`project:${p.id}`] ?? isActive(p)),
      };
    });
    // The whole list, in its own scroll area so panels stay in view below it.
    return { key: "projects", title: "Projects", items, add: { action: "toggleProjectPanel", iconSvg: haloIcons.chevron, tooltip: visible.projects ? "Hide Projects panel" : "Show Projects panel" }, collapsed: "active", maxHeight: 260,
      tabs: groups.length && !q ? { action: "selectGroup", active: group ? group.id : "all", items: [{ id: "all", label: "All", count: all.length }, ...groups.map(g => ({ id: g.id, label: g.name, count: g.projectIds.length }))] } : undefined };
  };

  const chatsSection = (): HaloSection | null => {
    if (!chats || chats.workspaceId !== ws?.id) return null;
    const q = query.trim().toLowerCase();
    const list = (chats.conversations || []).filter((c: any) => !q || `${c.title} ${c.provider}`.toLowerCase().includes(q)).slice(0, CHAT_LIMIT);
    const items: HaloItem[] = list.map((c: any): HaloItem => ({
      id: `chat:${c.id}`, title: c.title, detail: c.provider, iconSvg: haloIcons.chat, action: "chat", value: c.id,
      active: c.id === chats.activeId && !!visible.ai, busy: c.status === "busy" || c.status === "waiting",
    }));
    if ((chats.conversations || []).length > list.length || list.length) items.push({ id: "chats-all", title: "All chats…", iconSvg: haloIcons.history, action: "history", value: null });
    return { key: "chats", title: "Chats", items, collapsed: "none" };
  };

  /** Where an agent runs, as "Project" or "Project / task". */
  const placeName = (workspaceId: string) => {
    for (const p of projects?.projects || []) {
      if (p.id === workspaceId) return p.name;
      const t = p.tasks.find((t: any) => t.id === workspaceId); if (t) return `${p.name} / ${t.name}`;
    }
    return workspaceId === ws?.id ? ws?.name : undefined;
  };
  /** Working agents across all projects; one place (the Assistant rail). Falls back to a count
   *  when the services publish only `*.busy` maps. */
  /** Rows that stopped running: kept as "Done" until the user clicks them (newest first). */
  const finishedRows = new Map<string, HaloTask>();
  let lastRunning = new Map<string, HaloTask>();
  const FINISHED_LIMIT = 6;
  const workingSection = (): HaloSection | null => {
    const count = busyCount();
    const running: HaloTask[] = [];
    if (workingChats || workingAgents) {
      const fraction = (p: any) => p && Number.isFinite(p.percent) ? Math.max(0, Math.min(100, p.percent)) / 100 : null;
      const where = (p: any, place?: string) => [p?.note, place].filter(Boolean).join(" · ") || undefined;
      for (const c of workingChats || []) running.push({ id: `chat:${c.id}`, label: c.title || "Chat", detail: where(chatProgress?.[c.id], placeName(c.workspaceId)), iconSvg: haloIcons.chat,
        progress: fraction(chatProgress?.[c.id]), state: "running",
        action: "openAgent", value: { kind: "chat", id: c.id, workspaceId: c.workspaceId }, tooltip: "Open this chat and its project" });
      for (const a of workingAgents || []) {
        // Desktop tools bind persistent sessions by the same ID as their workspace endpoint.
        const desktop = chatProgress?.[a.id];
        const progress = desktop && (!a.progress || Number(desktop.at) >= Number(a.progress.at || 0)) ? desktop : a.progress;
        running.push({ id: `agent:${a.id}`, label: a.name || (a.workflow ? "Workflow agent" : "Background agent"),
          detail: where(progress, [a.workflow ? "Workflow" : null, placeName(a.workspaceId)].filter(Boolean).join(" · ")), progress: fraction(progress), state: "running",
          iconSvg: a.workflow ? sidebarIcons.workflow : sidebarIcons.bot,
          action: "openAgent", value: { kind: a.workflow ? "workflow" : "agent", id: a.id, workspaceId: a.workspaceId, workflow: a.workflow || null }, tooltip: "Open this agent and its project" });
      }
      // An agent that left the working lists finished its turn: keep it, done, until clicked.
      const now = new Map(running.map(t => [t.id, t]));
      for (const [id, t] of lastRunning) if (!now.has(id)) {
        finishedRows.delete(id);
        finishedRows.set(id, { ...t, state: "done", progress: 1, detail: (t.value as any)?.workspaceId ? placeName((t.value as any).workspaceId) : undefined,
          value: { ...(t.value as any), dismiss: id }, tooltip: "Finished · open it to dismiss" });
      }
      for (const id of now.keys()) finishedRows.delete(id); // running again
      while (finishedRows.size > FINISHED_LIMIT) finishedRows.delete(finishedRows.keys().next().value!);
      lastRunning = now;
    } else if (count) running.push({ id: "agents-working", label: `${count} agent${count === 1 ? "" : "s"} working`, iconSvg: sidebarIcons.bot, progress: null, state: "running" });
    const done = [...finishedRows.values()].reverse();
    if (!running.length && !done.length) return null;
    const title = running.length ? `Working · ${count || running.length}` : "Finished";
    return { key: "working", title, items: [], tasks: [...running, ...done].slice(0, 10), collapsed: "none" };
  };

  const model = (ctx: ModuleContext): HaloModel => {
    const usage = haloUsage(limits);
    if (side === "left") {
      const machine = !ws ? "No project" : ws.location === "ssh" ? (ws.ssh?.host || "SSH") : ws.location === "cloud" ? "Cloud" : "This computer";
      const sections = [projectsSection(),
        ...(enabled("run-bar") ? [{ key: "run", title: "Run", items: [], embed: { type: "slot", key: "run-bar", module: "run-bar", height: 62, grow: true } as UiNode, collapsed: "none" } as HaloSection] : []),
        { key: "menu", title: "Panels", items: panelItems(ctx, "left-top", ["projects"]) },
        { key: "tools", title: "Tools", items: panelItems(ctx, "left-bottom", ["projects"]) },
      ].filter(Boolean) as HaloSection[];
      return {
        side, expanded, focused, sections, busy: busyCount(), usage: [],
        header: { title: ws?.name || "Hato", subtitle: ws ? undefined : "Select a project", logo: true,
          embed: enabled("git-branch") && ws ? { type: "slot", key: "git-branch", module: "git-branch", height: 28 } as UiNode : undefined },
        search: { placeholder: "Search…", query },
        account: {
          initials: initialsOf(machine), name: machine, detail: error || (updates ? `${updates} module update${updates === 1 ? "" : "s"}` : ws ? (ws.location === "local" ? "Local workspace" : ws.machineId) : "Hato"),
          badge: updates || undefined, open: accountOpen, darkMode: colorMode !== "light",
          menu: [
            { key: "settings", label: "Settings", iconSvg: haloIcons.settings, action: "open", value: "settings" },
            { key: "plugins", label: "Plugins", iconSvg: haloIcons.plug, action: "open", value: "plugins" },
            { key: "modules", label: "Modules", iconSvg: haloIcons.modules, action: "open", value: "modules", badge: updates ? String(updates) : undefined },
            { key: "layout", label: "Layout", iconSvg: haloIcons.layout, action: "open", value: "layout" },
          ],
          status: [
            { type: "approvalPanel", key: "approvals" } as UiNode,
            ...(enabled("language-status") ? [{ type: "slot", key: "languages", module: "language-status", height: 24 } as UiNode] : []),
          ],
        },
      };
    }
    const chatsSec = chatsSection();
    return {
      side, expanded, focused, busy: busyCount(), usage,
      header: { title: "Assistant", subtitle: chats?.conversations?.length ? `${chats.conversations.length} chat${chats.conversations.length === 1 ? "" : "s"} in ${ws?.name || "this project"}` : ws?.name },
      primary: ws ? { label: "New chat", iconSvg: haloIcons.plus, action: "newChat", tooltip: "Start a new chat in this project" } : undefined,
      search: expanded ? { placeholder: "Search…", query } : undefined,
      sections: [
        ...(workingSection() ? [workingSection()!] : []),
        ...(chatsSec ? [chatsSec] : []),
        { key: "agents", title: "Panels", items: panelItems(ctx, "right-top") },
        { key: "more", title: "Tools", items: panelItems(ctx, "right-bottom") },
      ],
    };
  };

  const togglePanel = (ctx: ModuleContext, pid: string) => { if (!visible[pid]) focused = pid; ctx.events.emit(`${id}.togglePanel`, { id: pid }); };
  const showPanel = (ctx: ModuleContext, pid: string) => { if (!visible[pid]) togglePanel(ctx, pid); else focused = pid; };
  const watch = (ctx: ModuleContext, key: string, fn: (v: any) => void) => { fn(ctx.state.get(key)); const s = ctx.state.watch(key, (v: any) => { fn(v); ctx.ui.invalidate(); }); if (typeof s === "function") stops.push(s); };
  const setExpanded = (ctx: ModuleContext, value: boolean) => {
    expanded = value; accountOpen = false; if (!expanded) query = "";
    publishWidth(ctx); ctx.ui.invalidate();
    ctx.events.emit(`${id}.expanded`, { expanded });
  };
  /** Rails hold no call grants: every cross-module action is an event on the rail's own topic
   *  prefix, handled by the module that owns it (workspace-layout, projects-panel, ai, usage meters). */
  const request = (ctx: ModuleContext, name: string, payload: Record<string, unknown> = {}) => ctx.events.emit(`${id}.${name}`, payload);

  const mod: AppModule = {
    id, moduleApiVersion: 1,
    async activate(ctx: ModuleContext) {
      watch(ctx, "workspace-layout.sidebarOrder", v => { order = normalizeSidebarOrder(v); });
      watch(ctx, "workspace-layout.sidebarButtons", v => { choices = normalizeSidebarButtons(v); });
      visible = ctx.state.get("workspace-layout.panels") || {};
      const s = ctx.state.watch("workspace-layout.panels", (value: any) => {
        const next = value || {};
        // The indicator follows the most recently opened panel on this rail.
        const opened = Object.keys(next).find(k => next[k] && !visible[k] && buttons().some(p => p.id === k));
        if (opened) focused = opened;
        visible = next; ctx.ui.invalidate();
      });
      if (typeof s === "function") stops.push(s);
      watch(ctx, "workspace-layout.appearance", v => { theme = typeof v?.theme === "string" ? v.theme : "ember"; colorMode = typeof v?.mode === "string" ? v.mode : "system"; effects = surfaceEffectsOf(v?.effects); });
      watch(ctx, "workspace-layout.moduleUpdates", v => { updates = Number(v) > 0 ? Number(v) : 0; });
      watch(ctx, "workspace.selected", v => { ws = v; });
      watch(ctx, "acp.limits", v => { limits = v; });
      watch(ctx, "ai-sessions.busy", v => { busyAi = v; });
      watch(ctx, "persistent-agents.busy", v => { busyAgents = v; });
      watch(ctx, "projects-panel.rail", v => { projects = v && Array.isArray(v.projects) ? v : null; });
      watch(ctx, "ai.rail", v => { chats = v && Array.isArray(v.conversations) ? v : null; });
      watch(ctx, "ai-sessions.working", v => { workingChats = Array.isArray(v) ? v : null; });
      watch(ctx, "persistent-agents.working", v => { workingAgents = Array.isArray(v) ? v : null; });
      // Chats report through the report_progress tool (internal-mcp) or, without Hato's tools, reply
      // markers (ai-sessions); the newest report wins.
      let viaTool: Record<string, any> = {}, viaMarker: Record<string, any> = {};
      const merge = () => {
        const out: Record<string, any> = { ...viaMarker };
        for (const [id, p] of Object.entries(viaTool)) if (!out[id] || Number(p?.at) >= Number(out[id]?.at)) out[id] = p;
        chatProgress = out;
      };
      watch(ctx, "internal-mcp.progress", v => { viaTool = v && typeof v === "object" ? v : {}; merge(); });
      watch(ctx, "ai-sessions.progress", v => { viaMarker = v && typeof v === "object" ? v : {}; merge(); });
      // workspace-layout persists rail expansion and publishes it here.
      watch(ctx, "workspace-layout.railExpanded", v => { const next = v?.[id] === true; if (next !== expanded) { expanded = next; if (!expanded) query = ""; } });
      publishWidth(ctx);
      const s2 = ctx.state.watch("workspace-layout.railExpanded", () => publishWidth(ctx)); if (typeof s2 === "function") stops.push(s2);
      try { contributions = await loadContributions(ctx); } catch (e) { ctx.log.warn("plugins.list failed", String(e)); }
      syncPanels(ctx);
      stop = watchContributions(ctx, (c) => { contributions = c; syncPanels(ctx); ctx.ui.invalidate(); });
    },
    methods: {
      /** Expand or collapse this rail. */
      setExpanded: (ctx: ModuleContext, a: any) => { setExpanded(ctx, a?.expanded === true); return { expanded }; },
    },
    deactivate() { stop?.(); stops.splice(0).forEach(s => s()); for (const s of panelStops.values()) s(); panelStops.clear(); },
    render(ctx: ModuleContext): UiNode {
      const m = model(ctx);
      if (!focused || (!visible[focused] && !open[focused])) focused = m.sections.flatMap(s => s.items).find(i => i.active && !i.id.includes(":"))?.id || null;
      m.focused = focused;
      m.effects = effects;
      return haloRail(m);
    },
    async onEvent(ctx, ev) {
      const v: any = ev.value;
      switch (ev.action) {
        case "toggle":
          if (!buttons().some((panel) => panel.id === v)) break;
          if (Array.isArray(children[v])) {
            open[v] = !expanded || !open[v];
            if (open[v]) focused = v;
            if (!expanded) setExpanded(ctx, true);
            ctx.ui.invalidate();
          } else togglePanel(ctx, v);
          break;
        case "group": open[v] = !(open[v] ?? (typeof v === "string" && v.startsWith("project:") && projects?.projects.some(p => `project:${p.id}` === v && (p.id === projects!.selected || p.tasks.some((t: any) => t.id === projects!.selected))))); ctx.ui.invalidate(); break;
        case "child": if (v && typeof v.panel === "string") ctx.events.emit(`${id}.panelChild`, { panel: v.panel, child: v.child }); break;
        case "expand": setExpanded(ctx, v === true); break;
        case "query": query = typeof v === "string" ? v : ""; ctx.ui.invalidate(); break;
        case "queryClear": query = ""; ctx.ui.invalidate(); break;
        case "querySubmit": {
          const first = model(ctx).sections.flatMap(s => s.items)[0];
          query = "";
          if (first) await mod.onEvent!(ctx, { action: first.action, value: first.value } as any);
          ctx.ui.invalidate(); break;
        }
        case "workspace": if (typeof v === "string") request(ctx, "selectWorkspace", { workspaceId: v }); break;
        case "addProject": showPanel(ctx, "projects"); request(ctx, "addProject"); break;
        case "toggleProjectPanel": togglePanel(ctx, "projects"); ctx.ui.invalidate(); break;
        case "openPanel": if (typeof v === "string") showPanel(ctx, v); ctx.ui.invalidate(); break;
        case "newChat": showPanel(ctx, "ai"); request(ctx, "newChat"); break;
        case "chat": showPanel(ctx, "ai"); request(ctx, "selectConversation", { id: v }); break;
        case "history": showPanel(ctx, "ai"); request(ctx, "openHistory"); break;
        case "selectGroup": if (typeof v === "string") request(ctx, "selectGroup", { id: v }); break;
        case "openAgent":
          if (typeof v?.dismiss === "string") { finishedRows.delete(v.dismiss); ctx.ui.invalidate(); }
          if (v && typeof v.workspaceId === "string") {
            showPanel(ctx, v.kind === "workflow" ? "workflows" : "ai");
            request(ctx, "openAgent", { kind: v.kind, id: v.id, workspaceId: v.workspaceId, workflow: v.workflow ?? null });
          }
          break;
        case "usage": if (typeof v === "string") request(ctx, "refreshUsage", { provider: v }); break;
        case "account": accountOpen = v === true; ctx.ui.invalidate(); break;
        case "open":
          accountOpen = false; ctx.ui.invalidate();
          if (typeof v === "string") request(ctx, "open", { target: v });
          break;
        case "darkMode": request(ctx, "appearance", { mode: v === true ? "dark" : "light" }); break;
      }
    },
  };
  return mod;
}
