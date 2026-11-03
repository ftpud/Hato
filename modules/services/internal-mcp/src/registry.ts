import type { ModuleContext } from '../../../../sdk/types';
import type { McpScope, McpToolDefinition } from '../../../../sdk/mcp';
import { exportSettings } from '../../../../sdk/settings';
import { errMsg } from '../../../../sdk/runtime';
interface Registered extends McpToolDefinition { generation?: number; owner: string; localName: string; category: string }
export class McpRegistry {
  private active: string[] = [];
  private generations = new Map<string, number>();
  private accepted = new Map<string, any>();
  private catalog = new Map<string, Registered>();
  private policies: Record<string, boolean> = {};
  private watches = new Map<string, (() => void)[]>();
  private pending = new Map<string, { owner: string; generation?: number; resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private publish: () => void = () => {};
  private refreshVersion = 0;
  constructor(private ctx: ModuleContext, private builtins: McpToolDefinition[], private changed: () => void) {}
  async start() {
    const saved = await this.ctx.modules.call('persistence', 'settings.get', { key: 'internal-mcp.permissions' });
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) for (const [key, value] of Object.entries(saved)) if (typeof value === 'boolean') this.policies[key] = value;
    this.publish = exportSettings(this.ctx, () => {
      const groups = new Map<string, Registered[]>();
      for (const tool of this.catalog.values()) { const group = groups.get(tool.owner) || []; group.push(tool); groups.set(tool.owner, group); }
      return [...groups].map(([owner, tools]) => ({ key: `mcp:${owner}`, title: tools[0].category,
        description: 'Allow or deny individual internal MCP commands. New module commands start denied. Existing native capability checks still apply.',
        fields: tools.map(tool => ({ key: tool.name, label: tool.title || tool.localName, description: tool.description,
          type: 'toggle' as const, value: this.allowed(tool.name) })),
      }));
    }, async (_section, name, value) => {
      if (!this.catalog.has(name) || typeof value !== 'boolean') throw new Error('Invalid MCP permission');
      const tool = this.catalog.get(name)!;
      const next = { ...this.policies, [JSON.stringify([tool.owner, tool.localName])]: value };
      await this.ctx.modules.call('persistence', 'settings.set', { key: 'internal-mcp.permissions', value: next });
      this.policies = next; this.changed();
    }, { invalidate: false });
    this.ctx.events.on('kernel.modules.changed', () => { void this.refresh().catch(e => this.ctx.log.warn('MCP discovery', errMsg(e))); });
    await this.refresh();
  }
  async refresh() {
    const version = ++this.refreshVersion;
    const modules = await this.ctx.host.modules.list();
    if (version !== this.refreshVersion) return;
    this.active = modules.filter(module => module.active && module.id !== this.ctx.moduleId).map(module => module.id).sort();
    this.generations = new Map(modules.filter(module => module.active).map(module => [module.id, module.active!.generation]));
    for (const [id, stops] of this.watches) if (!this.active.includes(id)) { stops.forEach(stop => stop()); this.watches.delete(id); }
    for (const id of this.active) if (!this.watches.has(id)) this.watches.set(id, [
      this.ctx.state.watch(`${id}.mcp`, () => this.rebuild()),
      this.ctx.events.on(`${id}.mcp.result`, (reply: any) => {
        const waiting = this.pending.get(reply?.id);
        if (!waiting || waiting.owner !== id || waiting.generation !== reply.generation) return;
        clearTimeout(waiting.timer); this.pending.delete(reply.id);
        if (typeof reply.error === 'string') waiting.reject(new Error(reply.error)); else waiting.resolve(reply.result);
      }),
    ]);
    this.rebuild();
  }
  private rebuild() {
    const next = new Map<string, Registered>();
    for (const tool of this.builtins) next.set(tool.name, { ...tool, owner: 'internal-mcp', localName: tool.name, category: 'Module tools MCP' });
    for (const owner of this.active) {
      const published: any = this.ctx.state.get(`${owner}.mcp`);
      if (Array.isArray(published?.tools) && published.generation === this.generations.get(owner)) this.accepted.set(owner, published);
      const contribution = this.accepted.get(owner);
      if (!Array.isArray(contribution?.tools) || contribution.generation !== this.generations.get(owner)) continue;
      for (const tool of contribution.tools) {
        if (!tool || typeof tool.name !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(tool.name) || typeof tool.description !== 'string' || tool.inputSchema?.type !== 'object') continue;
        const name = `${owner}__${tool.name}`;
        if (name.length > 128 || next.has(name)) { this.ctx.log.warn('MCP command name collision or excessive length', name); continue; }
        next.set(name, { name, generation: contribution.generation, localName: tool.name, owner, category: `${typeof contribution.title === 'string' ? contribution.title : owner} MCP`,
          title: typeof tool.title === 'string' ? tool.title : tool.name, description: tool.description,
          inputSchema: tool.inputSchema, annotations: tool.annotations, timeoutMs: tool.timeoutMs });
      }
    }
    this.catalog = next; this.publish(); this.changed();
  }
  allowed(name: string) {
    const tool = this.catalog.get(name);
    if (!tool) return false;
    const key = JSON.stringify([tool.owner, tool.localName]);
    return Object.prototype.hasOwnProperty.call(this.policies, key) ? this.policies[key] : tool.owner === 'internal-mcp';
  }
  assertAllowed(name: string) { if (!this.allowed(name)) throw new Error(`MCP command is denied or unavailable: ${name}. Enable it in Settings.`); }
  list() {
    return [...this.catalog.values()].filter(tool => this.allowed(tool.name)).map(({ owner: _owner, localName: _localName, category: _category, timeoutMs: _timeout, generation: _generation, ...tool }) => tool);
  }
  call(name: string, args: any, scope: McpScope): Promise<any> {
    this.assertAllowed(name);
    const tool = this.catalog.get(name)!;
    if (tool.owner === 'internal-mcp') throw new Error('Built-in command uses the core MCP dispatcher');
    const id = crypto.randomHex(16);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Module MCP command timed out')); }, Math.max(1000, Math.min(180000, Number(tool.timeoutMs) || 30000)));
      this.pending.set(id, { owner: tool.owner, generation: tool.generation, resolve, reject, timer });
      try { this.ctx.events.emit('internal-mcp.call', { id, module: tool.owner, generation: tool.generation, tool: tool.localName, args, scope }); }
      catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }
  stop() {
    this.watches.forEach(stops => stops.forEach(stop => stop())); this.watches.clear();
    this.pending.forEach(waiting => { clearTimeout(waiting.timer); waiting.reject(new Error('MCP registry closed')); }); this.pending.clear();
  }
}
