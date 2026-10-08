import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter, once } from 'node:events';
import { createProbeServer } from './server.mjs';
import { configRevision } from './route-config.mjs';

async function setup(t) {
  let config = { version: 1, rules: [] }, token = '', phase = 'stopped';
  const starts = [];
  const service = Object.assign(new EventEmitter(), { resumeSession: async () => true, getRecentMessages: async () => [],
    client: { getAllChatMids: async () => ({ memberChats: ['c1'] }), getChats: async () => [{ chatMid: 'c1', chatName: '同名' }],
      getAllContactIds: async () => ['u1'], getContacts: async () => [{ mid: 'u1', displayName: '同名' }] } });
  const settingsStore = { load: async () => config, save: async value => { config = value; }, telegramToken: async () => token, saveTelegram: async value => { token = value; } };
  const relayController = { status: async () => ({ phase }), startRules: async revision => { starts.push(revision); }, stop: async () => { phase = 'stopped'; } };
  const telegramFactory = () => ({ getMe: async () => ({ username: 'synthetic_bot' }), getChat: async id => ({ id: Number(id), title: '測試 TG', type: 'supergroup' }),
    getUpdates: async () => [{ update_id: 1, message: { chat: { id: -1, title: '測試 TG' }, text: 'SYNTHETIC_PRIVATE_MESSAGE' } }] });
  const server = createProbeServer({ service, settingsStore, relayController, telegramFactory, token: 'synthetic-local-token' });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const call = (route, data) => new Promise((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port: server.address().port, path: '/api/'+route, method: data === undefined ? 'GET' : 'POST',
      headers: { Host: '127.0.0.1:18765', 'X-Probe-Token': 'synthetic-local-token', 'Content-Type': 'application/json' } }, response => {
      let body = ''; response.on('data', chunk => { body += chunk; }); response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(body) }));
    });
    request.on('error', reject); request.end(data === undefined ? undefined : JSON.stringify(data));
  });
  return { call, starts, setPhase: value => { phase = value; } };
}
const endpoint = (id, platform = 'line') => ({ id, platform, name: '同名' });
const config = (platform = 'line') => ({ version: 1, rules: [{ id: 'rule', name: '同名群組測試', enabled: true,
  sources: [endpoint(platform === 'line' ? 'c1' : '-1', platform)], destinations: [endpoint(platform === 'line' ? 'u1' : '-2', platform)] }] });

test('saved rules accept duplicate display names and dispatch a revision instead of names', async t => {
  const { call, starts } = await setup(t);
  assert.equal((await call('resume', {})).status, 200);
  assert.equal((await call('directory', {})).body.endpoints.length, 2);
  const saved = await call('rules', config());
  assert.equal(saved.status, 200);
  assert.equal((await call('relay/start', { useRules: true })).status, 202);
  assert.deepEqual(starts, [configRevision(saved.body.config)]);
});

test('Telegram-only rules do not require LINE login and stored tokens never return in APIs', async t => {
  const { call, starts } = await setup(t);
  const secret = 'SYNTHETIC_TELEGRAM_SECRET';
  assert.equal((await call('telegram/connect', { token: secret })).status, 200);
  const result = await call('rules');
  assert.equal(result.body.telegramConfigured, true);
  assert.ok(!JSON.stringify(result).includes(secret));
  assert.equal((await call('rules', config('telegram'))).status, 200);
  assert.equal((await call('relay/start', { useRules: true })).status, 202);
  assert.equal(starts.length, 1);
});

test('active or unknown relays block settings, credentials and discovery changes', async t => {
  const { call, setPhase } = await setup(t);
  for (const phase of ['running', 'degraded', 'starting', 'failed', 'unavailable', 'legacy']) {
    setPhase(phase);
    for (const [route, data] of [['rules', config()], ['telegram/connect', { token: 'synthetic' }], ['telegram/chat', { id: '-1' }], ['telegram/chats', {}], ['relay/start', { useRules: true }]]) assert.equal((await call(route, data)).status, 409, `${phase} ${route}`);
  }
});

test('Telegram directory exposes only identifiers and names, never message contents', async t => {
  const { call } = await setup(t);
  const result = await call('telegram/chats', {});
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.endpoints.map(row => row.id), ['-1']);
  assert.ok(!JSON.stringify(result).includes('SYNTHETIC_PRIVATE_MESSAGE'));
  assert.equal((await call('telegram/chat', { id: 'https://example.com' })).status, 400);
});

test('LINE endpoints require login, and invalid rule graphs cannot be persisted', async t => {
  const { call, starts } = await setup(t);
  assert.equal((await call('rules', config())).status, 200);
  assert.equal((await call('relay/start', { useRules: true })).status, 401);
  const invalid = config(); invalid.rules[0].destinations = invalid.rules[0].sources;
  assert.equal((await call('rules', invalid)).status, 400);
  assert.equal(starts.length, 0);
});
