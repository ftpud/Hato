import type { ModuleContext } from './types';
import { errMsg } from './runtime';
export interface McpScope { conversationId: string; workspaceId: string; machineId: string }
export interface McpToolDefinition {
  name: string; title?: string; description: string; inputSchema: Record<string, any>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
  timeoutMs?: number;
}
export interface ModuleMcpTool extends McpToolDefinition { handler(args: any, scope: McpScope): Promise<any> | any }
/** Publish commands under the provider's own namespace. The broker owns user permissions.
 * Requests can only originate on internal-mcp's kernel-enforced event namespace.
 * Handlers use this module's existing capabilities; no arbitrary cross-module RPC grant is added.
 */
export function exportMcpTools(ctx: ModuleContext, title: string, tools: ModuleMcpTool[]) {
  let pending = 0;
  const publish = () => ctx.state.set(`${ctx.moduleId}.mcp`, {
    title, generation: ctx.generation, tools: tools.map(({ handler: _handler, ...definition }) => definition),
  });
  ctx.events.on('internal-mcp.call', async (request: any) => {
    if (request?.module !== ctx.moduleId || request.generation !== ctx.generation || typeof request.id !== 'string') return;
    const tool = tools.find(tool => tool.name === request.tool);
    pending++;
    try {
      if (!tool) throw new Error('Unknown module MCP command');
      const scope = request.scope;
      if (!scope || typeof scope.workspaceId !== 'string' || typeof scope.conversationId !== 'string' || typeof scope.machineId !== 'string') throw new Error('Missing authenticated MCP scope');
      const result = await tool.handler(request.args || {}, scope);
      ctx.events.emit(`${ctx.moduleId}.mcp.result`, { id: request.id, generation: ctx.generation, result: result === undefined ? null : result });
    } catch (e) { ctx.events.emit(`${ctx.moduleId}.mcp.result`, { id: request.id, generation: ctx.generation, error: errMsg(e) }); }
    finally { pending--; }
  });
  publish();
  return { publish, pending: () => pending };
}
