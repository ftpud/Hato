import type { Handle, ModuleContext } from '../../../../sdk/types';
import type { McpScope, ModuleMcpTool } from '../../../../sdk/mcp';
const shellQuote = (text: string) => "'" + text.replace(/'/g, "'\\''") + "'";
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
export function plainOutput(text: string): string {
  return text.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\r\n/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
}
export function terminalTools(ctx: ModuleContext, saved?: [string, string[]][]) {
  const known = new Map<string, Set<string>>((saved || []).map(([workspace, keys]) => [workspace, new Set(keys)]));
  const running = new Map<Handle, string>();
  const remember = (workspace: string, key: string) => { const keys = known.get(workspace) || new Set<string>(); keys.add(key); known.set(workspace, keys); };
  async function check(scope: McpScope) {
    const desc = await ctx.modules.call('workspace', 'resolve', { workspaceId: scope.workspaceId });
    if (desc.machineId !== scope.machineId) throw new Error('MCP workspace machine has changed; reconnect the agent');
  }
  async function list(scope: McpScope) {
    await check(scope);
    const view = await ctx.modules.call('workspace', 'view.get', { workspaceId: scope.workspaceId });
    const tabs: { key: string; blockId: string | null; active: boolean }[] = [];
    const seen = new Set<string>();
    function add(key: string, blockId: string | null, active: boolean) { if (typeof key === 'string' && !seen.has(key)) { seen.add(key); tabs.push({ key, blockId, active }); } }
    function visit(node: any, depth = 0) {
      if (!node || depth > 32) return;
      if (node.kind === 'block' && Array.isArray(node.keys)) for (const key of node.keys) add(key, node.id, node.active === key);
      else if (Array.isArray(node.children)) node.children.forEach((child: any) => visit(child, depth + 1));
    }
    visit(view?.ui?.terminalLayout);
    if (!tabs.length && Array.isArray(view?.ui?.terminalTabs?.keys)) for (const key of view.ui.terminalTabs.keys) add(key, 'block-main', key === view.ui.terminalTabs.active);
    for (const key of known.get(scope.workspaceId) || []) if (await ctx.host.resources.lookup(`pty:${scope.workspaceId}:${key}`)) add(key, null, !tabs.length);
    return Promise.all(tabs.map(async (tab, index) => {
      const handle = await ctx.host.resources.lookup(`pty:${scope.workspaceId}:${tab.key}`);
      const info = handle ? await ctx.host.pty.info(handle) : null;
      if (info && info.machineId !== scope.machineId) throw new Error('Terminal belongs to another machine; restart it in the current workspace');
      return { ...tab, title: `Terminal ${index + 1}`, machineId: scope.machineId, cwd: info?.cwd || null, exit: info?.exit || null,
        status: !handle ? 'not_started' : info?.exit ? 'exited' : running.has(handle) ? 'running_command' : 'open' };
    }));
  }
  async function target(scope: McpScope, args: any) {
    const tabs = await list(scope);
    const tab = args.tab === undefined ? tabs.find(tab => tab.active) || tabs[0] : tabs.find(tab => tab.key === args.tab);
    if (!tab) throw new Error('Unknown terminal tab in this workspace; use list_tabs first');
    const handle = await ctx.host.resources.lookup(`pty:${scope.workspaceId}:${tab.key}`);
    if (!handle) throw new Error('Terminal tab is not running; open it in the terminal panel first');
    return { handle, tab: tab.key };
  }
  function integer(value: any, fallback: number, min: number, max: number) {
    if (value === undefined) return fallback;
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Expected an integer from ${min} to ${max}`);
    return value;
  }
  const schema = (properties: Record<string, any>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
  const tabProperty = { type: 'string', description: 'Tab key from list_tabs. Defaults to the first active tab.' };
  const tools: ModuleMcpTool[] = [
    { name: 'list_tabs', title: 'List terminal tabs', description: 'List terminal tabs and blocks in the authenticated workspace, including stable tab keys and status.',
      inputSchema: schema({}), annotations: { readOnlyHint: true }, handler: (_args, scope) => list(scope) },
    { name: 'tail', title: 'Read terminal output', description: 'Read bounded recent terminal output (up to 64 KiB), or output after a byte cursor. ANSI controls are removed. Reports truncated history.',
      inputSchema: schema({ tab: tabProperty, lines: { type: 'integer', minimum: 1, maximum: 500 }, cursor: { type: 'integer', minimum: 0 } }), annotations: { readOnlyHint: true },
      async handler(args, scope) {
        const { handle, tab } = await target(scope, args);
        const lines = integer(args.lines, 80, 1, 500);
        const cursor = args.cursor === undefined ? undefined : integer(args.cursor, 0, 0, Number.MAX_SAFE_INTEGER);
        const result = await ctx.host.pty.read(handle, { cursor, limitBytes: 65536 });
        const outputLines = plainOutput(result.text).split('\n');
        return { tab, ...result, truncated: result.truncated || outputLines.length > lines, text: outputLines.slice(-lines).join('\n') };
      } },
    { name: 'send', title: 'Send terminal input', description: 'Send input to an existing workspace terminal. Set enter=true to submit a line. May execute arbitrary commands. Send \\u0003 to interrupt.',
      inputSchema: schema({ tab: tabProperty, text: { type: 'string', maxLength: 65536 }, enter: { type: 'boolean' } }, ['text']), annotations: { destructiveHint: true },
      async handler(args, scope) {
        if (typeof args.text !== 'string' || args.text.length > 65536 || args.enter !== undefined && typeof args.enter !== 'boolean') throw new Error('Invalid terminal input');
        const { handle, tab } = await target(scope, args);
        if (running.has(handle) && args.text !== '\x03') throw new Error('A command is running in this tab; only an interrupt is allowed until it completes');
        await ctx.host.pty.write(handle, args.text + (args.enter ? '\r' : ''));
        if (args.text === '\x03') running.delete(handle);
        return { tab, sent: true };
      } },
    { name: 'run_and_wait_for_answer', title: 'Run terminal command and wait',
      description: 'Run a command through sh in an existing workspace terminal and wait for its exit marker. Inherits that terminal’s cwd/environment; changes inside the command do not alter the parent shell. Timeout leaves the command running. Use on a shell prompt, not inside an editor or another foreground program.',
      inputSchema: schema({ tab: tabProperty, command: { type: 'string', minLength: 1, maxLength: 32768 }, timeoutMs: { type: 'integer', minimum: 100, maximum: 120000 } }, ['command']),
      annotations: { destructiveHint: true }, timeoutMs: 150000,
      async handler(args, scope) {
        if (typeof args.command !== 'string' || !args.command.trim() || args.command.length > 32768 || args.command.includes('\0')) throw new Error('Invalid terminal command');
        const timeout = integer(args.timeoutMs, 30000, 100, 120000);
        const { handle, tab } = await target(scope, args);
        if (running.has(handle)) throw new Error('A command is already running in this tab');
        const nonce = crypto.randomHex(12);
        running.set(handle, nonce);
        const start = `\x1eHATO_START_${nonce}\x1f`, end = `\x1eHATO_END_${nonce}:`;
        let timedOut = false;
        try {
          let cursor = (await ctx.host.pty.read(handle, { limitBytes: 0 })).cursor;
          const script = `printf '\\036HATO_START_${nonce}\\037\\n'; ( eval ${shellQuote(args.command)} ); hato_result=$?; printf '\\036HATO_END_${nonce}:%s\\037\\n' "$hato_result"`;
          await ctx.host.pty.write(handle, `sh -c ${shellQuote(script)}\r`);
          const deadline = Date.now() + timeout;
          let buffer = '', started = false, truncated = false;
          while (Date.now() < deadline) {
            const output = await ctx.host.pty.read(handle, { cursor, limitBytes: 65536 });
            cursor = output.cursor; truncated ||= output.truncated; buffer += output.text;
            if (!started) { const index = buffer.indexOf(start); if (index >= 0) { started = true; buffer = buffer.slice(index + start.length); } }
            if (started) {
              const index = buffer.indexOf(end);
              if (index >= 0) {
                const match = /^(-?\d+)\x1f/.exec(buffer.slice(index + end.length));
                if (match) return { tab, exitCode: Number(match[1]), text: plainOutput(buffer.slice(0, index)).replace(/^\n/, ''), cursor, truncated, timedOut: false };
              }
            }
            if (buffer.length > 131072) { buffer = buffer.slice(-65536); truncated = true; }
            if (output.exit !== null) return { tab, exitCode: null, text: started ? plainOutput(buffer) : '', cursor, truncated, exited: output.exit, timedOut: false };
            await sleep(100);
          }
          timedOut = true;
          // Keep this tab reserved after timeout until the command exits or is explicitly interrupted.
          void (async () => {
            let suffix = buffer.slice(-256);
            try {
              while (running.get(handle) === nonce) {
                await sleep(250);
                const output = await ctx.host.pty.read(handle, { cursor, limitBytes: 65536 }); cursor = output.cursor;
                suffix = (suffix + output.text).slice(-65536);
                if (suffix.includes(end) || output.exit !== null) break;
                suffix = suffix.slice(-256);
              }
            } catch { /* Terminal was closed. */ }
            finally { if (running.get(handle) === nonce) running.delete(handle); }
          })();
          return { tab, exitCode: null, text: started ? plainOutput(buffer) : '', cursor, truncated, timedOut: true, running: true };
        } finally { if (!timedOut && running.get(handle) === nonce) running.delete(handle); }
      } },
  ];
  return { tools, remember, forget: (workspace: string, key: string) => known.get(workspace)?.delete(key), snapshot: () => [...known].map(([workspace, keys]) => [workspace, [...keys]]), running: () => running.size };
}
