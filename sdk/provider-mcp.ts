/** Provider-declared workaround for clients that ignore per-session stdio MCP servers. */
export interface McpLaunchOptions { flag: string; stdioType?: string; tools?: string[] }
const CONFIG_ENV = "HATO_MCP_LAUNCH_CONFIG";
// Runs on the agent's machine. Credentials travel in the spawn environment, then in a
// private temporary file, never in argv or in a workspace/global configuration file.
export const MCP_LAUNCH_WRAPPER = `
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),cp=require('node:child_process');
let dir;
const cleanup=()=>{if(dir){try{fs.rmSync(dir,{recursive:true,force:true});}catch{}dir=undefined;}};
process.on('exit',cleanup);
try {
 const config=process.env.${CONFIG_ENV};delete process.env.${CONFIG_ENV};
 if(!config)throw new Error('missing configuration');
 const [command,flag,...args]=process.argv.slice(1);
 dir=fs.mkdtempSync(path.join(os.tmpdir(),'hato-mcp-'));fs.chmodSync(dir,0o700);
 const file=path.join(dir,'servers.json');fs.writeFileSync(file,config,{mode:0o600});
 const child=cp.spawn(command,[...args,flag,'@'+file],{stdio:'inherit',env:process.env});
 for(const signal of ['SIGTERM','SIGINT','SIGHUP'])process.on(signal,()=>child.kill(signal));
 child.on('error',()=>{cleanup();process.stderr.write('Hato MCP launcher could not start the provider\\n');process.exit(1);});
 child.on('exit',code=>{cleanup();process.exit(code===null?1:code);});
} catch {cleanup();process.stderr.write('Hato MCP launcher could not prepare the private configuration\\n');process.exit(1);}
`;

export function providerMcpLaunch(options: McpLaunchOptions | undefined, executable: string, args: string[], env: Record<string, string>, servers: any[], nodeExecutable = "node") {
  const stdio = options ? servers.filter(server => (server.type || server.transport || "stdio") === "stdio") : [];
  if (!options || !stdio.length) return { executable, args, env, sessionServers: servers, wrapped: false };
  if (!/^--[a-z][a-z0-9-]*$/i.test(options.flag)) throw new Error("Invalid provider MCP launch flag");
  const configs: Record<string, any> = Object.create(null);
  for (const server of stdio) {
    if (typeof server.name !== "string" || typeof server.command !== "string" || !Array.isArray(server.args)) throw new Error("Invalid stdio MCP server");
    if (Object.prototype.hasOwnProperty.call(configs, server.name)) throw new Error(`Duplicate MCP server name: ${server.name}`);
    configs[server.name] = { type: options.stdioType || "local", command: server.command, args: server.args,
      env: Object.fromEntries((server.env || []).map((pair: any) => [pair.name, pair.value])),
      ...(options.tools ? { tools: options.tools } : {}) };
  }
  return { executable: nodeExecutable, args: ["-e", MCP_LAUNCH_WRAPPER, "--", executable, options.flag, ...args],
    env: { ...env, [CONFIG_ENV]: JSON.stringify({ mcpServers: configs }) },
    sessionServers: servers.filter(server => !stdio.includes(server)), wrapped: true };
}
