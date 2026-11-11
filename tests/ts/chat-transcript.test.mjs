// Chat transcript presentation is module data built from messages (no chat knowledge in Rust).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as esbuild from "esbuild";
const built = await esbuild.build({ entryPoints: ["sdk/chat-transcript.ts"], bundle: true, format: "esm", platform: "neutral", write: false });
const T = await import("data:text/javascript;base64," + Buffer.from(built.outputFiles[0].text).toString("base64"));
const walk = (n) => [n, ...(n.children || []).flatMap(walk)];

test("messages become keyed cards with role labels, markdown bodies and native copy", () => {
  const items = T.transcriptItems([
    { key: "u1", role: "user", text: "hi" },
    { key: "a1", role: "assistant", text: "**hello**" },
    { key: "t1", role: "tool", title: "Run\n  cargo test", text: "ok", status: "done" },
    { key: "r1", role: "thought", text: "thinking" },
  ], { agentLabel: "Claude · Opus", linkAction: "openLink" });
  assert.deepEqual(items.map((i) => i.key), ["u1", "a1", "t1", "r1"]);
  assert.equal(walk(items[0]).find((n) => n.key === "role").text, "YOU");
  assert.equal(walk(items[0]).find((n) => n.key === "text").selectable, true);
  assert.equal(walk(items[1]).find((n) => n.key === "role").text, "CLAUDE · OPUS");
  const md = walk(items[1]).find((n) => n.type === "markdown");
  assert.deepEqual([md.text, md.inline, md.linkAction], ["**hello**", true, "openLink"]);
  assert.equal(walk(items[1]).find((n) => n.key === "copy").copyText, "**hello**");
  assert.equal(walk(items[2]).find((n) => n.key === "summary").text, "Run cargo test");
  assert.equal(walk(items[2]).find((n) => n.key === "copy").copyText, "Run\n  cargo test\nok");
  assert.equal(walk(items[3]).find((n) => n.key === "kind").text, "REASONING");
});

test("older-history control and follow key", () => {
  const msgs = [{ key: "u1", role: "user", text: "a" }, { key: "a1", role: "assistant", text: "b" }, { key: "u2", role: "user", text: "c" }];
  const items = T.transcriptItems(msgs, { hasOlder: true, loadingOlder: true, loadOlderAction: "older" });
  assert.equal(items[0].key, "__older");
  assert.equal(items[0].disabled, true);
  assert.match(items[0].text, /Loading/);
  assert.equal(T.followKey(msgs), "u2");
  assert.equal(T.followKey([]), undefined);
});


test("reasoning is muted italic text without bold summary markers", () => {
  const body = walk(T.messageNode({ key: "r", role: "thought", text: "\n**Checking**\n\n\n*Release*\n" })).find(n => n.key === "body");
  assert.equal(body.text, "Checking\nRelease");
  assert.equal(body.color, "muted");
  assert.equal(body.style.italic, true);
  assert.equal(body.style.fontWeight, 400);
});
