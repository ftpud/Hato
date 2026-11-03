import type { AppModule } from "../../../../sdk/types";
const mod:AppModule={id:"internal-local-mcp",moduleApiVersion:1,methods:{
  async endpoint(ctx,a) {const ep=await ctx.modules.call("internal-mcp","endpoint",{...a,desktopOnly:true});return {...ep,server:{...ep.server,name:"internal-local-mcp"}};},
  revoke:(ctx,a)=>ctx.modules.call("internal-mcp","revoke",a),
  status:ctx=>ctx.modules.call("internal-mcp","status"),
}};
export default mod;
