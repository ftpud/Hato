#!/usr/bin/env node
// Pin already published artifacts. Never pin unpublished local modifications.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
const root = path.resolve(process.argv[2] || 'Hato-plugins');
execFileSync('git', ['diff', '--exit-code', 'HEAD', '--', 'catalogue.json', 'packages'], {cwd: root, stdio: 'pipe'});
const revision = execFileSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8'}).trim();
execFileSync('git', ['merge-base', '--is-ancestor', revision, 'origin/main'], {cwd: root, stdio: 'pipe'});
const catalogue = JSON.parse(fs.readFileSync(path.join(root, 'catalogue.json'), 'utf8'));
const file = p => ({path: p, sha256: createHash('sha256').update(fs.readFileSync(path.join(root, p))).digest('hex')});
const selected = new Set();
function include(id) {
  if (selected.has(id)) return;
  const pkg = catalogue.packages.find(p => p.id === id);
  if (!pkg) throw Error(`Missing bootstrap dependency: ${id}`);
  selected.add(id);
  for (const dep of Object.keys(pkg.dependencies)) include(dep);
}
for (const pkg of catalogue.packages) if (pkg.core) include(pkg.id);
const modules = catalogue.packages.filter(p => selected.has(p.id)).flatMap(p => p.artifacts.map(a => ({id: a.id,
  kind: JSON.parse(fs.readFileSync(path.join(root, a.manifest), 'utf8')).kind,
  manifest: file(a.manifest), bundle: file(a.bundle)})));
fs.writeFileSync('plugins.lock.json', JSON.stringify({schemaVersion: 1, revision,
  baseUrl: `https://raw.githubusercontent.com/ftpud/Hato-plugins/${revision}/`, modules}, null, 2) + '\n');
console.log(`Pinned ${modules.length} modules from ${selected.size} system plugins at ${revision}`);
