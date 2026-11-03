import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as esbuild from 'esbuild';
const built = await esbuild.build({ entryPoints: ['sdk/scoped-settings.ts'], bundle: true, format: 'esm', write: false });
const { scopesFor, syncScope } = await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64'));
function store(entries) {
  const values = new Map(entries.map(e => [e.key, e]));
  const call = async (method, a) => {
    if (method === 'scoped.list') return [...values.values()];
    const rev = values.get(a.key)?.rev ?? 0;
    if (a.expectedRev !== rev) throw Error('ECONFLICT');
    values.set(a.key, { key: a.key, value: a.value, rev: a.rev });
  };
  return { values, call };
}
test('scope precedence includes workspace, machine, user', () => {
  assert.deepEqual(scopesFor({id:'w',machineId:'m'}), ['workspace:w','machine:m','user']);
  assert.deepEqual(scopesFor(), ['user']);
});
test('sync copies missing and newer settings in both directions', async () => {
  const a = store([{key:'a',value:1,rev:1},{key:'b',value:0,rev:1}]);
  const b = store([{key:'b',value:2,rev:2}]);
  await syncScope('machine:m', a.call, b.call);
  assert.deepEqual([...a.values.values()], [...b.values.values()].sort((x,y)=>x.key.localeCompare(y.key)));
});
test('equal revisions converge to desktop and report conflicts once', async () => {
  const a = store([{key:'a',value:'desktop',rev:2}]), b = store([{key:'a',value:'remote',rev:2}]);
  assert.deepEqual(await syncScope('machine:m', a.call,b.call), {conflicts:['a']});
  assert.deepEqual(a.values.get('a'),b.values.get('a'));
  assert.equal(a.values.get('a').rev,3);
  assert.deepEqual(await syncScope('machine:m',a.call,b.call),{conflicts:[]});
});
test('sync compares JSON objects independently of property order', async () => {
  const a=store([{key:'a',value:{a:1,b:2},rev:1}]), b=store([{key:'a',value:{b:2,a:1},rev:1}]);
  assert.deepEqual(await syncScope('machine:m',a.call,b.call),{conflicts:[]});
});
test('sync does not overwrite an edit made after listing', async () => {
  const a=store([{key:'a',value:2,rev:2}]), b=store([{key:'a',value:1,rev:1}]);
  await assert.rejects(syncScope('machine:m', a.call, async (method,args) => {
    if(method==='scoped.set') b.values.set('a',{key:'a',value:'new edit',rev:3});
    return b.call(method,args);
  }), /ECONFLICT/);
  assert.equal(b.values.get('a').value,'new edit');
});
