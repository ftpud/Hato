import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
const result=await build({entryPoints:['modules/ui/settings/src/marketplace.ts'],bundle:true,format:'esm',platform:'node',write:false});
const {satisfies,plan}=await import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].text).toString('base64'));
test('version requirements handle zero-major compatibility and reject unsupported syntax',()=>{
 assert.ok(satisfies('0.1.3','^0.1.0'));assert.ok(!satisfies('0.2.0','^0.1.0'));
 assert.ok(!satisfies('0.0.2','^0.0.1'));assert.ok(satisfies('1.2.9','~1.2.3'));
 assert.ok(!satisfies('1.3.0','~1.2.3'));assert.ok(!satisfies('1.0.0','*'));
 assert.ok(!satisfies('1.0.0-beta','^1.0.0'));assert.ok(!satisfies('0.1.0','^0.1.1'));
});
const p=(id,dependencies={})=>({id,name:id,version:'0.1.0',coreVersion:'^0.1.0',dependencies});
test('dependency plans order prerequisites and reject cycles, missing and incompatible versions',()=>{
 assert.deepEqual(plan([p('a',{b:'^0.1.0'}),p('b')],'a','0.1.0').map(p=>p.id),['b','a']);
 assert.throws(()=>plan([p('a',{b:'^0.1.0'}),p('b',{a:'^0.1.0'})],'a','0.1.0'),/Cyclic/);
 assert.throws(()=>plan([p('a',{b:'^0.1.0'})],'a','0.1.0'),/Unsatisfied/);
 assert.throws(()=>plan([p('a',{b:'^0.2.0'}),p('b')],'a','0.1.0'),/Unsatisfied/);
 assert.throws(()=>plan([p('a')],'a','0.2.0'),/requires Hato/);
});
