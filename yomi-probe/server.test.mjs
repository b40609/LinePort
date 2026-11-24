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
import { createAutostartStore } from './autostart.mjs';

const fakeToken = 'test-only-token';
test('identity switch validates input, requires stopped relay and protects the API', async t => {
  let prepared = 0;
  const { call } = await setup(t, {}, { status: async () => ({ phase: 'running' }) }, undefined, undefined, undefined, async () => { prepared++; });
  assert.equal((await call('/api/device', '{"device":"IOSIPAD"}', { 'X-Probe-Token': 'wrong' })).status, 403);
  for (const value of [{}, { device: '__proto__' }, { device: 1 }, { device: 'DESKTOPWIN' }]) assert.equal((await call('/api/device', JSON.stringify(value))).status, 400);
  assert.equal((await call('/api/device', '{"device":"IOSIPAD"}')).status, 409);
  assert.equal(prepared, 0);
});

test('identity switch locks operations during preparation and reports failures safely', async t => {
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  t.after(() => release());
  const { call } = await setup(t, {}, { status: async () => ({ phase: 'stopped' }) }, undefined, undefined, undefined, async () => { entered(); await gate; throw new Error('private details'); });
  const first = call('/api/device', '{"device":"IOSIPAD"}'); await started;
  assert.equal((await call('/api/device', '{"device":"IOSIPAD"}')).status, 409);
  assert.equal((await call('/api/resume')).status, 409);
  release(); const failed = await first;
  assert.equal(failed.status, 503); assert.ok(!failed.body.includes('private'));
  assert.equal(JSON.parse((await call('/api/status', undefined, {}, 'GET')).body).busy, false);
});

test('switch acknowledges the selected identity before activating replacement', async t => {
  let activated = false, target;
  const { call } = await setup(t, {}, { status: async () => ({ phase: 'stopped' }) }, undefined, undefined, undefined, async id => {
    target = id; return { cancel() { assert.fail('Unexpected cancellation'); }, async activate() { activated = true; } };
  });
  const response = await call('/api/device', '{"device":"IOSIPAD"}');
  assert.equal(response.status, 202); assert.equal(response.headers.connection, 'close');
  assert.equal(JSON.parse(response.body).device, 'IOSIPAD'); assert.equal(target, 'IOSIPAD'); assert.equal(activated, true);
});

test('iPad rejects the known incompatible passwordless flow', async t => {
  const before = process.env.LINEPORT_LINE_DEVICE; process.env.LINEPORT_LINE_DEVICE = 'IOSIPAD';
  t.after(() => { if (before === undefined) delete process.env.LINEPORT_LINE_DEVICE; else process.env.LINEPORT_LINE_DEVICE = before; });
  const { call } = await setup(t, {}, undefined, undefined, () => assert.fail('Unexpected passwordless login'));
  assert.equal((await call('/api/login', '{"phone":"+886900000000"}')).status, 409);
});

test('developer Windows identity retains compatibility but exposes only two public choices', async t => {
  const before = process.env.LINEPORT_LINE_DEVICE; process.env.LINEPORT_LINE_DEVICE = 'DESKTOPWIN';
  t.after(() => { if (before === undefined) delete process.env.LINEPORT_LINE_DEVICE; else process.env.LINEPORT_LINE_DEVICE = before; });
  let called = false;
  const { call } = await setup(t, {}, { status: async () => ({ phase: 'stopped' }) }, undefined, async () => { called = true; });
  const home = await call('/', undefined, {}, 'GET');
  for (const identity of ['DESKTOPMAC', 'IOSIPAD']) assert.ok(home.body.includes('value="'+identity+'"'));
  assert.ok(!home.body.includes('value="DESKTOPWIN"'));
  assert.match(home.body, /name="lineport-device" content="DESKTOPWIN"/);
  assert.equal((await call('/api/login', '{"phone":"+886900000000"}')).status, 202); assert.equal(called, true);
});

test('QR API isolates iPad login, protects its image and cancels while busy', async t => {
  const before = process.env.LINEPORT_LINE_DEVICE;
  process.env.LINEPORT_LINE_DEVICE = 'IOSIPAD';
  t.after(() => { if (before === undefined) delete process.env.LINEPORT_LINE_DEVICE; else process.env.LINEPORT_LINE_DEVICE = before; });
  let aborted = false;
  const runner = async (_service, hooks) => {
    hooks.onQr('data:image/png;base64,synthetic');
    await new Promise(resolve => hooks.signal.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true }));
    throw new Error('sensitive upstream payload');
  };
  const { call } = await setup(t, {}, { status: async () => ({ phase: 'stopped' }) }, undefined, undefined, runner);
  assert.equal((await call('/api/login/qr')).status, 202);
  const status = await call('/api/status', undefined, {}, 'GET');
  assert.equal(status.headers['cache-control'], 'no-store');
  assert.match(JSON.parse(status.body).qr, /^data:image/);
  assert.equal((await call('/api/status', undefined, { 'X-Probe-Token': 'wrong' }, 'GET')).status, 403);
  assert.equal((await call('/api/login/qr')).status, 409);
  assert.equal((await call('/api/login/qr/cancel')).status, 202);
  assert.equal(aborted, true);
  const after = JSON.parse((await call('/api/status', undefined, {}, 'GET')).body);
  assert.equal(after.qr, ''); assert.equal(after.connected, false);
  assert.ok(!after.error.includes('sensitive'));
});
async function setup(t, overrides = {}, relayController, settingsStore, runPwlessLogin = async () => {}, runQrLogin, prepareRestart, autostartStore, extra = {}) {
  const service = Object.assign(new EventEmitter(), { resumeSession: async () => true, client: { getAllChatMids: async () => ({ memberChats: [] }), getChats: async () => [] } }, overrides);
  const server = createProbeServer({ service, token: fakeToken, runPwlessLogin, runQrLogin, prepareRestart, relayController, settingsStore, autostartStore, ...extra });
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
  return { call, startRequest, service };
}
test('autostart API reports preference state and applies shortcut changes', async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'lineport-server-autostart-'));
  t.after(async () => { const fs = await import('node:fs/promises'); await fs.rm(home, { recursive: true, force: true }); });
  const applied = [];
  const store = createAutostartStore(home, { apply: async (value, where) => { applied.push(where); return [{ kind: 'service', enabled: value.service }]; } });
  const { call } = await setup(t, {}, undefined, undefined, undefined, undefined, undefined, store);
  // Regression: the API used to also apply shortcuts against the real LOCALAPPDATA, overwriting live autostart scripts.
  t.after(() => assert.deepEqual([...new Set(applied)], [home]));
  const initial = await call('/api/autostart', undefined, {}, 'GET');
  assert.equal(initial.status, 200);
  assert.deepEqual(JSON.parse(initial.body).autostart, { service: false, relay: false });
  for (const value of [{}, { service: 'yes' }, { service: true }, null]) assert.equal((await call('/api/autostart', JSON.stringify(value))).status, 400);
  const updated = await call('/api/autostart', '{"service":true,"relay":true}');
  assert.equal(updated.status, 200);
  assert.deepEqual(JSON.parse(updated.body).autostart, { service: true, relay: true });
  const seeded = await call('/api/autostart', undefined, {}, 'GET');
  assert.deepEqual(JSON.parse(seeded.body).autostart, { service: true, relay: true });
  assert.deepEqual(JSON.parse(await readFile(path.join(home, 'LinePort', 'autostart.json'), 'utf8')), { service: true, relay: true, schemaVersion: 2, writtenByVersion: JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8')).version });
});
test('autostart endpoint stays hidden when the environment has no store', async t => {
  const { call } = await setup(t);
  assert.equal((await call('/api/autostart', undefined, {}, 'GET')).status, 404);
  assert.equal((await call('/api/autostart', '{"service":true,"relay":false}')).status, 404);
});
test('QR finalization rejects cancellation and retains successful login state', async t => {
  const before = process.env.LINEPORT_LINE_DEVICE;
  process.env.LINEPORT_LINE_DEVICE = 'IOSIPAD';
  t.after(() => { if (before === undefined) delete process.env.LINEPORT_LINE_DEVICE; else process.env.LINEPORT_LINE_DEVICE = before; });
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  const runner = async (_service, hooks) => {
    hooks.onQr('data:image/png;base64,synthetic');
    hooks.onFinalizing(); entered(); await gate;
    assert.equal(hooks.signal.aborted, false);
  };
  const { call } = await setup(t, {}, { status: async () => ({ phase: 'stopped' }) }, undefined, undefined, runner);
  assert.equal((await call('/api/login/qr')).status, 202);
  await started;
  assert.equal((await call('/api/login/qr/cancel')).status, 409);
  const pending = JSON.parse((await call('/api/status', undefined, {}, 'GET')).body);
  assert.equal(pending.qr, ''); assert.equal(pending.pin, ''); assert.equal(pending.busy, true);
  release(); await new Promise(resolve => setImmediate(resolve));
  const complete = JSON.parse((await call('/api/status', undefined, {}, 'GET')).body);
  assert.equal(complete.connected, true); assert.equal(complete.busy, false); assert.equal(complete.qrLogin, false);
});

test('desktop mode cannot invoke QR login and renders resolved device metadata', async t => {
  const { call } = await setup(t, {}, undefined, undefined, undefined, () => assert.fail('Unexpected QR login'));
  assert.equal((await call('/api/login/qr')).status, 409);
  const home = await call('/', undefined, {}, 'GET');
  assert.ok(!/__DEVICE(?:_LABEL|_NOTICE)?__/.test(home.body));
  assert.ok(!home.body.includes('value="DESKTOPWIN"'));
  assert.match(home.body, /name="lineport-device" content="DESKTOPMAC"/);
});

test('local API enforces Host, Origin, Fetch Metadata and token', async t => {
  const { call } = await setup(t);
  for (const headers of [{ Host: 'evil.example' }, { Origin: 'https://evil.example' }, { 'Sec-Fetch-Site': 'cross-site' }, { 'X-Probe-Token': 'wrong' }]) {
    assert.equal((await call('/api/status', undefined, headers, 'GET')).status, 403);
  }
  assert.equal((await call('/api/status', undefined, {}, 'GET')).status, 200);
});

test('revoked session clears connected status and permits a fresh login', async t => {
  const { call, service } = await setup(t, {}, { status: async () => ({ phase: 'stopped' }) });
  assert.equal((await call('/api/resume')).status, 200);
  assert.equal(JSON.parse((await call('/api/status', undefined, {}, 'GET')).body).connected, true);
  service.emit('line:loginRequired');
  const state = JSON.parse((await call('/api/status', undefined, {}, 'GET')).body);
  assert.equal(state.connected, false);
  assert.equal(state.phase, 'login_required');
  assert.equal((await call('/api/groups')).status, 401);
  assert.equal((await call('/api/login', JSON.stringify({ phone: '+886900000000' }))).status, 202);
});
test('login failure after phone approval exposes only safe diagnostic codes', async t => {
  const secret = 'SYNTHETIC_TOKEN_NOT_FOR_DISPLAY';
  const login = async (_service, _phone, _region, hooks) => {
    hooks.onWaitingBiometric();
    throw new Error(`loginV2 failed: code=20 msg="${secret}"`);
  };
  const { call } = await setup(t, {}, { status: async () => ({ phase: 'stopped' }) }, undefined, login);
  assert.equal((await call('/api/login', JSON.stringify({ phone: '+886900000000' }))).status, 202);
  const reply = await call('/api/status', undefined, {}, 'GET');
  const state = JSON.parse(reply.body);
  assert.equal(state.phase, 'failed');
  assert.equal(state.connected, false);
  assert.equal(state.pin, '');
  assert.equal(state.loginDiagnostic.stage, 'loginV2');
  assert.equal(state.loginDiagnostic.lineCode, 20);
  assert.match(state.error, /LINE code 20/);
  assert.ok(!reply.body.includes(secret));
});

test('home has nonce CSP, no-store and no unresolved placeholders', async t => {
  const { call } = await setup(t);
  const result = await call('/', undefined, {}, 'GET');
  assert.equal(result.status, 200);
  assert.match(result.headers['content-security-policy'], /script-src 'nonce-/);
  assert.equal(result.headers['cache-control'], 'no-store');
  assert.ok(!result.body.includes('__TOKEN__') && !result.body.includes('__NONCE__'));
  assert.match(result.body, /v1\.2\.0 · LINE · Telegram/);
  assert.match(result.body, /id="checkUpdate"/);
  assert.ok(result.body.includes('href="https://github.com/b40609/LinePort/releases"'));
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
  const relay = { status: async () => ({ phase: 'stopped', stage: secret, forwarded: 3, warning: secret, routes: [{ phase: 'failed', stage: 'destination_e2ee', failureReason: 'missing_receiver_key', forwarded: 3, name: secret, token: secret }] }) };
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
  assert.equal(backup.appVersion, '1.2.0');
  assert.deepEqual(backup.config, original);
  assert.equal(diagnostics.appVersion, '1.2.0');
  assert.equal(diagnostics.stage, 'unknown');
  assert.equal(diagnostics.routes[0].stage, 'destination_e2ee');
  assert.equal(diagnostics.routes[0].failureReason, 'missing_receiver_key');
  assert.deepEqual(Object.keys(diagnostics.routes[0]).sort(), ['errors', 'failureReason', 'forwarded', 'pending', 'phase', 'route', 'skipped', 'stage', 'uncertain']);
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

test('health alert settings save without stopping the relay, reuse the bot token and keep backups compatible', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'lineport-health-api-'));
  const botToken = '123456:SYNTHETIC_TOKEN_NOT_FOR_EXPORT_123';
  const store = createSettingsStore(directory);
  const sent = [];
  const telegramFactory = token => ({ send: async (...args) => { sent.push([token, ...args]); return { id: '-1001:1' }; } });
  const { call } = await setup(t, {}, { status: async () => ({ phase: 'running' }) }, store, undefined, undefined, undefined, undefined, { telegramFactory });
  assert.deepEqual(JSON.parse((await call('/api/health-alert', undefined, {}, 'GET')).body), { healthAlert: { enabled: false, telegramChatId: '' }, telegramConfigured: false });
  const noBot = await call('/api/health-alert', JSON.stringify({ enabled: true, telegramChatId: '-1001' }));
  assert.equal(noBot.status, 400); assert.match(JSON.parse(noBot.body).error, /連結 Telegram Bot/);
  for (const bad of [{ enabled: 'yes' }, { enabled: true }, { enabled: false, telegramChatId: 'abc' }, { enabled: false, telegramChatId: '-1', telegramThreadId: 0 }]) {
    assert.equal((await call('/api/health-alert', JSON.stringify(bad))).status, 400, JSON.stringify(bad));
  }
  await store.saveTelegram(botToken);
  const saved = await call('/api/health-alert', JSON.stringify({ enabled: true, telegramChatId: '-1001', telegramThreadId: 9 }));
  assert.equal(saved.status, 200, 'saving alerts does not require stopping the running relay');
  assert.deepEqual(JSON.parse(saved.body).healthAlert, { enabled: true, telegramChatId: '-1001', telegramThreadId: 9 });
  const onDisk = await readFile(path.join(directory, 'lineport-health-alert.json'), 'utf8');
  assert.ok(!onDisk.includes('SYNTHETIC_TOKEN'));
  assert.equal((await call('/api/health-alert/test')).status, 200);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].slice(0, 2), [botToken, '-1001']);
  assert.deepEqual(sent[0][3], { threadId: 9 });
  assert.match(sent[0][2], /測試告警/);
  assert.ok(!sent[0][2].includes('SYNTHETIC_TOKEN'));
  // Backups carry the alert destination but never the token; older backups without it still validate.
  const backup = JSON.parse((await call('/api/settings/backup', undefined, {}, 'GET')).body);
  assert.deepEqual(backup.healthAlert, { enabled: true, telegramChatId: '-1001', telegramThreadId: 9 });
  assert.ok(!JSON.stringify(backup).includes('SYNTHETIC_TOKEN'));
  const { healthAlert, ...legacy } = backup;
  assert.equal((await call('/api/settings/validate', JSON.stringify({ backup: legacy }))).status, 200);
  assert.equal((await call('/api/settings/validate', JSON.stringify({ backup }))).status, 200);
});

test('a failing test alert reports a safe error', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'lineport-health-api-'));
  const store = createSettingsStore(directory);
  await store.saveTelegram('123456:SYNTHETIC_TOKEN_NOT_FOR_EXPORT_123');
  await store.saveHealthAlert({ enabled: true, telegramChatId: '-1001' });
  const telegramFactory = () => ({ send: async () => { throw new Error('SYNTHETIC_PRIVATE https://api.telegram.org/botSECRET'); } });
  const { call } = await setup(t, {}, { status: async () => ({ phase: 'stopped' }) }, store, undefined, undefined, undefined, undefined, { telegramFactory });
  const reply = await call('/api/health-alert/test');
  assert.equal(reply.status, 502);
  assert.ok(!reply.body.includes('SYNTHETIC') && !reply.body.includes('SECRET'));
});

test('relay start and stop record the intent the watchdog honours', async t => {
  const intents = [];
  const store = { load: async () => normalizeConfig({ version: 1, rules: [{ id: 'r', name: 'r', enabled: true, sources: [{ platform: 'telegram', id: '-1' }], destinations: [{ platform: 'telegram', id: '-2' }] }] }), telegramToken: async () => 'x' };
  const relay = { status: async () => ({ phase: 'stopped' }), startRules: async () => {}, stop: async () => {} };
  const autostart = { load: async () => ({ service: true, relay: true }), saveRelayIntent: async value => { intents.push(value); } };
  const { call } = await setup(t, {}, relay, store, undefined, undefined, undefined, autostart);
  assert.equal((await call('/api/relay/start', '{"useRules":true}')).status, 202);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal((await call('/api/relay/stop')).status, 202);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(intents, ['running', 'stopped']);
});

test('update check is a token-protected GET that only reports versions', async t => {
  let calls = 0;
  const { call } = await setup(t, {}, undefined, undefined, undefined, undefined, undefined, undefined, { updateCheck: async () => { calls++; return { current: '1.1.0', latest: '1.2.0', newer: true, url: 'https://github.com/b40609/LinePort/releases/tag/v1.2.0' }; } });
  assert.equal(calls, 0, 'nothing is checked automatically');
  const reply = await call('/api/update/check', undefined, {}, 'GET');
  assert.equal(reply.status, 200);
  assert.deepEqual(JSON.parse(reply.body), { current: '1.1.0', latest: '1.2.0', newer: true, url: 'https://github.com/b40609/LinePort/releases/tag/v1.2.0' });
  assert.equal((await call('/api/update/check', undefined, { 'X-Probe-Token': 'wrong' }, 'GET')).status, 403);
  assert.equal(calls, 1);
});

test('graceful shutdown requires the page token and a stopped relay, then calls onShutdown once', async t => {
  let phase = 'running', shutdowns = 0;
  const { call } = await setup(t, {}, { status: async () => ({ phase }) }, undefined, undefined, undefined, undefined, undefined, { onShutdown: () => { shutdowns++; } });
  assert.equal((await call('/api/server/shutdown', '{}', { 'X-Probe-Token': 'wrong' })).status, 403);
  assert.equal((await call('/api/server/shutdown')).status, 409);
  phase = 'stopped';
  assert.equal((await call('/api/server/shutdown')).status, 202);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(shutdowns, 1);
});

test('compaction API refuses without explicit confirmation or while relaying', async t => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'lineport-server-compact-'));
  let phase = 'running';
  const { call } = await setup(t, {}, { status: async () => ({ phase }) }, undefined, undefined, undefined, undefined, undefined, { dataDirectory: folder });
  assert.equal((await call('/api/storage/compact', '{"confirm":true}')).status, 409);
  phase = 'stopped';
  assert.equal((await call('/api/storage/compact', '{}')).status, 400);
  const done = await call('/api/storage/compact', '{"confirm":true}');
  assert.equal(done.status, 200); assert.equal(JSON.parse(done.body).compacted, 0);
});
