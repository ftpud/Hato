// Unit tests for TS module logic. Modules are bundled with the same esbuild flags as production and
// exercised with fake ModuleContexts (no kernel needed). Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import * as esbuild from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
async function load(rel) {
  const r = await esbuild.build({ entryPoints: [path.join(root, rel)], bundle: true, format: "esm", platform: "neutral", target: "es2020", write: false, loader: { ".sql": "text", ".md": "text" } });
  return import("data:text/javascript;base64," + Buffer.from(r.outputFiles[0].text).toString("base64"));
}

test("unified diff parse + apply (with offset and multiple hunks)", async () => {
  const m = await load("modules/services/module-dev/src/index.ts");
  const src = ["a", "b", "c", "d", "e", "f", "g"].join("\n");
  const patch = ["--- a/src/x.ts", "+++ b/src/x.ts", "@@ -2,2 +2,2 @@", " b", "-c", "+C", "@@ -6,1 +6,2 @@", " f", "+F2"].join("\n");
  const files = m.parseUnifiedDiff(patch);
  assert.equal(files.length, 1);
  assert.equal(files[0].path, "src/x.ts");
  assert.equal(m.applyHunks(src, files[0].hunks), ["a", "b", "C", "d", "e", "f", "F2", "g"].join("\n"));
  // Context found even when line numbers are off.
  const shifted = "z\nz\n" + src;
  assert.equal(m.applyHunks(shifted, m.parseUnifiedDiff(patch)[0].hunks), "z\nz\n" + ["a", "b", "C", "d", "e", "f", "F2", "g"].join("\n"));
  assert.throws(() => m.applyHunks("nope", files[0].hunks), /does not apply/);
  assert.throws(() => m.parseUnifiedDiff("garbage"), /no file headers/);
});

test("JSON-RPC peer: framing, requests, notifications, partial lines, errors", async () => {
  const { JsonRpcPeer } = await load("sdk/runtime.ts");
  const sent = [];
  const peer = new JsonRpcPeer(async (l) => { sent.push(JSON.parse(l)); });
  const notes = [];
  peer.onNotification = (m, p) => notes.push([m, p]);
  peer.onRequest = async (m, p) => ({ echo: p.x });
  const pr = peer.request("initialize", { protocolVersion: 1 });
  assert.equal(sent[0].method, "initialize");
  peer.feed('{"jsonrpc":"2.0","id":1,"res');
  peer.feed('ult":{"ok":true}}\n{"jsonrpc":"2.0","method":"session/update","params":{"a":1}}\n');
  assert.deepEqual(await pr, { ok: true });
  assert.deepEqual(notes, [["session/update", { a: 1 }]]);
  peer.feed('{"jsonrpc":"2.0","id":"r1","method":"session/request_permission","params":{"x":5}}\n');
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(sent[1], { jsonrpc: "2.0", id: "r1", result: { echo: 5 } });
  const p2 = peer.request("x");
  peer.feed('{"jsonrpc":"2.0","id":2,"error":{"code":-32000,"message":"Authentication required"}}\n');
  await assert.rejects(p2, /Authentication required/);
  const p3 = peer.request("y");
  peer.failAll("closed");
  await assert.rejects(p3, /closed/);
});

test("language detection + short ids", async () => {
  const r = await load("sdk/runtime.ts");
  assert.equal(r.langFromPath("src/main.rs"), "rust");
  assert.equal(r.langFromPath("a/b/index.ts"), "typescript");
  assert.equal(r.langFromPath("Makefile"), "make");
  assert.equal(r.langFromPath("x.unknown"), "text");
  assert.equal(r.shortId("1234abcd-ef00-0000-0000-000000000000"), "1234abcd");
});

test("persistence: migrations are transactional, idempotent and owned by TS", async () => {
  const m = (await load("modules/services/persistence/src/index.ts")).default;
  const execs = [];
  let applied = [];
  const host = {
    db: {
      openNamespace: async (ns) => { assert.equal(ns, "persistence"); return "h_db"; },
      exec: async (_h, sql) => { execs.push(sql); return { changes: 0 }; },
      query: async (_h, sql) => (sql.includes("schema_migrations") ? applied.map((v) => ({ version: v })) : [{ v: applied.length }]),
      transaction: async (_h, stmts) => { assert.match(stmts[0].sql, /CREATE TABLE|CREATE INDEX/); applied.push(stmts[1].params[0]); return { changes: 1 }; },
    },
  };
  const ctx = { host, log: { info() {}, warn() {} } };
  await m.activate(ctx);
  assert.deepEqual(applied, [1, 2, 3]);
  await m.activate(ctx);
  assert.deepEqual(applied, [1, 2, 3], "re-activation must not re-apply migrations");
});

test("persistence refuses private key material", async () => {
  const m = (await load("modules/services/persistence/src/index.ts")).default;
  const ctx = { host: { db: { openNamespace: async () => "h", exec: async () => ({}), query: async () => [], transaction: async () => ({}) } }, log: { info() {} } };
  await m.activate(ctx);
  await assert.rejects(m.methods["ssh.upsert"](ctx, { profile: { id: "p", host: "h", port: 22, user: "u", authRef: "-----BEGIN OPENSSH PRIVATE KEY-----" } }), /private key/);
});

test("projects-panel renders keyed tree rows with separate select/expand actions", async () => {
  const m = (await load("modules/ui/projects-panel/src/index.ts")).default;
  const state = new Map();
  const ctx = {
    state: { get: (k) => state.get(k), watch() {}, set() {} },
    events: { on() {} },
    ui: { invalidate() {} },
    modules: { call: async (id, method) => { assert.equal(id, "projects"); assert.equal(method, "tree"); return [{ id: "p1", name: "Alpha", kind: "local", rootPath: "/a", expanded: true, isGit: true, hasCommits: true, tasks: [{ id: "t1", name: "T", branch: "task/t-1", status: "ready" }] }]; } },
  };
  await m.activate(ctx);
  const tree = m.render(ctx);
  const tr = tree.children.find((c) => c.type === "tree");
  assert.equal(tr.selectAction, "selectWorkspace");
  assert.equal(tr.expandAction, "toggleExpanded");
  assert.deepEqual(tr.rows.map((r) => r.key), ["project:p1:root", "task:t1"]);
  assert.equal(tr.rows[0].badge, "1 task");
  assert.equal(tr.rows[1].connector, "last");
  assert.equal(tr.rowHeight, 42);
  assert.match(tr.rows[0].iconSvg, /<svg/);
  assert.equal(tr.rows[0].weight, "semibold");
  assert.equal(tr.rows[0].detail, "/a");
});

test("projects-panel animates rows whose workspace has an active AI chat or background agent", async () => {
  const m = (await load("modules/ui/projects-panel/src/index.ts")).default;
  const watchers = new Map();
  let expanded = true;
  const state = new Map([["ai-sessions.busy", { "task:t1": 2 }]]);
  const ctx = {
    state: { get: (k) => state.get(k), watch: (k, fn) => watchers.set(k, fn), set() {} },
    events: { on() {} }, ui: { invalidate() {} },
    modules: { call: async () => [{ id: "p1", name: "Alpha", kind: "local", rootPath: "/a", expanded, tasks: [{ id: "t1", name: "T", branch: "task/t-1", status: "ready" }] }] },
  };
  await m.activate(ctx);
  try {
    const spinning = (r) => r.iconColor === "primary" && /rotate\(/.test(r.iconSvg);
    let rows = m.render(ctx).children.find((c) => c.type === "tree").rows;
    assert.deepEqual(rows.map(spinning), [false, true]);
    assert.equal(rows[1].detail, "AI working (2) · task/t-1");
    watchers.get("ai-sessions.busy")({ "project:p1:root": 1 });
    rows = m.render(ctx).children.find((c) => c.type === "tree").rows;
    assert.deepEqual(rows.map(spinning), [true, false]);
    assert.equal(rows[0].detail, "AI working · /a");
    // Background agents count too, and add to chats in the same workspace.
    watchers.get("persistent-agents.busy")({ "task:t1": 1, "project:p1:root": 1 });
    rows = m.render(ctx).children.find((c) => c.type === "tree").rows;
    assert.deepEqual(rows.map(spinning), [true, true]);
    assert.equal(rows[0].detail, "AI working (2) · /a");
    watchers.get("ai-sessions.busy")({});
    watchers.get("persistent-agents.busy")({});
    rows = m.render(ctx).children.find((c) => c.type === "tree").rows;
    assert.deepEqual(rows.map(spinning), [false, false]);
  } finally { m.deactivate(); }
});
