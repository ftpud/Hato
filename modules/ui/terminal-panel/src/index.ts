// Multiple resizable blocks; each block's tabs attach to independent kernel-owned PTYs.
import type { AppModule, ModuleContext, UiNode } from "../../../../sdk/types";
import { sidebarIcons } from "../../../../sdk/sidebar-icons";
import { terminalIcons } from "../../../../sdk/terminal-icons";
import { terminalTabStyle, tabButtonStyle } from "../../../../sdk/tab-style";
import { errMsg } from "../../../../sdk/runtime";
import { blocks, firstBlock, remove, replace, resize, restore, type Block, type Node } from "./model";
let ws: any = null;
let layout: Node = firstBlock();
let epoch = 0;
let error: string | null = null;
let terminals = new Map<string, any>();
let loading = new Map<string, Promise<void>>();
let busy = new Set<string>();
const uid = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
async function attach(ctx: ModuleContext, block: Block, restart = false) {
  if (!ws) return;
  const workspaceId = ws.id, version = epoch, key = block.active;
  if (loading.has(key)) return loading.get(key);
  if (!restart && terminals.has(key)) return;
  terminals.delete(key);
  const request = (async () => {
    try {
      const result = await ctx.modules.call("terminals", restart ? "restart" : "attach", { workspaceId, key }, { timeoutMs: 60000 });
      if (version === epoch && blocks(layout).some(b => b.keys.includes(key))) terminals.set(key, result);
    } catch (e) { if (version === epoch) error = errMsg(e); }
    finally { if (version === epoch) { loading.delete(key); ctx.ui.invalidate(); } }
  })();
  loading.set(key, request); ctx.ui.invalidate();
  await request;
}
async function save(ctx: ModuleContext) {
  const first = blocks(layout)[0];
  await ctx.modules.call("workspace", "view.patch", { workspaceId: ws.id, patch: { ui: {
    terminalLayout: JSON.parse(JSON.stringify(layout)), terminalTabs: { keys: [...first.keys], active: first.active },
  } } });
}
function reset(saved?: any) {
  epoch++; terminals = new Map(); loading = new Map(); busy = new Set(); error = null;
  layout = restore(saved || ws?.view?.ui?.terminalLayout, ws?.view?.ui?.terminalTabs);
}
async function attachVisible(ctx: ModuleContext) { await Promise.all(blocks(layout).map(block => attach(ctx, block))); }
function renderNode(node: Node): UiNode {
  if (node.kind === "split") return { type: "split", key: node.id, direction: node.direction, sizes: node.sizes,
    minSize: node.direction === "horizontal" ? 160 : 100, resizeAction: "resizeBlocks", grow: true, children: node.children.map(renderNode) };
  const all = blocks(layout), locked = !ws || busy.has(node.id) || loading.has(node.active);
  const action = (name: string) => `${name}:${node.id}`;
  const control = (name: string, tooltip: string, icon: "plus" | "refresh" | "x"): UiNode => ({ type: "button", key: name, text: "", icon,
    action: action(name), small: true, variant: "ghost", tooltip, disabled: locked });
  return { type: "column", key: node.id, gap: 3, padding: 4, grow: true, children: [
    { type: "row", key: "tabs", gap: 3, wrap: true, children: [
      ...node.keys.map((key): UiNode => ({ type: "row", key, gap: 0, style: terminalTabStyle(node.active === key), children: [
        { type: "button", key: "select", iconSvg: sidebarIcons.terminal, text: `Terminal ${all.flatMap(b => b.keys).indexOf(key) + 1}`,
          action: `select:${key}`, small: true, variant: "ghost", style: tabButtonStyle(node.active === key, true), disabled: locked },
        { type: "button", key: "close", text: "", icon: "x", action: `close:${key}`, small: true, variant: "ghost",
          style: tabButtonStyle(node.active === key, true), tooltip: "Close terminal", disabled: locked },
      ] })),
      control("new", "New terminal tab", "plus"),
      ...(["splitRight", "splitDown"] as const).map((name): UiNode => ({ type: "button", key: name, text: "", iconSvg: terminalIcons[name],
        action: action(name), small: true, variant: "ghost", tooltip: name === "splitRight" ? "Split right" : "Split down", disabled: locked })),
      control("restart", "Restart active shell", "refresh"),
      ...(all.length > 1 ? [control("closeBlock", "Close block and its terminal tabs", "x")] : []),
    ] },
    { type: "terminal", key: `term:${node.active}`, pty: terminals.get(node.active)?.pty || null,
      placeholder: ws ? "Starting shell…" : "Select a workspace.", grow: true },
  ] };
}
const mod: AppModule = {
  id: "terminal-panel", moduleApiVersion: 1,
  async activate(ctx, prev) {
    ws = ctx.state.get("workspace.selected") || null;
    reset(prev && prev.workspaceId === ws?.id ? prev.layout : undefined);
    ctx.state.watch("workspace.selected", (value: any) => {
      const changed = ws?.id !== value?.id; ws = value;
      if (changed) { reset(); void attachVisible(ctx); ctx.ui.invalidate(); }
    });
    ctx.events.on("terminals.changed", () => ctx.ui.invalidate());
    await attachVisible(ctx);
  },
  snapshot: () => ({ workspaceId: ws?.id || null, layout }),
  canSwap: async () => ({ ok: !busy.size && !loading.size, reason: "Terminal operation in progress" }),
  render(): UiNode { return { type: "column", key: "terminal-root", grow: true, children: [
    ...(error ? [{ type: "status", key: "err", text: error, level: "error" } as UiNode] : []), renderNode(layout),
  ] }; },
  async onEvent(ctx, ev) {
    if (!ws) return;
    if (ev.action === "resizeBlocks") {
      const value: any = ev.value;
      layout = resize(layout, ev.key, Array.isArray(value?.sizes) ? value.sizes : []);
      try { await save(ctx); } catch (e) { error = errMsg(e); }
      ctx.ui.invalidate(); return;
    }
    const [name, target] = ev.action.split(":");
    const block = name === "select" || name === "close" ? blocks(layout).find(b => b.keys.includes(target)) : blocks(layout).find(b => b.id === target) || (!target ? blocks(layout)[0] : undefined);
    if (!block || busy.has(block.id) || loading.has(block.active)) return;
    const version = epoch, workspaceId = ws.id;
    busy.add(block.id); error = null; ctx.ui.invalidate();
    try {
      if (name === "restart") { await attach(ctx, block, true); return; }
      if (name === "new") {
        const key = uid("shell"); layout = replace(layout, block.id, { ...block, keys: [...block.keys, key], active: key });
      } else if (name === "select") layout = replace(layout, block.id, { ...block, active: target });
      else if (name === "splitRight" || name === "splitDown") {
        const key = uid("shell");
        const next: Block = { kind: "block", id: uid("block"), keys: [key], active: key };
        layout = replace(layout, block.id, { kind: "split", id: uid("split"), direction: name === "splitRight" ? "horizontal" : "vertical", sizes: [0.5, 0.5], children: [block, next] });
      } else if (name === "close" || name === "closeBlock") {
        if (name === "closeBlock" && blocks(layout).length === 1) return;
        const closing = name === "closeBlock" ? block.keys : [target];
        for (const key of closing) {
          await ctx.modules.call("terminals", "close", { workspaceId, key });
          if (version !== epoch) return;
          terminals.delete(key);
        }
        const keys = block.keys.filter(key => !closing.includes(key));
        layout = keys.length ? replace(layout, block.id, { ...block, keys, active: keys.includes(block.active) ? block.active : keys[Math.min(block.keys.indexOf(target), keys.length - 1)] || keys[0] }) : remove(layout, block.id) || firstBlock();
      } else return;
      await save(ctx);
      if (version === epoch) await attachVisible(ctx);
    } catch (e) { if (version === epoch) error = errMsg(e); }
    finally { if (version === epoch) { busy.delete(block.id); ctx.ui.invalidate(); } }
  },
};
export default mod;
