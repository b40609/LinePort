import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { normalizeConfig } from './route-config.mjs';
import { createMultiRelay } from './multi-relay.mjs';
import { previewRules } from './user-tools.mjs';

const endpoint = (platform, id) => ({ platform, id, name: id });
const sources = [endpoint('line', 'canalysts'), endpoint('telegram', '-1001'), endpoint('telegram', '-1002')];
const destinations = [endpoint('line', 'creaders1'), endpoint('line', 'creaders2'), endpoint('telegram', '-2001'), endpoint('telegram', '-2002')];
const keywords = ['進場', '買進', '賣出', '停損', '停利', '續抱', '加碼', '減碼', '出場'];
const value = () => normalizeConfig({ version: 1, rules: sources.map((source, index) => ({
  id: 'call' + index, name: 'Call ' + index, enabled: true, sources: [source], destinations,
  senderAllowlist: { [source.platform + ':' + source.id]: source.platform === 'line' ? ['uanalyst1', 'uanalyst2', 'uanalyst3'] : ['123'] },
  include: keywords, exclude: [], prefix: '[來源' + index + '] ',
})) });

test('three analyst sources fan out to four mixed destinations and restart preserves successful pairs', async () => {
  const deliveries = [], reads = [];
  const directory = await mkdtemp(path.join(os.tmpdir(), 'lineport-call-routing-'));
  const adapter = platform => ({
    identity: 'synthetic-' + platform, recent: async () => [], prepare: async () => {},
    read: async id => {
      reads.push(platform + ':' + id);
      const analyst = platform === 'line' ? 'uanalyst1' : '123';
      const row = (suffix, from, text) => ({ id: id + ':' + suffix, from, text, createdTime: 1100 });
      return [row('call', analyst, '進場 100，停損 95，謝謝'), row('hold', analyst, '續抱'),
        row('stranger', platform === 'line' ? 'ubystander' : '456', '進場 100，停損 95'), row('greeting', analyst, '你好，謝謝'),
        row('image', analyst, '')];
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
    assert.ok(received.every(row => row.text.includes('進場') || row.text.endsWith('續抱')));
  }
  const restarted = await createMultiRelay(options);
  await restarted.tick();
  assert.equal(deliveries.length, 24);
  assert.ok(restarted.state.routes.every(route => route.pending === 0 && route.uncertain === 0));
});

test('mixed destinations preview explicitly reports caption only and rejects media enablement', () => {
  const config = value();
  const result = previewRules({ config, source: 'telegram:-1001', sender: '123', text: '進場 100',
    timestamp: 1100, media: { kind: 'photo', fileSize: 1000000 } }).results[0];
  assert.equal(result.destinations.filter(row => row.eligible).length, 4);
  assert.equal(result.contentKind, 'text');
  assert.match(result.summary, /只轉送說明文字，不含附件/);
  const blank = previewRules({ config, source: 'telegram:-1001', sender: '123', text: '', timestamp: 1100,
    media: { kind: 'photo', fileSize: 1000000 } }).results[0];
  assert.ok(blank.destinations.every(row => !row.eligible));
  assert.throws(() => normalizeConfig({ ...config, rules: config.rules.map(rule => ({ ...rule, media: true })) }), /純 Telegram|Telegram → Telegram/);
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
  assert.match(text, /LINE 圖片尚未支援/);
  assert.match(vm.runInContext('coverageText(sources,destinations,true)', context), /另建純 Telegram 規則/);
  assert.match(vm.runInContext('coverageText([],[],false)', context), /先選來源與目的/);
});
