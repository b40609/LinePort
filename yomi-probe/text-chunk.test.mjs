import test from 'node:test';
import assert from 'node:assert/strict';
import { splitTextChunks } from './text-chunk.mjs';

test('splitTextChunks keeps text within limit unchanged', () => {
  assert.deepEqual(splitTextChunks('hello world', 4000), ['hello world']);
  assert.deepEqual(splitTextChunks('a'.repeat(4000), 4000), ['a'.repeat(4000)]);
  assert.deepEqual(splitTextChunks('', 4000), ['']);
  assert.deepEqual(splitTextChunks(null, 4000), [null]);
});

test('splitTextChunks splits long text at paragraph boundaries with chunk tags', () => {
  const p1 = 'First paragraph content here.';
  const p2 = 'Second paragraph content here.';
  const p3 = 'Third paragraph content here.';
  const combined = `${p1}\n\n${p2}\n\n${p3}`;
  const chunks = splitTextChunks(combined, 35);
  assert.equal(chunks.length, 3);
  assert.ok(chunks[0].includes('(1/3)'));
  assert.ok(chunks[1].includes('(2/3)'));
  assert.ok(chunks[2].includes('(3/3)'));
  assert.ok(chunks[0].startsWith(p1));
  assert.ok(chunks[1].startsWith(p2));
  assert.ok(chunks[2].startsWith(p3));
});

test('splitTextChunks splits long text without newlines safely', () => {
  const longText = 'a'.repeat(9000);
  const chunks = splitTextChunks(longText, 4000);
  assert.equal(chunks.length, 3);
  assert.ok(chunks[0].endsWith('(1/3)'));
  assert.ok(chunks[1].endsWith('(2/3)'));
  assert.ok(chunks[2].endsWith('(3/3)'));
  // Each chunk plus tag remains comfortably under Telegram's 4096 hard limit
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 4096);
  }
});
