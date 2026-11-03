import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as esbuild from 'esbuild';
const result = await esbuild.build({ entryPoints: ['sdk/images.ts'], bundle: true, format: 'esm', write: false });
const { transcriptContent } = await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'));
const data = '/9j/' + 'ABCD'.repeat(500);
const uri = 'data:image/jpeg;base64,' + data;

test('replayed Markdown and raw image data URLs become attachments, not visible Base64', () => {
  for (const image of [uri, `![Screenshot](${uri})`]) {
    const projected = transcriptContent(`Before\n${image}\nAfter`);
    assert.equal(projected.text, 'Before\n\nAfter');
    assert.equal(projected.images.length, 1);
    assert.equal(projected.images[0].data, data);
    assert.ok(!projected.text.includes(data));
  }
});
test('bare image data is hidden, existing attachments are deduplicated and ordinary tokens stay intact', () => {
  assert.equal(transcriptContent(data).text, '');
  const existing = { name: 'Screenshot', mimeType: 'image/jpeg', data };
  assert.equal(transcriptContent(uri, [existing]).images.length, 1);
  const ordinary = 'ABCD'.repeat(500);
  assert.equal(transcriptContent(ordinary).text, ordinary);
  assert.equal(transcriptContent('Explain `**bold**`').text, 'Explain `**bold**`');
});
test('incomplete streamed image URLs hide their payload until a valid preview is available', () => {
  const projected = transcriptContent('data:image/png;base64,iVBORw0KGgoAB');
  assert.equal(projected.text, '[Picture data omitted]');
  assert.deepEqual(projected.images, []);
});
