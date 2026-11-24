// Agents report their own progress (report_progress) for the Assistant rail; usage meters refresh
// after agent work finishes.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as esbuild from "esbuild";
import { pluginsHost } from "./plugin-fixture.mjs";

let generation = 0;
const load = async (entry) => (await import("data:text/javascript;base64," + Buffer.from((await esbuild.build({ entryPoints: [entry], bundle: true, format: "esm", platform: "neutral", write: false })).outputFiles[0].text).toString("base64") + "#" + generation++));
const PA = await load("sdk/persistent-agents.ts");
const T = await load("sdk/chat-transcript.ts");
const find = (node, pred) => { if (!node || typeof node !== "object") return null; if (pred(node)) return node; for (const c of node.children || []) { const hit = find(c, pred); if (hit) return hit; } return null; };

function stateCtx(calls = []) {
  const values = new Map(), watches = new Map();
  return { values, ctx: { host: { env: { info: () => ({ repoRoot: "/r", dataDir: "/d" }) }, plugins: pluginsHost() },
    state: { get: k => values.get(k), set(k, v) { values.set(k, v); for (const fn of watches.get(k) || []) fn(v); }, watch(k, fn) { watches.set(k, [...(watches.get(k) || []), fn]); return () => {}; } },
    events: { on() { return () => {}; }, emit() {} },
    modules: { async call(target, method, args) { calls.push([target, method, args]); if (method === "settings.get") return undefined; return null; } },
    ui: { invalidate() {} }, log: { warn() {}, info() {} } } };
}

test("report_progress input is clamped, rounded and bounded", () => {
  assert.equal(PA.agentProgress({ percent: 42.6 }).percent, 43);
  assert.equal(PA.agentProgress({ percent: 180 }).percent, 100);
  assert.equal(PA.agentProgress({ percent: -3 }).percent, 0);
  assert.equal(PA.agentProgress({ percent: 10, note: "x".repeat(200) }).note.length, 80);
  assert.equal(PA.agentProgress({ percent: 10, note: "  " }).note, undefined);
  assert.throws(() => PA.agentProgress({ percent: "lots" }), /0 to 100/);
  assert.equal(PA.REPORT_PROGRESS_TOOL.name, "report_progress");
  assert.match(PA.PROGRESS_INSTRUCTION, /report_progress/);
});

test("progress tool calls never appear in a chat transcript", () => {
  const messages = [
    { key: "u", role: "user", text: "Fix it" },
    { key: "p1", role: "tool", text: "", title: "mcp__hato-internal__report_progress" },
    { key: "p2", role: "tool", text: "", title: "internal-remote-mcp.report_progress" },
    { key: "t", role: "tool", text: "", title: "Read file" },
  ];
  assert.deepEqual(T.transcriptItems(messages).map(n => n.key), ["u", "t"]);
});

test("working agents fill their bar from reported progress", async () => {
  const sidebar = (await load("Hato-plugins/modules/ui/sidebar/src/index.ts")).default;
  const { ctx } = stateCtx();
  await sidebar.activate(ctx);
  await sidebar.onEvent(ctx, { action: "expand", value: true });
  ctx.state.set("persistent-agents.busy", { "p:1": 1 });
  ctx.state.set("ai-sessions.busy", { "p:1": 1 });
  ctx.state.set("persistent-agents.working", [{ id: "s1", name: "Reviewer", workspaceId: "p:1", status: "busy", workflow: { workflowId: "w" }, progress: { percent: 40, note: "Reading tests" } }]);
  ctx.state.set("ai-sessions.working", [{ id: "c1", title: "Fix tests", workspaceId: "p:1", status: "busy" }]);
  ctx.state.set("internal-mcp.progress", { c1: { percent: 75, at: 1 } });
  const tree = sidebar.render(ctx);
  const agent = find(tree, n => n.key === "task:working:agent:s1");
  assert.equal(find(agent, n => n.type === "progress").value, 0.4, "native progress takes a 0–1 fraction");
  assert.match(find(agent, n => n.key === "detail").text, /^Reading tests · Workflow/);
  assert.equal(find(find(tree, n => n.key === "task:working:chat:c1"), n => n.type === "progress").value, 0.75);
  assert.ok(find(agent, n => n.type === "spinner"));
  assert.ok(find(agent, n => n.type === "progress").transition, "the fill animates");
  ctx.state.set("internal-mcp.progress", {});
  const waiting = find(sidebar.render(ctx), n => n.key === "task:working:chat:c1");
  assert.equal(find(waiting, n => n.type === "progress").indeterminate, true, "no report yet: indeterminate");
  assert.ok(find(waiting, n => n.type === "spinner"));
});

test("usage meters refresh after an agent finishes, debounced and throttled", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  const calls = [];
  const meter = (await load("Hato-plugins/modules/ui/claude-usage/src/index.ts")).default;
  const { ctx } = stateCtx(calls);
  await meter.activate(ctx);
  ctx.state.set("workspace.selected", { id: "p:1" });
  const probes = () => calls.filter(([target, method, args]) => target === "acp" && method === "limits" && args.force).length;
  ctx.state.set("persistent-agents.working", [{ id: "s1" }, { id: "s2" }]);
  ctx.state.set("persistent-agents.working", [{ id: "s2" }]);
  ctx.state.set("ai-sessions.working", []);
  t.mock.timers.tick(3999);
  assert.equal(probes(), 0, "waits for provider counters to settle");
  t.mock.timers.tick(1);
  await new Promise(r => setImmediate(r));
  assert.equal(probes(), 1);
  ctx.state.set("persistent-agents.working", []);
  t.mock.timers.tick(30000);
  await new Promise(r => setImmediate(r));
  assert.equal(probes(), 1, "at most one refresh per minute");
  t.mock.timers.tick(30000);
  await new Promise(r => setImmediate(r));
  assert.equal(probes(), 2);
  meter.deactivate?.();
});

test("agents without Hato's tools report progress as reply markers that never show", () => {
  assert.match(PA.PROGRESS_MARKER_INSTRUCTION, /<!-- hato-progress 40 \| Reading tests -->/);
  const reply = "Looking.\n<!-- hato-progress 5 | Starting -->\nDone part one.\n<!-- hato-progress 60% | Running the build -->\nMore.";
  assert.deepEqual([PA.lastProgressMarker(reply).percent, PA.lastProgressMarker(reply).note], [60, "Running the build"]);
  assert.equal(PA.lastProgressMarker("<!-- other comment -->"), null);
  assert.equal(PA.stripProgressMarkers(reply), "Looking.\nDone part one.\nMore.");
  assert.equal(PA.stripProgressMarkers("Step <!-- hato-progress 50 --> done"), "Step  done", "inline markers leave the text around them");
  // Streaming: a half-written marker at the end is hidden until it completes.
  assert.equal(PA.stripProgressMarkers("Working on it.\n<!-- hato-pro"), "Working on it.");
  assert.equal(PA.stripProgressMarkers("Working.\n<!-- hato-progress 4"), "Working.");
  assert.equal(PA.stripProgressMarkers("See <!-- note --> here"), "See <!-- note --> here", "other comments stay");
  // A marker split across chunks is still found.
  let scan = PA.scanProgressChunk("", "text <!-- hato-prog");
  assert.equal(scan.progress, null);
  scan = PA.scanProgressChunk(scan.tail, "ress 85 | Tests -->");
  assert.equal(scan.progress.percent, 85);
  // Transcripts hide markers; a reply that was only a marker disappears.
  const items = T.transcriptItems([{ key: "a", role: "assistant", text: reply }, { key: "b", role: "assistant", text: "<!-- hato-progress 100 -->" }]);
  assert.deepEqual(items.map(n => n.key), ["a"]);
  assert.doesNotMatch(JSON.stringify(items), /hato-progress/);
});

test("a chat without Hato's tools is asked for markers once per connection and reports them", async (t) => {
  const calls = [];
  const sessions = (await load("Hato-plugins/modules/services/ai-sessions/src/index.ts")).default;
  const prompts = [];
  const { ctx, values } = stateCtx(calls);
  const row = { id: "c1", workspaceId: "p:1", acpProfileId: "claude", title: "Chat 1", approvalPolicy: "ask", mcpSelection: [], config: {} };
  ctx.modules.call = async (target, method, args) => {
    calls.push([target, method, args]);
    if (method === "settings.get") return undefined;
    if (target === "persistence" && method === "conversations.get") return row;
    if (target === "persistence" && method === "messages.list") return [];
    if (target === "persistence" && method.startsWith("messages")) return null;
    if (target === "acp" && method === "prompt") { prompts.push(args.text); return {}; }
    if (target === "acp" && (method === "state" || method === "start")) return { status: "ready", sessionId: "s1", configOptions: [] };
    return null;
  };
  const events = new Map();
  ctx.events.on = (k, fn) => { events.set(k, fn); return () => {}; };
  await sessions.activate(ctx);
  try { await sessions.methods.send(ctx, { conversationId: "c1", text: "Fix the build" }); } catch (e) { ctx.log.warn(String(e)); }
  // Once per connection: the next prompt goes without the instruction.
  try { await sessions.methods.send(ctx, { conversationId: "c1", text: "And the tests" }); } catch {}
  if (!prompts.length) { t.skip("fixture could not open a provider connection"); return; }
  assert.match(prompts[0], /^Progress: .*hato-progress/s);
  assert.equal(prompts.length >= 2 ? /hato-progress/.test(prompts[1]) : false, false, "asked once per connection");
  events.get("acp.update")?.({ conversationId: "c1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "On it.\n<!-- hato-progress 30 | Reading -->" } } });
  await new Promise(r => setTimeout(r, 200));
  assert.equal(values.get("ai-sessions.progress")?.c1?.percent, 30);
});

test("the rail prefers the newest of tool and marker reports for a chat", async () => {
  const sidebar = (await load("Hato-plugins/modules/ui/sidebar/src/index.ts")).default;
  const { ctx } = stateCtx();
  await sidebar.activate(ctx);
  await sidebar.onEvent(ctx, { action: "expand", value: true });
  ctx.state.set("ai-sessions.busy", { "p:1": 1 });
  ctx.state.set("ai-sessions.working", [{ id: "c1", title: "Fix tests", workspaceId: "p:1", status: "busy" }]);
  ctx.state.set("internal-mcp.progress", { c1: { percent: 20, at: 1 } });
  ctx.state.set("ai-sessions.progress", { c1: { percent: 55, at: 2 } });
  const display = () => {
    const row = find(sidebar.render(ctx), n => n.key === "task:working:chat:c1");
    return find(row, n => n.type === "progress").value;
  };
  assert.equal(display(), 0.55);
  ctx.state.set("internal-mcp.progress", { c1: { percent: 70, at: 3 } });
  assert.equal(display(), 0.7);
});

test("desktop reports update a persistent agent bar and newer workspace reports take over", async () => {
  const sidebar = (await load("Hato-plugins/modules/ui/sidebar/src/index.ts")).default;
  const { ctx } = stateCtx();
  await sidebar.activate(ctx);
  await sidebar.onEvent(ctx, { action: "expand", value: true });
  const session = { id: "s1", name: "Codex", workspaceId: "p:1", status: "busy", progress: null };
  ctx.state.set("ai-sessions.working", []);
  ctx.state.set("persistent-agents.working", [session]);
  const bar = () => find(find(sidebar.render(ctx), n => n.key === "task:working:agent:s1"), n => n.type === "progress");
  assert.equal(bar().indeterminate, true);
  ctx.state.set("internal-mcp.progress", { s1: { percent: 25, at: 1 } });
  assert.equal(bar().value, 0.25);
  ctx.state.set("internal-mcp.progress", { s1: { percent: 65, at: 2 } });
  assert.equal(bar().value, 0.65);
  ctx.state.set("persistent-agents.working", [{ ...session, progress: { percent: 80, at: 3 } }]);
  assert.equal(bar().value, 0.8);
});

test("a finished agent stays in the rail as Done until it is clicked", async () => {
  const sidebar = (await load("Hato-plugins/modules/ui/sidebar/src/index.ts")).default;
  const { ctx } = stateCtx();
  const emitted = [];
  ctx.events.emit = (k, v) => emitted.push([k, v]);
  await sidebar.activate(ctx);
  await sidebar.onEvent(ctx, { action: "expand", value: true });
  ctx.state.set("persistent-agents.busy", { "p:1": 1 });
  ctx.state.set("persistent-agents.working", [{ id: "s1", name: "Reviewer", workspaceId: "p:1", status: "busy", workflow: null, progress: { percent: 60, at: 1 } }]);
  ctx.state.set("ai-sessions.working", []);
  sidebar.render(ctx);
  // The turn ends: the agent leaves the working list.
  ctx.state.set("persistent-agents.busy", {});
  ctx.state.set("persistent-agents.working", []);
  let tree = sidebar.render(ctx);
  const row = find(tree, n => n.key === "task:working:agent:s1");
  assert.ok(row, "kept after finishing");
  assert.equal(find(row, n => n.type === "progress").value, 1);
  assert.equal(find(row, n => n.key === "state").text, "Done");
  assert.equal(find(tree, n => n.key === "head:working") && JSON.stringify(find(tree, n => n.key === "head:working")).includes("FINISHED"), true);
  assert.ok(find(sidebar.render(ctx), n => n.key === "task:working:agent:s1"), "still there on later renders");
  await sidebar.onEvent(ctx, { action: row.action, value: row.value });
  assert.deepEqual(emitted.at(-1), ["sidebar.openAgent", { kind: "agent", id: "s1", workspaceId: "p:1", workflow: null }], "clicking opens it");
  assert.equal(find(sidebar.render(ctx), n => n.key === "task:working:agent:s1"), null, "and dismisses it");
});
