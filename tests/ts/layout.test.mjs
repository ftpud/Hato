// workspace-layout model: docking, bars, repair.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as esbuild from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const r = await esbuild.build({ entryPoints: [path.join(root, "modules/ui/workspace-layout/src/model.ts")], bundle: true, format: "esm", platform: "neutral", write: false });
const M = await import("data:text/javascript;base64," + Buffer.from(r.outputFiles[0].text).toString("base64"));
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
  assert.deepEqual(l.hidden, ["ai"]);
  l = M.moveTo(l, "ai", "bottom");
  assert.deepEqual(l.bottom.panels, ["terminal", "ai"]);
  assert.deepEqual(all(l), Object.keys(M.PANELS).sort());
});

test("bar items move between bars and reorder", () => {
  let l = M.moveBarItem(M.defaultLayout(), "versions", "top", "workspace");
  assert.deepEqual(l.bars.top.items, ["title", "versions", "workspace", "layoutMenu", "modules"]);
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
  assert.deepEqual(l.bars.top.items, ["title"]);
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
