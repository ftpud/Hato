import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

test('Git publishes counts while hidden and opens editable files on activation', async () => {
  const bundle = await build({ entryPoints: ['Hato-plugins/modules/ui/git-panel/src/index.ts'], bundle: true, format: 'esm', write: false });
  const mod = (await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'))).default;
  const values = new Map([['workspace.selected', { id: 'ws' }]]), watches = new Map(), events = new Map(), patches = [];
  let files = [{ path: 'src/main.ts', kind: 'modified' }];
  const ctx = {
    state: { get: key => values.get(key), set: (key, value) => values.set(key, value), watch: (key, fn) => watches.set(key, fn) },
    events: { on: (name, fn) => events.set(name, fn), emit() {} },
    ui: { invalidate() {} },
    modules: { async call(id, method, args) {
      if (id === 'git' && method === 'status') return { files, repo: true };
      if (method === 'view.patch') patches.push(args.patch);
    } },
  };
  await mod.activate(ctx);
  assert.equal(values.get('git-panel.panelBadge.git'), 1);
  const flatten = node => [node, ...(node.children || []).flatMap(flatten)];
  const file = flatten(mod.render()).find(node => node.action === 'diff');
  assert.equal(file.doubleClickAction, 'edit');
  await mod.onEvent(ctx, { action: file.doubleClickAction, value: file.value });
  assert.deepEqual(patches, [{ previewPath: 'src/main.ts' }]);
  files = [];
  events.get('git.changed')({ workspaceId: 'ws' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(values.get('git-panel.panelBadge.git'), 0);
  watches.get('workspace.selected')(null);
  assert.equal(values.get('git-panel.panelBadge.git'), 0);
  mod.deactivate();
});
