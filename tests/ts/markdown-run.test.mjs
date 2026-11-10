import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as esbuild from 'esbuild';
let generation = 0;
async function load(entry) {
  const built = await esbuild.build({ entryPoints: [entry], bundle: true, format: 'esm', write: false });
  return import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64') + '#' + (++generation));
}
const walk = node => [node, ...(node.children || []).flatMap(walk)];
const text = '# Example\n\n```sh\necho first\n```\n\nMiddle\n\n~~~shell\necho second\n~~~\n';

test('Markdown recognizes closed shell fences, ignores quoted fence examples, and preserves the command', async () => {
  const { shellBlocks } = await load('Hato-plugins/modules/ui/viewer/src/markdown.ts');
  assert.deepEqual(shellBlocks(text).map(block => [block.language, block.code]), [['sh', 'echo first\n'], ['shell', 'echo second\n']]);
  assert.equal(shellBlocks('````markdown\n```sh\necho not-a-command\n```\n````\n').length, 0);
  assert.equal(shellBlocks('```sh\necho incomplete\n').length, 0);
  assert.equal(shellBlocks('```python\nprint(1)\n```\n').length, 0);
  assert.equal(shellBlocks('  ```bash\r\n  echo "hello"\r\n  ```\r\n')[0].code, 'echo "hello"\r\n');
});

test('Markdown renders one Run button per shell block and dispatches each to its own stable terminal', async () => {
  const viewer = (await load('Hato-plugins/modules/ui/viewer/src/index.ts')).default;
  const terminal = (await load('Hato-plugins/modules/ui/terminal-panel/src/index.ts')).default;
  const events = {}, executions = [];
  let selected = { id: 'ws', view: { previewPath: 'README.md', ui: {} } };
  const watchers = [];
  const ctx = { moduleId: 'viewer', state: { get: () => selected, set() {}, watch: (_, fn) => { watchers.push(fn); } },
    events: { on: (topic, fn) => { events[topic] = fn; }, emit: (topic, args) => { void events[topic]?.(args); } }, ui: { invalidate() {} },
    modules: { async call(module, method, args) {
      if (method === 'settings.get') return null;
      if (method === 'view.patch') { selected = { ...selected, view: { ...selected.view, ...args.patch, ui: { ...selected.view.ui, ...args.patch.ui } } }; watchers.forEach(fn => fn(selected)); return; }
      if (module === 'files' && method === 'open') { assert.equal(args.includeText, true); return { document: 'md', relativePath: 'README.md', language: 'markdown', text }; }
      if (method === 'attach') return { pty: args.key };
      if (method === 'activity') return [];
      if (method === 'runCode') { executions.push(args); return { running: true }; }
      throw new Error(`${module}.${method}`);
    } },
  };
  try {
    await terminal.activate(ctx);
    await viewer.activate(ctx);
    const buttons = walk(viewer.render()).filter(node => node.action === 'runShellBlock');
    assert.equal(buttons.length, 2);
    for (const button of buttons) await viewer.onEvent(ctx, { action: button.action, value: button.value, inputs: {} });
    await viewer.onEvent(ctx, { action: buttons[0].action, value: buttons[0].value, inputs: {} });
    assert.equal(executions[0].key, 'md:README.md:0');
    assert.equal(executions[1].key, 'md:README.md:1');
    assert.equal(executions[2].key, executions[0].key);
    assert.equal(selected.view.ui.terminalTabs.keys.filter(key => key.startsWith('md:')).length, 2);
    assert.match(executions[0].command, /echo first/);
    assert.match(executions[1].command, /echo second/);
  } finally { await viewer.deactivate(ctx); terminal.deactivate(); }
});
