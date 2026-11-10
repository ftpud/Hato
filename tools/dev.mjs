#!/usr/bin/env node
// One command: build plugins, watch source/SDK changes, and activate changed bundles live.
import {spawn, spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
if (!fs.existsSync('Hato-plugins/modules')) throw Error('Run npm run plugins:setup first');
const initial = spawnSync(process.execPath, ['tools/build-modules.mjs'], {stdio:'inherit'});
if (initial.status !== 0) process.exit(initial.status || 1);
const watch = spawn(process.execPath, ['tools/build-modules.mjs', '--watch'], {stdio:'inherit'});
const app = spawn('cargo', ['run', '--', '--repo-root', root, '--dev-watch', ...process.argv.slice(2)], {stdio:'inherit'});
let stopping = false;
function stop(code) {
  if (stopping) return;
  stopping = true;
  watch.kill('SIGTERM'); app.kill('SIGTERM');
  process.exitCode = code;
}
process.on('SIGINT', () => stop(130));
process.on('SIGTERM', () => stop(143));
for (const child of [watch, app]) {
  child.on('error', error => { console.error(error); stop(1); });
  child.on('exit', code => stop(code || 0));
}
