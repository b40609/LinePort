import test from 'node:test';
import assert from 'node:assert/strict';
import { healthEvents, createHealthMonitor, startHealthMonitor, formatAlert, telegramAlertChannel, windowsAlertChannel } from './health-alert.mjs';

const SECRET = 'SYNTHETIC_PRIVATE_TEXT';
const route = (extra = {}) => ({ key: 'r1', name: 'LINE → TG', phase: 'running', stage: 'waiting', uncertain: 0, warning: SECRET, ...extra });
const running = (routes = [route()], extra = {}) => ({ relay: { phase: 'running', routes, sources: [] , ...extra } });
const recorder = (options = {}) => {
  const sent = [];
  const channel = { name: 'test', enabled: async () => options.enabled ?? true,
    send: async (text, event) => { if (options.fail?.()) throw new Error(SECRET); sent.push({ text, kind: event.kind }); } };
  return { sent, channel };
};

test('events cover blocked routes, LINE login, failing sources and storage, without message content', () => {
  const events = healthEvents({
    relay: { phase: 'degraded', routes: [route({ phase: 'blocked', stage: 'send_uncertain', uncertain: 2, uncertainIds: ['m-1', 'm-2'] }), route({ key: 'r2', phase: 'failed', stage: 'platform' }), route({ key: 'r3' })],
      sources: [{ platform: 'line', id: 'cs', name: 'Source A', consecutiveErrors: 5, warning: SECRET }, { platform: 'line', id: 'cx', name: 'X', consecutiveErrors: 4 }] },
    account: { phase: 'connected' }, storage: { blocked: false, warning: '儲存容量接近上限' } });
  assert.deepEqual(events.map(event => event.kind), ['route_uncertain', 'route_failed', 'source_read_failing', 'storage_warning']);
  const text = formatAlert(events[0], Date.UTC(2026, 10, 23, 1, 2, 3));
  assert.match(text, /路線：LINE → TG/);
  assert.match(text, /階段：send_uncertain/);
  assert.match(text, /待核對訊息 ID：m-1, m-2/);
  assert.match(text, /時間：2026-11-23 \d\d:02:03 \(UTC[+-]\d\d:\d\d\)/);
  assert.ok(!events.some(event => JSON.stringify(event).includes(SECRET)));
  assert.deepEqual(healthEvents({ account: { phase: 'login_required' } }).map(event => event.kind), ['line_login_required']);
  // A login loss reported by the relay source is one login event, not an extra read-failure alert.
  assert.deepEqual(healthEvents({ relay: { sources: [{ platform: 'line', id: 'cs', loginRequired: true, consecutiveErrors: 9 }] } }).map(event => event.kind), ['line_login_required']);
  assert.deepEqual(healthEvents({ storage: { blocked: true, warning: 'x' } }).map(event => event.kind), ['storage_blocked']);
  assert.deepEqual(healthEvents({ relay: { phase: 'failed', stage: 'journal', routes: [] } }).map(event => event.kind), ['relay_failed']);
});

test('monitor alerts once per unresolved event, re-alerts on change or cooldown, then sends one recovery', async () => {
  let clock = 0;
  const { sent, channel } = recorder();
  const monitor = createHealthMonitor({ channels: [channel], now: () => clock, cooldownMs: 1000 });
  const blocked = running([route({ phase: 'blocked', stage: 'send_uncertain', uncertain: 1, uncertainIds: ['m-1'] })], { phase: 'degraded' });
  await monitor.check(blocked);
  await monitor.check(blocked);
  assert.equal(sent.length, 1);
  await monitor.check(running([route({ phase: 'blocked', stage: 'send_uncertain', uncertain: 2, uncertainIds: ['m-1', 'm-2'] })], { phase: 'degraded' }));
  assert.equal(sent.length, 2, 'a changed signature re-alerts');
  clock = 1500;
  await monitor.check(running([route({ phase: 'blocked', stage: 'send_uncertain', uncertain: 2, uncertainIds: ['m-1', 'm-2'] })], { phase: 'degraded' }));
  assert.equal(sent.length, 3, 'cooldown elapsed');
  await monitor.check({ relay: { phase: 'stopped', routes: [] } });
  assert.equal(sent.length, 3, 'no recovery while stopped');
  await monitor.check(running());
  await monitor.check(running());
  assert.deepEqual(sent.map(item => item.kind), ['route_uncertain', 'route_uncertain', 'route_uncertain', 'recovered']);
  assert.match(sent.at(-1).text, /已恢復/);
  await monitor.check(running());
  assert.equal(sent.length, 4);
});

test('delivery failures and timeouts are contained and retried on the next check', async () => {
  let failing = true;
  const { sent, channel } = recorder({ fail: () => failing });
  const hanging = { name: 'hang', enabled: async () => true, send: () => new Promise(() => {}) };
  const monitor = createHealthMonitor({ channels: [hanging, channel], sendTimeoutMs: 20 });
  const state = { account: { phase: 'login_required' } };
  assert.deepEqual(await monitor.check(state), []);
  failing = false;
  assert.deepEqual(await monitor.check(state), [{ channel: 'test', kind: 'line_login_required' }]);
  assert.equal(sent.length, 1);
  const broken = createHealthMonitor({ channels: [{ name: 'x', enabled: async () => { throw new Error(SECRET); }, send: async () => {} }] });
  assert.deepEqual(await broken.check(state), []);
});

test('disabled channels send nothing and forget state; the timer survives snapshot errors', async () => {
  let enabled = false;
  const sent = [];
  const monitor = createHealthMonitor({ channels: [{ name: 't', enabled: async () => enabled, send: async text => { sent.push(text); } }] });
  await monitor.check({ account: { phase: 'login_required' } });
  assert.equal(sent.length, 0);
  enabled = true;
  await monitor.check({ account: { phase: 'login_required' } });
  assert.equal(sent.length, 1);
  let calls = 0;
  const stop = startHealthMonitor({ monitor: { check: async () => { calls++; } }, snapshot: async () => { if (calls === 0 && !stop.thrown) { stop.thrown = true; throw new Error('boom'); } return {}; }, intervalMs: 5, delayMs: 1 });
  await new Promise(resolve => setTimeout(resolve, 60));
  stop();
  assert.ok(calls >= 2);
});

test('Telegram channel reuses the saved bot, honours the topic and never stores its own token', async () => {
  const calls = [];
  const store = { healthAlert: async () => ({ enabled: true, telegramChatId: '-1001', telegramThreadId: 77 }), telegramToken: async () => 'tok' };
  const channel = telegramAlertChannel(store, token => ({ send: async (...args) => { calls.push([token, ...args]); return { id: '-1001:1' }; } }));
  assert.equal(await channel.enabled(), true);
  await channel.send('hello');
  assert.deepEqual(calls, [['tok', '-1001', 'hello', { threadId: 77 }]]);
  assert.equal(await telegramAlertChannel({ ...store, telegramToken: async () => '' }, () => ({})).enabled(), false);
  assert.equal(await telegramAlertChannel({ ...store, healthAlert: async () => ({ enabled: false, telegramChatId: '' }) }, () => ({})).enabled(), false);
});

test('Windows channel shows a short title and reports a suppressed notification as undelivered', async () => {
  const shown = [];
  const channel = windowsAlertChannel((title, message, options) => { shown.push({ title, message, options }); return true; }, 'win32');
  await channel.send('ignored', { kind: 'route_failed', title: '路線失敗停止', subject: 'R' });
  assert.deepEqual(shown[0], { title: 'LinePort 健康告警', message: '路線失敗停止：R', options: { throttleMs: 0, icon: 'Warning' } });
  await assert.rejects(windowsAlertChannel(() => false, 'win32').send('x', { kind: 'recovered', title: 't' }));
  assert.equal(await windowsAlertChannel(() => true, 'linux').enabled(), false);
});
