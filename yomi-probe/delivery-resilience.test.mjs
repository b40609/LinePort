import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, utimes } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { normalizeConfig } from './route-config.mjs';
import { createMultiRelay, createLineRelayAdapter } from './multi-relay.mjs';
import { createTelegramClient } from './telegram.mjs';
import { createDiscordClient } from './discord.mjs';
import { createDeliveryReviewStore } from './delivery-review.mjs';
import { compactStorage } from './compaction.mjs';
import { healthEvents } from './health-alert.mjs';
import { RelayError } from './relay-health.mjs';

const endpoint = (platform, id, extra = {}) => ({ platform, id, name: id, ...extra });
const makeDir = () => mkdtemp(path.join(os.tmpdir(), 'lineport-resilience-'));
const msg = (id, text = '台積電法說重點', createdTime = Date.UTC(2026, 10, 26, 1, 25, 0)) => ({
  id, text, createdTime, deliveredTime: createdTime, from: 'u1',
});

test('LP-03: pre-send failures (LINE login loss, invalid topic/reply) never mark send_uncertain or require manual review', async () => {
  const directory = await makeDir();
  const sent = [];
  let messages = [];
  const service = Object.assign(new EventEmitter(), {
    profile: { mid: 'uself' },
    loginRequired: false,
    resumeSession: async () => true,
    e2eeManager: { getSelfKeyByMid: () => ({}), encryptE2EEMessage: async () => ({}) },
    client: {
      getAllChatMids: async () => ({ memberChats: ['csource', 'cdest'] }),
      getChats: async ids => ids.map(chatMid => ({ chatMid })),
      getAllContactIds: async () => [],
      getContacts: async () => [],
    },
    getRecentMessages: async id => (id === 'csource' ? messages : []),
    sendMessage: async (to, text) => { sent.push([to, text]); return { id: `out-${sent.length}` }; },
  });
  const config = normalizeConfig({
    version: 1,
    rules: [{ id: 'r1', name: 'LINE 路線', enabled: true, sources: [endpoint('line', 'csource')], destinations: [endpoint('line', 'cdest')] }],
  });
  const line = await createLineRelayAdapter(service, [endpoint('line', 'csource'), endpoint('line', 'cdest')]);
  let clock = 1000;
  const relay = await createMultiRelay({ config, adapters: { line }, directory, now: () => clock, pause: async () => {} });

  // Simulate session loss after source read, right before destination send.
  messages = [msg('m1', '重要通知', 2000)];
  service.getRecentMessages = async id => {
    if (id === 'csource') {
      service.loginRequired = true;
      return messages;
    }
    return [];
  };
  await relay.tick();

  const route = relay.state.routes[0];
  assert.equal(route.phase, 'failed');
  assert.equal(route.uncertain, 0);
  assert.equal(route.pending, 1);
  assert.equal((await createDeliveryReviewStore(directory).list()).items.length, 0);
  assert.ok(healthEvents({ relay: relay.state }).some(event => event.kind === 'line_login_required'));

  // Re-authorizing and restarting sends the original text verbatim (no duplicate banner).
  service.loginRequired = false;
  service.getRecentMessages = async () => messages;
  const recoveredLine = await createLineRelayAdapter(service, [endpoint('line', 'csource'), endpoint('line', 'cdest')]);
  const restarted = await createMultiRelay({ config, adapters: { line: recoveredLine }, directory, now: () => 5000, pause: async () => {} });
  await restarted.tick();
  assert.equal(restarted.state.routes[0].phase, 'running');
  assert.equal(restarted.state.routes[0].pending, 0);
  assert.deepEqual(sent, [['cdest', '重要通知']]);
});

test('LP-X-01: Telegram 401/403/400 chat-level rejections fail the route cleanly without uncertain review, while 5xx stays uncertain', async () => {
  for (const [status, description] of [
    [401, 'Unauthorized'],
    [403, 'Forbidden: bot was kicked from the supergroup chat'],
    [400, 'Bad Request: chat not found'],
    [400, 'Bad Request: message thread not found'],
  ]) {
    const directory = await makeDir();
    let reject = true;
    const delivered = [];
    const tgClient = createTelegramClient('12345:SYNTHETIC_TOKEN_1234567890', {
      request: async (_url, options) => {
        const body = JSON.parse(options.body);
        if (reject) return new Response(JSON.stringify({ ok: false, error_code: status, description }), { status });
        delivered.push(body.text);
        return new Response(JSON.stringify({ ok: true, result: { message_id: 9, chat: { id: -1001 }, message_thread_id: 77 } }), { status: 200 });
      },
    });
    const config = normalizeConfig({
      version: 1,
      rules: [{ id: 'r', name: 'TG', enabled: true, sources: [endpoint('line', 'cs')], destinations: [endpoint('telegram', '-1001', { threadId: 77 })] }],
    });
    const adapters = {
      line: { identity: 'line:u', prepare: async () => 'e2ee', recent: async () => [], read: async () => [msg('m1', '快訊')], send: async () => ({ id: '1' }) },
      telegram: { identity: 'tg:1', prepare: async () => {}, send: (id, text, opts) => tgClient.send(id, text, opts) },
    };
    const relay = await createMultiRelay({ config, adapters, directory, now: () => 1000, pause: async () => {} });
    await relay.tick();
    const route = relay.state.routes[0];
    assert.equal(route.phase, 'failed', `${status} ${description}`);
    assert.equal(route.stage, 'destination_rejected', `${status} ${description}`);
    assert.equal(route.uncertain, 0, `${status} ${description}`);
    assert.equal(route.pending, 1, `${status} ${description}`);
    assert.equal(route.failures.rejected, 1, `${status} ${description}`);
    assert.equal((await createDeliveryReviewStore(directory).list()).items.length, 0);

    // Fix configuration/permissions and restart: message is delivered verbatim without duplicate notice.
    reject = false;
    const restarted = await createMultiRelay({ config, adapters, directory, now: () => 2000, pause: async () => {} });
    await restarted.tick();
    assert.equal(restarted.state.routes[0].phase, 'running');
    assert.deepEqual(delivered, ['快訊']);
  }

  // Discord 403 behaves identically.
  const dcDir = await makeDir();
  const dcClient = createDiscordClient('SYNTHETIC_DISCORD_TOKEN_1234567890', {
    request: async () => new Response(JSON.stringify({ message: 'Missing Permissions', code: 50013 }), { status: 403 }),
  });
  const dcConfig = normalizeConfig({
    version: 1,
    rules: [{ id: 'dc', name: 'DC', enabled: true, sources: [endpoint('line', 'cs')], destinations: [endpoint('discord', '123456789012345678')] }],
  });
  const dcRelay = await createMultiRelay({
    config: dcConfig,
    adapters: {
      line: { identity: 'line:u', prepare: async () => 'e2ee', recent: async () => [], read: async () => [msg('m1', 'DC 測試')], send: async () => ({ id: '1' }) },
      discord: { identity: 'dc:1', prepare: async () => {}, send: (id, text, opts) => dcClient.send(id, text, opts) },
    },
    directory: dcDir, now: () => 1000, pause: async () => {},
  });
  await dcRelay.tick();
  assert.equal(dcRelay.state.routes[0].phase, 'failed');
  assert.equal(dcRelay.state.routes[0].stage, 'destination_rejected');
  assert.equal(dcRelay.state.routes[0].uncertain, 0);

  // HTTP 502 remains uncertain (server may have accepted the message before gateway failure).
  const dir502 = await makeDir();
  const tg502 = createTelegramClient('12345:SYNTHETIC_TOKEN_1234567890', {
    request: async () => new Response(JSON.stringify({ ok: false, error_code: 502, description: 'Bad Gateway' }), { status: 502 }),
  });
  let clock = 1000;
  const relay502 = await createMultiRelay({
    config: normalizeConfig({ version: 1, rules: [{ id: 'r', name: 'TG502', enabled: true, sources: [endpoint('line', 'cs')], destinations: [endpoint('telegram', '-1001')] }] }),
    adapters: {
      line: { identity: 'line:u', prepare: async () => 'e2ee', recent: async () => [], read: async () => [msg('m1', '502 測試')], send: async () => ({ id: '1' }) },
      telegram: { identity: 'tg:1', prepare: async () => {}, send: (id, text, opts) => tg502.send(id, text, opts) },
    },
    directory: dir502, now: () => clock, pause: async () => {}, resendDelayMs: 30000,
  });
  await relay502.tick();
  assert.equal(relay502.state.routes[0].failures.server_error, 1);
  clock += 30000;
  await relay502.tick();
  assert.equal(relay502.state.routes[0].phase, 'blocked');
  assert.equal(relay502.state.routes[0].stage, 'send_uncertain');
});

test('LP-04: transient attachment preparation failures back off and recover; 6 consecutive failures fail the route', async () => {
  const directory = await makeDir();
  let clock = 1000, attempts = 0, failPrepare = true;
  const sent = [];
  const mediaConfig = normalizeConfig({
    version: 1,
    rules: [{ id: 'm', name: 'Media', enabled: true, media: true, sources: [endpoint('telegram', '-1')], destinations: [endpoint('discord', '123456789012345678')] }],
  });
  const mediaItem = { id: '-1:1', text: '報表', createdTime: 2000, from: 'u1', media: { kind: 'document', fileId: 'F1', fileSize: 8, caption: '報表', fileName: 'a.pdf' } };
  const adapters = {
    telegram: { identity: 'tg:1', prepare: async () => {}, recent: async () => [], read: async () => [mediaItem], send: async () => ({ id: '1' }) },
    discord: {
      identity: 'dc:1', prepare: async () => {},
      preparePayload: async value => {
        if (typeof value === 'string') return undefined;
        attempts++;
        if (failPrepare) throw new RelayError('Telegram 附件下載或格式驗證失敗，尚未呼叫目的發送；待送紀錄已保留，會自動重試');
        return { bytes: Buffer.alloc(8, 1), fileName: 'a.pdf' };
      },
      send: async (_id, value) => { sent.push(value.caption); return { id: '223456789012345678' }; },
    },
  };
  const relay = await createMultiRelay({ config: mediaConfig, adapters, directory, now: () => clock, pause: async () => {} });
  await relay.tick();
  assert.equal(attempts, 1);
  assert.equal(relay.state.routes[0].phase, 'running');
  assert.equal(relay.state.routes[0].pending, 1);
  assert.equal(relay.state.routes[0].uncertain, 0);

  // Before 5s backoff expires, no retry happens.
  clock += 4000;
  await relay.tick();
  assert.equal(attempts, 1);

  // At 5s, retries and succeeds when network recovers.
  failPrepare = false;
  clock += 1000;
  await relay.tick();
  assert.equal(attempts, 2);
  assert.deepEqual(sent, ['報表']);
  assert.equal(relay.state.routes[0].pending, 0);
  assert.equal(relay.state.routes[0].phase, 'running');

  // Persistent transient failure stops the route after 6 consecutive attempts so health alerts fire.
  const dir2 = await makeDir();
  let clock2 = 1000, tries2 = 0;
  const relay2 = await createMultiRelay({
    config: mediaConfig,
    adapters: {
      ...adapters,
      discord: { ...adapters.discord, preparePayload: async () => { tries2++; throw new RelayError('下載逾時'); } },
    },
    directory: dir2, now: () => clock2, pause: async () => {},
  });
  for (let i = 0; i < 6; i++) {
    await relay2.tick();
    clock2 += 300000;
  }
  assert.equal(tries2, 6);
  assert.equal(relay2.state.routes[0].phase, 'failed');
  assert.equal(relay2.state.routes[0].stage, 'prepare');
});

test('D6 (a): uncertain text resends exactly once with duplicate banner and source timestamp; second uncertainty blocks and alerts; attachments never auto-resend', async () => {
  const directory = await makeDir();
  const sourceTime = Date.UTC(2026, 10, 26, 1, 26, 6); // 2026-11-26 09:26:06 UTC+8
  let clock = sourceTime - 5000, callCount = 0;
  const delivered = [];
  const config = normalizeConfig({
    version: 1,
    rules: [{ id: 'r', name: 'Route 2', enabled: true, sources: [endpoint('line', 'cs')], destinations: [endpoint('telegram', '-1002')] }],
  });
  const adapters = {
    line: { identity: 'line:u', prepare: async () => 'e2ee', recent: async () => [], read: async () => [msg('m-uncertain', '早盤重點摘要', sourceTime), msg('m-next', '下一則正常訊息', sourceTime + 500)], send: async () => ({ id: '1' }) },
    telegram: {
      identity: 'tg:1', prepare: async () => {},
      send: async (_id, text) => {
        callCount++;
        if (callCount === 1) throw Object.assign(new RelayError('Telegram 連線失敗或逾時；發送結果可能不明'), { failure: 'timeout' });
        delivered.push(text);
        return { id: `-1002:${callCount}` };
      },
    },
  };
  const relay = await createMultiRelay({ config, adapters, directory, now: () => clock, pause: async () => {}, resendDelayMs: 30000 });
  await relay.tick();
  assert.equal(callCount, 1);
  assert.equal(relay.state.routes[0].phase, 'running');
  assert.equal(relay.state.routes[0].stage, 'resend_pending');
  assert.equal(relay.state.routes[0].uncertain, 0);
  assert.equal(delivered.length, 0);

  // After resendDelayMs, resends once with duplicate notice and original timestamp, then continues backlog.
  clock += 30000;
  await relay.tick();
  assert.equal(delivered.length, 2);
  assert.match(delivered[0], /^⚠️ 可能重複：前一次發送結果不明，系統自動重送一次（原訊息時間 2026-11-26 \d\d:26:06 \(UTC[+-]\d\d:\d\d\)）\n早盤重點摘要$/);
  assert.equal(delivered[1], '下一則正常訊息');
  assert.equal(relay.state.routes[0].phase, 'running');
  assert.equal(relay.state.routes[0].resent, 1);
  assert.equal(relay.state.routes[0].pending, 0);

  // Restart does not send anything again.
  const restarted = await createMultiRelay({ config, adapters, directory, now: () => clock + 5000, pause: async () => {} });
  await restarted.tick();
  assert.equal(delivered.length, 2);

  // Second case: when the automatic resend is ALSO uncertain, block and fire route_uncertain alert; never send a 3rd time.
  const dirBothFail = await makeDir();
  let clock2 = 1000, sendTries = 0;
  const adaptersBothFail = {
    line: { identity: 'line:u', prepare: async () => 'e2ee', recent: async () => [], read: async () => [msg('m-stuck', '連兩次不明', sourceTime)], send: async () => ({ id: '1' }) },
    telegram: {
      identity: 'tg:1', prepare: async () => {},
      send: async () => { sendTries++; throw Object.assign(new RelayError('Telegram 連線失敗或逾時'), { failure: 'network', code: 'ECONNRESET' }); },
    },
  };
  const relayFail = await createMultiRelay({ config, adapters: adaptersBothFail, directory: dirBothFail, now: () => clock2, pause: async () => {}, resendDelayMs: 30000 });
  await relayFail.tick();
  assert.equal(sendTries, 1);
  assert.equal(relayFail.state.routes[0].phase, 'running');
  clock2 += 30000;
  await relayFail.tick();
  assert.equal(sendTries, 2);
  assert.equal(relayFail.state.routes[0].phase, 'blocked');
  assert.equal(relayFail.state.routes[0].stage, 'send_uncertain');
  assert.equal(relayFail.state.routes[0].uncertain, 1);
  assert.equal(relayFail.state.routes[0].failures.network, 2);
  assert.ok(healthEvents({ relay: relayFail.state }).some(e => e.kind === 'route_uncertain'));

  // Even after compaction and restart, a twice-uncertain text remains blocked and never resends a 3rd time.
  await compactStorage(dirBothFail, { now: clock2 + 1000 });
  const relayFailRestart = await createMultiRelay({ config, adapters: adaptersBothFail, directory: dirBothFail, now: () => clock2 + 60000, pause: async () => {}, resendDelayMs: 30000 });
  await relayFailRestart.tick();
  assert.equal(sendTries, 2);
  assert.equal(relayFailRestart.state.routes[0].phase, 'blocked');

  // Third case: legacy journal (v1.2.0 uncertain row without queued time) recovers on startup and resends once.
  const dirLegacy = await makeDir();
  const initRelay = await createMultiRelay({
    config,
    adapters: {
      line: { identity: 'line:u', prepare: async () => 'e2ee', recent: async () => [], read: async () => [], send: async () => ({ id: '1' }) },
      telegram: { identity: 'tg:1', prepare: async () => {}, send: async () => ({ id: '-1002:1' }) },
    },
    directory: dirLegacy, now: () => 1000, pause: async () => {},
  });
  assert.equal(initRelay.state.phase, 'running');
  const routeFile = path.join(dirLegacy, (await readdir(dirLegacy)).find(n => n.startsWith('lineport-route-')));
  const { appendRecord } = await import('./relay-core.mjs');
  await appendRecord(routeFile, { id: 'legacy-1', outcome: 'queued', text: '昨日卡住的訊息' });
  await appendRecord(routeFile, { id: 'legacy-1', outcome: 'sending' });
  await appendRecord(routeFile, { id: 'legacy-1', outcome: 'uncertain' });
  const stalledDate = new Date(sourceTime);
  await utimes(routeFile, stalledDate, stalledDate);

  const legacyDelivered = [];
  let clockLegacy = sourceTime + 50000;
  const legacyRelay = await createMultiRelay({
    config,
    adapters: {
      line: { identity: 'line:u', prepare: async () => 'e2ee', recent: async () => [], read: async () => [], send: async () => ({ id: '1' }) },
      telegram: { identity: 'tg:1', prepare: async () => {}, send: async (_id, text) => { legacyDelivered.push(text); return { id: '-1002:88' }; } },
    },
    directory: dirLegacy, now: () => clockLegacy, pause: async () => {}, resendDelayMs: 30000,
  });
  assert.equal(legacyRelay.state.routes[0].phase, 'running');
  clockLegacy += 30000;
  await legacyRelay.tick();
  assert.equal(legacyDelivered.length, 1);
  assert.match(legacyDelivered[0], /⚠️ 可能重複.*首次發送約 2026-11-26.*\n昨日卡住的訊息$/);
  assert.equal(legacyRelay.state.routes[0].phase, 'running');
  assert.equal(legacyRelay.state.routes[0].uncertain, 0);

  // Fourth case: attachment uncertainty blocks immediately on the first unknown attempt.
  const dirMedia = await makeDir();
  let mediaTries = 0;
  const mediaRelay = await createMultiRelay({
    config: normalizeConfig({ version: 1, rules: [{ id: 'm', name: 'M', enabled: true, media: true, sources: [endpoint('telegram', '-1')], destinations: [endpoint('telegram', '-2')] }] }),
    adapters: {
      telegram: {
        identity: 'tg:1', prepare: async () => {}, recent: async () => [],
        read: async () => [{ id: '-1:9', text: '', createdTime: 2000, from: 'u1', media: { kind: 'photo', fileId: 'P1', fileSize: 100, caption: '圖' } }],
        send: async () => { mediaTries++; throw new RelayError('連線中斷'); },
      },
    },
    directory: dirMedia, now: () => 1000, pause: async () => {}, resendDelayMs: 10,
  });
  await mediaRelay.tick();
  assert.equal(mediaTries, 1);
  assert.equal(mediaRelay.state.routes[0].phase, 'blocked');
  assert.equal(mediaRelay.state.routes[0].stage, 'send_uncertain');
});
