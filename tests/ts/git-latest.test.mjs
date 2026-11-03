// git.latestChange: shows only what the most recent update changed, using a real temporary repo
// and a fake host whose stat mtime has one-second resolution like the native host.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as esbuild from "esbuild";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const built = await esbuild.build({ entryPoints: [path.join(root, "modules/services/git/src/index.ts")], bundle: true, format: "esm", platform: "neutral", target: "es2020", write: false });
const git = (await import("data:text/javascript;base64," + Buffer.from(built.outputFiles[0].text).toString("base64"))).default;

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hato-git-latest-"));
  const run = (...args) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  run("init", "-q"); run("config", "user.email", "t@example.com"); run("config", "user.name", "T");
  fs.writeFileSync(path.join(dir, "README.md"), "one\ntwo\nthree\n");
  fs.writeFileSync(path.join(dir, "other.txt"), "alpha\n");
  run("add", "."); run("commit", "-qm", "init");
  const docs = new Map(); let n = 0;
  const ctx = {
    modules: { async call(target, method) { if (target === "workspace" && method === "resolve") return { id: "w1", machineId: "local", location: "local", rootAbsolutePath: dir, name: "w" }; throw new Error(`${target}.${method}`); } },
    host: {
      capabilities: { async request() { return { grant: "g" + Math.random() }; } },
      process: { async run(_g, spec) { const r = spawnSync(spec.executable, spec.args, { cwd: spec.cwd, encoding: "utf8" }); return { code: r.status, stdout: r.stdout, stderr: r.stderr, truncated: false }; } },
      fs: {
        async stat(_g, p) { const s = fs.statSync(path.join(dir, p)); return { kind: s.isFile() ? "file" : "dir", size: s.size, mtime: Math.floor(s.mtimeMs / 1000), path: p }; },
        async read(_g, p) { return { path: p, binary: false, truncated: false, size: 0, text: fs.readFileSync(path.join(dir, p), "utf8") }; },
      },
      ui: { async documentOpen(_w, text) { const h = "doc" + ++n; docs.set(h, text); return h; } },
      resources: { async release(h) { docs.delete(h); } },
    },
  };
  const latest = async () => { const r = await git.methods.latestChange(ctx, { workspaceId: "w1" }); return { ...r, text: r.document ? docs.get(r.document) : "" }; };
  return { dir, latest, write: (p, t) => fs.writeFileSync(path.join(dir, p), t), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test("only the most recent update is shown, including same-second same-size edits", async () => {
  const f = fixture();
  try {
    f.write("README.md", "one\nTWO\nthree\n");
    let r = await f.latest();
    assert.ok(r.baseline, "first look compares the newest file with HEAD");
    assert.deepEqual(r.files, ["README.md"]);
    assert.match(r.text, /-two\n\+TWO/);

    f.write("README.md", "one\nTWO\nthree\nfour\n");
    r = await f.latest();
    assert.equal(r.baseline, false);
    assert.deepEqual(r.files, ["README.md"]);
    assert.match(r.text, /\+four/);
    assert.doesNotMatch(r.text, /[-+]two|[-+]TWO/, "earlier edit is no longer shown");

    f.write("README.md", "one\nTWO\nthree\nFOUR\n"); // same size, likely the same second
    r = await f.latest();
    assert.match(r.text, /-four\n\+FOUR/);

    const before = r.document;
    r = await f.latest();
    assert.equal(r.document, before, "no change keeps showing the last update");

    f.write("other.txt", "alpha\nbeta\n");
    f.write("new.md", "hello\n");
    r = await f.latest();
    assert.deepEqual([...r.files].sort(), ["new.md", "other.txt"]);
    assert.match(r.text, /new file mode/);
    assert.doesNotMatch(r.text, /README/);

    f.write("other.txt", "alpha\n"); // reverted to HEAD
    r = await f.latest();
    assert.deepEqual(r.files, ["other.txt"]);
    assert.match(r.text, /-beta/);
  } finally { f.cleanup(); }
});
