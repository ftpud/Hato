// Seed only disposable snapshot data; never run against your everyday app data.
export default {id:"__driver",moduleApiVersion:1,async activate(ctx){

 await globalThis.__testOp("test.approvals",{policy:"allow"});
 const repo=ctx.host.env.info().repoRoot;
 await globalThis.__testOp("test.pluginInstallMany",{paths:["library","library-panel"].map(id=>`${repo}/Hato-plugins/packages/library/0.1.1/${id}`)});
 for(const id of ["library","library-panel"])await globalThis.__testOp("test.pluginEnable",{id});
 const mode=await globalThis.__testOp("test.env",{name:"HATO_LIBRARY_SNAPSHOT"});
 if(mode==="empty")return;
 const add=async(name,kind,description,files)=>{
  let e=await ctx.modules.call("library","save",{scope:"global",kind,name,description,expectedRevision:null});
  for(const [path,content] of Object.entries(files))e=await ctx.modules.call("library","save",{scope:"global",id:e.id,path,content,expectedRevision:e.revision});
  return e;
 };
 const entry=await add("Release readiness","skill","Review a release, its checks and rollback plan.",{
  "SKILL.md":"# Release readiness\n\nUse this skill when preparing a release.\n\n## Before publishing\n\n- Review the changes and compatibility.\n- Run the relevant checks.\n- Read [the release checklist](references/checklist.md).\n\nOnly load references when needed. Scripts are available for review in the file tree.\n",
  "references/checklist.md":"# Release checklist\n\nRecord the version, validation evidence and rollback plan.\n",
  "scripts/check.sh":"#!/bin/sh\nset -eu\nnpm run typecheck\nnpm test\n"
 });
 await add("Architecture reviewer","agent","Review boundaries, hot reload and persistence.",{"AGENT.md":"# Architecture reviewer\n\nReview module boundaries and keep native changes small.\n"});
 await globalThis.__testOp("test.event",{module:"library-panel",event:{action:"select",key:"entries",rowKey:mode==="script"?`file:${entry.id}:scripts/check.sh`:entry.id,inputs:{}}});
}};
