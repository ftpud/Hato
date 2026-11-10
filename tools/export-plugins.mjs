// Export prebuilt, self-contained marketplace packages. Run modules:build first.
import fs from 'node:fs';
import path from 'node:path';
const target = process.argv[2];
if (!target) throw Error('Usage: node tools/export-plugins.mjs DESTINATION');
const catalogue = JSON.parse(fs.readFileSync('plugins.catalogue.json', 'utf8'));
for (const pkg of catalogue.packages) {
  pkg.artifacts = [];
  for (const id of pkg.modules) {
    const kind = ['services', 'ui'].find(k => fs.existsSync(`modules/${k}/${id}/manifest.json`));
    const manifest = JSON.parse(fs.readFileSync(`modules/${kind}/${id}/manifest.json`, 'utf8'));
    const base = `packages/${pkg.id}/${pkg.version}/${id}`;
    fs.mkdirSync(path.join(target, base, 'dist'), {recursive:true});
    fs.writeFileSync(path.join(target, base, 'manifest.json'), JSON.stringify(manifest,null,2)+'\n');
    fs.copyFileSync(`build/modules/${id}.mjs`, path.join(target,base,'dist',`${id}.mjs`));
    pkg.artifacts.push({id, manifest:`${base}/manifest.json`, bundle:`${base}/dist/${id}.mjs`});
  }
}
fs.writeFileSync(path.join(target,'catalogue.json'),JSON.stringify(catalogue,null,2)+'\n');
