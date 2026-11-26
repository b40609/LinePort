import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { once, EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { normalizeConfig, createSettingsStore } from './route-config.mjs';
import { createMultiRelay } from './multi-relay.mjs';
import { createRelayController } from './relay-controller.mjs';
import { safeDiagnostics } from './user-tools.mjs';
import { healthEvents, createHealthMonitor, telegramAlertChannel, localLogAlertChannel } from './health-alert.mjs';
import { createProbeServer } from './server.mjs';
import { TelegramRateLimit, TelegramUnsent } from './telegram.mjs';
import { RelayError } from './relay-health.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const shell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const endpoint = (platform, id, extra = {}) => ({ platform, id, name: id, ...extra });

test('LP-02 & LP-07: relayController.status() and safeDiagnostics preserve quarantine fields, failure categories and commit hash', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'lineport-lp02-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = normalizeConfig({
    version: 1,
    rules: [{ id: 'r1', name: '公告', enabled: true, sources: [endpoint('line', 'cs')], destinations: [endpoint('telegram', '-1001')] }],
  });
  let step = 0;
  const adapters = {
    line: {
      identity: 'line:u', prepare: async () => 'e2ee', recent: async () => [],
      read: async () => [
        { id: 'm1', text: '壞格式', createdTime: 2000, from: 'u1' },
        { id: 'm2', text: '限流測試', createdTime: 2001, from: 'u1' },
        { id: 'm3', text: '連不上測試', createdTime: 2002, from: 'u1' },
      ],
      send: async () => ({ id: '1' }),
    },
    telegram: {
      identity: 'tg:1', prepare: async () => {},
      send: async (_id, text) => {
        if (text === '壞格式') throw Object.assign(new RelayError('拒絕此則'), { rejected: true, permanent: true, status: 400 });
        step++;
        if (step === 1) throw new TelegramRateLimit(5);
        if (step === 2) throw Object.assign(new TelegramUnsent(), { code: 'ECONNREFUSED' });
        return { id: `-1001:${step}` };
      },
    },
  };
  let clock = 1000;
  const relay = await createMultiRelay({ config, adapters, directory, now: () => clock, pause: async () => {} });
  await relay.tick(); // m1 quarantined, m2 hits 429
  clock += 6000;
  await relay.tick(); // m2 hits ECONNREFUSED
  clock += 6000;
  await relay.tick(); // m2 + m3 succeed

  // Pass raw relay state through createRelayController().status() just like production 18766 -> 18765.
  const controller = createRelayController({
    request: async () => ({ ok: true, json: async () => ({ app: 'line-relay-bridge', ...relay.state }) }),
  });
  const sanitized = await controller.status();
  assert.equal(sanitized.routes[0].quarantined, 1);
  assert.equal(sanitized.routes[0].quarantinedSinceStart, 1);
  assert.deepEqual(sanitized.routes[0].quarantineIds, ['m1']);
  assert.deepEqual(sanitized.routes[0].failures, { rejected: 1, rate_limit: 1, unsent: 1 });

  // Contract check: healthEvents sees route_quarantined AFTER controller sanitization.
  const events = healthEvents({ relay: sanitized });
  assert.ok(events.some(e => e.kind === 'route_quarantined' && e.ids.includes('m1')));

  const diag = safeDiagnostics(sanitized, true);
  assert.equal(diag.routes[0].quarantined, 1);
  assert.deepEqual(diag.routes[0].failures, { rejected: 1, rate_limit: 1, unsent: 1 });
  assert.match(diag.commit, /^[a-f0-9]{7,40}$/);

  // Local rotating failure log distinguishes 429, unsent and rejected with elapsedMs, without message text.
  const failureLog = (await readFile(path.join(directory, 'lineport-failures.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(failureLog.map(r => r.failure), ['rejected', 'rate_limit', 'unsent']);
  assert.ok(failureLog.every(r => Number.isSafeInteger(r.elapsedMs) && r.elapsedMs >= 0));
  assert.ok(!JSON.stringify(failureLog).includes('壞格式') && !JSON.stringify(failureLog).includes('限流測試'));
});

test('LP-X-02 & LP-X-03 & LP-X-04: relay_down after 3 stopped/unavailable checks, daily alive summary, local alert log, and destination isolation guard', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'lineport-lpx02-'));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const windowsShown = [], remoteSent = [];
  let remoteFailedOnce = false;
  let clock = Date.parse('2026-11-27T08:50:00+08:00');
  const localChannel = localLogAlertChannel(directory);
  const monitor = createHealthMonitor({
    dataDirectory: directory,
    now: () => clock,
    channels: [
      localChannel,
      { name: 'windows', enabled: async () => true, send: async (_text, event) => { windowsShown.push(event.kind); } },
      { name: 'remote', enabled: async () => true, send: async (text, event) => { if (event.kind === 'relay_down' && !remoteFailedOnce) { remoteFailedOnce = true; throw new Error('network down'); } remoteSent.push({ kind: event.kind, text }); } },
    ],
  });

  // 1 & 2 consecutive unavailable checks while relayWanted=true do not fire relay_down yet.
  await monitor.check({ relay: { phase: 'unavailable' }, relayWanted: true });
  await monitor.check({ relay: { phase: 'stopped' }, relayWanted: true });
  assert.equal(windowsShown.includes('relay_down'), false);

  // 3rd consecutive check fires relay_down; failed remote attempt is recorded with ok:false, next check retries and logs ok:true.
  await monitor.check({ relay: { phase: 'unavailable' }, relayWanted: true });
  assert.ok(windowsShown.includes('relay_down'));
  await monitor.check({ relay: { phase: 'unavailable' }, relayWanted: true });
  assert.ok(remoteSent.some(item => item.kind === 'relay_down'));

  // Daily summary fires once after 09:00 Asia/Taipei when healthy, acting as positive liveness signal.
  clock = Date.parse('2026-11-27T09:05:00+08:00');
  const healthy = {
    relay: { phase: 'running', forwarded: 12, routes: [{ key: 'r1', name: 'Route 1', phase: 'running', stage: 'waiting', forwarded: 12, pending: 0, lastSend: '2026-11-27T00:55:00.000Z' }] },
    relayWanted: true,
    dailySummary: true,
    dailySummaryHour: 9,
  };
  await monitor.check(healthy);
  await monitor.check(healthy);
  assert.equal(remoteSent.filter(item => item.kind === 'daily_summary').length, 1);
  assert.match(remoteSent.find(item => item.kind === 'daily_summary').text, /每日存活摘要/);

  // Local alert log records both failed and succeeded attempts without sensitive text.
  const alertRows = (await readFile(path.join(directory, 'lineport-alerts.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(alertRows.some(row => row.channel === 'remote' && row.kind === 'relay_down' && row.ok === false));
  assert.ok(alertRows.some(row => row.channel === 'remote' && row.kind === 'relay_down' && row.ok === true));
  assert.ok(alertRows.some(row => row.kind === 'daily_summary' && row.ok === true));

  // LP-X-04 guard: API and channel reject sending alerts to a monitored destination topic or sharing the monitored Bot.
  const store = createSettingsStore(directory);
  await store.save(normalizeConfig({
    version: 1,
    rules: [{ id: 'r1', name: 'R1', enabled: true, sources: [endpoint('line', 'cs')], destinations: [endpoint('telegram', '-100999', { threadId: 12345 })] }],
  }));
  await store.saveTelegram('123456:MONITORED_RELAY_BOT_TOKEN_123456');

  const service = Object.assign(new EventEmitter(), { resumeSession: async () => true, client: { getAllChatMids: async () => ({ memberChats: [] }), getChats: async () => [] } });
  const server = createProbeServer({ service, token: 'tok', settingsStore: store, relayController: { status: async () => ({ phase: 'running' }) } });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const port = server.address().port;
  const postAlert = body => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: '/api/health-alert', method: 'POST', headers: { Host: '127.0.0.1:18765', 'X-Probe-Token': 'tok', 'Content-Type': 'application/json' } },
      res => { const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() })); });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });

  // Same chat/topic as monitored route -> rejected (400).
  const sameDest = await postAlert({ enabled: true, telegramChatId: '-100999', telegramThreadId: 12345, alertBotToken: '999999:DEDICATED_ALERT_BOT_TOKEN_123456' });
  assert.equal(sameDest.status, 400);

  // Different chat, but reusing the same Bot as the monitored Telegram route without a dedicated alert bot -> rejected (400).
  const sameBot = await postAlert({ enabled: true, telegramChatId: '888888' });
  assert.equal(sameBot.status, 400);

  // Dedicated alert bot + independent chat -> accepted (200), and channel uses the dedicated bot token.
  const usedTokens = [];
  const independent = await postAlert({ enabled: true, telegramChatId: '888888', alertBotToken: '999999:DEDICATED_ALERT_BOT_TOKEN_123456' });
  assert.equal(independent.status, 200);
  const tgChannel = telegramAlertChannel(store, tok => ({ send: async () => { usedTokens.push(tok); return { id: '888888:1' }; } }));
  assert.equal(await tgChannel.enabled(), true);
  await tgChannel.send('test');
  assert.deepEqual(usedTokens, ['999999:DEDICATED_ALERT_BOT_TOKEN_123456']);
});

test('LP-X-02 watchdog: stops a hung (unavailable x2) relay before restarting it', { skip: process.platform !== 'win32' }, async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'lineport-wd-hung-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(path.join(home, 'autostart.json'), JSON.stringify({ service: true, relay: true }));
  await writeFile(path.join(home, 'relay-intent.json'), JSON.stringify({ desired: 'running' }));
  await writeFile(path.join(home, 'autostart-relay.ps1'), '# synthetic');
  const stopScript = path.join(home, 'mock-stop-relay.ps1');
  await writeFile(stopScript, '# synthetic stop');

  const tok = 'c'.repeat(64);
  const ui = http.createServer((req, res) => {
    if (req.url === '/') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(`<title>LinePort</title><script>const token='${tok}';</script>`); return; }
    if (req.url === '/api/diagnostics' && req.headers['x-probe-token'] === tok) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ phase: 'unavailable' })); return; }
    res.writeHead(403); res.end();
  });
  ui.listen(0, '127.0.0.1'); await once(ui, 'listening');
  t.after(() => new Promise(resolve => ui.close(resolve)));
  const baseUrl = `http://127.0.0.1:${ui.address().port}`;
  const runWd = () => new Promise(resolve => execFile(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'watchdog.ps1'),
    '-LinePortHome', home, '-BaseUrl', baseUrl, '-StopRelayScript', stopScript, '-DryRun'], { windowsHide: true, timeout: 30000 },
    (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr })));

  // First unavailable check records streak 1 and waits.
  assert.equal((await runWd()).code, 0);
  const log1 = (await readFile(path.join(home, 'watchdog.log'), 'utf8')).replace(/^\uFEFF/, '');
  assert.match(log1, /unavailable.*1\/2/i);
  assert.doesNotMatch(log1, /would start autostart-relay/);

  // Second consecutive unavailable check stops the hung relay first, then starts autostart-relay.ps1.
  assert.equal((await runWd()).code, 0);
  const log2 = (await readFile(path.join(home, 'watchdog.log'), 'utf8')).replace(/^\uFEFF/, '');
  assert.match(log2, /\[dry-run\] would stop hung relay/);
  assert.match(log2, /\[dry-run\] would start autostart-relay\.ps1/);
});
