import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createLineRelayAdapter, createMultiRelay } from './multi-relay.mjs';
import { normalizeLineMessage, downloadLineMedia, sendLineMedia } from './line-media.mjs';
import { createTelegramClient, telegramMessage } from './telegram.mjs';
import { createDiscordClient, DiscordUnsent } from './discord.mjs';
import { normalizeConfig, matchingContent } from './route-config.mjs';
import { safeFileName, mediaPayload, mediaRejection, payloadVersion, describePayload } from './media-payload.mjs';
import { parseJournal } from './relay-core.mjs';
import { RelayError } from './relay-health.mjs';

const KEY = 'U1lOVEhFVElDX0tFWV9NQVRFUklBTA==';
const jpeg = Buffer.from([255, 216, 255, 224, 1, 2, 3]), pdf = Buffer.from('%PDF-1.4 synthetic');
const e2eeImage = { id: '5001', chatMid: 'csource', contentType: 1, createdTime: 2000, from: 'ufriend', e2eeDecrypted: true,
  text: JSON.stringify({ keyMaterial: KEY }), contentMetadata: { OID: 'oid-1', SID: 'emi', e2eeVersion: '2' } };
const e2eeFile = { id: '5002', chatMid: 'csource', contentType: 14, createdTime: 2001, from: 'ufriend', e2eeDecrypted: true,
  text: JSON.stringify({ keyMaterial: KEY, fileName: '../報表 <Q4>.pdf' }), contentMetadata: { OID: 'oid-2', SID: 'emf', FILE_SIZE: String(pdf.length), e2eeVersion: '2' } };

test('file names are cleaned into one safe segment with extension kept', () => {
  assert.equal(safeFileName('../報表 <Q4>.pdf'), '_報表 _Q4_.pdf');
  assert.equal(safeFileName('CON.txt'), '_CON.txt');
  assert.equal(safeFileName('a‮fdp.exe'), 'a_fdp.exe');
  assert.equal(safeFileName('...'), 'file.bin');
  assert.equal(safeFileName(undefined, 'x.bin'), 'x.bin');
  const long = safeFileName('a'.repeat(300) + '.xlsx');
  assert.equal(long.length, 120); assert.ok(long.endsWith('.xlsx'));
});

test('LINE E2EE media JSON is classified by contentType and never treated as chat text', () => {
  const image = normalizeLineMessage(e2eeImage, 'csource');
  assert.equal(image.text, ''); assert.equal(image.media.kind, 'photo'); assert.equal(image.media.source, 'line');
  assert.deepEqual(image.media.obs, { oid: 'oid-1', sid: 'emi', keyMaterial: KEY });
  const file = normalizeLineMessage(e2eeFile, 'csource');
  assert.equal(file.text, ''); assert.equal(file.media.kind, 'document'); assert.equal(file.media.fileName, '_報表 _Q4_.pdf'); assert.equal(file.media.fileSize, pdf.length);
  const sticker = normalizeLineMessage({ id: '5003', contentType: 7, text: JSON.stringify({ STKID: 1 }), createdTime: 1 }, 'csource');
  assert.equal(sticker.text, ''); assert.equal(sticker.media, undefined);
  const location = normalizeLineMessage({ id: '5004', contentType: 15, e2eeDecrypted: true, text: '{"location":{"latitude":1}}', createdTime: 1 }, 'csource');
  assert.equal(location.text, ''); assert.equal(location.media, undefined);
  const text = { id: '5005', contentType: 0, text: '{"keyMaterial":"looks like json but is text"}' };
  assert.equal(normalizeLineMessage(text, 'csource'), text);
  const failed = normalizeLineMessage({ ...e2eeImage, e2eeDecrypted: false, text: undefined, e2eeDecryptFailure: { reason: 'x' } }, 'csource');
  assert.equal(failed.media, undefined); assert.ok(failed.e2eeDecryptFailure);
  const legacy = normalizeLineMessage({ id: '5006', contentType: 1, contentMetadata: {}, createdTime: 1 }, 'csource');
  assert.equal(legacy.media.obs, undefined); assert.equal(legacy.media.messageId, '5006');
});

function lineService(messages = []) {
  const calls = [];
  const service = Object.assign(new EventEmitter(), {
    profile: { mid: 'usynthetic' }, loginRequired: false, resumeSession: async () => true,
    e2eeManager: { getSelfKeyByMid: () => ({}), encryptE2EEMessage: async () => ({}) },
    client: { authToken: 'SYNTHETIC', getAllChatMids: async () => ({ memberChats: ['csource', 'cdestination'] }), getChats: async ids => ids.map(chatMid => ({ chatMid })), getAllContactIds: async () => [], getContacts: async () => [] },
    getRecentMessages: async () => messages,
    getPreviousMessages: async () => [],
    sendMessage: async (...args) => { calls.push(['text', ...args]); return { id: String(900 + calls.length) }; },
    sendImage: async (...args) => { calls.push(['image', ...args]); return { messageId: String(800 + calls.length) }; },
    sendFile: async (...args) => { calls.push(['file', ...args]); return { messageId: String(700 + calls.length) }; },
  });
  return { service, calls };
}
const endpoint = (platform, id) => ({ platform, id, name: id });

test('regression: LINE routes without attachments never forward decrypted media key material', async () => {
  const messages = [], { service, calls } = lineService(messages);
  const adapter = await createLineRelayAdapter(service, [endpoint('line', 'csource'), endpoint('line', 'cdestination')]);
  const config = normalizeConfig({ version: 1, rules: [{ id: 'r', name: 'r', enabled: true, sources: [endpoint('line', 'csource')], destinations: [endpoint('line', 'cdestination')] }] });
  const relay = await createMultiRelay({ config, adapters: { line: adapter }, directory: await mkdtemp(path.join(os.tmpdir(), 'lineport-media-')), now: () => 1000, pause: async () => {} });
  messages.push(e2eeImage, e2eeFile, { id: '5010', contentType: 0, text: '一般文字', createdTime: 2002, from: 'ufriend', chatMid: 'csource' });
  await relay.tick();
  assert.deepEqual(calls.map(call => [call[0], call[2]]), [['text', '一般文字']]);
  assert.ok(!JSON.stringify(calls).includes(KEY));
});

test('LINE media downloads verify through E2EE decrypt or legacy path and fail closed', async () => {
  const { service } = lineService(), seen = [];
  const load = async () => ({
    downloadObject: async (client, options) => { seen.push(['object', options]); return Buffer.alloc(64, 1); },
    downloadLegacy: async (client, options) => { seen.push(['legacy', options]); return { bytes: jpeg }; },
    decrypt: async (bytes, key) => { seen.push(['decrypt', key]); return pdf; },
  });
  const file = normalizeLineMessage(e2eeFile, 'csource').media;
  assert.deepEqual(await downloadLineMedia(service, file, { load }), { bytes: pdf, fileName: '_報表 _Q4_.pdf' });
  assert.deepEqual(seen.map(row => row[0]), ['object', 'decrypt']);
  const legacy = normalizeLineMessage({ id: '5006', contentType: 1, contentMetadata: {}, createdTime: 1 }, 'csource').media;
  assert.deepEqual(await downloadLineMedia(service, legacy, { load }), { bytes: jpeg, fileName: 'image.jpg' });
  // Declared size mismatch, MAC failure and non-image bytes never reach the destination.
  await assert.rejects(downloadLineMedia(service, { ...file, fileSize: pdf.length + 1 }, { load }), /尚未呼叫目的發送/);
  await assert.rejects(downloadLineMedia(service, file, { load: async () => ({ ...(await load()), decrypt: async () => { throw new Error('MAC mismatch SYNTHETIC'); } }) }),
    error => error instanceof RelayError && !error.message.includes('SYNTHETIC'));
  await assert.rejects(downloadLineMedia(service, legacy, { load: async () => ({ ...(await load()), downloadLegacy: async () => ({ bytes: pdf }) }) }), /格式無法辨識/);
});

test('LINE destination sends documents through the E2EE file API and non-JPEG images as files', async () => {
  const { service, calls } = lineService();
  const document = mediaPayload({ kind: 'document', fileId: 'TG_FILE', fileSize: pdf.length, fileName: 'a.pdf', caption: '說明' });
  assert.deepEqual(await sendLineMedia(service, 'cdestination', document, { bytes: pdf, fileName: 'a.pdf' }), { id: '902', ids: ['701', '902'] });
  assert.deepEqual(calls.map(call => call[0]), ['file', 'text']); assert.equal(calls[0][3], 'a.pdf');
  calls.length = 0;
  const gif = Buffer.from('GIF89a-synthetic');
  await sendLineMedia(service, 'cdestination', { ...normalizeLineMessage(e2eeImage, 'csource').media }, { bytes: gif, fileName: 'image.gif' });
  assert.deepEqual(calls.map(call => call[0]), ['file']);
  await assert.rejects(sendLineMedia(service, 'cdestination', document, { bytes: pdf, fileName: '../x.pdf' }), /安全下載/);
  service.sendFile = async () => ({});
  await assert.rejects(sendLineMedia(service, 'cdestination', document, { bytes: pdf, fileName: 'a.pdf' }), /不要直接重送/);
});

function telegram(responses) {
  const requests = [];
  const client = createTelegramClient('12345:SYNTHETIC_TOKEN_1234567890', { request: async (url, options) => {
    requests.push({ method: url.split('/').at(-1), url, options });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    if (next instanceof Response) return next;
    return { ok: true, status: 200, json: async () => ({ ok: true, result: next }) };
  } });
  return { client, requests };
}

test('Telegram documents keep file names, accept unknown sizes and respect the 20 MB Bot download limit', async () => {
  const update = { message: { chat: { id: -1 }, message_id: 7, date: 2, from: { id: 1 }, document: { file_id: 'DOC', file_name: '季報/final?.xlsx' } } };
  const media = telegramMessage(update).media;
  assert.deepEqual(media, { kind: 'document', fileId: 'DOC', fileSize: 0, caption: '', fileName: '季報_final_.xlsx' });
  assert.equal(payloadVersion({ ...media, caption: '' }), 2);
  const { client } = telegram([{ file_id: 'DOC', file_size: pdf.length, file_path: 'documents/file_1.xlsx' }, new Response(pdf)]);
  assert.deepEqual(await client.downloadMedia(media), { bytes: pdf, fileName: '季報_final_.xlsx' });
  await assert.rejects(telegram([]).client.downloadMedia({ ...media, fileSize: 20000001 }), /20 MB/);
  const huge = telegramMessage({ message: { ...update.message, document: { file_id: 'BIG', file_size: 60000000, file_name: 'big.iso' } } }).media;
  assert.deepEqual(huge, { kind: 'unsupported', fileSize: 60000000, fileName: 'big.iso' });
});

test('Telegram uploads LINE bytes as multipart and sends long captions as follow-up messages', async () => {
  const ack = id => ({ message_id: id, chat: { id: -2 } });
  const line = normalizeLineMessage(e2eeFile, 'csource').media;
  const { client, requests } = telegram([ack(1), ack(2)]);
  const caption = 'x'.repeat(1500);
  assert.deepEqual(await client.send('-2', { ...line, caption }, { prepared: { bytes: pdf, fileName: 'r.pdf' } }), { id: '-2:2', ids: ['-2:1', '-2:2'] });
  assert.equal(requests[0].method, 'sendDocument'); assert.ok(requests[0].options.body instanceof FormData);
  assert.equal(requests[0].options.body.get('caption'), null); assert.equal(requests[0].options.body.get('document').name, 'r.pdf');
  assert.equal(JSON.parse(requests[1].options.body).text, caption);
  await assert.rejects(telegram([]).client.send('-2', line, {}), /安全下載/);
  const failing = telegram([ack(1), new Error('reset SYNTHETIC_TOKEN')]);
  await assert.rejects(failing.client.send('-2', { ...line, caption }, { prepared: { bytes: pdf, fileName: 'r.pdf' } }), error => /不要直接重送/.test(error.message) && !error.message.includes('SYNTHETIC'));
});

test('Discord uploads attachments as multipart, classifies unsent connections and enforces 10 MB', async () => {
  const channel = '123456789012345678', token = 'SYNTHETIC_DISCORD_TOKEN_abcdefghijklmnop', requests = [];
  const client = createDiscordClient(token, { request: async (url, options) => { requests.push(options); return { ok: true, status: 200, json: async () => ({ id: '234567890123456789', channel_id: channel }) }; } });
  const payload = mediaPayload({ kind: 'document', fileId: 'TG', fileSize: pdf.length, fileName: 'a.pdf', caption: '@everyone 說明' });
  assert.equal((await client.send(channel, payload, { prepared: { bytes: pdf, fileName: 'a.pdf' } })).id, '234567890123456789');
  const body = requests[0].body, json = JSON.parse(body.get('payload_json'));
  assert.equal(json.content, '@everyone 說明'); assert.deepEqual(json.allowed_mentions.parse, []); assert.equal(body.get('files[0]').name, 'a.pdf');
  assert.equal(requests[0].headers['Content-Type'], undefined);
  await assert.rejects(client.send(channel, payload, { prepared: { bytes: Buffer.alloc(10000001), fileName: 'a.pdf' } }), /10 MB/);
  const offline = createDiscordClient(token, { request: async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }); } });
  await assert.rejects(offline.send(channel, '通知'), error => error instanceof DiscordUnsent && error.unsent === true);
  const reset = createDiscordClient(token, { request: async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }); } });
  await assert.rejects(reset.send(channel, '通知'), error => !(error instanceof DiscordUnsent));
  assert.equal(mediaRejection({ ...payload, fileSize: 20000000 }, 'discord'), '超過 Discord 10 MB 上限');
});

test('end to end: LINE file reaches Telegram and Discord, Telegram file reaches LINE, oversize becomes a notice', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'lineport-media-e2e-'));
  const lineMessages = [], { service, calls: lineCalls } = lineService(lineMessages);
  const lineAdapter = await createLineRelayAdapter(service, [endpoint('line', 'csource'), endpoint('line', 'cdestination')], { downloadMedia: async () => ({ bytes: pdf, fileName: 'tg.pdf' }) });
  lineAdapter.downloadMedia = async () => ({ bytes: pdf, fileName: '_報表 _Q4_.pdf' });
  const sent = [];
  const tgMessages = [{ id: '-1:1', chatId: '-1', text: '', createdTime: 3000, from: '9', media: { kind: 'document', fileId: 'TGDOC', fileSize: pdf.length, caption: '', fileName: 'tg.pdf' } },
    { id: '-1:2', chatId: '-1', text: '', createdTime: 3001, from: '9', media: { kind: 'unsupported', fileSize: 70000000, fileName: 'huge.iso' } }];
  const downloads = [];
  const download = async payload => { downloads.push(payload.source || 'telegram'); return payload.source === 'line' ? lineAdapter.downloadMedia(payload) : { bytes: pdf, fileName: 'tg.pdf' }; };
  const adapters = {
    line: { ...lineAdapter, preparePayload: text => typeof text === 'string' ? undefined : download(text) },
    telegram: { identity: 'tg', prepare: async () => {}, recent: async () => [], read: async () => tgMessages, preparePayload: text => typeof text === 'string' || text.source !== 'line' ? undefined : download(text),
      send: async (id, payload, options) => { sent.push(['telegram', typeof payload === 'string' ? payload : payload.kind, options.prepared?.fileName]); return { id: `${id}:${sent.length}` }; } },
    discord: { identity: 'dc', prepare: async () => {}, preparePayload: text => typeof text === 'string' ? undefined : download(text),
      send: async (id, payload, options) => { sent.push(['discord', typeof payload === 'string' ? payload : payload.kind, options.prepared?.fileName]); return { id: '234567890123456789' }; } },
  };
  const config = normalizeConfig({ version: 1, rules: [
    { id: 'line-out', name: 'line-out', enabled: true, media: true, sources: [endpoint('line', 'csource')], destinations: [endpoint('telegram', '-2'), endpoint('discord', '123456789012345678')] },
    { id: 'tg-in', name: 'tg-in', enabled: true, media: true, sources: [endpoint('telegram', '-1')], destinations: [endpoint('line', 'cdestination')] },
  ] });
  const relay = await createMultiRelay({ config, adapters, directory, now: () => 1000, pause: async () => {} });
  lineMessages.push(e2eeFile);
  for (let i = 0; i < 3; i++) await relay.tick();
  assert.deepEqual(sent.sort(), [['discord', 'document', '_報表 _Q4_.pdf'], ['telegram', 'document', '_報表 _Q4_.pdf']]);
  assert.deepEqual(lineCalls.map(call => call[0]), ['file', 'text']);
  assert.equal(lineCalls[0][3], 'tg.pdf'); assert.match(lineCalls[1][2], /附件未轉送：Telegram 檔案 huge\.iso · 70\.0 MB/);
  assert.ok(relay.state.routes.every(route => route.phase === 'running' && route.pending === 0));
  // Journals hold references only: no bytes, no temporary files.
  const files = await readdir(directory);
  assert.ok(files.every(name => /^lineport-(route-[a-f0-9]{64}|output)\.jsonl$/.test(name)));
  for (const name of files.filter(name => name.startsWith('lineport-route-'))) {
    const journal = await readFile(path.join(directory, name), 'utf8');
    assert.ok(!journal.includes(pdf.toString('base64'))); parseJournal(journal);
  }
});

test('describePayload labels LINE and Telegram attachments for manual review', () => {
  assert.match(describePayload(normalizeLineMessage(e2eeFile, 'csource').media), /^\[LINE 檔案 _報表 _Q4_\.pdf · /);
  assert.match(describePayload({ kind: 'photo', fileId: 'x', fileSize: 1500000, caption: 'c' }), /^\[Telegram 圖片 · 1\.5 MB\]\nc$/);
  assert.equal(matchingContent(normalizeConfig({ version: 1, rules: [{ id: 'a', name: 'a', enabled: true, media: true, sources: [endpoint('line', 'csource')], destinations: [endpoint('telegram', '-2')] }] }).rules[0],
    normalizeLineMessage(e2eeImage, 'csource'), 'line:csource', endpoint('line', 'csource')).kind, 'photo');
});
