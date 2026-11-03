// Plugin contributions: what enabled plugins add to the shell, validated defensively.
import { test } from "node:test";
import assert from "node:assert/strict";
import { P, builtinPlugins, builtinPanelDefs } from "./plugin-fixture.mjs";

test("built-in manifests contribute the default panels, sidebars and overlays", () => {
  const c = P.collectContributions(builtinPlugins());
  assert.deepEqual(Object.keys(c.panels).sort(), ["ai", "files", "git", "projects", "remote", "terminal", "viewer"]);
  assert.equal(c.panels.files.module, "explorer");
  assert.deepEqual(c.sidebars.map((s) => [s.module, s.side]), [["left-sidebar", "left"], ["sidebar", "right"]]);
  assert.deepEqual(c.overlays.map((o) => o.module), ["settings"]);
  assert.deepEqual(P.activityPanels(c, "right").map((p) => p.id), ["projects", "files", "git", "remote"]);
  assert.deepEqual(P.activityPanels(c, "left").map((p) => p.id), ["ai", "terminal"]);
});

test("disabled plugins contribute nothing; a user plugin can add a panel and sidebar button", () => {
  const list = builtinPlugins({ "git-panel": { enabled: false } });
  list.push({ id: "notes", name: "Notes", kind: "ui", enabled: true, source: "user", contributes: { panels: [{ id: "notes", title: "Notes", dock: { column: 4 }, activity: { side: "right", order: 5, iconSvg: "<svg/>" } }] } });
  const c = P.collectContributions(list);
  assert.ok(!c.panels.git);
  assert.equal(c.panels.notes.module, "notes");
  assert.deepEqual(P.activityPanels(c, "right").map((p) => p.id), ["notes", "projects", "files", "remote"]);
  const defs = builtinPanelDefs(list);
  assert.deepEqual(defs.notes.dock, { column: 4, size: undefined });
});

test("malformed contributions are skipped, duplicates keep the first", () => {
  const c = P.collectContributions([
    { id: "a", enabled: true, contributes: { panels: [null, { id: "bad id!" }, { id: "x", title: "First" }, { id: "x", title: "Second" }], sidebars: [{ side: "top" }, "nope"], overlays: ["str"] } },
    { id: "b", enabled: true, contributes: "garbage" },
  ]);
  assert.deepEqual(Object.keys(c.panels), ["x"]);
  assert.equal(c.panels.x.title, "First");
  assert.deepEqual(c.sidebars, []);
  assert.deepEqual(c.overlays, []);
});
