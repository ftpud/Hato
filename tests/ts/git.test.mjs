import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as esbuild from 'esbuild';
const load = async (entry) => import('data:text/javascript;base64,' + Buffer.from((await esbuild.build({ entryPoints: [entry], bundle: true, format: 'esm', write: false })).outputFiles[0].text).toString('base64'));
const S = await load('Hato-plugins/modules/services/git/src/status.ts');
const P = await load('Hato-plugins/modules/ui/git-panel/src/model.ts');
const G = await load('sdk/git.ts');

test('porcelain -z status parses kinds, staging and renames', () => {
  const out = ' M src/a.ts\0M  staged.ts\0MM both.ts\0R  new name.ts\0old name.ts\0?? untracked/x.md\0 D gone.ts\0UU conflict.ts\0A  added.ts\0';
  const files = S.parseStatus(out);
  const by = Object.fromEntries(files.map((f) => [f.path, f]));
  assert.equal(by['src/a.ts'].kind, 'modified'); assert.equal(by['src/a.ts'].staged, false); assert.equal(by['src/a.ts'].unstaged, true);
  assert.equal(by['staged.ts'].staged, true); assert.equal(by['staged.ts'].unstaged, false);
  assert.ok(by['both.ts'].staged && by['both.ts'].unstaged);
  assert.equal(by['new name.ts'].kind, 'renamed'); assert.equal(by['new name.ts'].origPath, 'old name.ts');
  assert.equal(by['untracked/x.md'].kind, 'untracked');
  assert.equal(by['gone.ts'].kind, 'deleted');
  assert.equal(by['conflict.ts'].kind, 'conflicted');
  assert.equal(by['added.ts'].kind, 'added');
  assert.deepEqual(files.map((f) => f.path), [...files.map((f) => f.path)].sort((a, b) => a.localeCompare(b)));
});

test('numstat -z parses counts, binaries and renames', () => {
  const m = S.parseNumstat('3\t1\tsrc/a.ts\0-\t-\timg.png\0' + '2\t0\t\0old.ts\0new.ts\0');
  assert.deepEqual(m.get('src/a.ts'), { additions: 3, deletions: 1, binary: false });
  assert.deepEqual(m.get('img.png'), { additions: null, deletions: null, binary: true });
  assert.deepEqual(m.get('new.ts'), { additions: 2, deletions: 0, binary: false });
});

test('panel rows show status badge, directory and selection', () => {
  const [row] = P.changeRows([{ path: 'src/a.ts', origPath: null, kind: 'modified', index: 'M', worktree: 'M', staged: true, unstaged: true, additions: 3, deletions: 1, binary: false }], 'src/a.ts');
  assert.equal(row.label, 'a.ts'); assert.equal(row.badge, 'M +3 −1'); assert.match(row.detail, /^src · Modified, partly staged$/); assert.ok(row.selected);
  assert.equal(P.signature({ branch: 'main', files: [] }), 'main\n');
});

test('diff tabs round-trip through preview paths', () => {
  assert.equal(G.diffTabPath(G.diffTab('a/b.ts')), 'a/b.ts');
  assert.equal(G.diffTabPath('a/b.ts'), null);
});
