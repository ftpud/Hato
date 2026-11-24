// Smoke test: agent progress reaches the Assistant rail through both channels.
//  1. report_progress over the real desktop MCP endpoint (agents with Hato's tools).
//  2. Reply markers from a real ACP chat with Hato's tools turned off (fixture provider).
// Run: tests/integration/run-integration.sh tests/integration/progress-smoke.js
/** Every text in a rendered tree (labels, markdown, rows), tolerant of any node shape. */
function allText(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) { for (const n of node) allText(n, out); return out; }
  for (const key of ['text', 'label', 'title']) if (typeof node[key] === 'string') out.push(node[key]);
  for (const key of ['children', 'rows', 'items']) if (node[key]) allText(node[key], out);
  return out;
}

export default {
  id: '__driver', moduleApiVersion: 1,
  async activate(ctx) {
    const call = (m, method, args, timeoutMs = 120000) => ctx.modules.call(m, method, args, { timeoutMs });
    try {
      await T('test.approvals', { policy: 'allow' });
      const projects = await until(async () => { const tree = await call('projects', 'tree', {}); return tree.length ? tree : null; });
      if (!projects) throw new Error('No project');
      await call('workspace', 'select', { workspaceId: `project:${projects[0].id}:root` });
      const workspace = await until(() => T('test.state', { key: 'workspace.selected' }));
      if (!workspace) throw new Error('No workspace');

      // ---- 1. MCP tool --------------------------------------------------------------------------
      const endpoint = await call('internal-mcp', 'endpoint', { workspaceId: workspace.id, conversationId: 'progress-tool' });
      const env = Object.fromEntries(endpoint.server.env.map(item => [item.name, item.value]));
      const script = `const net=require('node:net');const messages=${JSON.stringify([
        { method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'progress-smoke', version: '1' } } },
        { method: 'tools/list' },
        { method: 'tools/call', params: { name: 'report_progress', arguments: { percent: 40, note: 'Tool step' } } },
        { method: 'tools/call', params: { name: 'report_progress', arguments: { percent: 'lots' } } },
      ])};
const socket=net.connect({host:'127.0.0.1',port:${Number(env.HATO_MCP_PORT)}});let buffer='',index=0;const responses=[];
const send=()=>socket.write(JSON.stringify({jsonrpc:'2.0',id:index+1,...messages[index]})+'\\n');
socket.setTimeout(15000,()=>{console.error('timeout');process.exit(1)});
socket.on('connect',()=>{socket.write(JSON.stringify({hatoAuth:${JSON.stringify(env.HATO_MCP_TOKEN)}})+'\\n');send()});
socket.on('data',chunk=>{buffer+=chunk;let at;while((at=buffer.indexOf('\\n'))>=0){const line=buffer.slice(0,at);buffer=buffer.slice(at+1);if(!line)continue;const r=JSON.parse(line);if(!r.id)continue;responses.push(r);index++;if(index<messages.length)send();else{console.log(JSON.stringify(responses));socket.end()}}});
socket.on('error',e=>{console.error(e.message);process.exit(1)});`;
      const run = await T('test.exec', { argv: ['node', '-e', script] });
      if (run.code !== 0) throw new Error(run.stderr);
      const [init, list, report, bad] = JSON.parse(run.stdout).map(r => r.result || r.error);
      check('MCP starting instructions ask for progress', /report_progress/.test(init?.instructions || ''), init?.instructions);
      check('report_progress is advertised', list?.tools?.some(t => t.name === 'report_progress'));
      check('report_progress accepts a report', report && !report.isError, report);
      check('invalid percent is rejected', bad?.isError === true, bad);
      const toolState = await until(async () => (await T('test.state', { key: 'internal-mcp.progress' }))?.['progress-tool']);
      check('tool report is published for the sidebar', toolState?.percent === 40 && toolState?.note === 'Tool step', toolState);

      // ---- 2. Reply markers from a chat without Hato's tools ------------------------------------
      const node = (await T('test.exec', { argv: ['node', '-p', 'process.execPath'] })).stdout.trim();
      const repo = (await T('test.env', { name: 'PWD' })) || '';
      const fixture = `${(await T('test.exec', { argv: ['pwd'] })).stdout.trim() || repo}/tests/integration/fixtures/progress-agent.mjs`;
      await call('acp', 'saveProfile', { profile: { id: 'progress-agent', machineId: 'local', provider: 'custom', name: 'Progress fixture', executable: node, args: [fixture], envRefs: {}, enabled: true } });
      const conv = await call('ai-sessions', 'create', { workspaceId: workspace.id, profileId: 'progress-agent' });
      await call('ai-sessions', 'setMcp', { conversationId: conv.id, internal: false });
      await call('ai-sessions', 'connect', { conversationId: conv.id }, 120000);
      await call('sidebar', 'setExpanded', { expanded: true });
      const sending = call('ai-sessions', 'send', { conversationId: conv.id, text: 'Run the smoke step' }, 60000).catch(e => e);

      const markerState = await until(async () => (await T('test.state', { key: 'ai-sessions.progress' }))?.[conv.id], 8000);
      check('a marker split across chunks becomes progress', markerState?.percent === 40 && markerState?.note === 'Smoke step', markerState);
      const working = await T('test.state', { key: 'ai-sessions.working' });
      check('the chat is listed as working', Array.isArray(working) && working.some(w => w.id === conv.id), working);
      const row = await until(async () => find(await T('test.render', { module: 'sidebar' }), n => n.key === `task:working:chat:${conv.id}`), 4000);
      const bar = row && find(row, n => n.type === 'progress');
      check('the Assistant rail fills the bar to 40%', bar?.value === 0.4, bar);
      check('the rail shows the reported step', /^Smoke step/.test(find(row, n => n.key === 'detail')?.text || ''), row && find(row, n => n.key === 'detail'));
      let chat = allText(await T('test.render', { module: 'ai' })).join('\n');
      check('the prompt carried the marker instruction', chat.includes('instruction:yes'), chat.slice(0, 400));
      check('the chat shows the reply without the marker', chat.includes('Working on it.') && !/hato-prog/.test(chat), chat.slice(0, 400));

      await sending;
      const done = await until(async () => !((await T('test.state', { key: 'ai-sessions.working' })) || []).some(w => w.id === conv.id), 10000);
      check('the chat leaves the working list when the turn ends', done);
      chat = allText(await T('test.render', { module: 'ai' })).join('\n');
      check('the finished reply has no markers', chat.includes('Finished.') && !/hato-prog/.test(chat), chat.slice(0, 400));
      const rail = await T('test.render', { module: 'sidebar' });
      check('the finished chat drops out of the Working section', !find(rail, n => n.key === `task:working:chat:${conv.id}`));

      // ---- 3. Background agent without workspace tools (local daemon, agent-runner) ------------
      await call('persistence', 'acpProfiles.upsert', { profile: { id: 'progress-bg', machineId: '*', provider: 'fixture', name: 'Progress fixture', executable: node, args: [fixture], envRefs: {}, enabled: true } });
      const agent = await call('persistent-agents', 'create', { workspaceId: workspace.id, name: 'Progress agent', profileId: 'progress-bg', mcps: [] }, 240000);
      check('background agent starts on the local daemon', agent?.status === 'ready', agent);
      await call('persistent-agents', 'send', { workspaceId: workspace.id, id: agent.id, text: 'Run the background step' }, 60000);
      const bg = await until(async () => ((await T('test.state', { key: 'persistent-agents.working' })) || []).find(w => w.id === agent.id && w.progress), 15000, 250);
      check('agent-runner turns the marker into working-agent progress', bg?.progress?.percent === 40 && bg?.progress?.note === 'Smoke step', bg);
      const bgRow = await until(async () => find(await T('test.render', { module: 'sidebar' }), n => n.key === `task:working:agent:${agent.id}`), 6000);
      check('the Assistant rail fills the background agent bar', find(bgRow, n => n.type === 'progress')?.value === 0.4, bgRow && find(bgRow, n => n.type === 'progress'));
      const view = await until(async () => { const v = await call('persistent-agents', 'view', { workspaceId: workspace.id, id: agent.id }); return v.session.status === 'ready' ? v : null; }, 15000, 250);
      const first = view?.messages?.find(m => m.role === 'user')?.text || '';
      check('the background prompt carried the marker instruction', /hato-progress/.test(first) || view?.messages?.some(m => /instruction:yes/.test(m.text || '')), view?.messages?.map(m => m.text).slice(0, 3));
      check('the background turn finishes', !!view, view?.session?.status);
    } catch (e) {
      check('smoke test ran to the end', false, String(e && e.message || e));
    }
    await finish();
  },
};
