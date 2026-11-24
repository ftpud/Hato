import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

async function load() {
  const bundle = await build({ entryPoints: ['Hato-plugins/modules/services/browser/src/tools.ts'], bundle: true, format: 'esm', write: false });
  return import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64') + `#${Math.random()}`);
}

function fakeSession(extra = {}) {
  return {
    spec: { id: 's' }, start() {}, noteAgent() {}, netSeq: 0, activeTab: 't',
    view: () => ({ id: 's', name: 's', status: 'running', locationLabel: 'local', url: '', title: '', viewport: {}, tabs: [] }),
    ...extra,
  };
}

test('screenshots count against an image budget that warns before the limit', async () => {
  const { browserTools } = await load();
  const session = fakeSession({
    async screenshot() { return { data: 'AAAA', mimeType: 'image/jpeg', width: 1, height: 1, scale: 1, origin: { x: 0, y: 0 } }; },
  });
  const tools = browserTools({ pick: () => session, agentSessions: () => [session] });
  const call = (name, args) => tools.find(tool => tool.name === name).handler(args, { conversationId: 'c1' });
  const budget = await call('browser_screenshot', { budgetOnly: true });
  assert.equal(budget.imageBudget.remaining, 50);
  let last;
  for (let i = 0; i < 41; i++) last = await call('browser_screenshot', {});
  assert.equal(last.imageBudget.taken, 41);
  assert.match(last.imageBudget.warning, /9 screenshots left/);
  assert.equal(last.mcpContent[0].type, 'image');
  assert.equal((await call('browser_sessions', {})).imageBudget.remaining, 9);
  // Another conversation has its own budget.
  const other = await tools.find(tool => tool.name === 'browser_screenshot').handler({ budgetOnly: true }, { conversationId: 'c2' });
  assert.equal(other.imageBudget.remaining, 50);
});

test('a timed-out wait reports which conditions failed and why', async () => {
  const { browserTools } = await load();
  const session = fakeSession({
    async waitFor() { return { found: false, waitedMs: 120, conditions: { text: false, settled: false }, hint: 'The page was still loading when the wait ended' }; },
  });
  const tools = browserTools({ pick: () => session, agentSessions: () => [session] });
  const result = await tools.find(tool => tool.name === 'browser_wait').handler({ text: 'x' }, {});
  assert.equal(result.found, false);
  assert.equal(result.ok, false);
  assert.match(result.error, /still loading/);
  assert.deepEqual(result.conditions, { text: false, settled: false });
});

test('click, type, scroll and select accept names, labels and screenshot coordinates', async () => {
  const { browserTools } = await load();
  const tools = browserTools({ pick: () => fakeSession(), agentSessions: () => [] });
  const schema = name => tools.find(tool => tool.name === name).inputSchema.properties;
  for (const name of ['browser_click', 'browser_type', 'browser_scroll', 'browser_select', 'browser_inspect']) {
    for (const key of ['name', 'label', 'scale', 'originX']) assert.ok(schema(name)[key], `${name} accepts ${key}`);
  }
  assert.ok(schema('browser_click').dryRun && schema('browser_type').dryRun);
  assert.ok(schema('browser_elements').fields && schema('browser_elements').selector);
  assert.ok(schema('browser_wait').request && schema('browser_wait').textGone);
  assert.ok(tools.some(tool => tool.name === 'browser_console'));
});
