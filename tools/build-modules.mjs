#!/usr/bin/env node
// Build every module under modules/{services,ui}/<id>/ into build/modules/<id>.mjs (seed artifacts).
// The kernel imports a changed seed build as a new artifact version at startup.
// The in-app path (module-dev service) runs the very same esbuild flags, writing to stdout.
import * as esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "build", "modules");
fs.mkdirSync(out, { recursive: true });

export const ESBUILD_FLAGS = { bundle: true, format: "esm", platform: "neutral", target: "es2020", logLevel: "warning", legalComments: "none", charset: "utf8", loader: { ".sql": "text", ".md": "text" } };

function discover() {
  const mods = [];
  for (const kind of ["services", "ui"]) {
    const dir = path.join(root, "modules", kind);
    if (!fs.existsSync(dir)) continue;
    for (const id of fs.readdirSync(dir).sort()) {
      const mf = path.join(dir, id, "manifest.json");
      if (!fs.existsSync(mf)) continue;
      const m = JSON.parse(fs.readFileSync(mf, "utf8"));
      if (m.id !== id) throw new Error(`${mf}: id ${m.id} does not match directory`);
      mods.push({ id, entry: path.join(dir, id, m.entry) });
    }
  }
  return mods;
}

async function buildOne(m) {
  const r = await esbuild.build({ ...ESBUILD_FLAGS, entryPoints: [m.entry], write: false });
  const code = r.outputFiles[0].text;
  const file = path.join(out, `${m.id}.mjs`);
  const prev = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
  if (prev !== code) fs.writeFileSync(file, code);
  return { id: m.id, bytes: Buffer.byteLength(code, "utf8"), changed: prev !== code };
}

const watch = process.argv.includes("--watch");
const only = process.argv.filter((a) => !a.startsWith("--")).slice(2);
const discovered = discover();
const unknown = only.filter(id => !discovered.some(m => m.id === id));
if (unknown.length) {
  console.error(`Unknown module(s): ${unknown.join(", ")}`);
  process.exit(1);
}
const selected = () => discover().filter(m => only.length === 0 || only.includes(m.id));
const mods = discovered.filter(m => only.length === 0 || only.includes(m.id));
let failed = 0;
for (const m of mods) {
  try {
    const r = await buildOne(m);
    console.log(`${r.changed ? "built  " : "same   "} ${m.id.padEnd(18)} ${String(r.bytes).padStart(7)} bytes`);
  } catch (e) {
    failed++;
    console.error(`FAILED ${m.id}: ${e.message}`);
  }
}
if (watch) {
  console.log("watching modules/ and sdk/ for changes (rebuilds seeds; the running kernel only picks them up with --dev-watch)…");
  let timer = null;
  let building = false;
  let dirty = false;
  const drain = async () => {
    if (building) return;
    building = true;
    try {
      while (dirty) {
        dirty = false;
        try {
          for (const m of selected()) {
            try {
              const r = await buildOne(m);
              if (r.changed) console.log(`rebuilt ${m.id}`);
            } catch (e) { console.error(`FAILED ${m.id}: ${e.message}`); }
          }
        } catch (e) { console.error(`FAILED discovery: ${e.message}`); }
      }
    } finally { building = false; }
  };
  const rebuild = () => {
    clearTimeout(timer);
    timer = setTimeout(() => { dirty = true; void drain(); }, 150);
  };
  fs.watch(path.join(root, "modules"), { recursive: true }, rebuild);
  fs.watch(path.join(root, "sdk"), { recursive: true }, rebuild);
} else if (failed) {
  process.exit(1);
}
