import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function load() {
  const dir = mkdtempSync(join(tmpdir(), "cloud-activity-"));
  const out = join(dir, "map.mjs");
  await build({ entryPoints: ["Hato-plugins/modules/services/cloud-activity/src/map.ts"], bundle: true, format: "esm", platform: "neutral", outfile: out, logLevel: "error" });
  const mod = await import(out);
  rmSync(dir, { recursive: true, force: true });
  return mod;
}

test("cloud-activity exports allowlisted states and detects completed turns", async () => {
  const { activityItems } = await load();
  const remembered = new Map();
  const t = "2026-11-23T10:00:00.000Z";
  const s = (status, extra = {}) => ({ id: "s1", name: "Fix <tests>\n now", status, createdAt: t, updatedAt: t, profile: { name: "Claude" }, inline: { secret: "x" }, ...extra });

  // Idle session never seen working: omitted.
  assert.deepEqual(activityItems([s("ready")], remembered, t), []);
  let [item] = activityItems([s("busy", { updatedAt: "2026-11-23T10:01:00.000Z" })], remembered, t);
  assert.equal(item.state, "running");
  assert.equal(item.title, "Fix tests now");
  assert.equal(item.source, "Claude");
  assert.deepEqual(Object.keys(item).sort(), ["detail", "id", "kind", "source", "startedAt", "state", "title", "updatedAt"]);
  [item] = activityItems([s("waiting", { updatedAt: "2026-11-23T10:02:00.000Z" })], remembered, t);
  assert.equal(item.state, "attention");
  assert.equal(item.detail, "Waiting for you");
  [item] = activityItems([s("ready", { updatedAt: "2026-11-23T10:03:00.000Z" })], remembered, t);
  assert.equal(item.state, "completed");
  [item] = activityItems([s("error", { error: "token sk-123 leaked" })], remembered, t);
  assert.equal(item.state, "failed");
  assert.doesNotMatch(JSON.stringify(item), /sk-123/);
  [item] = activityItems([s("busy", { workflow: { id: "w" } })], remembered, t);
  assert.equal(item.kind, "workflow");
  // Sessions that disappear are forgotten.
  assert.deepEqual(activityItems([], remembered, t), []);
  assert.equal(remembered.size, 0);
});
