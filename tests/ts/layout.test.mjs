// workspace-layout model: docking, bars, repair.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as esbuild from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const r = await esbuild.build({ entryPoints: [path.join(root, "modules/ui/workspace-layout/src/model.ts")], bundle: true, format: "esm", platform: "neutral", write: false });
const M = await import("data:text/javascript;base64," + Buffer.from(r.outputFiles[0].text).toString("base64"));
import { builtinPanelDefs, pluginsHost } from "./plugin-fixture.mjs";
M.setPanels(builtinPanelDefs());
const all = (l) => [...l.columns.flatMap((c) => c.panels), ...l.bottom.panels, ...Object.keys(l.floating), ...Object.keys(l.detached), ...l.hidden].sort();
const sum = (xs) => xs.reduce((a, b) => a + b, 0);

test("default layout places every panel exactly once", () => {
  const l = M.defaultLayout();
  assert.deepEqual(all(l), Object.keys(M.PANELS).sort());
});

test("drop left/right creates a column; top/bottom stacks; sizes stay normalized", () => {
  let l = M.defaultLayout();
  l = M.dropPanel(l, "terminal", "viewer", "right");
  assert.equal(l.bottom.panels.length, 0);
  const vi = l.columns.findIndex((c) => c.panels.includes("viewer"));
  assert.deepEqual(l.columns[vi + 1].panels, ["terminal"]);
  assert.ok(Math.abs(sum(l.columns.map((c) => c.size)) - 1) < 1e-6);
  l = M.dropPanel(l, "files", "projects", "bottom");
  const pc = l.columns.find((c) => c.panels.includes("projects"));
  assert.deepEqual(pc.panels, ["projects", "files"]);
  assert.ok(Math.abs(sum(pc.sizes) - 1) < 1e-6);
  assert.equal(l.columns.length, 4, "the emptied files column is removed");
  assert.deepEqual(all(l), Object.keys(M.PANELS).sort());
});

test("float / detach / hide / back to bottom keep a single location", () => {
  let l = M.moveTo(M.defaultLayout(), "ai", "floating");
  assert.ok(l.floating.ai && !l.columns.some((c) => c.panels.includes("ai")));
  l = M.moveTo(l, "ai", "detached");
  assert.ok(l.detached.ai && !l.floating.ai);
  l = M.moveTo(l, "ai", "hidden");
  assert.deepEqual(l.hidden, ["git", "remote", "ai"]); // git and remote are hidden by default
  l = M.moveTo(l, "ai", "bottom");
  assert.deepEqual(l.bottom.panels, ["terminal", "ai"]);
  assert.deepEqual(all(l), Object.keys(M.PANELS).sort());
});

test("bar items move between bars and reorder", () => {
  let l = M.moveBarItem(M.defaultLayout(), "versions", "top", "workspace");
  assert.deepEqual(l.bars.top.items, ["title", "versions", "workspace", "layoutMenu", "modules", "settings"]);
  assert.ok(!l.bars.bottom.items.includes("versions"));
  l = M.moveBarItem(l, "title", "bottom", "approvals", true);
  assert.deepEqual(l.bars.bottom.items, ["machine", "approvals", "title"]);
  l = M.removeBarItem(l, "title");
  assert.ok(![...l.bars.top.items, ...l.bars.bottom.items].includes("title"));
});

test("repair drops unknown/duplicate ids and re-docks missing panels", () => {
  const bad = { v: 1, columns: [{ panels: ["projects", "bogus", "projects"], size: 2, sizes: [] }], bottom: { panels: ["terminal"], sizes: [5] }, bars: { top: { items: ["title", "nope"] } } };
  const l = M.repair(bad);
  assert.deepEqual(all(l), Object.keys(M.PANELS).sort());
  assert.ok(Math.abs(sum(l.columns.map((c) => c.size)) - 1) < 1e-6);
  assert.deepEqual(l.bars.top.items, ["title", "settings"]);
  assert.deepEqual(M.repair(null), M.defaultLayout());
});

test("repair tolerates malformed persisted containers and geometry", () => {
  const l = M.repair({ v: 1, columns: [null, { panels: "bad" }], bottom: { panels: false }, hidden: {}, floating: { ai: null }, detached: { viewer: { width: -10 } }, bars: { top: { items: {} }, bottom: { items: ["toString", "modules", "modules"] } } });
  assert.deepEqual(all(l), Object.keys(M.PANELS).sort());
  assert.equal(l.floating.ai.width, 520);
  assert.equal(l.detached.viewer.width, 760);
  assert.deepEqual(l.bars.bottom.items, ["modules"]);
  assert.deepEqual(M.moveBarItem(l, "modules", "invalid", null), l);
});

test("Settings migrates old layouts once and respects later placement", () => {
  const old = M.defaultLayout();
  delete old.settingsButton;
  old.bars.top.items = old.bars.top.items.filter((id) => id !== "settings");
  const migrated = M.repair(old);
  assert.ok(migrated.bars.top.items.includes("settings"));
  const moved = M.moveBarItem(migrated, "settings", "bottom", null);
  assert.ok(M.repair(moved).bars.bottom.items.includes("settings"));
  assert.ok(!M.repair(M.removeBarItem(migrated, "settings")).bars.top.items.includes("settings"));
});

test("collapsed panes use full-name restore buttons without reserving columns or rows", async () => {
  const built = await esbuild.build({ entryPoints: [path.join(root, 'modules/ui/workspace-layout/src/index.ts')], bundle: true, format: 'esm', write: false });
  const mod = (await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64'))).default;
  const layout = M.defaultLayout();
  layout.collapsed = { projects: true, files: true, viewer: true };
  const originalSizes = layout.columns.map(c => c.size);
  const ctx = { host: { plugins: pluginsHost() }, modules: { async call(_, method) { if (method === 'list') return []; if (method === 'updates') return { modules: [], available: [], errors: [] }; } }, state: { get() { return null; }, set() {}, watch() {} }, events: { on() { return () => {}; } }, ui: { invalidate() {} }, log: { warn() {} } };
  const walk = node => [node, ...(node.children || []).flatMap(walk)];
  await mod.activate(ctx, { layout });
  let nodes = walk(mod.render());
  const cols = nodes.find(node => node.key === 'cols');
  assert.deepEqual(cols.fixed, [0, 0, 0, null]);
  const restore = nodes.find(node => node.key === 'restore-buttons');
  assert.equal(restore.wrap, true);
  assert.deepEqual(restore.children.filter(node => node.type === 'button').map(node => node.text), ['Projects', 'Files', 'Source viewer']);
  for (const id of ['projects', 'files', 'viewer']) assert.ok(!nodes.some(node => node.type === 'slot' && node.module === M.PANELS[id].slot));
  await mod.onEvent(ctx, { action: 'toggleCollapse', value: 'files', inputs: {} });
  assert.deepEqual(mod.methods.getLayout().columns.map(c => c.size), originalSizes);
  nodes = walk(mod.render());
  assert.ok(nodes.some(node => node.type === 'slot' && node.module === 'explorer'));
  assert.ok(!nodes.some(node => node.key === 'restore-files'));
  await mod.methods.setLayout(ctx, { layout: { ...layout, collapsed: Object.fromEntries(Object.keys(M.PANELS).map(id => [id, true])) } });
  nodes = walk(mod.render());
  assert.ok(nodes.some(node => node.key === 'empty'));
  assert.equal(nodes.find(node => node.key === 'restore-buttons').children.filter(node => node.type === 'button').length, 5);
});

test('new default-hidden panels stay hidden in older saved layouts instead of docking', () => {
  const saved = { v: 1, columns: [{ panels: ['projects', 'files', 'viewer', 'ai'], size: 1, sizes: [0.25, 0.25, 0.25, 0.25] }], bottom: { panels: ['terminal'], sizes: [1], collapsed: false }, hidden: [] };
  const l = M.repair(saved);
  assert.deepEqual(l.hidden, ['git', 'remote']);
  assert.ok(!l.columns.some((c) => c.panels.includes('git')));
  const shown = M.dropPanel(l, 'git', 'files', 'bottom');
  assert.deepEqual(shown.columns[0].panels.slice(0, 3), ['projects', 'files', 'git']);
});
