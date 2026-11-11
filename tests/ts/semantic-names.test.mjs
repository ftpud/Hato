import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as esbuild from 'esbuild';
const result = await esbuild.build({ entryPoints: ['sdk/lsp.ts'], bundle: true, format: 'esm', write: false });
const { semanticNames } = await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'));
const legend = { tokenTypes: ['class', 'interface', 'property', 'parameter'] };
const text = 'class A implements Runnable {\n  Map<String, A> node;\n  void f(A node) {}\n}';
// [deltaLine, deltaStart, length, type, modifiers]
const data = [0, 6, 1, 0, 0, 0, 13, 8, 1, 0, 1, 2, 3, 1, 0, 0, 4, 6, 0, 0, 0, 11, 4, 2, 0, 1, 9, 1, 0, 0, 0, 2, 4, 3, 0];
test('semantic tokens decode to identifier kinds', () => {
  assert.deepEqual(semanticNames({ data }, legend, text), { A: 'class', Runnable: 'interface', Map: 'interface', String: 'class' });
});
test('malformed semantic results are ignored', () => {
  assert.deepEqual(semanticNames(null, legend, text), {});
  assert.deepEqual(semanticNames({ data: [0, 0, 999, 0, 0] }, legend, text), {});
  assert.deepEqual(semanticNames({ data }, null, text), {});
});
