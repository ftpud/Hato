export default {
  id: "__driver", moduleApiVersion: 1,
  async activate() {
    const modules = await globalThis.__testOp("test.modules", {});
    for (const id of ["persistence", "workspace", "module-dev"]) {
      if (!modules.some(m => m.id === id && m.active)) throw new Error(`Packaged module ${id} did not boot`);
    }
  },
};
