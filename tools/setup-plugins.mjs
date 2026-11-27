#!/usr/bin/env node
// A separate checkout, deliberately not a second copy of sources tracked by Hato.
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
// The plugin branch this Hato branch is bound to (`branch` in plugins.lock.json; default main).
const lock = fs.existsSync('plugins.lock.json') ? JSON.parse(fs.readFileSync('plugins.lock.json', 'utf8')) : {};
const branch = typeof lock.branch === 'string' && /^[A-Za-z0-9._\/-]{1,100}$/.test(lock.branch) ? lock.branch : 'main';
if (!fs.existsSync('Hato-plugins/.git')) {
  const result = spawnSync('git', ['clone', '--branch', branch, 'https://github.com/ftpud/Hato-plugins.git', 'Hato-plugins'], {stdio:'inherit'});
  if (result.status !== 0) process.exit(result.status || 1);
}
if (!fs.existsSync('Hato-plugins/modules')) throw Error('The plugin repository needs its source migration published before development setup can complete.');
const current = spawnSync('git', ['-C', 'Hato-plugins', 'rev-parse', '--abbrev-ref', 'HEAD'], {encoding: 'utf8'}).stdout?.trim();
if (current && current !== branch) console.warn(`Hato-plugins is on '${current}', but this Hato branch is bound to '${branch}': run git -C Hato-plugins checkout ${branch}`);
console.log(`Plugin sources available in Hato-plugins/ (${branch}). Run npm run dev for hot reload.`);
