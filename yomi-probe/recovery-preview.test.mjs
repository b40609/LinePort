import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { normalizeConfig, matchingContent } from './route-config.mjs';
import { previewRules, settingsBackup, validateBackup, safeDiagnostics } from './user-tools.mjs';
import { createMultiRelay } from './multi-relay.mjs';
import { parseJournal } from './relay-core.mjs';
import { createTelegramClient, createTelegramInbox, telegramMessage, TelegramRateLimit } from './telegram.mjs';
import { createDiscordClient } from './discord.mjs';
import { sendRelayText } from './relay-send.mjs';
import { createDeliveryReviewStore } from './delivery-review.mjs';
import { privateSnapshot, verifySnapshot } from './storage-health.mjs';
import { sourceReply, destinationReply } from './reply-links.mjs';

const directory = () => mkdtemp(path.join(os.tmpdir(), 'lineport-recovery-'));
const endpoint = (id, platform = 'telegram') => ({ platform, id, name: id });
const config = (extra = {}) => normalizeConfig({ version: 1, rules: [{ id: 'call', name: 'Call', enabled: true, sources: [endpoint('-1')], destinations: [endpoint('-2')], ...extra }] });
const message = (id, extra = {}) => ({ id: `-1:${id}`, text: 'Call 進場 100，停損 95', createdTime: 1000 + id, from: '123', ...extra });
const response = body => ({ ok: true, status: 200, json: async () => body });
function adapter(messages = []) {
  const calls = [];
  return { identity: 'synthetic', calls, recent: async () => [], prepare: async () => {}, read: async () => messages,
    send: async (id, value, options) => { calls.push({ id, value, options }); return { id: `${id}:${calls.length + 100}` }; } };
}
const options = async (value, telegram, extra = {}) => ({ config: value, adapters: { telegram }, directory: await directory(), now: () => 1000, pause: async () => {}, ...extra });

test('media preview matches queued payload filters and includes prefix without accessing real media', async () => {
  const value = config({ media: true, senderAllowlist: { 'telegram:-1': ['123'] }, include: ['Call'], prefix: '[A] ' });
  for (const kind of ['photo', 'document']) {
    const media = { kind, fileSize: 1000000, fileId: 'SYNTHETIC_FILE' };
    const input = { config: value, source: 'telegram:-1', text: message(1).text, sender: '123', timestamp: 1001, media };
    const preview = previewRules(input).results[0];
    const client = adapter([message(1, { media })]);
    const relay = await createMultiRelay(await options(value, client)); await relay.tick();
    assert.equal(preview.contentKind, kind); assert.equal(preview.destinations[0].eligible, true);
    assert.equal(client.calls[0].value.caption, preview.text);
    assert.equal(client.calls[0].value.fileSize, 1000000);
    assert.equal(preview.text, matchingContent(value.rules[0], message(1, { media }), input.source).caption);
    assert.equal(previewRules({ ...input, sender: '456' }).results[0].destinations[0].eligible, false);
    assert.match(previewRules({ ...input, protected: true }).results[0].destinations[0].reason, /受保護/);
    assert.match(previewRules({ ...input, text: '謝謝' }).results[0].destinations[0].reason, /必要關鍵字/);
  }
});

test('media preview distinguishes no-caption attachment, disabled media and size/caption failures', () => {
  const input = { config: config({ media: true }), source: 'telegram:-1', text: '', media: { kind: 'photo', fileSize: 10000000 } };
  assert.equal(previewRules(input).results[0].destinations[0].eligible, true);
  for (const fileSize of [0, -1, 10000001]) assert.match(previewRules({ ...input, media: { kind: 'photo', fileSize } }).results[0].destinations[0].reason, /格式、大小或說明/);
  assert.equal(previewRules({ ...input, media: { kind: 'document', fileSize: 50000000 } }).results[0].destinations[0].eligible, true);
  assert.equal(previewRules({ ...input, media: { kind: 'document', fileSize: 50000001 } }).results[0].destinations[0].eligible, false);
  assert.equal(previewRules({ ...input, text: 'x'.repeat(1025) }).results[0].destinations[0].eligible, false);
  const rejected = previewRules({ ...input, reply: true, media: { kind: 'photo', fileSize: 10000001 } }).results[0];
  assert.match(rejected.destinations[0].reason, /實際運作時會暫停/); assert.equal(rejected.replyReason, '');
  const disabled = previewRules({ ...input, config: config(), text: 'Call' }).results[0];
  assert.equal(disabled.contentKind, 'text'); assert.match(disabled.summary, /不含附件/);
  assert.equal(previewRules({ ...input, config: config() }).results[0].destinations[0].eligible, false);
});

test('preview rejects unselected sources and invalid time even when no rule matches', () => {
  const input = { config: config(), source: 'telegram:-1', text: 'Call' };
  for (const extra of [{ source: 'telegram:-9' }, { timestamp: 8640000000000001 }, { media: { kind: 'video', fileSize: 1 } }, { protected: 'true' }, { reply: 'true' }]) assert.throws(() => previewRules({ ...input, ...extra }));
});

test('each preview source uses its own author allowlist and hold/skip are visible for media', () => {
  const timestamp = Date.parse('2026-10-12T08:00:00+08:00');
  const schedule = { timezone: 'Asia/Taipei', days: [1], start: 540, end: 900, outside: 'hold' };
  const value = config({ media: true, sources: [endpoint('-1'), endpoint('-3')], senderAllowlist: { 'telegram:-1': ['123'], 'telegram:-3': ['456'] }, schedule });
  const input = { config: value, source: 'telegram:-1', sender: '123', text: 'Call', timestamp, media: { kind: 'photo', fileSize: 1 } };
  assert.match(previewRules(input).results[0].destinations[0].reason, /保留待送/);
  assert.equal(previewRules({ ...input, source: 'telegram:-3' }).results[0].destinations[0].eligible, false);
  assert.match(previewRules({ ...input, config: config({ media: true, schedule: { ...schedule, outside: 'skip' } }) }).results[0].destinations[0].reason, /略過/);
});

test('native reply IDs are scoped to source and destination and invalid IDs never reach an adapter', () => {
  assert.equal(sourceReply(message(2, { replyTo: '-1:1' }), 'telegram', '-1'), '-1:1');
  assert.equal(sourceReply(message(2, { replyTo: '-9:1' }), 'telegram', '-1'), null);
  assert.equal(sourceReply({ relatedMessageId: '100', messageRelationType: 3 }, 'line', 'csource'), '100');
  assert.equal(sourceReply({ relatedMessageId: '100', messageRelationType: 1 }, 'line', 'csource'), null);
  for (const id of ['-9:1', '-2:9007199254740992', '-2:0', 'url']) assert.equal(destinationReply('telegram', '-2', id), undefined);
  assert.equal(destinationReply('discord', '123456789', '18446744073709551616'), undefined);
});

test('reply mapping survives restart and uses independent native IDs at multiple destinations', async () => {
  const client = adapter([message(1)]), value = config({ replies: true, destinations: [endpoint('-2'), endpoint('-3')] });
  const setup = await options(value, client), first = await createMultiRelay(setup); await first.tick();
  const parents = new Map(client.calls.map((call, index) => [call.id, `${call.id}:${index + 101}`]));
  client.read = async () => [message(1), message(2, { replyTo: '-1:1' })];
  const restarted = await createMultiRelay(setup); await restarted.tick();
  for (const [id, replyTo] of parents) assert.deepEqual(client.calls.slice(2).find(call => call.id === id).options, { replyTo });
  assert.equal(restarted.state.forwarded, 2);
  const third = await createMultiRelay(setup); await third.tick(); assert.equal(client.calls.length, 4);
});

test('cross-platform replies use destination IDs and preserve the same route after restart', async () => {
  for (const sourcePlatform of ['line', 'telegram']) {
    const destinationPlatform = sourcePlatform === 'line' ? 'telegram' : 'line';
    const sourceId = sourcePlatform === 'line' ? 'csource' : '-1', destId = destinationPlatform === 'line' ? 'cdest' : '-2';
    const parent = sourcePlatform === 'line' ? { id: '1', text: 'Call', createdTime: 1001 } : message(1);
    const child = sourcePlatform === 'line' ? { id: '2', text: 'Call', createdTime: 1002, relatedMessageId: '1', messageRelationType: 3 } : message(2, { replyTo: '-1:1' });
    const from = adapter([parent]), to = adapter(), destinationId = destinationPlatform === 'line' ? '101' : '-2:101';
    to.send = async (id, value, options) => { to.calls.push({ id, value, options }); return { id: destinationId }; };
    const value = config({ sources: [endpoint(sourceId, sourcePlatform)], destinations: [endpoint(destId, destinationPlatform)], replies: true });
    const setup = { config: value, adapters: { [sourcePlatform]: from, [destinationPlatform]: to }, directory: await directory(), now: () => 1000, pause: async () => {} };
    await (await createMultiRelay(setup)).tick(); from.read = async () => [parent, child];
    await (await createMultiRelay(setup)).tick();
    assert.equal(to.calls.length, 2); assert.deepEqual(to.calls[1].options, { replyTo: destinationId });
  }
});

test('unknown reply delivery stays blocked after restart and never retries the child', async () => {
  const client = adapter([message(1)]), setup = await options(config({ replies: true }), client);
  const first = await createMultiRelay(setup); await first.tick();
  let attempts = 0;
  client.read = async () => [message(2, { replyTo: '-1:1' })];
  client.send = async (_, __, options) => { attempts++; assert.deepEqual(options, { replyTo: '-2:101' }); throw new Error('SYNTHETIC_LOST_ACK'); };
  await first.tick(); assert.equal(first.state.uncertain, 1);
  const restarted = await createMultiRelay(setup); await restarted.tick(); await restarted.tick();
  assert.equal(attempts, 1); assert.equal(restarted.state.routes[0].phase, 'blocked');
});

test('replies are opt-in and settings backup retains the option without changing old behavior', async () => {
  const value = config(), client = adapter([message(1), message(2, { replyTo: '-1:1' })]);
  assert.equal(value.rules[0].replies, false); assert.throws(() => config({ replies: 'true' }));
  const relay = await createMultiRelay(await options(value, client)); await relay.tick();
  assert.deepEqual(client.calls[1].options, {});
  assert.equal(validateBackup(settingsBackup(config({ replies: true }))).rules[0].replies, true);
  assert.match(previewRules({ config: value, source: 'telegram:-1', text: 'Call', reply: true }).results[0].replyReason, /關閉/);
});

test('filtered parent is never backfilled and a reply is sent once as an ordinary message', async () => {
  const client = adapter([message(1, { from: '456' }), message(2, { replyTo: '-1:1' })]);
  const relay = await createMultiRelay(await options(config({ replies: true, senderAllowlist: { 'telegram:-1': ['123'] } }), client));
  await relay.tick(); assert.equal(client.calls.length, 1); assert.deepEqual(client.calls[0].options, {});
  assert.match(relay.state.routes[0].replyNotice, /沒有可用對照/);
  assert.ok(!JSON.stringify(safeDiagnostics(relay.state, true)).includes('replyNotice'));
});

test('persisted queued media reply retains its parent when restart occurs before delivery', async () => {
  const client = adapter([message(1)]), setup = await options(config({ replies: true, media: true }), client);
  const first = await createMultiRelay(setup); await first.tick();
  client.read = async () => [message(2, { replyTo: '-1:1', text: 'Call', media: { kind: 'photo', fileId: 'SYNTHETIC_FILE', fileSize: 1 } })];
  await first.tick({ deliver: false }); assert.equal(first.state.routes[0].pending, 1);
  const restarted = await createMultiRelay(setup); await restarted.tick({ sourceKeys: [] });
  assert.equal(client.calls.length, 2); assert.equal(client.calls[1].value.kind, 'photo'); assert.deepEqual(client.calls[1].options, { replyTo: '-2:101' });
});

test('explicit rate limits preserve pending reply target across restart', async () => {
  let clock = 1000, limited = true;
  const client = adapter([message(1)]), setup = await options(config({ replies: true }), client, { now: () => clock });
  const first = await createMultiRelay(setup); await first.tick();
  const send = client.send;
  client.send = async (...args) => { if (limited) throw new TelegramRateLimit(2); return send(...args); };
  client.read = async () => [message(2, { replyTo: '-1:1' })]; await first.tick();
  const restarted = await createMultiRelay(setup); await restarted.tick(); assert.equal(client.calls.length, 1);
  clock = 3000; limited = false; await restarted.tick(); assert.deepEqual(client.calls[1].options, { replyTo: '-2:101' });
});

test('manual confirmation of an unknown parent does not invent a destination reply ID', async () => {
  const client = adapter([message(1)]), setup = await options(config({ replies: true }), client);
  const send = client.send;
  client.send = async () => { throw new Error('SYNTHETIC_UNKNOWN'); };
  const first = await createMultiRelay(setup); await first.tick();
  const review = createDeliveryReviewStore(setup.directory), item = (await review.list()).items[0];
  await review.resolve({ ...item, decision: 'received' });
  client.send = send; client.read = async () => [message(2, { replyTo: '-1:1' })];
  const restarted = await createMultiRelay(setup); await restarted.tick();
  assert.equal(client.calls.length, 1); assert.deepEqual(client.calls[0].options, {}); assert.match(restarted.state.routes[0].replyNotice, /尚未確認送達/);
});

test('malformed or unsupported reply journals fail closed without dropping pending evidence', () => {
  const rows = [{ startedAt: 1000, baseline: [] }, { id: '-1:1', outcome: 'queued', text: 'Call' }];
  const parse = extra => parseJournal([...rows, extra].map(JSON.stringify).join('\n') + '\n');
  for (const extra of [{ id: '-1:2', outcome: 'queued', text: 'Call', replyTo: '-1:1', replyVersion: 2 }, { id: '-1:1', outcome: 'sent', destinationId: '../../secret' }, { id: '-1:2', outcome: 'sent', destinationId: '-2:1' }]) assert.throws(() => parse(extra));
});

test('Telegram reply extraction excludes quoted text and wrong-chat relations; inbox recovery retains IDs', async () => {
  const update = { update_id: 1, message: { chat: { id: -1 }, message_id: 2, date: 2, text: 'Call', from: { id: 123 }, reply_to_message: { chat: { id: -1 }, message_id: 1, text: 'SYNTHETIC_PARENT_PRIVATE_BODY' } } };
  const parsed = telegramMessage(update); assert.equal(parsed.replyTo, '-1:1'); assert.ok(!JSON.stringify(parsed).includes('PRIVATE_BODY'));
  assert.equal(telegramMessage({ ...update, message: { ...update.message, reply_to_message: { chat: { id: -9 }, message_id: 1 } } }).replyTo, undefined);
  const file = path.join(await directory(), 'lineport-telegram-inbox-12345.jsonl'), client = { getUpdates: async () => [update] };
  await (await createTelegramInbox(file, client, ['-1'])).poll();
  assert.equal((await createTelegramInbox(file, client, ['-1'])).messages('-1')[0].replyTo, '-1:1');
});

test('Telegram sends native text and media replies in one request and rejects wrong-chat mappings', async () => {
  const calls = [], client = createTelegramClient('12345:SYNTHETIC_TOKEN_1234567890', { request: async (url, options) => { calls.push({ url, body: JSON.parse(options.body) }); return response({ ok: true, result: { message_id: 101, chat: { id: -2 } } }); } });
  await client.send('-2', 'Call', { replyTo: '-2:100' });
  await client.send('-2', { kind: 'photo', fileId: 'SYNTHETIC_FILE', fileSize: 1, caption: '' }, { replyTo: '-2:100' });
  for (const call of calls) assert.deepEqual(call.body.reply_parameters, { message_id: 100, allow_sending_without_reply: true });
  await assert.rejects(client.send('-2', 'Call', { replyTo: '-9:100' })); assert.equal(calls.length, 2);
});

test('Discord replies suppress mentions and LINE reply uses the encrypted public service boundary', async () => {
  let body, args;
  const client = createDiscordClient('SYNTHETIC_DISCORD_TOKEN_1234567890', { request: async (_, options) => { body = JSON.parse(options.body); return response({ id: '234567890123456789', channel_id: '123456789012345678' }); } });
  await client.send('123456789012345678', 'Call', { replyTo: '345678901234567890' });
  assert.deepEqual(body.message_reference, { message_id: '345678901234567890', channel_id: '123456789012345678', fail_if_not_exists: false });
  assert.equal(body.allowed_mentions.replied_user, false);
  await sendRelayText({ sendMessage: async (...value) => { args = value; } }, 'cdest', 'Call', { replyTo: '100' });
  assert.deepEqual(args, ['cdest', 'Call', undefined, { relatedMessageId: '100', messageRelationType: 3, relatedMessageServiceCode: 1 }]);
});

test('private archive is checked against original bytes and can be independently reverified', async () => {
  const folder = await directory(), file = path.join(folder, 'lineport-output.jsonl');
  await writeFile(file, 'SYNTHETIC_EVIDENCE\n'); const original = await readFile(file);
  const archive = await privateSnapshot(folder); assert.equal(archive.verified, true);
  assert.deepEqual(await verifySnapshot(path.join(folder, archive.archive)), { verified: true, files: 1, bytes: original.length });
  assert.deepEqual(await readFile(file), original);
  await writeFile(path.join(folder, archive.archive, 'lineport-output.jsonl'), 'SYNTHETIC_TAMPERED\n');
  await assert.rejects(verifySnapshot(path.join(folder, archive.archive))); assert.deepEqual(await readFile(file), original);
});

test('archive verification rejects incomplete, extra, duplicate and traversal entries without restoring', async () => {
  const folder = await directory(); await writeFile(path.join(folder, 'lineport-output.jsonl'), 'SYNTHETIC\n');
  const archive = await privateSnapshot(folder), target = path.join(folder, archive.archive), file = path.join(target, 'manifest.json'), manifest = JSON.parse(await readFile(file));
  for (const entries of [[{ ...manifest.files[0], name: '../lineport-output.jsonl' }], [manifest.files[0], manifest.files[0]], [{ ...manifest.files[0], bytes: 999 }]]) {
    await writeFile(file, JSON.stringify({ ...manifest, files: entries })); await assert.rejects(verifySnapshot(target));
  }
  await writeFile(file, '{'); await assert.rejects(verifySnapshot(target));
  await writeFile(file, JSON.stringify(manifest)); await writeFile(path.join(target, 'unexpected.txt'), 'SYNTHETIC'); await assert.rejects(verifySnapshot(target));
  assert.ok((await readdir(folder)).includes('lineport-output.jsonl'));
});
