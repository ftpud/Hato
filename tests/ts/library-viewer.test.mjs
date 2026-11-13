import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as esbuild from 'esbuild';
let generation = 0;
async function load(entry) {
  const built = await esbuild.build({ entryPoints: [entry], bundle: true, format: 'esm', write: false });
  return (await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64') + '#' + (++generation))).default;
}
const walk = node => [node, ...(node?.children || []).flatMap(walk)];
const find = (node, key) => walk(node).find(n => n?.key === key);
const tick = () => new Promise(r => setTimeout(r, 0));
async function settle() { for (let i = 0; i < 20; i++) await tick(); }

// Library service, panel and viewer on one fake bus; module calls carry the caller id.
async function fixture() {
  const mods = {
    library: await load('Hato-plugins/modules/services/library/src/index.ts'),
    'library-panel': await load('Hato-plugins/modules/ui/library-panel/src/index.ts'),
    viewer: await load('Hato-plugins/modules/ui/viewer/src/index.ts'),
  };
  const listeners = {}, rows = new Map(), documents = new Map(), watchers = [];
  let selected = { id: 'ws', view: { previewPath: null, ui: {} } };
  const emit = (topic, args) => { for (const fn of listeners[topic] || []) void fn(args); };
  const ctxs = {};
  for (const id of Object.keys(mods)) ctxs[id] = {
    moduleId: id, generation: 1, log: { warn() {}, info() {} },
    state: { get: () => selected, set() {}, watch: (_, fn) => watchers.push(fn) },
    events: { on: (topic, fn) => (listeners[topic] ||= []).push(fn), emit },
    ui: { invalidate() {} },
    host: {
      plugins: { list: async () => ({ plugins: [] }) },
      resources: { release: async () => {} },
      ui: { documentOpen: async (_ws, text) => { const h = `doc${documents.size}`; documents.set(h, text); return h; }, toast() {} },
      db: { openNamespace: async () => 'library', query: async (_, _sql, args) => [...rows.values()].filter(r => r.project_id === args[0]),
        exec: async (_, sql, args) => { if (sql.startsWith('INSERT')) rows.set(args[0], { project_id: args[1], data: args[2] }); if (sql.startsWith('DELETE')) rows.delete(args[0]); } },
    },
    modules: { async call(target, method, args) {
      if (target === 'persistence') return null;
      if (target === 'workspace' && method === 'resolve') return { projectId: args.workspaceId };
      if (target === 'workspace' && method === 'view.patch') {
        selected = { ...selected, view: { ...selected.view, ...args.patch, ui: { ...selected.view.ui, ...args.patch.ui } } };
        watchers.forEach(fn => fn(selected)); return;
      }
      if (target === 'language-service') return null;
      const fn = mods[target]?.methods?.[method];
      if (!fn) throw new Error(`${target}.${method}`);
      return fn(ctxs[target], args, { caller: id });
    } },
  };
  for (const id of Object.keys(mods)) await mods[id].activate(ctxs[id]);
  const event = (id, action, extra = {}) => mods[id].onEvent(ctxs[id], { action, key: action, inputs: {}, ...extra });
  return { mods, ctxs, event, documents, get selected() { return selected; }, emit, listeners };
}

test('Library files open as editor tabs, save through the provider and refuse stale overwrites', async () => {
  const f = await fixture(), { mods, ctxs, event } = f;
  await event('library-panel', 'new');
  await event('library-panel', 'create', { inputs: { name: 'Release', description: 'Ship it' } });
  await settle();
  const [entry] = await mods.library.methods.list(ctxs.library, { scope: 'global' });
  const tab = `virtual:library-panel/global/${entry.id}/SKILL.md`;
  assert.equal(f.selected.view.previewPath, tab, 'creating an entry opens its root page in the editor');
  let view = mods.viewer.render();
  assert.match(find(view, 'path').text, /Library · Release \/ SKILL\.md/);
  assert.ok(find(view, 'virtual-preview'), 'Markdown renders in the editor preview');
  assert.equal(find(mods['library-panel'].render(), 'preview'), undefined, 'the panel no longer embeds a preview');

  // Edit the source in the viewer; autosave goes through the library-panel provider.
  await event('viewer', 'toggleMarkdown');
  view = mods.viewer.render();
  const code = find(view, 'code');
  assert.equal(code.editable, true);
  assert.equal(code.definitionMethod, undefined, 'no language server for virtual tabs');
  await event('viewer', 'edit', { value: { document: code.document, text: '# Release\n\nEdited in the editor.\n' } });
  await event('viewer', 'save');
  await settle();
  assert.equal((await mods.library.methods.read(ctxs.library, { scope: 'global', id: entry.id, path: 'SKILL.md' })).content, '# Release\n\nEdited in the editor.\n');
  assert.equal(find(mods.viewer.render(), 'save-state').text, 'Saved');

  // A concurrent writer (e.g. MCP) changes the file while the editor has unsaved edits.
  await event('viewer', 'edit', { value: { document: code.document, text: 'mine' } });
  const fresh = await mods.library.methods.read(ctxs.library, { scope: 'global', id: entry.id });
  await mods.library.methods.save(ctxs.library, { scope: 'global', id: entry.id, path: 'SKILL.md', content: 'theirs', expectedRevision: fresh.revision });
  await settle();
  await event('viewer', 'save');
  await settle();
  assert.equal(find(mods.viewer.render(), 'save-state').text, 'Changed elsewhere');
  assert.equal((await mods.library.methods.read(ctxs.library, { scope: 'global', id: entry.id, path: 'SKILL.md' })).content, 'theirs');
  await event('viewer', 'overwrite');
  await settle();
  assert.equal((await mods.library.methods.read(ctxs.library, { scope: 'global', id: entry.id, path: 'SKILL.md' })).content, 'mine');
  await mods.viewer.deactivate(ctxs.viewer);
});

test('virtual tabs only accept their own provider, and save events carry no text', async () => {
  const f = await fixture(), { mods, ctxs } = f;
  await assert.rejects(mods.viewer.methods['virtual.show'](ctxs.viewer, { workspaceId: 'ws', tab: 'virtual:library-panel/global/x/SKILL.md', title: 'spoof' }, { caller: 'other' }), /Only the module/);
  const seen = [];
  (f.listeners['viewer.virtualSave'] ||= []).unshift(ev => seen.push(ev));
  const entry = await mods.library.methods.save(ctxs.library, { scope: 'global', kind: 'agent', name: 'Reviewer', expectedRevision: null });
  await f.event('library-panel', 'select', { rowKey: `file:${entry.id}:AGENT.md` });
  await settle();
  const code = (await f.event('viewer', 'toggleMarkdown'), find(mods.viewer.render(), 'code'));
  await f.event('viewer', 'edit', { value: { document: code.document, text: 'secret' } });
  await f.event('viewer', 'save');
  await settle();
  assert.equal(seen.length, 1);
  assert.equal(JSON.stringify(seen[0]).includes('secret'), false);
  await assert.rejects(Promise.resolve().then(() => mods.viewer.methods['virtual.take'](ctxs.viewer, { requestId: seen[0].requestId }, { caller: 'library-panel' })), /Unknown|already/);
  await mods.viewer.deactivate(ctxs.viewer);
});

test('relative Markdown links open sibling Library pages; restored tabs ask the provider', async () => {
  const f = await fixture(), { mods, ctxs } = f;
  let entry = await mods.library.methods.save(ctxs.library, { scope: 'global', kind: 'skill', name: 'Linked', expectedRevision: null });
  entry = await mods.library.methods.save(ctxs.library, { scope: 'global', id: entry.id, path: 'references/guide.md', content: '# Guide', expectedRevision: entry.revision });
  await f.event('library-panel', 'refresh');
  await f.event('library-panel', 'select', { rowKey: entry.id });
  await settle();
  await f.event('viewer', 'openLink', { value: 'references/guide.md#top' });
  await settle();
  assert.equal(f.selected.view.previewPath, `virtual:library-panel/global/${entry.id}/references/guide.md`);
  assert.match(find(mods.viewer.render(), 'md').text, /# Guide/);

  // A tab the viewer has no content for (e.g. restored after restart) is requested from the provider.
  entry = await mods.library.methods.save(ctxs.library, { scope: 'global', id: entry.id, path: 'scripts/check.sh', content: '#!/bin/sh\necho ok\n', expectedRevision: entry.revision });
  await ctxs.viewer.modules.call('workspace', 'view.patch', { workspaceId: 'ws', patch: { previewPath: `virtual:library-panel/global/${entry.id}/scripts/check.sh` } });
  await settle();
  const code = find(mods.viewer.render(), 'code');
  assert.equal(f.documents.get(code.document), '#!/bin/sh\necho ok\n');
  assert.match(find(mods.viewer.render(), 'path').text, /Linked \/ scripts\/check\.sh/);
  // A deleted entry shows an error instead of stale content.
  await mods.library.methods.remove(ctxs.library, { scope: 'global', id: entry.id, expectedRevision: entry.revision });
  await settle();
  assert.match(find(mods.viewer.render(), 'err').text, /not found/);
  await mods.viewer.deactivate(ctxs.viewer);
});
