import test from 'node:test';
import assert from 'node:assert/strict';
import { unseenText } from './relay-rules.mjs';
test('exclude history, duplicates and unreadable messages; preserve chronological order', () => {
  const messages = [
    { id: 'old', createdTime: 90, text: 'history' },
    { id: 'seen', createdTime: 110, text: 'duplicate' },
    { id: 'second', createdTime: 130, text: 'second' },
    { id: 'first', createdTime: 120, text: 'first' },
    { id: 'bad', createdTime: 140, text: 'encrypted', e2eeDecryptFailure: true },
    { id: 'image', createdTime: 150, text: '' },
  ];
  assert.deepEqual(unseenText(messages, new Set(['seen']), 100).map(m => m.id), ['first', 'second']);
  assert.deepEqual(unseenText(messages, new Set(['seen', 'first', 'second']), 100), []);
});
