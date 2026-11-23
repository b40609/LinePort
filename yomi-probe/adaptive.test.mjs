import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { normalizeConfig } from './route-config.mjs';
import { createMultiRelay } from './multi-relay.mjs';
import { contentFingerprint, createDedupeWindow } from './content-dedupe.mjs';

const directory = () => mkdtemp(path.join(os.tmpdir(), 'lineport-adaptive-'));
const endpoint = (platform, id) => ({ platform, id, name: id });
// 2026-11-23 12:00 Asia/Taipei
const NOON = Date.parse('2026-11-23T12:00:00+08:00');

async function lineRelay({ schedule, start = NOON } = {}) {
  let clock = start, messages = [];
  const line = { identity: 'line', recent: async () => [], prepare: async () => 'e2ee', read: async () => messages, send: async () => ({ id: '1' }) };
  const telegram = { identity: 'tg', prepare: async () => {}, send: async (id) => ({ id: `${id}:1` }) };
  const config = normalizeConfig({ version: 1, rules: [{ id: 'r', name: 'r', enabled: true, sources: [endpoint('line', 'csource')], destinations: [endpoint('telegram', '-2')], ...(schedule ? { schedule } : {}) }] });
  const relay = await createMultiRelay({ config, adapters: { line, telegram }, directory: await directory(), now: () => clock, pause: async () => {} });
  return { relay, key: 'line:csource', tick: () => relay.tick(), advance: ms => { clock += ms; }, push: (id, text) => { messages = [...messages, { id, text, createdTime: clock, from: 'u1' }]; } };
}

test('LINE polling stays at 3 s while active and slows to 10 s, then 15 s, when idle', async () => {
  const f = await lineRelay();
  assert.equal(f.relay.pollDelay(f.key), 3000);
  f.advance(9 * 60000); await f.tick(); assert.equal(f.relay.pollDelay(f.key), 3000);
  f.advance(2 * 60000); await f.tick(); assert.equal(f.relay.pollDelay(f.key), 10000);
  f.advance(25 * 60000); await f.tick(); assert.equal(f.relay.pollDelay(f.key), 15000);
  // A new message switches straight back to 3 s.
  f.push('m1', '通知'); await f.tick(); assert.equal(f.relay.pollDelay(f.key), 3000);
  assert.equal(f.relay.state.sources[0].pollIntervalMs, 3000);
});

test('LINE polling drops to 30 s at night or when every rule is outside its schedule', async () => {
  const night = await lineRelay({ start: Date.parse('2026-11-23T02:00:00+08:00') });
  night.advance(11 * 60000); await night.tick(); assert.equal(night.relay.pollDelay(night.key), 30000);
  const schedule = { timezone: 'Asia/Taipei', days: [1, 2, 3, 4, 5], start: 540, end: 600, outside: 'hold' };
  const outside = await lineRelay({ schedule });
  outside.advance(11 * 60000); await outside.tick(); assert.equal(outside.relay.pollDelay(outside.key), 30000);
  outside.push('m1', '通知'); await outside.tick(); assert.equal(outside.relay.pollDelay(outside.key), 3000);
});

test('fingerprints ignore case, width, whitespace, punctuation and symbols', () => {
  assert.equal(contentFingerprint('【公告】明天停班！'), contentFingerprint('公告 明天停班'));
  assert.equal(contentFingerprint('ＡＢＣ 123'), contentFingerprint('abc123'));
  assert.notEqual(contentFingerprint('明天停班'), contentFingerprint('明天上班'));
  assert.equal(contentFingerprint('  ！！ '), '');
  const window = createDedupeWindow({ maxEntries: 2 });
  assert.equal(window.duplicate('d', 'a', 0, 1000), false); assert.equal(window.duplicate('d', 'A!', 500, 1000), true);
  assert.equal(window.duplicate('d', 'a', 2000, 1000), false); assert.equal(window.duplicate('other', 'a', 2000, 1000), false);
  window.duplicate('d', 'b', 2000, 1000); window.duplicate('d', 'c', 2000, 1000);
  assert.equal(window.duplicate('d', 'a', 2100, 1000), false, 'oldest entries are evicted first');
});

test('opt-in dedupe forwards the first copy per destination and records the rest as skipped', async () => {
  const sent = [], at = 5000;
  const messagesA = [{ id: 'a1', text: '【公告】明天停班！', createdTime: at, from: 'u1' }, { id: 'a2', text: '另一則', createdTime: at + 1, from: 'u1' }];
  const messagesB = [{ id: 'b1', text: '公告 明天停班', createdTime: at + 60000, from: 'u2' }, { id: 'b2', text: '公告 明天停班', createdTime: at + 20 * 60000, from: 'u2' }];
  const line = { identity: 'line', recent: async () => [], prepare: async () => 'e2ee', read: async id => id === 'csourcea' ? messagesA : messagesB, send: async () => ({ id: '1' }) };
  const telegram = { identity: 'tg', prepare: async () => {}, send: async (id, text) => { sent.push([id, text]); return { id: `${id}:${sent.length}` }; } };
  const rule = (extra = {}) => ({ id: 'r', name: 'r', enabled: true, sources: [endpoint('line', 'csourcea'), endpoint('line', 'csourceb')], destinations: [endpoint('telegram', '-2')], ...extra });
  const relay = await createMultiRelay({ config: normalizeConfig({ version: 1, rules: [rule({ dedupe: { windowMinutes: 10 } })] }), adapters: { line, telegram }, directory: await directory(), now: () => 1000, pause: async () => {}, deliveryBudget: 20 });
  await relay.tick();
  assert.deepEqual(sent.map(row => row[1]).sort(), ['【公告】明天停班！', '公告 明天停班', '另一則'].sort());
  assert.equal(relay.state.routes.reduce((sum, route) => sum + route.deduplicated, 0), 1);
  // Off by default, and invalid windows are rejected.
  assert.equal(normalizeConfig({ version: 1, rules: [rule()] }).rules[0].dedupe, undefined);
  for (const windowMinutes of [0, 1441, 1.5, '10']) assert.throws(() => normalizeConfig({ version: 1, rules: [rule({ dedupe: { windowMinutes } })] }), /時間窗/);
});
