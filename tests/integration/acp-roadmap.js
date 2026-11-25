// Native argv PTY + persistence replay, using throwaway application data only.
export default { id: '__driver', moduleApiVersion: 1, async activate(ctx) {
 try {
  await T('test.approvals',{policy:'allow'});
  const root='/tmp';
  const grant=await ctx.host.capabilities.request({kind:'process',root,target:{kind:'local'}});
  const pty=await ctx.host.pty.spawn(grant.grant,{target:{kind:'local'},executable:'/bin/sh',args:['-c','test -t 0 && test -t 1 && test -z "${HOME+x}" && printf "%s" "$1"','verification','argv ; $(false) is literal'],cwd:root,envRemove:['HOME'],columns:90,rows:20});
  const output=await until(async()=>{const r=await ctx.host.pty.read(pty.handle,{limitBytes:4096});return r.exit?r:null;});
  check('argv terminal is interactive',output&&output.exit==='exited with code 0',output);
  await ctx.host.pty.close(pty.handle);
  const literal=await ctx.host.pty.spawn(grant.grant,{executable:'/bin/sh',args:['-c','test -t 0 && test -t 1 && printf "%s" "$1"','verification','argv ; $(false) is literal'],cwd:root,columns:90,rows:20});
  const data=await until(async()=>{const r=await ctx.host.pty.read(literal.handle,{limitBytes:4096});return r.exit?r:null;});
  check('PTY argv stays literal without shell interpolation',data&&data.text.includes('argv ; $(false) is literal')&&data.exit==='exited with code 0',data);
  await ctx.host.pty.close(literal.handle);
  let denied=false;try{await ctx.host.pty.spawn(grant.grant,{executable:'/bin/sh',args:[],cwd:'/',columns:90,rows:20});}catch(e){denied=/outside/.test(e.message);}
  check('PTY process scope rejects cwd escape',denied);
  await ctx.host.capabilities.release(grant.grant);
  const call=(method,args)=>ctx.modules.call('persistence',method,args);
  const cid='replay-verification';
  await call('conversations.insert',{conversation:{id:cid,workspaceId:'verification',acpProfileId:'fixture',title:'Replay verification'}});
  for(let i=1;i<=120;i++)await call('messages.upsert',{conversationId:cid,id:'local-'+i,kind:'user',payload:{text:'Message '+i}});
  const incoming=[{kind:'user',payload:{text:'Message 1',providerSessionId:'s',providerMessageId:'u1'}},{kind:'assistant',payload:{text:'Recovered answer',providerSessionId:'s',providerMessageId:'a1'}},{kind:'user',payload:{text:'Message 2',providerSessionId:'s',providerMessageId:'u2'}}];
  await call('messages.reconcileReplay',{conversationId:cid,messages:incoming,limit:80});
  const result=await call('messages.reconcileReplay',{conversationId:cid,messages:incoming,limit:80});
  check('replay keeps the cache bounded',result.messages.length===80&&result.hasOlder);
  const all=await call('messages.list',{conversationId:cid,limit:500});
  check('replay is idempotent across the entire database',all.length===121,all.length);
  check('provider-only rows are inserted between known anchors',all[0].id==='local-1'&&all[1].payload.text==='Recovered answer'&&all[2].id==='local-2');
  check('replay sequences remain positive and unique',all.every((m,i)=>m.sequence===i+1));
 }catch(e){check('uncaught',false,e.message+'\n'+e.stack);}
 await finish();
}};
