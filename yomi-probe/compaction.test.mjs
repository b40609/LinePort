import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { compactRouteJournal, verifyRouteCompaction, compactStorage } from './compaction.mjs';
import { parseJournal } from './relay-core.mjs';
import { normalizeConfig } from './route-config.mjs';
import { createMultiRelay } from './multi-relay.mjs';
import { createDeliveryReviewStore, inspectDelivery } from './delivery-review.mjs';
import { verifySnapshot } from './storage-health.mjs';

const directory = () => mkdtemp(path.join(os.tmpdir(), 'lineport-compact-'));
const endpoint = (id, platform = 'telegram') => ({ platform, id, name: id });
const jsonl = rows => rows.map(row => JSON.stringify(row) + '\n').join('');

// A long-running route: many delivered and skipped messages, one queued, one unresolved, one retrying.
function history(count = 3000) {
  const rows = [{ routeIdentity: 'a'.repeat(64), name: 'n', source: endpoint('-1'), destination: endpoint('-2') }, { startedAt: 1000, baseline: ['-1:0'] }];
  for (let i = 1; i <= count; i++) {
    const id = `-1:${i}`;
    if (i % 3 === 0) { rows.push({ id, outcome: 'baseline' }); continue; }
    rows.push({ id, outcome: 'queued', text: `通知 ${i} ${'內容'.repeat(40)}`, ...(i % 7 === 0 ? { replyVersion: 1, replyTo: `-1:${i - 1}` } : {}) });
    rows.push({ id, outcome: 'sending' }, { id, outcome: 'sent', destinationId: `-2:${i}` });
  }
  rows.push({ id: '-1:9001', outcome: 'media_queued', payloadVersion: 2, payload: { kind: 'document', fileId: 'F', fileSize: 0, caption: '', fileName: 'a.pdf' } });
  rows.push({ id: '-1:9002', outcome: 'queued', text: '不明' }, { id: '-1:9002', outcome: 'sending' }, { id: '-1:9002', outcome: 'uncertain' });
  rows.push({ id: '-1:9003', outcome: 'queued', text: '等待重試' }, { id: '-1:9003', outcome: 'sending' }, { id: '-1:9003', outcome: 'retry', retryAt: 99999 });
  return jsonl(rows);
}

test('route compaction keeps every seen ID, queue, unresolved send, reply mapping and retry deadline', () => {
  const original = history(), compacted = compactRouteJournal(original, { now: 5000, recentBodies: 10 });
  assert.ok(Buffer.byteLength(compacted) < Buffer.byteLength(original) / 2, `${Buffer.byteLength(compacted)} vs ${Buffer.byteLength(original)}`);
  verifyRouteCompaction(original, compacted, { now: 5000 });
  const before = parseJournal(original), after = parseJournal(compacted);
  assert.deepEqual([...after.seen].sort(), [...before.seen].sort());
  assert.deepEqual([...after.pending], [...before.pending]);
  assert.deepEqual([...after.delivered].sort(), [...before.delivered].sort());
  assert.equal(after.retryAt, 99999); assert.equal(after.startedAt, 1000);
  // Older delivered bodies become placeholders; the newest stay verbatim.
  assert.match(compacted, /已壓縮/); assert.ok(compacted.includes('通知 2999'));
  // Compaction is idempotent and still verifiable.
  verifyRouteCompaction(compacted, compactRouteJournal(compacted, { now: 5000, recentBodies: 10 }), { now: 5000 });
});

test('verification rejects a candidate that would lose a queued message or unresolved evidence', () => {
  const original = history(30), good = compactRouteJournal(original, { now: 5000 });
  const dropQueued = good.split('\n').filter(line => !line.includes('-1:9001')).join('\n');
  assert.throws(() => verifyRouteCompaction(original, dropQueued, { now: 5000 }), /語意不一致/);
  const dropUncertain = good.split('\n').filter(line => !line.includes('"uncertain"')).join('\n');
  assert.throws(() => verifyRouteCompaction(original, dropUncertain, { now: 5000 }));
});

async function liveData() {
  const folder = await directory(), calls = [];
  let fail = false, messages = Array.from({ length: 60 }, (_, i) => ({ id: `-1:${i + 1}`, text: `通知 ${i + 1} ${'x'.repeat(200)}`, createdTime: 2000 + i, from: '1' }));
  const telegram = { identity: 'tg', recent: async () => [], prepare: async () => {}, read: async () => messages,
    send: async (id, text) => { if (fail) throw new Error('SYNTHETIC'); calls.push(text); return { id: `${id}:${calls.length}` }; } };
  const setup = { config: normalizeConfig({ version: 1, rules: [{ id: 'r', name: 'r', enabled: true, sources: [endpoint('-1')], destinations: [endpoint('-2')] }] }),
    adapters: { telegram }, directory: folder, now: () => 1000, pause: async () => {}, deliveryBudget: 100 };
  const relay = await createMultiRelay(setup); await relay.tick();
  assert.equal(calls.length, 60);
  // Then one uncertain send that a person resolves.
  fail = true; messages = [...messages, { id: '-1:61', text: '最後一則', createdTime: 3000, from: '1' }];
  await relay.tick();
  const review = createDeliveryReviewStore(folder), [item] = (await review.list()).items;
  await review.resolve({ ...item, decision: 'received' });
  fail = false;
  // A Telegram inbox with handled and unhandled messages.
  const inbox = path.join(folder, 'lineport-telegram-inbox-1.jsonl');
  await writeFile(inbox, jsonl([...messages.map((message, i) => ({ offset: i + 2, message: { ...message, chatId: '-1' } })), { offset: 80, message: { id: '-1:70', chatId: '-1', text: '還沒讀', createdTime: 4000 } }, { offset: 81 }]));
  // A duplicated output key.
  await appendFile(path.join(folder, 'lineport-output.jsonl'), (await readFile(path.join(folder, 'lineport-output.jsonl'), 'utf8')).split('\n')[0] + '\n');
  return { folder, calls, setup, item, messages };
}

test('stopped-state compaction backs up first, switches verified files and the relay continues without resending', async () => {
  const { folder, calls, setup, item } = await liveData();
  const before = Object.fromEntries(await Promise.all((await readdir(folder)).filter(name => name.endsWith('.jsonl')).map(async name => [name, await readFile(path.join(folder, name), 'utf8')])));
  const result = await compactStorage(folder, { now: 5000, recentBodies: 5 });
  assert.ok(result.compacted >= 2); assert.ok(result.bytesAfter < result.bytesBefore);
  // The backup keeps every original byte and verifies.
  await verifySnapshot(path.join(folder, result.backup));
  for (const [name, text] of Object.entries(before)) assert.equal(await readFile(path.join(folder, result.backup, name), 'utf8'), text);
  // Inbox keeps the offset and the unread message only.
  const inbox = await readFile(path.join(folder, 'lineport-telegram-inbox-1.jsonl'), 'utf8');
  assert.match(inbox, /還沒讀/); assert.ok(!inbox.includes('通知 1 ')); assert.ok(inbox.split('\n').filter(Boolean).every(line => JSON.parse(line).offset === 81));
  // Manual review evidence still matches the compacted journal.
  const reviewed = await inspectDelivery(folder, item.identity);
  assert.equal(reviewed.unresolved.size, 0); assert.equal(reviewed.resolutions.length, 1);
  // Restart: nothing is resent, new messages still flow.
  const restarted = await createMultiRelay({ ...setup, now: () => 6000 });
  setup.adapters.telegram.read = async () => [{ id: '-1:62', text: '新訊息', createdTime: 6500, from: '1' }];
  await restarted.tick();
  assert.equal(calls.length, 61); assert.equal(calls.at(-1), '新訊息');
});

test('compaction aborts without switching when a journal changes during the run', async () => {
  const { folder } = await liveData();
  const route = (await readdir(folder)).find(name => name.startsWith('lineport-route-'));
  const original = await readFile(path.join(folder, route), 'utf8');
  await assert.rejects(compactStorage(folder, { now: 5000, beforeSwitch: async plan => {
    const first = plan[0]; await appendFile(path.join(folder, first.name), first.name === 'lineport-output.jsonl' ? '{"key":"late"}\n' : '{"id":"-1:99","outcome":"baseline"}\n');
  } }), /已被其他程序修改/);
  const current = await readFile(path.join(folder, route), 'utf8');
  assert.ok(current === original || current.startsWith(original));
});
