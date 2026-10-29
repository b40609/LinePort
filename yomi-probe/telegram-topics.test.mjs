import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { normalizeConfig, endpointKey, createSettingsStore } from './route-config.mjs';
import { createTelegramClient, TelegramRateLimit } from './telegram.mjs';
import { telegramDestinations, createTopicEndpoint } from './telegram-topics.mjs';
import { createMultiRelay } from './multi-relay.mjs';
import { inspectDelivery } from './delivery-review.mjs';
import { settingsBackup, validateBackup } from './user-tools.mjs';

const token = '123456:synthetic_token_for_tests_only';
const chat = { platform: 'telegram', id: '-222', name: 'Forum' };
const topic = threadId => ({ ...chat, threadId });
const rule = destinations => ({ id: 'topics', name: 'Topics', enabled: true,
  sources: [{ platform: 'telegram', id: '-111', name: 'Source' }], destinations });
const config = destinations => normalizeConfig({ version: 1, rules: [rule(destinations)] });
const directory = () => mkdtemp(path.join(os.tmpdir(), 'lineport-topics-'));
const ok = result => ({ ok: true, json: async () => ({ ok: true, result }) });

test('topic destinations survive save, reload and backup without changing legacy endpoint keys', async () => {
  assert.equal(endpointKey(chat), 'telegram:-222');
  assert.notEqual(endpointKey(topic(10)), endpointKey(topic(20)));
  const value = config([chat, topic(10), topic(20)]), store = createSettingsStore(await directory());
  assert.equal(value.version, 2);
  assert.equal(config([chat]).version, 1);
  await store.save(value);
  assert.deepEqual(await store.load(), value);
  assert.deepEqual(validateBackup(settingsBackup(value)), value);
  await store.restore(settingsBackup(value).config);
  assert.deepEqual(await store.load(), value);
  assert.throws(() => config([topic(10), topic(10)]), /重複/);
  assert.deepEqual(await store.telegramTopics(), []);
  await store.saveTelegramTopics([topic(10), { platform: 'line', id: 'invalid', threadId: 10 }, { platform: 'telegram', id: '-222', name: 'Topic2', threadId: 'bad' }]);
  assert.deepEqual(await store.telegramTopics(), [{ platform: 'telegram', id: '-222', name: 'Forum', kind: 'group', threadId: 10 }]);
});

test('createTopicEndpoint handles custom topic names and prevents prefix accumulation', () => {
  const baseChat = { id: -222, title: 'TradingGroup', type: 'supergroup', is_forum: true };
  assert.equal(createTopicEndpoint(baseChat, 10, 'General').name, 'TradingGroup / General');
  assert.equal(createTopicEndpoint(baseChat, 10).name, 'TradingGroup');
  assert.equal(createTopicEndpoint({ ...baseChat, title: 'TradingGroup / Previous' }, 10, 'Latest').name, 'TradingGroup / Latest');
});

test('topics reject malformed IDs, unsupported platforms, source filtering and chat-level cycles', () => {
  for (const id of [0, -1, 1.5, '10', null, true, 2147483648, Number.MAX_SAFE_INTEGER]) assert.throws(() => config([topic(id)]), /話題 ID/);
  assert.equal(config([topic(2147483647)]).rules[0].destinations[0].threadId, 2147483647);
  assert.throws(() => config([{ platform: 'line', id: 'cdest', threadId: 10 }]), /話題 ID/);
  assert.throws(() => normalizeConfig({ version: 1, rules: [{ ...rule([chat]), sources: [topic(10)] }] }), /只支援轉發目的/);
  assert.throws(() => normalizeConfig({ version: 1, rules: [{ ...rule([topic(10)]), sources: [chat] }] }), /相同/);
  const forward = rule([topic(10)]), reverse = { ...rule(forward.sources), id: 'reverse', sources: [chat] };
  assert.throws(() => normalizeConfig({ version: 1, rules: [forward, reverse] }), /循環/);
});

test('discovery lists observed forum topics, retains topic names and never exposes message contents', () => {
  const forum = { id: -222, title: 'Forum', type: 'supergroup', is_forum: true };
  const message = (thread, extra = {}) => ({ message: { chat: forum, message_thread_id: thread, text: 'SYNTHETIC_PRIVATE_MESSAGE', ...extra } });
  const rows = telegramDestinations([
    message(10, { forum_topic_created: { name: 'LinePort' } }), message(10),
    message(20), message(10, { forum_topic_edited: { name: 'Renamed' } }), message(10), message('30'),
    message(40, { has_protected_content: true }),
    message(50, { chat: { id: -333, title: 'Discussion', type: 'supergroup' } }),
    message(60, { chat: { id: -444, title: 'Channel', type: 'channel', is_forum: true } }),
  ]);
  assert.deepEqual(rows.filter(row => row.threadId).map(row => row.threadId), [10, 20]);
  assert.equal(rows.find(row => row.threadId === 10).name, 'Forum / Renamed');
  assert.ok(!JSON.stringify(rows).includes('SYNTHETIC_PRIVATE_MESSAGE'));
});

test('text, photo, document and replies all pin the same Telegram thread and require its acknowledgement', async () => {
  const calls = [], client = createTelegramClient(token, { request: async (url, options) => {
    const data = JSON.parse(options.body); calls.push({ method: url.split('/').at(-1), data });
    return ok({ message_id: calls.length, chat: { id: -222 }, message_thread_id: 10 });
  } });
  for (const payload of ['text', { kind: 'photo', fileId: 'synthetic_photo', fileSize: 100, caption: 'photo' }, { kind: 'document', fileId: 'synthetic_document', fileSize: 100, caption: 'document' }]) {
    assert.ok((await client.send('-222', payload, { threadId: 10, replyTo: '-222:7' })).id);
  }
  assert.deepEqual(calls.map(call => call.method), ['sendMessage', 'sendPhoto', 'sendDocument']);
  assert.ok(calls.every(call => call.data.message_thread_id === 10 && call.data.reply_parameters.message_id === 7));
  for (const threadId of [20, undefined, '10']) {
    const wrong = createTelegramClient(token, { request: async () => ok({ message_id: 1, chat: { id: -222 }, message_thread_id: threadId }) });
    assert.equal((await wrong.send('-222', 'text', { threadId: 10 })).id, '');
  }
  for (const threadId of [0, '10', null, 2147483648]) await assert.rejects(client.send('-222', 'text', { threadId }), /話題 ID/);
  assert.equal(calls.length, 3);
});

test('two topics isolate delivery and reply journals across restart, and changing a topic starts a distinct route', async () => {
  const dir = await directory(), calls = [];
  const client = createTelegramClient(token, { request: async (url, options) => {
    const data = JSON.parse(options.body); calls.push(data);
    return ok({ message_id: calls.length, chat: { id: -222 }, message_thread_id: data.message_thread_id });
  } });
  const messages = [
    { id: '-111:1', text: 'first', createdTime: 1100 },
    { id: '-111:2', text: 'reply', replyTo: '-111:1', createdTime: 1101 },
    { id: '-111:3', text: 'photo', createdTime: 1102, media: { kind: 'photo', fileId: 'synthetic_photo', fileSize: 100, caption: '' } },
    { id: '-111:4', text: 'file', createdTime: 1103, media: { kind: 'document', fileId: 'synthetic_document', fileSize: 100, caption: '' } },
  ];
  const prepared = [], pauses = [], telegram = { identity: 'synthetic-bot', recent: async () => [], read: async () => messages,
    prepare: async (id, endpoint) => prepared.push(endpoint.threadId), send: (id, text, options) => client.send(id, text, options) };
  const value = config([topic(10), topic(20)]); value.rules[0].media = true; value.rules[0].replies = true;
  const options = { config: value, adapters: { telegram }, directory: dir, now: () => 1000, pause: async ms => pauses.push(ms) };
  const relay = await createMultiRelay(options); await relay.tick();
  assert.equal(relay.state.forwarded, 8);
  assert.deepEqual(pauses, Array(7).fill(1100));
  assert.deepEqual(prepared.sort(), [10, 20]);
  for (const thread of [10, 20]) {
    const deliveries = calls.filter(call => call.message_thread_id === thread);
    assert.equal(deliveries.length, 4);
    const first = calls.indexOf(deliveries[0]) + 1;
    assert.equal(deliveries[1].reply_parameters.message_id, first);
  }
  const restarted = await createMultiRelay(options); await restarted.tick();
  assert.equal(calls.length, 8);
  const changed = config([topic(30)]);
  await (await createMultiRelay({ ...options, config: changed })).tick();
  assert.equal(calls.filter(call => call.message_thread_id === 30).length, 4);
  assert.equal((await readdir(dir)).filter(name => name.startsWith('lineport-route-')).length, 3);
});

test('invalid or unconfirmed topics block only their route and never retry to the default chat', async () => {
  for (const failure of ['rejected', 'wrong-thread']) {
    const dir = await directory(), calls = [];
    const client = createTelegramClient(token, { request: async (url, options) => {
      const data = JSON.parse(options.body); calls.push(data);
      if (data.message_thread_id === 10 && failure === 'rejected') return { ok: false, json: async () => ({ ok: false, error_code: 400 }) };
      return ok({ message_id: calls.length, chat: { id: -222 }, message_thread_id: 20 });
    } });
    const telegram = { identity: 'synthetic-bot', recent: async () => [], prepare: async () => {},
      read: async () => [{ id: '-111:1', text: 'hello', createdTime: 1100 }], send: (id, text, options) => client.send(id, text, options) };
    const options = { config: config([topic(10), topic(20)]), adapters: { telegram }, directory: dir, now: () => 1000, pause: async () => {} };
    const relay = await createMultiRelay(options); await relay.tick();
    assert.equal(relay.state.routes.find(row => row.destination.threadId === 10).phase, 'blocked');
    assert.equal(relay.state.forwarded, 1);
    const restarted = await createMultiRelay(options); await restarted.tick();
    assert.equal(calls.length, 2);
    assert.ok(calls.every(call => call.message_thread_id === 10 || call.message_thread_id === 20));
    const journals = (await readdir(dir)).filter(name => name.startsWith('lineport-route-'));
    const reviews = await Promise.all(journals.map(name => inspectDelivery(dir, name.slice(15, -6))));
    assert.ok(reviews.some(review => review.unresolved.size === 1 && review.route.destination.includes('話題 #10')));
  }
});

test('a safe rate-limit retry preserves the topic after restarting with a durable queue', async () => {
  let attempts = 0, clock = 1000;
  const calls = [], telegram = { identity: 'synthetic-bot', recent: async () => [], prepare: async () => {},
    read: async () => [{ id: '-111:1', text: 'hello', createdTime: 1100 }],
    send: async (id, text, options) => { calls.push(options); if (++attempts === 1) throw new TelegramRateLimit(5); return { id: '-222:1' }; } };
  const options = { config: config([topic(10)]), adapters: { telegram }, directory: await directory(), now: () => clock, pause: async () => {} };
  const relay = await createMultiRelay(options); await relay.tick();
  const restarted = await createMultiRelay(options); await restarted.tick(); assert.equal(attempts, 1);
  clock = 6000; await restarted.tick(); assert.equal(attempts, 2);
  assert.ok(calls.every(call => call.threadId === 10));
});

test('topic output remains excluded from a downstream whole-chat source after restart', async () => {
  let stage = 0;
  const calls = [], telegram = { identity: 'synthetic-bot', recent: async () => [], prepare: async () => {},
    read: async id => id === '-111' ? [{ id: '-111:1', text: 'input', createdTime: 1100 }]
      : stage ? [{ id: '-222:1', text: 'bridge output', createdTime: 2100 }] : [],
    send: async (id, text, options) => { calls.push({ id, options }); return { id: '-222:1' }; } };
  const value = normalizeConfig({ version: 1, rules: [rule([topic(10)]),
    { ...rule([{ platform: 'telegram', id: '-333', name: 'Next' }]), id: 'downstream', sources: [chat] }] });
  const options = { config: value, adapters: { telegram }, directory: await directory(), pause: async () => {} };
  await (await createMultiRelay({ ...options, now: () => 1000 })).tick();
  stage = 1;
  await (await createMultiRelay({ ...options, now: () => 2000 })).tick();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.threadId, 10);
});
