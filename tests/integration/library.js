// Real SQLite + panel round trip, isolated by run-integration.sh's data directory.
export default {id:"__driver",moduleApiVersion:1,async activate(ctx){
 const call=(method,args)=>ctx.modules.call("library",method,args);
 const event=(action,inputs={},extra={})=>T("test.event",{module:"library-panel",event:{action,key:action,inputs,...extra}});
 const find=(node,key)=>node?.key===key?node:(node?.children||[]).map(n=>find(n,key)).find(Boolean);
 try {
 await globalThis.__testOp("test.approvals",{policy:"allow"});
 const repo=ctx.host.env.info().repoRoot;
 await globalThis.__testOp("test.pluginInstallMany",{paths:["library","library-panel"].map(id=>`${repo}/Hato-plugins/packages/library/0.1.1/${id}`)});
 for(const id of ["library","library-panel"])await globalThis.__testOp("test.pluginEnable",{id});

  await event("new");await event("create",{name:"Integration skill",description:"A nested skill"});
  let entries=await call("list",{scope:"global"});check("panel creates an entry",entries.length===1);
  const id=entries[0].id;
  await event("startAdd");await event("addFile",{newPath:"references/deep/page.md"});
  check("panel adds nested Markdown",(await call("read",{scope:"global",id,path:"references/deep/page.md"})).content.startsWith("# page"));
  await event("startAdd");await event("addFile",{newPath:"scripts/check.sh"});
  const script=await call("read",{scope:"global",id,path:"scripts/check.sh"});
  check("shell files remain stored text",script.content.startsWith("#!/bin/sh"));
  const tree=await T("test.render",{module:"library-panel"});
  check("tree exposes nested files",find(tree,"entries").rows.some(r=>r.label==="check.sh"&&r.depth===2));
  check("panel no longer embeds an editor",!find(tree,"editor")&&!find(tree,"preview-scroll"));
  await event("expand",{},{rowKey:`dir:${id}:scripts`});
  check("folder collapse hides scripts",!find(await T("test.render",{module:"library-panel"}),"entries").rows.some(r=>r.label==="check.sh"));
  await event("askDeleteFile",{},{rowKey:`file:${id}:scripts/check.sh`,value:"scripts/check.sh"});await event("deleteFile");
  check("file deletion asks first and removes the file",!(await call("read",{scope:"global",id})).paths.includes("scripts/check.sh"));
  await event("askRemove");await event("remove");
  check("entry deletion removes its files",(await call("list",{scope:"global"})).length===0);
 }catch(e){check("uncaught",false,`${e.message}\n${e.stack}`);}
 await finish();
}};
