import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { normalizeConfig } from './route-config.mjs';
import { createMultiRelay } from './multi-relay.mjs';
import { previewRules } from './user-tools.mjs';
import { TelegramRateLimit } from './telegram.mjs';

const endpoint = (platform, id) => ({ platform, id, name: id });
const sources = [endpoint('line', 'csenders'), endpoint('telegram', '-1001'), endpoint('telegram', '-1002')];
const destinations = [endpoint('line', 'creaders1'), endpoint('line', 'creaders2'), endpoint('telegram', '-2001'), endpoint('telegram', '-2002')];
const keywords = ['公告', '通知', '變更', '更新', '完成', '提醒', '新增', '調整', '結束'];
const value = () => normalizeConfig({ version: 1, rules: sources.map((source, index) => ({
  id: 'call' + index, name: '通知 ' + index, enabled: true, sources: [source], destinations,
  senderAllowlist: { [source.platform + ':' + source.id]: source.platform === 'line' ? ['usender1', 'usender2', 'usender3'] : ['123'] },
  include: keywords, exclude: [], prefix: '[來源' + index + '] ',
})) });

test('twelve pairs isolate LINE uncertainty, persist Telegram cooldown, and recover while sources are offline', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'lineport-isolation-'));
  const calls = [], accepted = [], config = value();
  let clock = 1000, limited = false, uncertain = false, offline = false;
  const adapter = platform => ({ identity: 'synthetic-' + platform, prepare: async () => {}, recent: async () => [],
    read: async id => { if (offline) throw new Error('synthetic disconnected');
      return [{ id: id + ':notice', from: platform === 'line' ? 'usender1' : '123', text: '公告', createdTime: 1100 }]; },
    send: async (id, text) => {
      calls.push([platform, id, text]);
      if (platform === 'telegram' && !limited) { limited = true; throw new TelegramRateLimit(5); }
      if (platform === 'line' && id === 'creaders1' && !uncertain) { uncertain = true; throw new Error('synthetic lost acknowledgement'); }
      accepted.push([platform, id, text]); return { id: 'synthetic-output-' + accepted.length };
    } });
  const options = { config, adapters: { line: adapter('line'), telegram: adapter('telegram') }, directory, now: () => clock, pause: async () => {} };
  const relay = await createMultiRelay(options); await relay.tick();
  assert.equal(relay.state.routes.filter(route => route.phase === 'blocked').length, 1);
  assert.equal(accepted.filter(row => row[0] === 'line').length, 5);
  // Another destination may already be in flight when the first 429 arrives.
  const acceptedBeforeRestart = accepted.length;
  const attemptsBeforeRestart = calls.filter(row => row[0] === 'telegram').length;
  assert.ok(attemptsBeforeRestart <= 2);
  const blockedText = calls.find(row => row[0] === 'line' && row[1] === 'creaders1')[2];
  offline = true;
  const restarted = await createMultiRelay(options); await restarted.tick();
  assert.equal(calls.filter(row => row[0] === 'telegram').length, attemptsBeforeRestart);
  assert.equal(accepted.length, acceptedBeforeRestart);
  clock = 6000; await restarted.tick();
  assert.equal(accepted.filter(row => row[0] === 'telegram').length, 6);
  assert.equal(calls.filter(row => row[0] === 'line' && row[1] === 'creaders1' && row[2] === blockedText).length, 1);
  assert.equal(new Set(accepted.map(row => JSON.stringify(row))).size, 11);
  await restarted.tick(); assert.equal(accepted.length, 11);
  assert.equal(restarted.state.routes.filter(route => route.phase === 'blocked').length, 1);
});

test('three sender sources fan out to four mixed destinations and restart preserves successful pairs', async () => {
  const deliveries = [], reads = [];
  const directory = await mkdtemp(path.join(os.tmpdir(), 'lineport-call-routing-'));
  const adapter = platform => ({
    identity: 'synthetic-' + platform, recent: async () => [], prepare: async () => {},
    read: async id => {
      reads.push(platform + ':' + id);
      const sender = platform === 'line' ? 'usender1' : '123';
      const row = (suffix, from, text) => ({ id: id + ':' + suffix, from, text, createdTime: 1100 });
      return [row('call', sender, '公告 100，更新 95，謝謝'), row('hold', sender, '提醒'),
        row('stranger', platform === 'line' ? 'ubystander' : '456', '公告 100，更新 95'), row('greeting', sender, '你好，謝謝'),
        row('image', sender, '')];
    },
    send: async (id, text) => { deliveries.push({ platform, id, text }); return { id: String(10000 + deliveries.length) }; },
  });
  const options = { config: value(), adapters: { line: adapter('line'), telegram: adapter('telegram') },
    directory, now: () => 1000, pause: async () => {}, deliveryBudget: 30 };
  const relay = await createMultiRelay(options);
  assert.equal(relay.state.routes.length, 12);
  await relay.tick();
  assert.equal(reads.length, 3);
  assert.equal(deliveries.length, 24);
  for (const destination of destinations) {
    const received = deliveries.filter(row => row.platform === destination.platform && row.id === destination.id);
    assert.equal(received.length, 6);
    for (let i = 0; i < 3; i++) assert.equal(received.filter(row => row.text.startsWith('[來源' + i + '] ')).length, 2);
    assert.ok(received.every(row => row.text.includes('公告') || row.text.endsWith('提醒')));
  }
  const restarted = await createMultiRelay(options);
  await restarted.tick();
  assert.equal(deliveries.length, 24);
  assert.ok(restarted.state.routes.every(route => route.pending === 0 && route.uncertain === 0));
});

test('sender and exclusion filters survive a stopped interval and restart across mixed destinations', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'lineport-filter-restart-'));
  const deliveries = [], messages = new Map();
  const settings = normalizeConfig({ version: 1, rules: sources.map((source, index) => ({
    id: 'notice-' + index, name: '通知 ' + index, enabled: true, sources: [source], destinations,
    senderAllowlist: { [source.platform + ':' + source.id]: [source.platform === 'line' ? 'usender1' : '123'] },
    include: ['通知'], exclude: ['忽略'], prefix: '[來源' + index + '] ',
  })) });
  const allowed = source => source.platform === 'line' ? 'usender1' : '123';
  const other = source => source.platform === 'line' ? 'ubystander' : '456';
  const key = source => source.platform + ':' + source.id;
  const row = (source, id, from, text, createdTime) => ({ id: key(source) + ':' + id, from, text, createdTime });
  for (const source of sources) messages.set(key(source), [
    row(source, 'first', allowed(source), '通知 A', 1100),
    row(source, 'same-text-new-id', allowed(source), '通知 A', 1101),
    row(source, 'excluded', allowed(source), '通知 A 忽略', 1102),
    row(source, 'bystander', other(source), '通知 A', 1103),
    row(source, 'greeting', allowed(source), '你好，謝謝', 1104),
  ]);
  const adapter = platform => ({
    identity: 'synthetic-' + platform, prepare: async () => {}, recent: async () => [],
    read: async id => messages.get(platform + ':' + id) || [],
    send: async (id, text) => {
      deliveries.push({ platform, id, text });
      return { id: 'synthetic-ack-' + deliveries.length };
    },
  });
  let clock = 1000;
  const options = { config: settings, adapters: { line: adapter('line'), telegram: adapter('telegram') },
    directory, now: () => clock, pause: async () => {}, deliveryBudget: 40 };
  const started = await createMultiRelay(options);
  clock = 1200;
  await started.tick();
  assert.equal(started.state.routes.length, 12);
  assert.equal(deliveries.length, 24);
  assert.ok(started.state.routes.every(route => route.skipped === 3 && route.pending === 0));

  // Simulate stopping the worker: new source messages arrive without another tick.
  for (const source of sources) messages.get(key(source)).push(
    row(source, 'while-stopped', allowed(source), '通知 B', 2100),
    row(source, 'excluded-while-stopped', allowed(source), '通知 B 忽略', 2101),
  );
  clock = 2200;
  const restarted = await createMultiRelay(options);
  await restarted.tick();
  assert.equal(deliveries.length, 36);
  await restarted.tick();
  assert.equal(deliveries.length, 36);
  for (const destination of destinations) {
    const received = deliveries.filter(item => item.platform === destination.platform && item.id === destination.id);
    assert.equal(received.length, 9);
    for (let index = 0; index < sources.length; index++) {
      const matching = received.filter(item => item.text.startsWith('[來源' + index + '] '));
      assert.deepEqual(matching.map(item => item.text), [
        '[來源' + index + '] 通知 A', '[來源' + index + '] 通知 A', '[來源' + index + '] 通知 B',
      ]);
    }
    assert.ok(received.every(item => !item.text.includes('忽略') && !item.text.includes('你好')));
  }
  assert.ok(restarted.state.routes.every(route => route.skipped === 1 && route.pending === 0 && route.uncertain === 0));
});

test('mixed destinations preview explicitly reports caption only and rejects media enablement', () => {
  const config = value();
  const result = previewRules({ config, source: 'telegram:-1001', sender: '123', text: '公告 100',
    timestamp: 1100, media: { kind: 'photo', fileSize: 1000000 } }).results[0];
  assert.equal(result.destinations.filter(row => row.eligible).length, 4);
  assert.equal(result.contentKind, 'text');
  assert.match(result.summary, /只轉送說明文字，不含附件/);
  const blank = previewRules({ config, source: 'telegram:-1001', sender: '123', text: '', timestamp: 1100,
    media: { kind: 'photo', fileSize: 1000000 } }).results[0];
  assert.ok(blank.destinations.every(row => !row.eligible));
  assert.throws(() => normalizeConfig({ ...config, rules: config.rules.map(rule => ({ ...rule, media: true })) }), /Telegram 來源/);
});

test('selection coverage explains twelve pairs and media limitations without changing editor options', async () => {
  const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');
  const source = html.match(/function coverageText\(sources,destinations,media\)\{.*?\}\r?\n/)[0];
  const context = vm.createContext({});
  vm.runInContext(source, context);
  context.sources = sources;
  context.destinations = destinations;
  const text = vm.runInContext('coverageText(sources,destinations,false)', context);
  assert.match(text, /3 個來源 → 4 個目的，共 12 組配對/);
  assert.match(text, /圖片／檔案本身不會送達/);
  assert.match(text, /LINE 來源圖片尚未支援/);
  assert.match(vm.runInContext('coverageText(sources,destinations,true)', context), /LINE 來源尚未支援/);
  assert.match(vm.runInContext('coverageText([],[],false)', context), /先選來源與目的/);
});
