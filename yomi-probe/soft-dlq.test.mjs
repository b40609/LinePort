import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { normalizeConfig } from './route-config.mjs';
import { createMultiRelay } from './multi-relay.mjs';
import { RelayError } from './relay-health.mjs';
import { createTelegramClient } from './telegram.mjs';
import { createDeliveryReviewStore } from './delivery-review.mjs';
import { healthEvents, createHealthMonitor } from './health-alert.mjs';

const endpoint = (platform, id) => ({ platform, id, name: id });
const config = normalizeConfig({ version: 1, rules: [{ id: 'r', name: '公告', enabled: true, sources: [endpoint('line', 'csource')], destinations: [endpoint('telegram', '-2')] }] });
const permanent = () => Object.assign(new RelayError('Telegram 拒絕此則內容'), { rejected: true, permanent: true, status: 400 });

async function fixture(directory, failures) {
  let messages = [];
  const sent = [];
  const line = { identity: 'line', recent: async () => [], prepare: async () => 'e2ee', read: async () => messages, send: async () => ({ id: '1' }) };
  const telegram = { identity: 'tg', prepare: async () => {}, send: async (id, text) => {
    const failure = failures(text);
    if (failure) throw failure;
    sent.push(text); return { id: `${id}:${sent.length}` };
  } };
  const relay = await createMultiRelay({ config, adapters: { line, telegram }, directory, now: () => 1000, pause: async () => {}, deliveryBudget: 20 });
  return { relay, sent, push: (...texts) => { messages = [...messages, ...texts.map((text, index) => ({ id: `m${messages.length + index + 1}`, text, createdTime: 2000, from: 'u1' }))]; } };
}
const route = relay => relay.state.routes[0];

test('Telegram marks only per-message 400 rejections permanent, never chat-wide ones', async () => {
  const reply = (status, description) => async () => new Response(JSON.stringify({ ok: false, error_code: status, description }), { status });
  const tooLong = createTelegramClient('12345:SYNTHETIC_TOKEN_1234567890', { request: reply(400, 'Bad Request: message is too long') });
  await assert.rejects(tooLong.send('-2', 'x'), error => error.rejected === true && error.permanent === true);
  const chat = createTelegramClient('12345:SYNTHETIC_TOKEN_1234567890', { request: reply(400, 'Bad Request: chat not found') });
  await assert.rejects(chat.send('-2', 'x'), error => error.rejected === true && error.permanent === false);
  const forbidden = createTelegramClient('12345:SYNTHETIC_TOKEN_1234567890', { request: reply(403, 'Forbidden: bot was kicked') });
  await assert.rejects(forbidden.send('-2', 'x'), error => error.permanent === false);
});

test('a definite per-message rejection is quarantined with an audit row and later messages keep flowing', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'lineport-dlq-'));
  const f = await fixture(directory, text => text === '壞訊息' ? permanent() : null);
  f.push('壞訊息', '正常訊息');
  await f.relay.tick();
  assert.deepEqual(f.sent, ['正常訊息']);
  assert.equal(route(f.relay).phase, 'running');
  assert.equal(route(f.relay).quarantined, 1);
  assert.deepEqual(route(f.relay).quarantineIds, ['m1']);
  const review = (await readFile(path.join(directory, `lineport-review-${(await createDeliveryReviewStore(directory).list()).quarantined[0].identity}.jsonl`), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(review.map(row => [row.version, row.id, row.decision, row.quarantined, row.phase]), [[3, 'm1', 'skip', true, 'send']]);
  // The health monitor reports it once, without blocking recovery notices.
  const events = healthEvents({ relay: f.relay.state });
  assert.deepEqual(events.map(event => [event.kind, event.ids]), [['route_quarantined', ['m1']]]);
  const sentAlerts = [];
  const monitor = createHealthMonitor({ channels: [{ name: 'c', enabled: async () => true, send: async text => sentAlerts.push(text) }], now: () => 0, cooldownMs: 1 });
  await monitor.check({ relay: f.relay.state }); await monitor.check({ relay: f.relay.state });
  assert.equal(sentAlerts.length, 1);
  assert.match(sentAlerts[0], /已隔離訊息 ID：m1/);

  // A restart keeps the item quarantined: no resend, no review block, count restored without a new alert.
  const again = await fixture(directory, () => null);
  await again.relay.tick();
  assert.deepEqual(again.sent, []);
  assert.equal(route(again.relay).phase, 'running');
  assert.equal(route(again.relay).quarantined, 1);
  assert.equal(healthEvents({ relay: again.relay.state }).length, 0);
  const listed = await createDeliveryReviewStore(directory).list();
  assert.equal(listed.items.length, 0);
  assert.deepEqual(listed.quarantined.map(row => [row.id, row.phase, row.route.name]), [['m1', 'send', '公告']]);
});

test('an uncertain send is never quarantined, even when marked permanent', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'lineport-dlq-'));
  // Not a platform rejection: the request may have been delivered.
  const f = await fixture(directory, text => text === '不明' ? Object.assign(new RelayError('連線中斷'), { permanent: true }) : null);
  f.push('不明', '之後');
  await f.relay.tick();
  assert.deepEqual(f.sent, []);
  assert.equal(route(f.relay).phase, 'blocked');
  assert.equal(route(f.relay).stage, 'send_uncertain');
  assert.equal(route(f.relay).quarantined, 0);
  const listed = await createDeliveryReviewStore(directory).list();
  assert.deepEqual(listed.items.map(item => item.id), ['m1']);
  assert.deepEqual(listed.quarantined, []);
});

test('more than three quarantines in a row pause the route instead of skipping silently', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'lineport-dlq-'));
  const f = await fixture(directory, text => text.startsWith('壞') ? permanent() : null);
  f.push('壞1', '壞2', '壞3', '壞4', '好');
  await f.relay.tick();
  assert.deepEqual(f.sent, []);
  assert.equal(route(f.relay).quarantined, 3);
  assert.notEqual(route(f.relay).phase, 'running');
  // A success in between resets the streak.
  const other = await fixture(await mkdtemp(path.join(os.tmpdir(), 'lineport-dlq-')), text => text.startsWith('壞') ? permanent() : null);
  other.push('壞1', '壞2', '壞3', '好', '壞4', '好2');
  await other.relay.tick();
  assert.deepEqual(other.sent, ['好', '好2']);
  assert.equal(route(other.relay).quarantined, 4);
  assert.equal(route(other.relay).phase, 'running');
});

test('an attachment that can never be prepared is quarantined before any send', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'lineport-dlq-'));
  const sent = [];
  let messages = [];
  const mediaConfig = normalizeConfig({ version: 1, rules: [{ id: 'r', name: 'r', enabled: true, media: true, sources: [endpoint('telegram', '-1')], destinations: [endpoint('discord', '123456789012345678')] }] });
  const telegram = { identity: 'tg', prepare: async () => {}, recent: async () => [], read: async () => messages, send: async () => ({ id: '1' }) };
  const discord = { identity: 'dc', prepare: async () => {}, send: async (id, text) => { sent.push(text); return { id: '223456789012345678' }; },
    preparePayload: async value => { if (typeof value !== 'string') throw Object.assign(new RelayError('附件超過上限'), { permanent: true }); } };
  const relay = await createMultiRelay({ config: mediaConfig, adapters: { telegram, discord }, directory, now: () => 1000, pause: async () => {}, deliveryBudget: 20 });
  messages = [{ id: 'm1', text: '', createdTime: 2000, from: 'u1', media: { kind: 'document', fileId: 'F', fileSize: 100, caption: '', fileName: 'a.pdf' } },
    { id: 'm2', text: '文字', createdTime: 2000, from: 'u1' }];
  await relay.tick();
  assert.deepEqual(sent, ['文字']);
  assert.equal(route(relay).quarantined, 1);
  const listed = await createDeliveryReviewStore(directory).list();
  assert.deepEqual(listed.quarantined.map(row => [row.id, row.phase]), [['m1', 'prepare']]);
});
