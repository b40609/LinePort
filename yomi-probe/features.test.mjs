import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, open } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { normalizeConfig, matchingContent, matchingText } from './route-config.mjs';
import { inSchedule } from './rule-options.mjs';
import { previewRules } from './user-tools.mjs';
import { createMultiRelay } from './multi-relay.mjs';
import { appendRecord, parseJournal } from './relay-core.mjs';
import { createTelegramClient, telegramMessage, createTelegramInbox } from './telegram.mjs';
import { privateSnapshot, storageHealth, readJournalFile, MAX_JOURNAL_BYTES } from './storage-health.mjs';
import { recentSenders } from './source-senders.mjs';

const endpoint = (id, platform = 'line') => ({ id, platform, name: id });
const rule = options => normalizeConfig({ version: 1, rules: [{ id: 'one', name: 'Call', enabled: true, sources: [endpoint('csource')], destinations: [endpoint('cdest')], ...options }] }).rules[0];
const directory = () => mkdtemp(path.join(os.tmpdir(), 'lineport-features-'));
const message = (id = 'a', text = '進場 100，停損 95', from = 'uanalyst') => ({ id, text, from, createdTime: 1100 });
function adapter(messages = []) {
  const calls = [];
  return { identity: 'synthetic', calls, prepare: async () => {}, recent: async () => [], read: async () => messages,
    send: async (id, value) => { calls.push([id, value]); return { id: `out-${calls.length}` }; } };
}
const taipei = value => Date.parse(value + '+08:00');
test('per-source sender IDs reject bystanders and missing identity, preserve unrestricted other sources', () => {
  const value = rule({ sources: [endpoint('csource'), endpoint('-1', 'telegram')], senderAllowlist: { 'line:csource': ['uanalyst', 'uanalyst'] } });
  assert.deepEqual(value.senderAllowlist['line:csource'], ['uanalyst']);
  assert.equal(matchingText(value, message('a', '你好', 'ubystander'), 'line:csource'), null);
  assert.equal(matchingText(value, message('a', 'Call', ''), 'line:csource'), null);
  assert.equal(matchingText(value, message(), 'line:csource'), message().text);
  assert.equal(matchingText(value, message('b', 'Call', '123'), 'telegram:-1'), 'Call');
  assert.throws(() => rule({ senderAllowlist: { 'line:cother': ['uanalyst'] } }));
  assert.throws(() => rule({ senderAllowlist: { 'line:csource': ['同名分析師'] } }));
});
test('preview and relay use identical sender and content filters, independently for each destination', async () => {
  const value = rule({ senderAllowlist: { 'line:csource': ['uanalyst'] }, include: ['停損'], prefix: '[Call] ' });
  const config = { version: 1, rules: [value] }, line = adapter([message(), message('b', '謝謝', 'ubystander')]);
  const relay = await createMultiRelay({ config, adapters: { line }, directory: await directory(), now: () => 1000, pause: async () => {} });
  await relay.tick();
  const preview = previewRules({ config, source: 'line:csource', sender: 'uanalyst', text: message().text, timestamp: 1100 });
  assert.deepEqual(line.calls, [['cdest', preview.results[0].text]]);
  assert.equal(relay.state.routes[0].skipped, 1);
  assert.equal(previewRules({ config, source: 'line:csource', text: message().text }).results[0].text, null);
  assert.match(previewRules({ config, source: 'line:csource', sender: 'ubystander', text: message().text }).results[0].destinations[0].reason, /非指定發訊者/);
  assert.match(previewRules({ config, source: 'line:csource', sender: 'uanalyst', text: '謝謝' }).results[0].destinations[0].reason, /沒有包含任一必要關鍵字/);
});
test('overnight schedule belongs to starting weekday, end is exclusive, invalid schedules reject', () => {
  const schedule = { timezone: 'Asia/Taipei', days: [1], start: 22 * 60, end: 2 * 60, outside: 'hold' };
  assert.equal(inSchedule(schedule, taipei('2026-10-12T22:00:00')), true);
  assert.equal(inSchedule(schedule, taipei('2026-10-13T01:59:00')), true);
  assert.equal(inSchedule(schedule, taipei('2026-10-13T02:00:00')), false);
  assert.equal(inSchedule(schedule, taipei('2026-10-13T22:00:00')), false);
  assert.throws(() => rule({ schedule: { ...schedule, days: [] } }));
  assert.throws(() => rule({ schedule: { ...schedule, timezone: 'UTC' } }));
});
test('hold stores queued text across restart and sends only inside the Taipei window', async () => {
  const schedule = { timezone: 'Asia/Taipei', days: [1], start: 9 * 60, end: 15 * 60, outside: 'hold' };
  const value = rule({ schedule }), folder = await directory();
  let clock = taipei('2026-10-12T08:00:00');
  const line = adapter([{ ...message(), createdTime: clock + 1000 }]);
  const options = { config: { version: 1, rules: [value] }, adapters: { line }, directory: folder, now: () => clock };
  const relay = await createMultiRelay(options); await relay.tick();
  assert.equal(line.calls.length, 0); assert.equal(relay.state.routes[0].pending, 1);
  assert.match(relay.state.routes[0].warning, /時段外/);
  const restarted = await createMultiRelay(options);
  clock = taipei('2026-10-12T09:00:00'); await restarted.tick();
  assert.equal(line.calls.length, 1); assert.equal(restarted.state.routes[0].pending, 0);
});
test('skip evaluates message timestamp rather than catch-up time and persists its dedup evidence', async () => {
  const schedule = { timezone: 'Asia/Taipei', days: [1], start: 9 * 60, end: 15 * 60, outside: 'skip' };
  const value = rule({ schedule }), folder = await directory();
  let clock = taipei('2026-10-12T08:00:00');
  const line = adapter([{ ...message(), createdTime: clock + 1000 }]);
  const options = { config: { version: 1, rules: [value] }, adapters: { line }, directory: folder, now: () => clock };
  const relay = await createMultiRelay(options); clock = taipei('2026-10-12T09:30:00'); await relay.tick();
  assert.equal(line.calls.length, 0); assert.equal(relay.state.routes[0].skipped, 1);
  const restarted = await createMultiRelay(options); await restarted.tick(); assert.equal(line.calls.length, 0);
});
test('independent source workers deliver before a slow source settles, without duplicate destination sends', async () => {
  const line = adapter(), folder = await directory();
  let finish;
  line.read = id => id === 'cslow' ? new Promise(resolve => { finish = resolve; }) : Promise.resolve([message()]);
  const config = { version: 1, rules: [rule({ sources: [endpoint('cslow'), endpoint('cfast')] })] };
  const relay = await createMultiRelay({ config, adapters: { line }, directory: folder, now: () => 1000, operationTimeoutMs: 500 });
  const slow = relay.tick({ sourceKeys: ['line:cslow'] });
  await relay.tick({ sourceKeys: ['line:cfast'] });
  assert.equal(line.calls.length, 1);
  finish([]); await slow; assert.equal(line.calls.length, 1);
});
test('write failure before queue checkpoint prevents send and source checkpoint advancement', async () => {
  const folder = await directory(), line = adapter([message()]), config = { version: 1, rules: [rule()] };
  const relay = await createMultiRelay({ config, adapters: { line }, directory: folder, now: () => 1000,
    writeRecord: async (file, row) => { if (row.outcome === 'queued') throw Object.assign(new Error('synthetic disk full'), { code: 'ENOSPC' }); await appendRecord(file, row); } });
  await relay.tick(); assert.equal(line.calls.length, 0); assert.equal(relay.state.routes[0].phase, 'failed');
  const restarted = await createMultiRelay({ config, adapters: { line }, directory: folder, now: () => 2000 });
  await restarted.tick(); assert.equal(line.calls.length, 1);
});
test('killing a separate synthetic process after sending checkpoint blocks restart without resend', async () => {
  const folder = await directory(), line = adapter(), config = { version: 1, rules: [rule()] };
  await createMultiRelay({ config, adapters: { line }, directory: folder, now: () => 1000 });
  const file = path.join(folder, (await readdir(folder)).find(name => name.startsWith('lineport-route-')));
  const source = `import { appendRecord } from ${JSON.stringify(new URL('./relay-core.mjs', import.meta.url).href)}; await appendRecord(process.argv[1], {id:'a', outcome:'queued', text:'SYNTHETIC'}); await appendRecord(process.argv[1], {id:'a', outcome:'sending'}); process.send('saved'); setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source, file], { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  try { await once(child, 'message'); const exited = once(child, 'exit'); child.kill(); await exited; }
  finally { if (child.exitCode === null && child.signalCode === null) child.kill(); }
  const restarted = await createMultiRelay({ config, adapters: { line }, directory: folder, now: () => 2000 });
  await restarted.tick(); assert.equal(restarted.state.routes[0].phase, 'blocked'); assert.equal(line.calls.length, 0);
});
test('backlog exceeds bounded queues without losing messages or dedup evidence', async () => {
  const line = adapter(Array.from({ length: 80 }, (_, i) => message(String(i), `Call ${i}`)));
  const relay = await createMultiRelay({ config: { version: 1, rules: [rule()] }, adapters: { line }, directory: await directory(), now: () => 1000,
    queueLimit: 7, deliveryBudget: 4, pause: async () => {} });
  for (let i = 0; i < 22; i++) await relay.tick();
  assert.equal(line.calls.length, 80); assert.equal(new Set(line.calls.map(call => call[1])).size, 80);
  assert.equal(relay.state.routes[0].pending, 0);
});
const media = { kind: 'photo', fileId: 'SYNTHETIC_FILE_ID', fileSize: 1024, caption: '' };
test('media is opt-in, only Telegram to Telegram, bounded and sender-filtered', () => {
  assert.throws(() => rule({ media: true }));
  const value = rule({ sources: [endpoint('-1', 'telegram')], destinations: [endpoint('-2', 'telegram')], media: true, prefix: '[Call] ', senderAllowlist: { 'telegram:-1': ['123'] } });
  assert.equal(matchingContent(value, { ...message('a', '', '456'), media }, 'telegram:-1'), null);
  assert.equal(matchingContent(value, { ...message('a', '', '123'), media }, 'telegram:-1').caption, '[Call] ');
  assert.throws(() => matchingContent(value, { ...message('a', '', '123'), media: { ...media, fileSize: 11 * 1024 * 1024 } }, 'telegram:-1'));
  assert.throws(() => matchingContent(value, { ...message('a', '', '123'), media: { ...media, fileSize: 10000001 } }, 'telegram:-1'));
  assert.throws(() => matchingContent(value, { ...message('a', '', '123'), media: { kind: 'unsupported' } }, 'telegram:-1'));
});
test('Telegram media uses Bot file IDs and validates acknowledgements without download URLs', async () => {
  const calls = [], client = createTelegramClient('12345:SYNTHETIC_TOKEN_1234567890', { request: async (url, options) => {
    calls.push([url.split('/').at(-1), JSON.parse(options.body)]);
    return { ok: true, json: async () => ({ ok: true, result: { message_id: 1, chat: { id: -2 } } }) };
  } });
  assert.deepEqual(await client.send('-2', media), { id: '-2:1' });
  assert.deepEqual(await client.send('-2', { ...media, kind: 'document' }), { id: '-2:1' });
  assert.deepEqual(calls.map(call => call[0]), ['sendPhoto', 'sendDocument']);
  assert.equal(calls[0][1].photo, media.fileId); assert.equal(calls[1][1].document, media.fileId);
});
test('media queue survives offline restart and refuses corrupt or future payloads', async () => {
  const value = rule({ sources: [endpoint('-1', 'telegram')], destinations: [endpoint('-2', 'telegram')], media: true });
  const folder = await directory(), telegram = adapter([{ ...message('a', ''), media }]);
  const options = { config: { version: 1, rules: [value] }, adapters: { telegram }, directory: folder, now: () => 1000 };
  const relay = await createMultiRelay(options); await relay.tick({ deliver: false }); assert.equal(telegram.calls.length, 0);
  telegram.read = async () => { throw new Error('synthetic offline'); };
  const restarted = await createMultiRelay(options); await restarted.tick();
  assert.deepEqual(telegram.calls[0][1], media);
  assert.throws(() => parseJournal(JSON.stringify({ id: 'a', outcome: 'media_queued', payloadVersion: 2, payload: media }) + '\n'));
});
test('anonymous Telegram administrators use sender_chat identity, never pseudo-user attribution', () => {
  const value = telegramMessage({ message: { chat: { id: -1 }, message_id: 1, date: 1, sender_chat: { id: -1 }, from: { id: 123, is_bot: true }, text: 'Call' } });
  assert.equal(value.from, 'chat:-1'); assert.equal(value.bot, false);
});
test('captionless images persist in the inbox and protected media never persists', async () => {
  const folder = await directory();
  const raw = { chat: { id: -1 }, message_id: 1, date: 1, photo: [{ file_id: media.fileId, file_size: 1024 }], from: { id: 123 } };
  const client = { getUpdates: async () => [{ update_id: 1, message: raw }, { update_id: 2, message: { ...raw, message_id: 2, has_protected_content: true } }] };
  const inbox = await createTelegramInbox(path.join(folder, 'inbox.jsonl'), client, ['-1']); await inbox.poll();
  assert.equal(inbox.messages('-1').length, 1); assert.deepEqual(inbox.messages('-1')[0].media, media);
});
test('private snapshot retains original bytes and evidence and excludes all credential filenames', async () => {
  const folder = await directory(), name = `lineport-route-${'a'.repeat(64)}.jsonl`;
  await writeFile(path.join(folder, name), 'SYNTHETIC_PENDING_EVIDENCE\n');
  await writeFile(path.join(folder, 'lineport-telegram.json'), 'SYNTHETIC_SECRET');
  const before = await readFile(path.join(folder, name)), snapshot = await privateSnapshot(folder);
  assert.deepEqual(await readFile(path.join(folder, name)), before);
  assert.deepEqual(await readFile(path.join(folder, snapshot.archive, name)), before);
  const manifest = JSON.parse(await readFile(path.join(folder, snapshot.archive, 'manifest.json')));
  assert.equal(manifest.files.length, 1); assert.match(manifest.files[0].sha256, /^[a-f0-9]{64}$/);
  assert.ok(!(await readdir(path.join(folder, snapshot.archive))).includes('lineport-telegram.json'));
});
test('oversized journal stops before parsing and capacity preflight prevents platform send', async () => {
  const folder = await directory(), line = adapter([message()]);
  const relay = await createMultiRelay({ config: { version: 1, rules: [rule()] }, adapters: { line }, directory: folder, now: () => 1000 });
  const file = path.join(folder, 'lineport-output.jsonl'), handle = await open(file, 'wx');
  try { await handle.truncate(MAX_JOURNAL_BYTES + 1); } finally { await handle.close(); }
  await assert.rejects(readJournalFile(file)); assert.equal((await storageHealth(folder)).blocked, true);
  await relay.tick(); assert.equal(line.calls.length, 0); assert.equal(relay.state.routes[0].phase, 'failed');
});
test('recent senders deduplicate stable identities and return no message content', () => {
  const value = recentSenders([message(), message('b', 'SYNTHETIC_PRIVATE', 'uanalyst'), message('c', 'x', '')], 'line');
  assert.deepEqual(value, [{ id: 'uanalyst', name: 'uanalyst' }]);
});
