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
  const { default: mod } = await load("Hato-plugins/modules/ui/settings/src/index.ts");
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
  assert.ok(!walk(mod.render(ctx)).some(n => n.key === "plugin-tabs"));
  assert.equal(mod.snapshot().selectedCategory, JSON.stringify(["example", "general"]));
  mod.onEvent(ctx, { action: "change", key: toggle.key, value: false });
  assert.deepEqual(emitted, [{ topic: "settings.change", payload: { module: "example", section: "general", key: "enabled", value: false } }]);
  active = false; await mod.methods.open(ctx);
  assert.ok(!walk(mod.render(ctx)).some((n) => n.type === "toggle"));
  assert.ok(walk(mod.render(ctx)).some(n => n.key === "plugin-tabs"));
  assert.deepEqual(stopped, ["example.settings"]);
  mod.onEvent(ctx, { action: "close" });
  assert.equal(mod.render(ctx).key, "settings-closed");
  mod.deactivate();
});

test("modules can publish multiple independent categories with identical section keys across providers", async () => {
  const { default: mod } = await load("Hato-plugins/modules/ui/settings/src/index.ts");
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
  assert.deepEqual(walk(mod.render(ctx)).filter(n => n.type === 'choice').map(n => n.text), ['One general', 'One advanced', 'Two general', 'Plugins']);
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

test('ordered settings validate all items and support movable spacers without dropping buttons', async () => {
  const { exportSettings } = await load('sdk/settings.ts');
  let listener, published, calls = 0, value = JSON.stringify(['a', 'b']);
  const ctx = { moduleId: 'example', state: { set(_key, state) { published = state; } }, events: { on(_key, fn) { listener = fn; } }, ui: { invalidate() {} } };
  exportSettings(ctx, () => [{ key: 'bar', title: 'Bar', fields: [{ key: 'items', label: 'Buttons', type: 'order', value, items: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], allowSpacers: true }] }], (_section, _key, next) => { value = next; calls++; });
  const edit = async items => { listener({ module: 'example', section: 'bar', key: 'items', value: JSON.stringify(items) }); await tick(); };
  await edit(['b', '@spacer:test', 'a']);
  assert.equal(calls, 1); assert.deepEqual(JSON.parse(value), ['b', '@spacer:test', 'a']);
  for (const invalid of [['b'], ['a', 'a', 'b'], ['a', 'b', 'unknown']]) { await edit(invalid); assert.equal(calls, 1); assert.ok(published.error); }
});

test('settings search, grouped navigation, table layout and order controls route confirmed edits', async () => {
  const { default: mod } = await load('Hato-plugins/modules/ui/settings/src/index.ts');
  const fields = [{ key: 'items', label: 'Left top', type: 'order', value: '["a","b"]', allowSpacers: true, items: [{ id: 'a', label: 'Files' }, { id: 'b', label: 'Git' }] }];
  const value = { sections: [{ key: 'sidebar-order', title: 'Sidebar order & spacers', group: 'Workspace', fields }, { key: 'table', title: 'Table display', group: 'Appearance', layout: 'table', fields: [{ key: 'density', label: 'Row density', type: 'select', value: 'compact', options: [{ value: 'compact', label: 'Compact' }] }] }] };
  const emitted = [];
  const ctx = { moduleId: 'settings', host: { modules: { list: async () => [{ id: 'example', active: true }] }, plugins: { list: async () => ({ plugins: [], root: null }) } }, state: { get: key => key === 'example.settings' ? value : undefined, watch: () => () => {} }, events: { on() {}, emit: (_topic, edit) => emitted.push(edit) }, ui: { invalidate() {} } };
  await mod.activate(ctx); await mod.methods.open(ctx, { module: 'example', section: 'sidebar-order' });
  let nodes = walk(mod.render(ctx));
  assert.ok(nodes.some(n => n.text === 'WORKSPACE'));
  const down = nodes.find(n => n.action === 'order:down' && n.value.index === 0);
  await mod.onEvent(ctx, { action: down.action, value: down.value });
  assert.deepEqual(JSON.parse(emitted.at(-1).value), ['b','a']);
  fields[0].value = emitted.at(-1).value;
  const add = walk(mod.render(ctx)).find(n => n.action === 'order:add');
  await mod.onEvent(ctx, { action: add.action, value: add.value });
  assert.ok(JSON.parse(emitted.at(-1).value).at(-1).startsWith('@spacer:'));
  await mod.onEvent(ctx, { action: 'search', value: 'density' });
  nodes = walk(mod.render(ctx));
  assert.ok(nodes.some(n => n.key === 'preferences-table'));
  assert.ok(!nodes.some(n => n.type === 'choice' && n.text === 'Sidebar order & spacers'));
  await mod.onEvent(ctx, { action: 'search', value: 'no such setting' });
  assert.ok(walk(mod.render(ctx)).some(n => n.text === 'No matching settings.'));
  await mod.methods.open(ctx, { category: 'plugins' });
  assert.ok(walk(mod.render(ctx)).some(n => n.key === 'plugin-tabs'), 'explicit page navigation clears the search');
  mod.deactivate();
});

test('text settings submit the current native input on Enter and validate string values', async () => {
  const { default: mod } = await load('Hato-plugins/modules/ui/settings/src/index.ts');
  const emitted = [];
  const state = { sections: [{ key: 'server', title: 'Language server', fields: [{ key: 'executable', label: 'Executable', type: 'text', value: 'jdtls' }] }] };
  const ctx = { moduleId: 'settings', host: { modules: { list: async () => [{ id: 'example', active: {} }] }, plugins: { list: async () => ({ plugins: [] }) } },
    state: { get: () => state, watch: () => () => {} }, events: { on() {}, emit: (topic, payload) => emitted.push({ topic, payload }) }, ui: { invalidate() {} } };
  await mod.activate(ctx);
  await mod.methods.open(ctx, { module: 'example', section: 'server' });
  const input = walk(mod.render(ctx)).find(n => n.type === 'textInput' && n.submitAction === 'change');
  assert.equal(input.value, 'jdtls');
  mod.onEvent(ctx, { action: 'change', key: input.key, value: null, inputs: { [input.key]: '/opt/jdtls/bin/jdtls' } });
  assert.deepEqual(emitted.at(-1), { topic: 'settings.change', payload: { module: 'example', section: 'server', key: 'executable', value: '/opt/jdtls/bin/jdtls' } });
  mod.deactivate();
  const { exportSettings } = await load('sdk/settings.ts');
  let listener, published, saved;
  exportSettings({ moduleId: 'example', state: { set(_key, value) { published = value; } }, events: { on(_topic, fn) { listener = fn; } }, ui: { invalidate() {} } }, () => state.sections,
    (_section, _key, value) => { saved = value; });
  listener({ module: 'example', section: 'server', key: 'executable', value: null });
  await tick(); assert.match(published.error, /Invalid/); assert.equal(saved, undefined);
  listener(emitted.at(-1).payload);
  await tick(); assert.equal(saved, '/opt/jdtls/bin/jdtls');
});

test('settings action buttons route validated actions without treating them as preference values', async () => {
  const { default: mod } = await load('Hato-plugins/modules/ui/settings/src/index.ts');
  const emitted = [];
  let disabled = false;
  const contribution = () => ({ sections: [{ key: 'java', title: 'Java', fields: [{ key: 'install', type: 'action', label: 'Dependencies', buttonLabel: 'Install missing dependencies', disabled }] }] });
  const ctx = { moduleId: 'settings', host: { modules: { list: async () => [{ id: 'language-service', active: {} }] }, plugins: { list: async () => ({ plugins: [] }) } },
    state: { get: contribution, watch: () => () => {} }, events: { on() {}, emit: (topic, payload) => emitted.push({ topic, payload }) }, ui: { invalidate() {} } };
  await mod.activate(ctx); await mod.methods.open(ctx, { module: 'language-service', section: 'java' });
  try {
    const button = walk(mod.render(ctx)).find(n => n.action === 'settingAction');
    assert.equal(button.text, 'Install missing dependencies');
    mod.onEvent(ctx, { action: 'settingAction', key: button.key });
    assert.deepEqual(emitted, [{ topic: 'settings.action', payload: { module: 'language-service', section: 'java', key: 'install' } }]);
    disabled = true;
    mod.onEvent(ctx, { action: 'settingAction', key: button.key });
    mod.onEvent(ctx, { action: 'change', key: button.key, value: 'forged' });
    assert.equal(emitted.length, 1);
  } finally { mod.deactivate(); }
  const { exportSettings } = await load('sdk/settings.ts');
  const handlers = {}, actions = [], changes = [];
  disabled = false;
  exportSettings({ moduleId: 'language-service', events: { on: (key, fn) => { handlers[key] = fn; } }, state: { set() {} }, ui: { invalidate() {} } },
    () => contribution().sections, (_section, key) => changes.push(key), { action: async (section, key) => actions.push([section, key]) });
  handlers['settings.action']({ module: 'language-service', section: 'java', key: 'install' });
  await tick(); assert.deepEqual(actions, [['java', 'install']]);
  disabled = true;
  handlers['settings.action']({ module: 'language-service', section: 'java', key: 'install' });
  handlers['settings.change']({ module: 'language-service', section: 'java', key: 'install', value: 'forged' });
  await tick(); assert.equal(actions.length, 1); assert.deepEqual(changes, []);
});
