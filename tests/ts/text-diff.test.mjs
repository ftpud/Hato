// sdk/text-diff: generated patches must be valid Git patches that reproduce the new text.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as esbuild from "esbuild";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const built = await esbuild.build({ entryPoints: [path.join(root, "sdk/text-diff.ts")], bundle: true, format: "esm", platform: "neutral", write: false });
const { unifiedPatch } = await import("data:text/javascript;base64," + Buffer.from(built.outputFiles[0].text).toString("base64"));

function applies(before, after) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hato-text-diff-"));
  try {
    if (before !== null) fs.writeFileSync(path.join(dir, "f.txt"), before);
    const patch = unifiedPatch("f.txt", before, after);
    if (before === after) { assert.equal(patch, ""); return; }
    fs.writeFileSync(path.join(dir, "p.diff"), patch);
    execFileSync("git", ["apply", "--unsafe-paths", "p.diff"], { cwd: dir, stdio: "pipe" });
    const result = fs.existsSync(path.join(dir, "f.txt")) ? fs.readFileSync(path.join(dir, "f.txt"), "utf8") : null;
    assert.equal(result, after, patch);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test("small edits, insertions, deletions and newline-at-EOF changes apply with git", () => {
  const base = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
  applies(base, base.replace("line 5\n", "line five\n"));
  applies(base, base.replace("line 10\n", "line 10\nnew a\nnew b\n").replace("line 30\n", ""));
  applies(base, base.replace("line 1\n", "") + "tail\n");
  applies(base, base.slice(0, -1));
  applies("a\nb", "a\nc");
  applies(base, base);
});

test("created and deleted files", () => {
  applies(null, "hello\nworld\n");
  applies("bye\n", null);
});

test("random edits round-trip", () => {
  let seed = 7;
  const rand = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  for (let round = 0; round < 40; round++) {
    const lines = Array.from({ length: 5 + rand(60) }, () => "x" + rand(8));
    const next = [...lines];
    for (let e = 0; e < 1 + rand(6); e++) {
      const at = rand(next.length + 1), op = rand(3);
      if (op === 0) next.splice(at, 0, "new" + rand(100));
      else if (op === 1 && next.length) next.splice(Math.min(at, next.length - 1), 1);
      else if (next.length) next[Math.min(at, next.length - 1)] = "chg" + rand(100);
    }
    applies(lines.join("\n") + "\n", next.join("\n") + "\n");
  }
});
