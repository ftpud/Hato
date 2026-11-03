export default {
  id: '__driver', moduleApiVersion: 1,
  async activate(ctx) {
    try {
      await T('test.approvals', { policy: 'allow' });
      const projects = await until(async () => { const tree = await ctx.modules.call('projects', 'tree', {}); return tree.length ? tree : null; });
      if (!projects) throw new Error('No project');
      await ctx.modules.call('workspace', 'select', { workspaceId: `project:${projects[0].id}:root` });
      const workspace = await until(() => T('test.state', { key: 'workspace.selected' }));
      if (!workspace) throw new Error('No workspace');
      const terminal = await ctx.modules.call('terminals', 'attach', { workspaceId: workspace.id, key: 'main' });
      await until(async () => {
        const state = await T('test.state', { key: 'internal-mcp.settings' });
        return state?.sections?.some(section => section.key === 'mcp:terminals' && section.fields.length === 4);
      });
      const endpoint = await ctx.modules.call('internal-mcp', 'endpoint', { workspaceId: workspace.id, conversationId: 'mcp-test' });
      const env = Object.fromEntries(endpoint.server.env.map(item => [item.name, item.value]));
      async function request(messages) {
        const script = `const net=require('node:net'); const messages=${JSON.stringify([{method:'initialize',params:{protocolVersion:'2025-06-18',clientInfo:{name:'integration',version:'1'}}}, ...messages])};
const socket=net.connect({host:'127.0.0.1',port:${Number(env.HATO_MCP_PORT)}}); let buffer='',index=0;const responses=[];
const send=()=>socket.write(JSON.stringify({jsonrpc:'2.0',id:index+1,...messages[index]})+'\\n');
socket.setTimeout(15000,()=>{console.error('timeout');process.exit(1)});
socket.on('connect',()=>{socket.write(JSON.stringify({hatoAuth:${JSON.stringify(env.HATO_MCP_TOKEN)}})+'\\n');send()});
socket.on('data',chunk=>{buffer+=chunk;let at;while((at=buffer.indexOf('\\n'))>=0){const line=buffer.slice(0,at);buffer=buffer.slice(at+1);if(!line)continue;const response=JSON.parse(line);if(!response.id)continue;responses.push(response);index++;if(index<messages.length)send();else{console.log(JSON.stringify(responses));socket.end()}}});
socket.on('error',error=>{console.error(error.message);process.exit(1)});`;
        const result = await T('test.exec', { argv: ['node', '-e', script] });
        if (result.code !== 0) throw new Error(result.stderr);
        return JSON.parse(result.stdout).slice(1).map(response => response.result || response.error);
      }
      let response = await request([{ method: 'tools/list' }, { method: 'tools/call', params: { name: 'terminals__send', arguments: { text: 'should-not-send', enter: true } } }]);
      check('new module tools are hidden and calls denied by default', !response[0].tools.some(tool => tool.name.startsWith('terminals__')) && response[1].isError === true);
      await ctx.modules.call('settings', 'open', {});
      for (const command of ['list_tabs', 'tail', 'send', 'run_and_wait_for_answer']) {
        await ev('settings', 'change', { key: JSON.stringify(['internal-mcp', 'mcp:terminals', `terminals__${command}`]), value: true });
        const saved = await until(async () => {
          const policy = await ctx.modules.call('persistence', 'settings.get', { key: 'internal-mcp.permissions' });
          return policy?.[JSON.stringify(['terminals', command])] === true;
        });
        if (!saved) throw new Error('Permission did not save: ' + command);
      }
      response = await request([{ method: 'tools/list' },
        { method: 'tools/call', params: { name: 'terminals__list_tabs', arguments: {} } },
        { method: 'tools/call', params: { name: 'terminals__run_and_wait_for_answer', arguments: { command: "printf 'HATO_MCP_OUTPUT\\n'; exit 7", timeoutMs: 5000 } } },
        { method: 'tools/call', params: { name: 'terminals__tail', arguments: { lines: 80 } } },
        { method: 'tools/call', params: { name: 'terminals__send', arguments: { tab: 'foreign-tab', text: 'no' } } },
      ]);
      check('allowed commands are advertised dynamically', response[0].tools.filter(tool => tool.name.startsWith('terminals__')).length === 4);
      const tabs = JSON.parse(response[1].content[0].text);
      check('tab list is scoped to the session workspace', tabs.length >= 1 && tabs.some(tab => tab.key === 'main' && tab.machineId === workspace.machineId));
      const run = response[2].structuredContent;
      check('real PTY command returns output and exit status', !response[2].isError && run?.exitCode === 7 && run?.text.includes('HATO_MCP_OUTPUT'), response[2]);
      check('tail reads bounded native output', response[3].structuredContent?.text.includes('HATO_MCP_OUTPUT'));
      check('foreign terminal targets are rejected', response[4].isError === true);
      let ownership = false;
      try { await ctx.host.pty.read(terminal.pty, {}); } catch (error) { ownership = /owned by|owner/.test(error.message); }
      check('native output reads enforce handle ownership', ownership);
      await ev('settings', 'change', { key: JSON.stringify(['internal-mcp', 'mcp:terminals', 'terminals__send']), value: false });
      await until(async () => (await ctx.modules.call('persistence', 'settings.get', { key: 'internal-mcp.permissions' }))?.['["terminals","send"]'] === false);
      response = await request([{ method: 'tools/call', params: { name: 'terminals__send', arguments: { text: 'cached-name', enter: true } } }]);
      check('revoked commands reject cached tool names', response[0].isError === true);
      await ctx.modules.call('internal-mcp', 'revoke', { conversationId: 'mcp-test' });
    } catch (error) { check('uncaught', false, error.message + '\n' + error.stack); }
    await finish();
  },
};
