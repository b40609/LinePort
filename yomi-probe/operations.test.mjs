import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { normalizeConfig } from './route-config.mjs';
import { createMultiRelay } from './multi-relay.mjs';
import { createDeliveryReviewStore, inspectDelivery } from './delivery-review.mjs';

const directory = () => mkdtemp(path.join(os.tmpdir(), 'lineport-operations-'));
const endpoint = (id, platform = 'telegram') => ({ platform, id, name: id });
const config = () => normalizeConfig({ version: 1, rules: [{ id: 'call', name: '通知', enabled: true, sources: [endpoint('-1')], destinations: [endpoint('-2')] }] });
const message = (id, time) => ({ id: `-1:${id}`, text: `通知 ${id}`, createdTime: time, from: '123' });

async function blockedRoute() {
  const folder = await directory(), calls = [];
  let clock = 1000, fail = true, messages = [message(1, 2000), message(2, 2001), message(3, 2002)];
  const telegram = { identity: 'synthetic', recent: async () => [], prepare: async () => {}, read: async () => messages,
    send: async (id, text) => { if (fail) throw new Error('SYNTHETIC_UNKNOWN'); calls.push(text); return { id: `${id}:${100 + calls.length}` }; } };
  const setup = { config: config(), adapters: { telegram }, directory: folder, now: () => clock, pause: async () => {}, resendDelayMs: 1000 };
  const relay = await createMultiRelay(setup); await relay.tick(); clock += 1000; await relay.tick();
  assert.equal(relay.state.routes[0].phase, 'blocked');
  fail = false;
  return { folder, calls, telegram, setup, setMessages: value => { messages = value; } };
}

test('review list shows the queued backlog and when the route stopped', async () => {
  const { folder } = await blockedRoute();
  const { items } = await createDeliveryReviewStore(folder).list();
  assert.equal(items.length, 1); assert.equal(items[0].id, '-1:1');
  assert.equal(items[0].backlog, 2); assert.ok(Date.parse(items[0].blockedSince) > 0);
});

test('received without fast-forward resumes the whole backlog in order', async () => {
  const { folder, calls, setup, setMessages } = await blockedRoute();
  const review = createDeliveryReviewStore(folder), [item] = (await review.list()).items;
  await review.resolve({ ...item, decision: 'received' });
  setMessages([message(1, 2000), message(2, 2001), message(3, 2002), message(4, 5500)]);
  const restarted = await createMultiRelay({ ...setup, now: () => 6000 }); await restarted.tick();
  assert.deepEqual(calls, ['通知 2', '通知 3', '通知 4']);
});

test('fast-forward drops the backlog with an audit row, skips stale source messages and keeps new ones', async () => {
  const { folder, calls, setup, setMessages } = await blockedRoute();
  const review = createDeliveryReviewStore(folder, { now: () => 5000 }), [item] = (await review.list()).items;
  assert.deepEqual(await review.resolve({ ...item, decision: 'received', fastForward: true }), { resolved: true, decision: 'received', fastForward: true, dropped: 2 });
  const audit = (await readFile(path.join(folder, (await readdir(folder)).find(name => name.startsWith('lineport-review-'))), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(audit, [{ version: 2, id: '-1:1', decision: 'received', fastForward: true, dropped: ['-1:2', '-1:3'], at: 5000 }]);
  // Message 5 arrived while the route was stopped (before the decision); message 4 arrived after it.
  setMessages([message(1, 2000), message(2, 2001), message(3, 2002), message(5, 4000), message(4, 5500)]);
  const restarted = await createMultiRelay({ ...setup, now: () => 6000 }); await restarted.tick();
  assert.deepEqual(calls, ['通知 4']);
  assert.equal(restarted.state.routes[0].pending, 0); assert.ok(restarted.state.routes[0].fastForwardAt);
  // A second restart keeps the cursor: nothing stale is resurrected.
  const again = await createMultiRelay({ ...setup, now: () => 7000 }); await again.tick();
  assert.deepEqual(calls, ['通知 4']);
});

test('fast-forward is only offered with "received" and malformed version 2 rows fail closed', async () => {
  const { folder } = await blockedRoute();
  const review = createDeliveryReviewStore(folder), [item] = (await review.list()).items;
  await assert.rejects(review.resolve({ ...item, decision: 'skip', fastForward: true }), /快轉只能搭配/);
  await assert.rejects(review.resolve({ ...item, decision: 'received', fastForward: 'yes' }), /快轉只能搭配/);
  const { appendRecord } = await import('./relay-core.mjs');
  await appendRecord(path.join(folder, `lineport-review-${item.identity}.jsonl`), { version: 2, id: item.id, decision: 'received', fastForward: true, at: 1 });
  await assert.rejects(inspectDelivery(folder, item.identity), error => error.status === 409);
});
