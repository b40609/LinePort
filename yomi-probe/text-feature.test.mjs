import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createMultiRelay } from './multi-relay.mjs';
import { normalizeConfig } from './route-config.mjs';

const fixture = () => mkdtemp(path.join(os.tmpdir(), 'lineport-feature-'));
const endpoint = (platform, id, name = id) => ({ platform, id, name });
const message = (id, text, sender = 'u123', createdTime = 1700000000000) => ({ id, text, from: sender, createdTime });

test('P1 feature: AND keyword matching filters accurately', async () => {
  const directory = await fixture();
  const sent = [];
  const telegram = {
    identity: 'tg:bot',
    prepare: async () => {},
    send: async (id, text) => {
      sent.push({ id, text });
      return { id: `out-${sent.length}` };
    },
  };
  const line = {
    identity: 'line:self',
    recent: async () => [],
    read: async () => [
      message('m1', '台積電 2330 今日買進加碼'),
      message('m2', '2330 今日觀望不動作'),
      message('m3', '聯發科 2454 買進進場'),
    ],
  };
  const config = normalizeConfig({
    version: 1,
    rules: [{
      id: 'stock-filter',
      name: '台積電買進專區',
      enabled: true,
      sources: [endpoint('line', 'csource', '股票討論群')],
      destinations: [endpoint('telegram', '-100999')],
      include: ['2330 + 買進'],
      exclude: [],
      prefix: '[訊號] ',
    }],
  });
  const relay = await createMultiRelay({ config, adapters: { line, telegram }, directory, now: () => 1700000000000, pause: async () => {} });
  await relay.tick();
  assert.equal(relay.state.forwarded, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, '[訊號] 台積電 2330 今日買進加碼');
});

test('P1 feature: dynamic templating interpolates source and sender alias', async () => {
  const directory = await fixture();
  const sent = [];
  const telegram = {
    identity: 'tg:bot',
    prepare: async () => {},
    send: async (id, text) => {
      sent.push({ id, text });
      return { id: `out-${sent.length}` };
    },
  };
  const line = {
    identity: 'line:self',
    recent: async () => [],
    read: async () => [
      message('m10', '聯發科突破壓力', 'u999', 1700000000000),
    ],
  };
  const config = normalizeConfig({
    version: 1,
    rules: [{
      id: 'template-rule',
      name: '自訂模版',
      enabled: true,
      sources: [endpoint('line', 'csource', '劣勢資本')],
      destinations: [endpoint('telegram', '-100999')],
      senderAllowlist: { 'line:csource': ['u999'] },
      senderAliases: { 'line:csource': { u999: '土88' } },
      include: [],
      exclude: [],
      prefix: '[{source} / {sender}] ',
    }],
  });
  const relay = await createMultiRelay({ config, adapters: { line, telegram }, directory, now: () => 1700000000000, pause: async () => {} });
  await relay.tick();
  assert.equal(relay.state.forwarded, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, '[劣勢資本 / 土88] 聯發科突破壓力');
});
