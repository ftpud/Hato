#!/usr/bin/env node
// A separate checkout, deliberately not a second copy of sources tracked by Hato.
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
if (!fs.existsSync('Hato-plugins/.git')) {
  const result = spawnSync('git', ['clone', 'https://github.com/ftpud/Hato-plugins.git', 'Hato-plugins'], {stdio:'inherit'});
  if (result.status !== 0) process.exit(result.status || 1);
}
if (!fs.existsSync('Hato-plugins/modules')) throw Error('The plugin repository needs its source migration published before development setup can complete.');
console.log('Plugin sources available in Hato-plugins/. Run npm run dev for hot reload.');
