// Review 2026-11-27 P1-2 / P1-3: the health monitor must not keep reporting a watchdog circuit that a
// healthy relay has already closed, and must alert when a destination stays unreachable.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { normalizeConfig } from './route-config.mjs';
import { createMultiRelay } from './multi-relay.mjs';
import { createRelayController } from './relay-controller.mjs';
import { createHealthMonitor, healthEvents } from './health-alert.mjs';
import { TelegramUnsent } from './telegram.mjs';

const HOUR = 3600000;
const endpoint = (platform, id) => ({ platform, id, name: id });
const recorder = () => {
  const sent = [];
  return { sent, kinds: () => sent.map(item => item.kind), channel: { name: 'remote', enabled: async () => true, send: async (text, event) => { sent.push({ kind: event.kind, text }); } } };
};
const healthyRelay = { phase: 'running', routes: [{ key: 'r1', name: '公告', phase: 'running', stage: 'waiting', forwarded: 3, pending: 0 }] };

test('P1-2: a circuit stamp left behind after the relay is healthy is not reported every 6 hours', async () => {
  let clock = Date.parse('2026-11-27T10:00:00+08:00');
  const remote = recorder();
  const monitor = createHealthMonitor({ now: () => clock, channels: [remote.channel] });
  const stale = new Date(clock - HOUR).toISOString();
  for (let hour = 0; hour < 72; hour++, clock += HOUR) await monitor.check({ relay: healthyRelay, relayWanted: true, watchdogCircuitAt: stale });
  assert.deepEqual(remote.kinds().filter(kind => kind === 'watchdog_circuit_open'), []);
});

test('P1-2: circuit opens while the relay is down, then the relay recovers: recovery is announced and the stale stamp stays quiet', async () => {
  let clock = Date.parse('2026-11-27T10:00:00+08:00');
  const remote = recorder();
  const monitor = createHealthMonitor({ now: () => clock, channels: [remote.channel] });
  const stamp = new Date(clock).toISOString();
  await monitor.check({ relay: { phase: 'stopped' }, relayWanted: true, watchdogCircuitAt: stamp });
  assert.ok(remote.kinds().includes('watchdog_circuit_open'), 'open circuit with the relay down is alerted');
  clock += 10 * 60000;
  // Fixed by hand; the watchdog has not run yet, so its state file still carries the stamp.
  await monitor.check({ relay: healthyRelay, relayWanted: true, watchdogCircuitAt: stamp });
  assert.equal(remote.kinds().at(-1), 'recovered', 'route recovery must not be suppressed by the stale stamp');
  for (let hour = 0; hour < 24; hour++) { clock += HOUR; await monitor.check({ relay: healthyRelay, relayWanted: true, watchdogCircuitAt: stamp }); }
  assert.equal(remote.kinds().filter(kind => kind === 'watchdog_circuit_open').length, 1);
  // A later relay outage with only the old stamp is not a new circuit; a new stamp is.
  clock += HOUR;
  await monitor.check({ relay: { phase: 'unavailable' }, relayWanted: true, watchdogCircuitAt: stamp });
  assert.equal(remote.kinds().filter(kind => kind === 'watchdog_circuit_open').length, 1);
  await monitor.check({ relay: { phase: 'unavailable' }, relayWanted: true, watchdogCircuitAt: new Date(clock).toISOString() });
  assert.equal(remote.kinds().filter(kind => kind === 'watchdog_circuit_open').length, 2);
});

test('P1-2: unparseable or future circuit stamps are ignored', async () => {
  const clock = Date.parse('2026-11-27T10:00:00+08:00');
  for (const stamp of ['not-a-date', new Date(clock + 2 * HOUR).toISOString()]) {
    const remote = recorder();
    const monitor = createHealthMonitor({ now: () => clock, channels: [remote.channel] });
    await monitor.check({ relay: { phase: 'stopped' }, relayWanted: true, watchdogCircuitAt: stamp });
    assert.deepEqual(remote.kinds().filter(kind => kind === 'watchdog_circuit_open'), [], stamp);
  }
});

test('P1-3: a destination that stays unreachable raises route_unreachable through the real relay status path, then recovery is announced', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'lineport-p13-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = normalizeConfig({ version: 1, rules: [{ id: 'r1', name: '公告', enabled: true, sources: [endpoint('line', 'cs')], destinations: [endpoint('telegram', '-1001')] }] });
  let reachable = false, sends = 0, delivered = 0;
  const adapters = {
    line: { identity: 'line:u', prepare: async () => 'e2ee', recent: async () => [], read: async () => [{ id: 'm1', text: '合成測試訊息', createdTime: 2000, from: 'u1' }], send: async () => ({ id: '1' }) },
    telegram: { identity: 'tg:1', prepare: async () => {}, send: async () => { sends++; if (!reachable) throw Object.assign(new TelegramUnsent(), { code: 'ENOTFOUND' }); delivered++; return { id: `-1001:${sends}` }; } },
  };
  let clock = 1000;
  const relay = await createMultiRelay({ config, adapters, directory, now: () => clock, pause: async () => {} });
  const controller = createRelayController({ request: async () => ({ ok: true, json: async () => ({ app: 'line-relay-bridge', ...relay.state }) }) });
  const remote = recorder();
  const monitor = createHealthMonitor({ now: () => clock, channels: [remote.channel] });

  // Four hours of a blocked destination (e.g. company network) with the relay itself healthy.
  for (let elapsed = 0; elapsed < 4 * HOUR; elapsed += 60000) {
    clock += 60000;
    await relay.tick();
    await monitor.check({ relay: await controller.status(), relayWanted: true });
  }
  assert.ok(sends >= 10, `relay kept retrying (${sends} attempts)`);
  assert.equal(delivered, 0);
  const status = await controller.status();
  assert.ok(status.routes[0].unsentStreak >= 10, 'consecutive unsent attempts are exposed on the route');
  assert.equal(typeof status.routes[0].unsentSince, 'string');
  assert.ok(healthEvents({ relay: status, now: clock }).some(event => event.kind === 'route_unreachable' && event.subject === '公告'));
  assert.equal(remote.kinds().filter(kind => kind === 'route_unreachable').length, 1, 'alerted once within the 6-hour cooldown');
  assert.ok(!remote.sent.some(item => item.text.includes('合成測試訊息')), 'alerts never carry message text');

  reachable = true;
  for (let step = 0; step < 10 && delivered === 0; step++) { clock += 60000; await relay.tick(); }
  assert.equal(delivered, 1);
  const recovered = await controller.status();
  assert.equal(recovered.routes[0].unsentStreak, 0);
  await monitor.check({ relay: recovered, relayWanted: true });
  assert.equal(remote.kinds().at(-1), 'recovered');
});

test('P1-3: a short network blip below the threshold stays quiet', () => {
  const now = Date.parse('2026-11-27T10:00:00Z');
  const route = since => ({ key: 'r1', name: '公告', phase: 'running', stage: 'waiting', pending: 1, unsentStreak: 3, unsentSince: new Date(now - since).toISOString() });
  assert.deepEqual(healthEvents({ relay: { phase: 'degraded', routes: [route(60000)] }, now }).map(event => event.kind), []);
  assert.deepEqual(healthEvents({ relay: { phase: 'degraded', routes: [route(20 * 60000)] }, now }).map(event => event.kind), ['route_unreachable']);
});
