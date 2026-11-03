export default {id:"__driver",moduleApiVersion:1,async activate(ctx){
 try{
  await T("test.approvals",{policy:"allow"});
  const render=()=>T("test.render",{module:"mcp-panel"});
  await ev("workspace-layout","dock",{value:"mcps"});
  let tree=await until(async()=>find(await render(),n=>n.type==="tree"&&n.rows.some(r=>r.key==="internal-remote-mcp")));
  check("standalone MCP panel lists built-ins without workspace",!!tree);
  await ev("mcp-panel","add");
  await ev("mcp-panel","save",{inputs:{name:"Panel fixture",command:"node",args:'["fixture.js"]',env:'{"TEST_TOKEN":"test-value"}'}});
  tree=await until(async()=>find(await render(),n=>n.type==="tree"&&n.rows.some(r=>r.label==="Panel fixture")));
  const id=tree.rows.find(r=>r.label==="Panel fixture").key;
  check("MCP panel adds server",!!id);
  await ev("mcp-panel","select",{rowKey:id});await ev("mcp-panel","configure");
  check("configuration editor preserves command",find(await render(),n=>n.key==="command")?.value==="node");
  await ev("mcp-panel","enabled",{value:false});
  await ev("mcp-panel","save",{inputs:{name:"Edited fixture",command:"node",args:'["updated.js"]',env:'{}'}});
  const saved=(await ctx.modules.call("persistent-agents","listMcps")).find(s=>s.id===id);
  check("configuration update retains id and enabled state",saved?.name==="Edited fixture"&&saved?.enabled===false&&saved?.args[0]==="updated.js");
  await ev("mcp-panel","remove");await ev("mcp-panel","confirmRemove");
  check("MCP panel removes server",!(await ctx.modules.call("persistent-agents","listMcps")).some(s=>s.id===id));
 }catch(e){check("uncaught",false,`${e.message}\n${e.stack}`);}await finish();
}};
