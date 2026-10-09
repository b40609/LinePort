import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createTelegramClient, createTelegramInbox, telegramMessage, TelegramRateLimit } from './telegram.mjs';

const token = '123456:synthetic_token_for_tests_only';
const update = (id, extra = {}) => ({ update_id: id, message: { message_id: id, chat: { id: -123 }, date: 1000, text: 'synthetic text', ...extra } });

test('only explicit validated Telegram 429 responses permit safe retry', async () => {
  for (const seconds of [5, 0, -1, '5', undefined, 2147484]) {
    const client = createTelegramClient(token, { request: async () => ({ status: 429, ok: false,
      json: async () => ({ ok: false, error_code: 429, parameters: { retry_after: seconds }, description: token }) }) });
    await assert.rejects(client.send('-123', 'test'), error => {
      assert.equal(error instanceof TelegramRateLimit, seconds === 5);
      assert.ok(!error.message.includes(token));
      if (seconds === 5) assert.equal(error.retryAfterMs, 5000);
      return true;
    });
  }
});

test('inbox warns at 80 percent without exposing stored message content', async () => {
  const file = path.join(await mkdtemp(path.join(os.tmpdir(), 'lineport-capacity-')), 'inbox.jsonl');
  await appendFile(file, Array.from({ length: 40000 }, (_, i) => JSON.stringify({ offset: i + 1,
    message: { id: String(i), chatId: '-123', text: 'SYNTHETIC_PRIVATE_TEXT', createdTime: 1000 } }) + '\n').join(''));
  const inbox = await createTelegramInbox(file, {}, ['-123']);
  assert.match(inbox.health().warning, /40000\/50000/);
  assert.ok(!JSON.stringify(inbox.health()).includes('SYNTHETIC_PRIVATE_TEXT'));
});

test('Telegram API errors never expose the token or upstream diagnostic strings', async () => {
  for (const request of [async () => { throw new Error(`https://example/${token}`); }, async () => ({ ok: false, json: async () => ({ error_code: 403, description: token }) })]) {
    await assert.rejects(createTelegramClient(token, { request }).getMe(), error => !error.message.includes(token) && /Telegram/.test(error.message));
  }
});

test('Telegram uses plaintext JSON and validates the acknowledgement and text limit', async () => {
  const calls = [];
  const client = createTelegramClient(token, { request: async (url, options) => { calls.push(JSON.parse(options.body)); return { ok: true, json: async () => ({ ok: true, result: { message_id: 7, chat: { id: -123 } } }) }; } });
  assert.deepEqual(await client.send('-123', '<b>literal</b>'), { id: '-123:7' });
  assert.deepEqual(calls[0], { chat_id: '-123', text: '<b>literal</b>' });
  await assert.rejects(client.send('-123', 'a'.repeat(4097)), /4,096/);
  assert.equal(calls.length, 1);
  for (const result of [{ message_id: 7 }, { message_id: 7, chat: { id: -456 } }, { message_id: '7', chat: { id: -123 } }]) {
    const malformed = createTelegramClient(token, { request: async () => ({ ok: true, json: async () => ({ ok: true, result }) }) });
    assert.equal((await malformed.send('-123', 'synthetic')).id, '');
  }
});

test('protected, ephemeral and paid Telegram messages are marked as protected', () => {
  for (const flags of [{ has_protected_content: true }, { is_paid_post: true }, { is_ephemeral: true }]) assert.equal(telegramMessage(update(1, flags)).protected, true);
  assert.equal(telegramMessage(update(1)).id, '-123:1');
});

test('Telegram confirms offsets only after durable persistence and restores messages across restart', async () => {
  const file = path.join(await mkdtemp(path.join(os.tmpdir(), 'lineport-telegram-')), 'inbox.jsonl');
  const offsets = [], client = { getUpdates: async offset => { offsets.push(offset); return offset ? [] : [update(10), update(11, { has_protected_content: true }), update(12, { from: { is_bot: true } })]; } };
  const inbox = await createTelegramInbox(file, client, ['-123']);
  await inbox.poll();
  assert.equal(inbox.messages('-123').length, 1);
  const restarted = await createTelegramInbox(file, client, ['-123']);
  await restarted.poll();
  assert.deepEqual(offsets, [0, 13]);
  assert.equal(restarted.messages('-123')[0].text, 'synthetic text');
  await appendFile(file, '{"offset":');
  await assert.rejects(createTelegramInbox(file, client, ['-123']), /Incomplete/);
});

test('an inbox write failure never acknowledges an update on the next poll', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'lineport-inbox-failure-'));
  // Corrupt the synthetic append target only after preflight, before the offset advances.
  const file = path.join(directory, 'inbox.jsonl');
  const offsets = [], client = { getUpdates: async offset => { offsets.push(offset); await mkdir(file); return [update(10)]; } };
  const inbox = await createTelegramInbox(file, client, ['-123']);
  await assert.rejects(inbox.poll());
  await assert.rejects(inbox.poll());
  assert.deepEqual(offsets, [0]);
});

test('malformed Telegram timestamps never poison the journal or advance acknowledgements', async () => {
  const file = path.join(await mkdtemp(path.join(os.tmpdir(), 'lineport-invalid-update-')), 'inbox.jsonl');
  const offsets = [];
  let malformed = true;
  const client = { getUpdates: async offset => { offsets.push(offset); return [update(10, { date: malformed ? 'invalid' : 1000 })]; } };
  const inbox = await createTelegramInbox(file, client, ['-123']);
  await assert.rejects(inbox.poll());
  malformed = false;
  const restarted = await createTelegramInbox(file, client, ['-123']);
  await restarted.poll();
  assert.deepEqual(offsets, [0, 0]);
  assert.equal(restarted.messages('-123').length, 1);
});

test('an overflowing update ID is rejected before it can corrupt the saved offset', async () => {
  const file = path.join(await mkdtemp(path.join(os.tmpdir(), 'lineport-invalid-offset-')), 'inbox.jsonl');
  const inbox = await createTelegramInbox(file, { getUpdates: async () => [{ update_id: Number.MAX_SAFE_INTEGER }] }, []);
  await assert.rejects(inbox.poll());
  await createTelegramInbox(file, { getUpdates: async () => [] }, []);
});
