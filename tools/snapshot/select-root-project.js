// Snapshot setup: select the project registered for --root so workspace panels (Git, Files, …)
// render real content instead of "Select a project or task". Use with:
//   hato --root . --data-dir /tmp/hato-snap/data --snapshot-setup tools/snapshot/select-root-project.js ...
// HATO_SNAP_PROJECT=<project name or id> selects another project.
export default {
  id: "__driver", moduleApiVersion: 1,
  async activate(ctx) {
    const env = (name) => globalThis.__testOp("test.env", { name });
    const want = await env("HATO_SNAP_PROJECT");
    const root = ctx.host.env.info().initialRoot;
    const projects = await ctx.modules.call("persistence", "projects.list");
    const p = projects.find((x) => (want ? x.id === want || x.name === want : x.rootPath === root)) || (want ? null : projects[0]);
    if (!p) throw new Error(`no project matches ${want || root}; known: ${projects.map((x) => x.name).join(", ") || "none"}`);
    await ctx.modules.call("workspace", "select", { workspaceId: `project:${p.id}:root` });
    ctx.log.info("snapshot setup selected", p.name);
  },
};
