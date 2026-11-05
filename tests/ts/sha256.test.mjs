import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as esbuild from 'esbuild';
const built = await esbuild.build({ entryPoints: ['sdk/sha256.ts'], bundle: true, format: 'esm', write: false });
const { sha256Hex } = await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64'));
const expected = text => createHash('sha256').update(text).digest('hex');

test('SHA-256 matches native UTF-8 hashing across padding, Unicode and surrogate boundaries', () => {
  for (const text of ['', 'abc', 'hello world', 'Привет 🦊 café', '\ud800', '\udc00', '\ud800x', 'x\udfff', ...Array.from({ length: 140 }, (_, n) => 'a'.repeat(n)), '😀'.repeat(65)])
    assert.equal(sha256Hex(text), expected(text), JSON.stringify(text));
});

test('multi-megabyte hashing does not allocate through the embedded TextEncoder', () => {
  const previous = globalThis.TextEncoder;
  globalThis.TextEncoder = class { encode() { throw new Error('unbounded encoder used'); } };
  try {
    const text = 'x'.repeat(6 * 1024 * 1024) + '😀';
    assert.equal(sha256Hex(text), expected(text));
  } finally { globalThis.TextEncoder = previous; }
});
