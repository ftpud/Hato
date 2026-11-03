import { test } from "node:test";
import assert from "node:assert/strict";
import * as esbuild from "esbuild";
async function load(entry) {
  const r = await esbuild.build({ entryPoints: [entry], bundle: true, format: "esm", platform: "neutral", write: false });
  return import("data:text/javascript;base64," + Buffer.from(r.outputFiles[0].text).toString("base64"));
}
const walk = node => [node, ...(node.children || []).flatMap(walk)];
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("module settings validate edits, serialize saves and report failures without changing confirmed values", async () => {
  const { exportSettings } = await load("sdk/settings.ts");
  let listener, published;
  let enabled = true;
  const calls = [];
  const ctx = { moduleId: "example", state: { set(key, value) { assert.equal(key, "example.settings"); published = value; } }, events: { on(topic, fn) { assert.equal(topic, "settings.change"); listener = fn; } }, ui: { invalidate() {} } };
  exportSettings(ctx, () => [{ key: "general", title: "Example", fields: [{ key: "enabled", type: "toggle", label: "Enabled", value: enabled }] }], async (_, key, value) => {
    calls.push(value);
    if (value === true) throw new Error("Save failed");
    enabled = value;
  });
  listener({ module: "other", section: "general", key: "enabled", value: false });
  await tick(); assert.deepEqual(calls, []);
  listener({ module: "example", section: "general", key: "enabled", value: "invalid" });
  await tick(); assert.match(published.error, /Invalid/); assert.deepEqual(calls, []);
  listener({ module: "example", section: "general", key: "enabled", value: false });
  listener({ module: "example", section: "general", key: "enabled", value: true });
  await tick(); assert.deepEqual(calls, [false, true]);
  assert.equal(published.sections[0].fields[0].value, false);
  assert.equal(published.error, "Save failed");
});

test("Settings discovers live contributions, routes edits, closes and removes inactive providers", async () => {
  const { default: mod } = await load("modules/ui/settings/src/index.ts");
  let active = true;
  const emitted = [], stopped = [];
  const state = { sections: [{ key: "general", title: "Example preferences", fields: [{ key: "enabled", type: "toggle", label: "Enabled", value: true }] }], error: null };
  const ctx = { moduleId: "settings", host: { modules: { list: async () => [{ id: "example", active: active ? {} : null }] }, plugins: { list: async () => ({ plugins: [], root: null, rootOverride: null }) } }, state: { get: () => state, watch: (key) => () => stopped.push(key) }, events: { on() {}, emit: (topic, payload) => emitted.push({ topic, payload }) }, ui: { invalidate() {} } };
  await mod.activate(ctx);
  assert.equal(mod.render(ctx).key, "settings-closed");
  await mod.methods.open(ctx);
  const tree = mod.render(ctx);
  assert.equal(tree.type, "modal");
  // The first module-contributed category opens by default.
  assert.ok(walk(tree).some((n) => n.type === "toggle"));
  assert.ok(walk(tree).some(n => n.type === "choice" && n.text === "Example preferences"));
  mod.onEvent(ctx, { action: "selectCategory", value: JSON.stringify(["example", "general"]) });
  const toggle = walk(mod.render(ctx)).find((n) => n.type === "toggle");
  assert.ok(!walk(mod.render(ctx)).some(n => n.key === "plugins-hint"));
  assert.equal(mod.snapshot().selectedCategory, JSON.stringify(["example", "general"]));
  mod.onEvent(ctx, { action: "change", key: toggle.key, value: false });
  assert.deepEqual(emitted, [{ topic: "settings.change", payload: { module: "example", section: "general", key: "enabled", value: false } }]);
  active = false; await mod.methods.open(ctx);
  assert.ok(!walk(mod.render(ctx)).some((n) => n.type === "toggle"));
  assert.ok(walk(mod.render(ctx)).some(n => n.key === "plugins-hint"));
  assert.deepEqual(stopped, ["example.settings"]);
  mod.onEvent(ctx, { action: "close" });
  assert.equal(mod.render(ctx).key, "settings-closed");
  mod.deactivate();
});

test("modules can publish multiple independent categories with identical section keys across providers", async () => {
  const { default: mod } = await load("modules/ui/settings/src/index.ts");
  const values = {
    'one.settings': { sections: [
      { key: 'general', title: 'One general', description: 'General options', fields: [{ key: 'value', label: 'One value', type: 'toggle', value: true }] },
      { key: 'advanced', title: 'One advanced', fields: [{ key: 'value', label: 'Advanced value', type: 'toggle', value: false }] },
    ] },
    'two.settings': { sections: [{ key: 'general', title: 'Two general', fields: [{ key: 'value', label: 'Two value', type: 'toggle', value: false }] }] },
  };
  const emitted = [];
  const ctx = { moduleId: 'settings', host: { modules: { list: async () => [{ id: 'one', active: {} }, { id: 'two', active: {} }] }, plugins: { list: async () => ({ plugins: [], root: null, rootOverride: null }) } },
    state: { get: key => values[key], watch: () => () => {} }, events: { on() {}, emit: (topic, payload) => emitted.push({ topic, payload }) }, ui: { invalidate() {} } };
  await mod.activate(ctx);
  await mod.methods.open(ctx, { module: 'two', section: 'general' });
  assert.deepEqual(walk(mod.render(ctx)).filter(n => n.type === 'choice').map(n => n.text), ['Plugins', 'One general', 'One advanced', 'Two general']);
  const toggle = walk(mod.render(ctx)).find(n => n.type === 'toggle');
  assert.equal(toggle.label, 'Two value');
  mod.onEvent(ctx, { action: 'change', key: toggle.key, value: true });
  assert.equal(emitted[0].payload.module, 'two');
  mod.onEvent(ctx, { action: 'selectCategory', value: JSON.stringify(['one', 'advanced']) });
  assert.equal(walk(mod.render(ctx)).find(n => n.type === 'toggle').label, 'Advanced value');
  delete values['one.settings'];
  assert.equal(walk(mod.render(ctx)).find(n => n.type === 'toggle').label, 'Two value');
  mod.deactivate();
});
