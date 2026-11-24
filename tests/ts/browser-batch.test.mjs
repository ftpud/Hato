import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

test('a browser batch holds its session queue until every step finishes', async () => {
  const bundle = await build({
    entryPoints: ['Hato-plugins/modules/services/browser/src/tools.ts'],
    bundle: true, format: 'esm', write: false,
  });
  const { browserTools } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
  const calls = [];
  let entered, release;
  const waiting = new Promise(resolve => { entered = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  const shared = {
    spec: { id: 'shared' }, start() {}, noteAgent() {},
    async navigate() { calls.push('navigate'); entered(); await blocked; return { url: 'about:blank' }; },
    text(_scope, selector) { calls.push(selector); return { text: selector }; },
  };
  const other = { ...shared, spec: { id: 'other' } };
  const tools = browserTools({ pick: id => id === 'shared' ? shared : other });
  const scope = { allowedBrowserCommands: ['browser_navigate', 'browser_text'] };
  const call = (name, args) => tools.find(tool => tool.name === name).handler(args, scope);
  const batch = call('browser_batch', { session: 'shared', steps: [
    { command: 'browser_navigate', arguments: { url: 'about:blank' } },
    { command: 'browser_text', arguments: { selector: 'batch text' } },
  ] });
  await waiting;
  const queued = call('browser_text', { session: 'shared', selector: 'queued text' });
  await call('browser_text', { session: 'other', selector: 'other session' });
  assert.deepEqual(calls, ['navigate', 'other session']);
  release();
  await Promise.all([batch, queued]);
  assert.deepEqual(calls, ['navigate', 'other session', 'batch text', 'queued text']);
});
