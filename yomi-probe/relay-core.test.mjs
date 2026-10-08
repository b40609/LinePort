import test from 'node:test';
import assert from 'node:assert/strict';
import { parseJournal, establishBaseline, forwardBatch } from './relay-core.mjs';
import { unseenText } from './relay-rules.mjs';

const messages = [{ id: 'a', createdTime: 120, text: 'one' }, { id: 'b', createdTime: 130, text: 'two' }];
function fixture(overrides = {}) {
  const records = [], sends = [], pauses = [];
  return { messages, seen: new Set(), startedAt: 100, state: { forwarded: 0, uncertain: 0 },
    record: async row => records.push(row), send: async text => { sends.push(text); return { id: 'ack' }; },
    pause: async ms => pauses.push(ms), records, sends, pauses, ...overrides };
}
test('duplicate IDs within one batch are sent once; same text with different IDs survives', async () => {
  const f = fixture({ messages: [messages[0], messages[0], { ...messages[0], id: 'other' }] });
  await forwardBatch(f);
  assert.deepEqual(f.sends, ['one', 'one']);
  assert.deepEqual(f.pauses, [1000]);
});
test('invalid timestamps and invalid baselines cannot forward history', () => {
  assert.deepEqual(unseenText([{ id: 'x', createdTime: Infinity, text: 'bad' }], new Set(), 100), []);
  assert.throws(() => unseenText(messages, new Set(), NaN));
});
test('failed checkpoint does not change baseline IDs', async () => {
  const seen = new Set();
  await assert.rejects(establishBaseline({ messages, startedAt: 100, seen, record: async () => { throw new Error('disk'); } }));
  assert.equal(seen.size, 0);
});
test('complete checkpoint restores all baseline IDs together', async () => {
  const rows = [];
  await establishBaseline({ messages, startedAt: 100, seen: new Set(), record: async row => rows.push(row) });
  assert.equal(rows.length, 1);
  const restored = parseJournal(JSON.stringify(rows[0]) + '\n');
  assert.deepEqual([...restored.seen], ['a', 'b']);
  assert.equal(restored.startedAt, 100);
});
test('truncated or malformed journals fail closed', () => {
  for (const text of ['{"startedAt":100}', '{bad}\n', '{"startedAt":"100"}\n', '{"id":"a","outcome":"sending"}\n']) {
    assert.throws(() => parseJournal(text));
  }
});
test('legacy journal keeps sending and uncertain IDs deduplicated across restart', () => {
  const restored = parseJournal('{"startedAt":100}\n{"id":"a","outcome":"sending"}\n{"id":"b","outcome":"uncertain"}\n');
  assert.deepEqual(unseenText(messages, restored.seen, restored.startedAt), []);
});
test('journal failure before send prevents delivery', async () => {
  const f = fixture({ record: async () => { throw new Error('disk'); } });
  await assert.rejects(forwardBatch(f));
  assert.equal(f.sends.length, 0);
  assert.equal(f.state.stage, 'journal');
});
test('ambiguous send records uncertainty and stops before the next message', async () => {
  let attempts = 0;
  const f = fixture({ send: async () => { attempts++; throw new Error('network'); } });
  await assert.rejects(forwardBatch(f));
  assert.equal(attempts, 1);
  assert.equal(f.state.stage, 'send_uncertain');
  assert.equal(f.state.uncertain, 1);
  assert.deepEqual(f.records.map(r => r.outcome), ['sending', 'uncertain']);
  assert.ok(f.seen.has('a'));
  assert.ok(!f.seen.has('b'));
});
test('failure writing uncertainty is classified as journal failure', async () => {
  const f = fixture({ send: async () => { throw new Error('network'); }, record: async row => { if (row.outcome === 'uncertain') throw new Error('disk'); } });
  await assert.rejects(forwardBatch(f));
  assert.equal(f.state.stage, 'journal');
});
test('missing acknowledgement is uncertain rather than forwarded', async () => {
  const f = fixture({ send: async () => undefined });
  await assert.rejects(forwardBatch(f));
  assert.equal(f.state.forwarded, 0);
  assert.equal(f.state.uncertain, 1);
});
test('sent-record failure stops batch and keeps ID seen', async () => {
  const f = fixture({ record: async row => { if (row.outcome === 'sent') throw new Error('disk'); } });
  await assert.rejects(forwardBatch(f));
  assert.deepEqual(f.sends, ['one']);
  assert.ok(f.seen.has('a'));
  assert.equal(f.state.stage, 'journal');
});
