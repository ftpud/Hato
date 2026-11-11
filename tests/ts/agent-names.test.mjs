import { test } from "node:test";
import assert from "node:assert/strict";
import * as esbuild from "esbuild";
async function load(entry) {
  const r = await esbuild.build({ entryPoints: [entry], bundle: true, format: "esm", platform: "neutral", write: false });
  return import("data:text/javascript;base64," + Buffer.from(r.outputFiles[0].text).toString("base64"));
}

test("background agents are named Provider/Model and follow changes only while the name is automatic", async () => {
  const { autoAgentName, isAutoAgentName, providerLabel } = await load("sdk/persistent-agents.ts");
  const profile = { name: "Claude (claude-agent-acp)", provider: "claude" };
  const models = { configOptions: [{ id: "model", category: "model", currentValue: "opus", options: [{ value: "opus", name: "Opus 4.5" }, { value: "sonnet", name: "Sonnet 4.5" }] }] };
  assert.equal(providerLabel(profile), "Claude");
  assert.equal(autoAgentName({ profile, ...models }), "Claude/Opus 4.5");
  assert.equal(autoAgentName({ profile, model: "" }), "Claude");
  // Legacy names (no flag) are inferred from their shape.
  for (const name of ["Chat", "Claude", "Claude (claude-agent-acp)", "Claude/Sonnet 4.5"]) assert.equal(isAutoAgentName({ name, profile, ...models }), true, name);
  assert.equal(isAutoAgentName({ name: "Refactor parser", profile, ...models }), false);
  // The explicit flag wins, even for a custom name shaped like an automatic one.
  assert.equal(isAutoAgentName({ name: "Claude/Opus 4.5", customName: true, profile, ...models }), false);
  assert.equal(isAutoAgentName({ name: "Anything", customName: false, profile, ...models }), true);
});
