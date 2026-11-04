import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as esbuild from 'esbuild';
const result = await esbuild.build({ entryPoints: ['sdk/links.ts'], bundle: true, format: 'esm', write: false });
const { resolveWorkspaceLink: r } = await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'));
const root = '/Users/me/proj';
test('markdown file links resolve to workspace-relative paths', () => {
  assert.equal(r('README.md', root), 'README.md');
  assert.equal(r('./guide.md#setup', root, 'docs'), 'docs/guide.md');
  assert.equal(r('../sdk/types.ts', root, 'docs'), 'sdk/types.ts');
  assert.equal(r('/Users/me/proj/kernel/src/ui/mod.rs:812', root), 'kernel/src/ui/mod.rs');
  assert.equal(r('file:///Users/me/proj/a%20b.md', root), 'a b.md');
  assert.equal(r('file://localhost/Users/me/proj/x.ts:3:7', root), 'x.ts');
  assert.equal(r('<docs/My File.md>', root), 'docs/My File.md');
});
test('non-file and out-of-root links are rejected', () => {
  for (const href of ['#anchor', 'https://x.dev', 'vscode://file/x', '/etc/passwd', '../../outside.md', 'file:///tmp/x', '', '~/x']) assert.equal(r(href, root), null, href);
  assert.equal(r('a.md', null), null);
});

test('file links handle line suffixes, filesystem roots and remote authorities', () => {
  assert.equal(r('index.ts:12:3', root), 'index.ts');
  assert.equal(r('index.ts:12#section', root), 'index.ts');
  assert.equal(r('/etc/hosts', '/'), 'etc/hosts');
  assert.equal(r('etc/hosts', '/'), 'etc/hosts');
  assert.equal(r('file://remote/Users/me/proj/x.ts', root), null);
  assert.equal(r('x.ts', 'relative/root'), null);
});
