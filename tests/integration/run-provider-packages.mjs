#!/usr/bin/env node
// Real kernel test with a fresh system-only module set and no marketplace network dependency.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const plugins=path.join(root,'Hato-plugins');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'hato-provider-packages-'));
try {
 const host=path.join(temp,'host'),catalogue=JSON.parse(fs.readFileSync(path.join(plugins,'plugins.catalogue.json'),'utf8'));
 const selected=new Set();
 function include(id){if(selected.has(id))return;const p=catalogue.packages.find(p=>p.id===id);if(!p)throw Error(`Unknown ${id}`);selected.add(id);Object.keys(p.dependencies).forEach(include);}
 catalogue.packages.filter(p=>p.core).forEach(p=>include(p.id));
 for(const pkg of catalogue.packages.filter(p=>selected.has(p.id)))for(const id of pkg.modules){
  const kind=['services','ui'].find(k=>fs.existsSync(path.join(plugins,'modules',k,id,'manifest.json')));
  const destination=path.join(host,'modules',kind,id);fs.mkdirSync(destination,{recursive:true});
  fs.copyFileSync(path.join(plugins,'modules',kind,id,'manifest.json'),path.join(destination,'manifest.json'));
  fs.mkdirSync(path.join(host,'build/modules'),{recursive:true});
  fs.copyFileSync(path.join(plugins,'build/modules',id+'.mjs'),path.join(host,'build/modules',id+'.mjs'));
 }
 fs.mkdirSync(path.join(host,'grants'),{recursive:true});
 const driver=path.join(temp,'driver.js');
 fs.writeFileSync(driver,fs.readFileSync(path.join(root,'tests/integration/lib.js'),'utf8')+fs.readFileSync(path.join(root,'tests/integration/provider-packages.js'),'utf8'));
 const result=spawnSync(path.join(root,'target/debug/hato'),['--repo-root',host,'--data-dir',path.join(temp,'data'),'--headless-script',driver],{cwd:root,stdio:'inherit',env:{...process.env,HATO_PACKAGE_SOURCE_ROOT:root}});
 if(result.error)throw result.error;
 process.exitCode=result.status || 0;
}finally{fs.rmSync(temp,{recursive:true,force:true});}
