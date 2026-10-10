import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createProbeServer } from './server.mjs';
import { configRevision, createSettingsStore, normalizeConfig } from './route-config.mjs';

const fakeToken = 'test-only-token';
async function setup(t, overrides = {}, relayController, settingsStore) {
  const service = Object.assign(new EventEmitter(), { resumeSession: async () => true, client: { getAllChatMids: async () => ({ memberChats: [] }), getChats: async () => [] } }, overrides);
  const server = createProbeServer({ service, token: fakeToken, runPwlessLogin: async () => {}, relayController, settingsStore });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const port = server.address().port;
  function startRequest(route, headers = {}, method = 'POST') {
    let request;
    const response = new Promise((resolve, reject) => {
      request = http.request({ hostname: '127.0.0.1', port, path: route, method,
        headers: { Host: '127.0.0.1:18765', 'X-Probe-Token': fakeToken, 'Content-Type': 'application/json', ...headers } }, res => {
        const parts = [];
        res.on('data', p => parts.push(p));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parts).toString() }));
      });
      request.on('error', reject);
    });
    return { request, response };
  }
  async function call(route, value = '{}', headers = {}, method = 'POST') {
    const { request, response } = startRequest(route, headers, method);
    request.end(method === 'GET' ? undefined : value);
    return response;
  }
  return { call, startRequest };
}
test('local API enforces Host, Origin, Fetch Metadata and token', async t => {
  const { call } = await setup(t);
  for (const headers of [{ Host: 'evil.example' }, { Origin: 'https://evil.example' }, { 'Sec-Fetch-Site': 'cross-site' }, { 'X-Probe-Token': 'wrong' }]) {
    assert.equal((await call('/api/status', undefined, headers, 'GET')).status, 403);
  }
  assert.equal((await call('/api/status', undefined, {}, 'GET')).status, 200);
});
test('home has nonce CSP, no-store and no unresolved placeholders', async t => {
  const { call } = await setup(t);
  const result = await call('/', undefined, {}, 'GET');
  assert.equal(result.status, 200);
  assert.match(result.headers['content-security-policy'], /script-src 'nonce-/);
  assert.equal(result.headers['cache-control'], 'no-store');
  assert.ok(!result.body.includes('__TOKEN__') && !result.body.includes('__NONCE__'));
  assert.match(result.body, /v0\.8\.3 · LINE · Telegram/);
  assert.match(result.body, /releases\/tag\/v0\.8\.3/);
});
test('isolated HTTP download, backup validation and restore preserve pre-restore settings', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'lineport-api-acceptance-'));
  const secret = 'SYNTHETIC_CREDENTIAL_NOT_FOR_EXPORT';
  const original = normalizeConfig({ version: 1, rules: [{ id: 'synthetic', name: 'Synthetic route', enabled: false,
    sources: [{ platform: 'line', id: 'csynthetic-source', name: 'Synthetic source' }],
    destinations: [{ platform: 'line', id: 'csynthetic-dest', name: 'Synthetic destination' }],
    include: ['sample'], exclude: ['ignore'], prefix: '[sample] ' }] });
  await writeFile(path.join(directory, 'lineport-rules.json'), JSON.stringify({ ...original, token: secret, rules: original.rules.map(rule => ({ ...rule, token: secret })) }));
  const store = createSettingsStore(directory);
  const relay = { status: async () => ({ phase: 'stopped', forwarded: 3, warning: secret, routes: [{ phase: 'stopped', forwarded: 3, name: secret, token: secret }] }) };
  const { call } = await setup(t, {}, relay, store);
  const backupReply = await call('/api/settings/backup', undefined, {}, 'GET');
  const diagnosticReply = await call('/api/diagnostics', undefined, {}, 'GET');
  assert.equal(backupReply.status, 200);
  assert.equal(diagnosticReply.status, 200);
  for (const [filename, reply] of [['downloaded-settings.json', backupReply], ['downloaded-diagnostics.json', diagnosticReply]]) {
    assert.equal(reply.headers['cache-control'], 'no-store');
    assert.ok(!reply.body.includes(secret));
    await writeFile(path.join(directory, filename), reply.body);
    assert.deepEqual(JSON.parse(await readFile(path.join(directory, filename), 'utf8')), JSON.parse(reply.body));
  }
  const backup = JSON.parse(backupReply.body);
  const diagnostics = JSON.parse(diagnosticReply.body);
  assert.equal(backup.appVersion, '0.8.3');
  assert.deepEqual(backup.config, original);
  assert.equal(diagnostics.appVersion, '0.8.3');
  assert.deepEqual(Object.keys(diagnostics.routes[0]).sort(), ['errors', 'forwarded', 'pending', 'phase', 'route', 'skipped', 'uncertain']);
  const before = await readFile(path.join(directory, 'lineport-rules.json'), 'utf8');
  const invalid = { ...backup, version: 999 };
  assert.equal((await call('/api/settings/validate', JSON.stringify({ backup: invalid }))).status, 400);
  assert.equal((await call('/api/settings/restore', JSON.stringify({ backup: invalid, revision: configRevision(original) }))).status, 400);
  assert.equal((await call('/api/settings/restore', JSON.stringify({ backup, revision: 'stale' }))).status, 409);
  assert.equal(await readFile(path.join(directory, 'lineport-rules.json'), 'utf8'), before);
  assert.equal((await readdir(directory)).some(name => name.startsWith('lineport-settings-before-restore-')), false);
  assert.equal((await call('/api/settings/validate', JSON.stringify({ backup }))).status, 200);
  const changedBackup = { ...backup, config: { version: 1, rules: [] } };
  const restored = await call('/api/settings/restore', JSON.stringify({ backup: changedBackup, revision: configRevision(original) }));
  assert.equal(restored.status, 200);
  const result = JSON.parse(restored.body);
  assert.match(result.backup, /^lineport-settings-before-restore-[a-f0-9-]+\.json$/);
  assert.deepEqual(JSON.parse(await readFile(path.join(directory, result.backup), 'utf8')), original);
  assert.deepEqual(await store.load(), { version: 1, rules: [] });
});
test('malformed bodies rejected; unauthenticated group read blocked', async t => {
  const { call } = await setup(t);
  assert.equal((await call('/api/resume', '{')).status, 400);
  assert.equal((await call('/api/resume', 'null')).status, 400);
  assert.equal((await call('/api/resume', '[]')).status, 400);
  assert.equal((await call('/api/resume', '{}', { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await call('/api/resume', JSON.stringify({ text: 'a'.repeat(5000) }))).status, 413);
  assert.equal((await call('/api/groups')).status, 401);
});
test('overlapping request bodies cannot start concurrent session operations', async t => {
  let release, entered;
  const began = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const { call, startRequest } = await setup(t, { resumeSession: async () => { calls++; entered(); await gate; return true; } });
  t.after(() => release());
  const slow = startRequest('/api/resume');
  slow.request.write('{');
  const active = call('/api/resume');
  await began;
  slow.request.end('}');
  assert.equal((await slow.response).status, 409);
  release();
  assert.equal((await active).status, 200);
  assert.equal(calls, 1);
});
test('upstream exceptions never reveal sensitive context', async t => {
  const { call } = await setup(t, { resumeSession: async () => { throw new Error('SYNTHETIC_SECRET'); } });
  const result = await call('/api/resume');
  assert.equal(result.status, 500);
  assert.ok(!result.body.includes('SYNTHETIC_SECRET'));
  assert.ok(!(await call('/api/status', undefined, {}, 'GET')).body.includes('SYNTHETIC_SECRET'));
});

test('relay start validates membership, different IDs and unique names before dispatch', async t => {
  const routes = [];
  const { call } = await setup(t, { client: {
    getAllChatMids: async () => ({ memberChats: ['c1', 'c2', 'c3', 'c4'] }),
    getChats: async () => ['來源🔥', '測試✅', '重名', '重名'].map((chatName, i) => ({ chatMid: 'c' + (i + 1), chatName })),
  } }, { status: async () => ({ phase: 'stopped' }), start: async (...route) => { routes.push(route); }, stop: async () => {} });
  assert.equal((await call('/api/relay/start', '{}')).status, 401);
  await call('/api/resume');
  await call('/api/groups');
  for (const route of [{ sourceId: 'evil', destinationId: 'c2' }, { sourceId: 'c1', destinationId: 'c1' }, { sourceId: 'c3', destinationId: 'c2' }]) {
    assert.equal((await call('/api/relay/start', JSON.stringify(route))).status, 400);
  }
  assert.equal((await call('/api/relay/start', JSON.stringify({ sourceId: 'c1', destinationId: 'c2' }))).status, 202);
  assert.deepEqual(routes, [['來源🔥', '測試✅']]);
});

test('relay actions are asynchronous, serialized and failure details are redacted', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  const { call } = await setup(t, {}, { status: async () => ({ phase: 'running' }), stop: async () => { await gate; throw new Error('SYNTHETIC_PRIVATE_PATH'); } });
  assert.equal((await call('/api/relay/stop', 'null')).status, 400);
  assert.equal((await call('/api/relay/stop')).status, 202);
  assert.equal(JSON.parse((await call('/api/relay/status', undefined, {}, 'GET')).body).action, 'stopping');
  assert.equal((await call('/api/resume')).status, 409);
  assert.equal((await call('/api/relay/stop', '{}', { 'X-Probe-Token': 'wrong' })).status, 403);
  release();
  await new Promise(resolve => setImmediate(resolve));
  const result = await call('/api/status', undefined, {}, 'GET');
  assert.equal(JSON.parse(result.body).busy, false);
  assert.ok(!result.body.includes('SYNTHETIC_PRIVATE_PATH'));
});

test('account operations require a stopped relay, including unknown status', async t => {
  let resumes = 0;
  let phase = 'running';
  const { call } = await setup(t, { resumeSession: async () => { resumes++; return true; } }, { status: async () => ({ phase }) });
  for (phase of ['running', 'starting', 'legacy', 'unavailable', 'failed']) {
    assert.equal((await call('/api/resume')).status, 409);
    assert.equal((await call('/api/login', JSON.stringify({ phone: '0912345678' }))).status, 409);
  }
  assert.equal(resumes, 0);
  phase = 'stopped';
  assert.equal((await call('/api/resume')).status, 200);
  assert.equal(resumes, 1);
});
