import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as esbuild from 'esbuild';
const result = await esbuild.build({ entryPoints: ['sdk/reasoning.ts'], bundle: true, format: 'esm', write: false });
const { reasoningMarkdown } = await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'));
test('adjacent streamed reasoning headings stay separated and italic', () => {
  const chunks = ['**Checking usageMeter support', '**', '**Staging usage meter fallback**', '**Adding uiFeatures detection**'];
  assert.equal(reasoningMarkdown(chunks.join('')), '*Checking usageMeter support*\n\n*Staging usage meter fallback*\n\n*Adding uiFeatures detection*');
  assert.equal(reasoningMarkdown('**First**\n\n**Second**'), '*First*\n\n*Second*');
  assert.equal(reasoningMarkdown('Before **heading** after'), 'Before *heading* after');
});
test('reasoning keeps code, escaped markers, Unicode and ordinary streamed text intact', () => {
  for (const text of ['`**code**`', '```\n**code**\n```', '\\*\\*literal\\*\\*', 'Already *italic*', 'Checking configuration…']) assert.equal(reasoningMarkdown(text), text);
  assert.equal(reasoningMarkdown('**日本語**'), '*日本語*');
  assert.equal(reasoningMarkdown('**Still streaming'), '**Still streaming');
  assert.equal(reasoningMarkdown('**Short**' + ' text '.repeat(400)), '*Short*' + ' text '.repeat(400));
});
