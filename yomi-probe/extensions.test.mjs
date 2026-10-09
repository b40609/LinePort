import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, open, readdir } from 'node:fs/promises';
import { EventEmitter, once } from 'node:events';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createDiscordClient, DiscordRateLimit, discordId } from './discord.mjs';
import { protectToken, unprotectToken } from './dpapi.mjs';
import { botCredentials } from './bot-credentials.mjs';
import { atomicJson, createSettingsStore, normalizeConfig } from './route-config.mjs';
import { createMultiRelay } from './multi-relay.mjs';
import { createRelayController } from './relay-controller.mjs';
import { createTelegramInbox } from './telegram.mjs';
import { storageHealth, privateSnapshot, MAX_JOURNAL_BYTES } from './storage-health.mjs';
import { createProbeServer } from './server.mjs';
import { previewRules } from './user-tools.mjs';

const directory = () => mkdtemp(path.join(os.tmpdir(), 'lineport-extensions-'));
const dcToken = 'SYNTHETIC_DISCORD_TOKEN_1234567890';
const channel = '123456789012345678';
const endpoint = (platform, id) => ({ platform, id, name: id });
const config = (extra = {}) => normalizeConfig({ version: 1, rules: [{ id: 'call', name: 'Call', enabled: true, sources: [endpoint('line', 'csource')], destinations: [endpoint('discord', channel)], ...extra }] });
const message = (id = 'one') => ({ id, text: '進場 100 停損 95', from: 'uanalyst', createdTime: 1100 });
const response = (body, status = 200) => ({ ok: status === 200, status, json: async () => body });
const fakeProtection = { protect: async token => ({ synthetic: token }), unprotect: async record => { if (!record.synthetic) throw new Error('SYNTHETIC_INVALID'); return record.synthetic; } };

test('Discord text suppresses mentions and embeds and accepts only a matching acknowledgement', async () => {
  let options;
  const client = createDiscordClient(dcToken, { request: async (_, value) => { options = value; return response({ id: '234567890123456789', channel_id: channel }); } });
  assert.deepEqual(await client.send(channel, '@everyone Call'), { id: '234567890123456789' });
  const body = JSON.parse(options.body);
  assert.deepEqual(body.allowed_mentions, { parse: [], users: [], roles: [], replied_user: false });
  assert.equal(body.flags, 4); assert.equal(options.redirect, 'error');
  assert.equal((await createDiscordClient(dcToken, { request: async () => response({ id: '234567890123456789', channel_id: '345678901234567890' }) }).send(channel, 'Call')).id, '');
  await assert.rejects(client.send(channel, 'a'.repeat(2001)));
});

test('Discord validates Bot identity, unsigned snowflakes and ordinary guild text channels', async () => {
  assert.equal(discordId('18446744073709551615'), true);
  for (const id of ['18446744073709551616', '00123456', '-123456', 123456]) assert.equal(discordId(id), false);
  await assert.rejects(createDiscordClient(dcToken, { request: async () => response({ id: channel, bot: false }) }).getMe());
  for (const type of [1, 5, 11]) await assert.rejects(createDiscordClient(dcToken, { request: async () => response({ id: channel, type, guild_id: '234567890123456789' }) }).getChannel(channel));
  assert.equal((await createDiscordClient(dcToken, { request: async () => response({ id: channel, type: 0, guild_id: '234567890123456789' }) }).getChannel(channel)).type, 0);
});

test('Discord retries only explicit, bounded 429 responses and redacts upstream errors', async () => {
  const limited = createDiscordClient(dcToken, { request: async () => response({ retry_after: .125, global: false }, 429) });
  await assert.rejects(limited.send(channel, 'Call'), error => error instanceof DiscordRateLimit && error.retryAfterMs === 125);
  for (const body of [{ retry_after: -1, global: true }, { retry_after: 1 }, { retry_after: 2147484, global: false }]) {
    await assert.rejects(createDiscordClient(dcToken, { request: async () => response(body, 429) }).send(channel, 'Call'), error => !(error instanceof DiscordRateLimit));
  }
  await assert.rejects(createDiscordClient(dcToken, { request: async () => { throw new Error(dcToken); } }).send(channel, 'Call'), error => !error.message.includes(dcToken));
});

test('Discord retry deadlines survive restart while other platforms continue', async () => {
  const folder = await directory(), calls = [], line = { identity: 'synthetic-line', prepare: async () => {}, recent: async () => [], read: async () => [message()], send: async id => { calls.push(id); return { id: 'out-line' }; } };
  let clock = 1000, limited = true;
  const discord = { identity: 'synthetic-discord', prepare: async () => {}, send: async id => { calls.push(id); if (limited) throw new DiscordRateLimit(2); return { id: 'out-discord' }; } };
  const value = config({ destinations: [endpoint('discord', channel), endpoint('line', 'cdest')] });
  const options = { config: value, adapters: { line, discord }, directory: folder, now: () => clock, pause: async () => {} };
  const relay = await createMultiRelay(options); await relay.tick();
  assert.equal(calls.length, 2); assert.equal(relay.state.routes[0].retryAt, 3000);
  const restarted = await createMultiRelay(options); await restarted.tick(); assert.equal(calls.length, 2);
  limited = false; clock = 3000; await restarted.tick(); assert.equal(calls.length, 3);
  assert.equal(restarted.state.routes[0].pending, 0);
});

test('Discord missing acknowledgement remains blocked after restart without a second send', async () => {
  const folder = await directory(); let sends = 0;
  const adapters = { line: { identity: 'synthetic', recent: async () => [], read: async () => [message()] }, discord: { identity: 'synthetic', prepare: async () => {}, send: async () => { sends++; return { id: '' }; } } };
  const options = { config: config(), adapters, directory: folder, now: () => 1000 };
  const relay = await createMultiRelay(options); await relay.tick();
  assert.equal(relay.state.routes[0].phase, 'blocked');
  const restarted = await createMultiRelay(options); await restarted.tick(); assert.equal(sends, 1); assert.equal(restarted.state.routes[0].phase, 'blocked');
});

test('Discord source and media rules reject, and preview reflects the 2000 character limit', () => {
  assert.throws(() => config({ sources: [endpoint('discord', channel)], destinations: [endpoint('line', 'cdest')] }));
  assert.throws(() => config({ media: true }));
  const result = previewRules({ config: config(), source: 'line:csource', text: 'a'.repeat(2001) });
  assert.equal(result.results[0].destinations[0].eligible, false);
});

test('status preserves Discord destination identity', async () => {
  const controller = createRelayController({ request: async () => response({ app: 'line-relay-bridge', version: 3, phase: 'running', routes: [{ destination: endpoint('discord', channel) }] }) });
  assert.equal((await controller.status()).routes[0].destination.platform, 'discord');
});

test('credential opt-in retains legacy bytes and reconnect never downgrades protection', async () => {
  const folder = await directory(), old = path.join(folder, 'lineport-telegram.json');
  await atomicJson(old, { token: 'SYNTHETIC_LEGACY' }); const bytes = await readFile(old);
  const store = createSettingsStore(folder, fakeProtection);
  await store.saveTelegram('SYNTHETIC_NEW', true); assert.equal(await store.telegramToken(), 'SYNTHETIC_NEW');
  await store.saveTelegram('SYNTHETIC_LATEST', false); assert.equal(await store.telegramProtected(), true);
  assert.equal(await store.telegramToken(), 'SYNTHETIC_LATEST'); assert.deepEqual(await readFile(old), bytes);
});

test('corrupt protected credentials fail closed and failed saves preserve original bytes', async () => {
  const folder = await directory(), file = path.join(folder, 'lineport-telegram-protected.json');
  await atomicJson(path.join(folder, 'lineport-telegram.json'), { token: 'SYNTHETIC_LEGACY' });
  await writeFile(file, 'null'); await assert.rejects(createSettingsStore(folder, fakeProtection).telegramToken());
  await atomicJson(file, { synthetic: 'SYNTHETIC_PROTECTED' }); const bytes = await readFile(file);
  const store = botCredentials(folder, 'telegram', async () => { throw new Error('SYNTHETIC_WRITE_SECRET'); }, fakeProtection);
  await assert.rejects(store.save('SYNTHETIC_NEW', true), error => !error.message.includes('SYNTHETIC_WRITE_SECRET') && /原設定保留/.test(error.message));
  assert.deepEqual(await readFile(file), bytes);
});

test('Windows DPAPI roundtrip and tamper rejection use synthetic data only', { skip: process.platform !== 'win32' }, async () => {
  const synthetic = 'SYNTHETIC_DPAPI_NO_REAL_ACCOUNT';
  const record = await protectToken(synthetic);
  assert.equal(record.protection, 'dpapi-current-user'); assert.ok(!record.data.includes(synthetic));
  assert.equal(await unprotectToken(record), synthetic);
  const corrupt = Buffer.from(record.data, 'base64'); corrupt[corrupt.length - 1] ^= 1;
  await assert.rejects(unprotectToken({ ...record, data: corrupt.toString('base64') }));
});

test('private snapshots include legacy journals without copying credentials', async () => {
  const folder = await directory();
  await writeFile(path.join(folder, 'relay-source1-destination2.jsonl'), 'SYNTHETIC_EVIDENCE\n');
  await writeFile(path.join(folder, `relay-${'a'.repeat(24)}.jsonl`), 'SYNTHETIC_EVIDENCE\n');
  await writeFile(path.join(folder, 'lineport-discord-protected.json'), 'SYNTHETIC_SECRET');
  assert.equal((await storageHealth(folder)).files, 2);
  const result = await privateSnapshot(folder); assert.equal(result.files, 2);
  assert.ok(!(await readdir(path.join(folder, result.archive))).includes('lineport-discord-protected.json'));
});

test('Telegram capacity preflight stops before acknowledging upstream updates', async () => {
  const folder = await directory(), file = path.join(folder, 'lineport-output.jsonl');
  const handle = await open(file, 'wx'); try { await handle.truncate(MAX_JOURNAL_BYTES); } finally { await handle.close(); }
  let polls = 0;
  const inbox = await createTelegramInbox(path.join(folder, 'lineport-telegram-inbox-12345.jsonl'), { getUpdates: async () => { polls++; return []; } }, ['-1']);
  await assert.rejects(inbox.poll()); assert.equal(polls, 0);
});

test('destination spacing persists across worker ticks and a closing schedule holds the next payload', async () => {
  let clock = Date.parse('2026-10-12T14:59:59+08:00'), sends = 0, pauses = 0;
  const start = clock;
  const line = { identity: 'synthetic', prepare: async () => {}, recent: async () => [], read: async () => [{ ...message('one'), createdTime: start + 1 }, ...(sends ? [{ ...message('two'), createdTime: start + 2 }] : [])], send: async () => { sends++; return { id: `out-${sends}` }; } };
  const value = config({ destinations: [endpoint('line', 'cdest')], schedule: { timezone: 'Asia/Taipei', days: [1], start: 9 * 60, end: 15 * 60, outside: 'hold' } });
  const relay = await createMultiRelay({ config: value, adapters: { line }, directory: await directory(), now: () => clock, pause: async () => { pauses++; clock += 1100; } });
  await relay.tick(); await relay.tick();
  assert.equal(pauses, 1); assert.equal(sends, 1); assert.equal(relay.state.routes[0].pending, 1);
});

async function apiSetup(t) {
  const folder = await directory(), settingsStore = createSettingsStore(folder, fakeProtection);
  let phase = 'stopped';
  const service = Object.assign(new EventEmitter(), { resumeSession: async () => true, profile: { mid: 'usynthetic' }, client: {
    getAllChatMids: async () => ({ memberChats: ['csource'] }), getChats: async () => [{ chatMid: 'csource', chatName: '示範來源' }], getAllContactIds: async () => [], getContacts: async () => [{ mid: 'uanalyst', displayName: '示範分析師' }],
  }, getRecentMessages: async () => [{ ...message(), text: 'SYNTHETIC_PRIVATE_MESSAGE' }] });
  const server = createProbeServer({ service, token: 'synthetic-api-auth', runPwlessLogin: async () => {}, settingsStore, dataDirectory: folder,
    relayController: { status: async () => ({ phase }) }, discordFactory: () => ({ getMe: async () => ({ id: channel, username: 'SyntheticBot', bot: true }), getChannel: async id => ({ id, name: 'synthetic-channel' }) }) });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const call = (route, data, authenticated = true) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path: route, method: data === undefined ? 'GET' : 'POST', headers: {
      Host: '127.0.0.1:18765', 'X-Probe-Token': authenticated ? 'synthetic-api-auth' : 'wrong', 'Content-Type': 'application/json',
    } }, res => { const parts = []; res.on('data', chunk => parts.push(chunk)); res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(parts).toString() })); });
    req.on('error', reject); req.end(data === undefined ? undefined : JSON.stringify(data));
  });
  return { call, settingsStore, setPhase: value => { phase = value; }, folder };
}

test('author discovery returns identities without text, requires auth and stopped relay', async t => {
  const api = await apiSetup(t);
  assert.equal((await api.call('/api/source/senders', { platform: 'line', id: 'csource' }, false)).status, 403);
  await api.call('/api/resume', {});
  const result = await api.call('/api/source/senders', { platform: 'line', id: 'csource' });
  assert.equal(result.status, 200); assert.ok(result.text.includes('uanalyst')); assert.ok(!result.text.includes('SYNTHETIC_PRIVATE_MESSAGE'));
  api.setPhase('running'); assert.equal((await api.call('/api/source/senders', { platform: 'line', id: 'csource' })).status, 409);
});

test('Discord connect never returns token; archive and connect enforce stopped state', async t => {
  const api = await apiSetup(t);
  const connected = await api.call('/api/discord/connect', { token: dcToken, protect: true });
  assert.equal(connected.status, 200); assert.ok(!connected.text.includes(dcToken));
  const settings = await api.call('/api/rules'); assert.ok(!settings.text.includes(dcToken)); assert.equal(JSON.parse(settings.text).discordProtected, true);
  assert.equal((await api.call('/api/discord/channel', { id: channel })).status, 200);
  await writeFile(path.join(api.folder, 'lineport-output.jsonl'), 'SYNTHETIC_PRIVATE\n');
  assert.ok(!(await api.call('/api/storage')).text.includes('SYNTHETIC_PRIVATE'));
  api.setPhase('running'); assert.equal((await api.call('/api/storage/archive', {})).status, 409);
  assert.equal((await api.call('/api/discord/connect', { token: dcToken })).status, 409);
  api.setPhase('stopped'); assert.equal((await api.call('/api/storage/archive', {})).status, 200);
});
