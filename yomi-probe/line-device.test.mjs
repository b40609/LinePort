import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lineDevice } from './line-device.mjs';

const execute = promisify(execFile);
const root = path.dirname(fileURLToPath(import.meta.url));

test('device allowlist rejects unknown identities and separates data roots', () => {
  assert.throws(() => lineDevice('CHROMEOS'), /Unsupported/);
  assert.throws(() => lineDevice('__proto__'), /Unsupported/);
  assert.equal(lineDevice('DESKTOPMAC').directory, 'LineCallYomiProbe');
  assert.equal(lineDevice('IOSIPAD').directory, 'LineCallYomiProbe-IOSIPAD');
});

// Exercise the real vendored login, resume and refresh transport in fresh processes.
// All HTTPS requests are intercepted before any LINE module is loaded.
for (const device of ['DESKTOPMAC', 'IOSIPAD']) {
  test(`${device} login, restored session and refresh use the same device headers offline`, async () => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'lineport-device-'));
    const script = `
      import assert from 'node:assert/strict';
      import https from 'node:https';
      import { EventEmitter } from 'node:events';
      const requests = [];
      https.request = options => {
        requests.push(options);
        const request = new EventEmitter();
        request.write = () => {};
        request.end = () => queueMicrotask(() => request.emit('error', new Error('LOGGED_OUT synthetic offline fixture')));
        return request;
      };
      const { configureLineDevice } = await import('./line-device.mjs');
      const profile = await configureLineDevice();
      const { LINE_APP_CONFIG } = await import('./node_modules/@rikaidev/yomi/dist/line/core/config.js');
      const expected = profile.id === 'IOSIPAD' ? 'IOSIPAD\\t26.7.2\\tiOS\\t18.0' : LINE_APP_CONFIG.lineApp;
      assert.ok(expected.startsWith(profile.id + '\\t'));
      const { LinePwlessLogin } = await import('./node_modules/@rikaidev/yomi/dist/line/auth/pwless/index.js');
      const login = new LinePwlessLogin();
      assert.equal(login.config.lineApp, expected);
      await assert.rejects(login.sendPwless(Buffer.alloc(0)), /synthetic offline fixture/);
      await assert.rejects(login.sendPwlessLongPoll(Buffer.alloc(0)), /synthetic offline fixture/);
      const { resumeSession, tryRefreshToken } = await import('./node_modules/@rikaidev/yomi/dist/line/core/auth-session-runtime.js');
      const service = Object.assign(new EventEmitter(), {
        logger: { info() {}, warn() {}, error() {}, debug() {} },
        sessionState: { authToken: 'SYNTHETIC', refreshToken: 'SYNTHETIC_REFRESH', async loadFromStore() {}, async loadRecentFetchState() {}, bindClient() {} },
        credentialStore: { async get(key) { assert.equal(key, 'line_e2ee_keys'); return '[]'; } },
        setState() {},
      });
      assert.equal(await resumeSession(service), false);
      assert.equal(service.loginRequired, true);
      assert.equal(await tryRefreshToken(service), false);
      assert.deepEqual(requests.map(r => r.path), [LINE_APP_CONFIG.pwlessPath, LINE_APP_CONFIG.pwlessLongPollPath, LINE_APP_CONFIG.talkPath, LINE_APP_CONFIG.tokenRefreshPath]);
      for (const request of requests) {
        assert.equal(request.headers['X-Line-Application'], expected);
        assert.equal(request.headers['User-Agent'], LINE_APP_CONFIG.userAgent);
      }
      await assert.rejects(configureLineDevice(profile.id === 'IOSIPAD' ? 'DESKTOPMAC' : 'IOSIPAD'), /Restart/);
      process.stdout.write('offline-verified');
    `;
    const { stdout } = await execute(process.execPath, ['--input-type=module', '-e', script], {
      cwd: root, timeout: 15000, windowsHide: true,
      env: { ...process.env, LINEPORT_LINE_DEVICE: device, YOMI_DATA_DIR: temporary, YOMI_NO_KEYCHAIN: '1' },
    });
    assert.match(stdout, /offline-verified/);
  });
}

test('iPad runtime uses a protected isolated directory and leaves desktop data untouched', { skip: process.platform !== 'win32' }, async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'lineport-ipad-runtime-'));
  const { stdout } = await execute(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import path from 'node:path';
    import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
    import { prepareDataDirectory } from './runtime.mjs';
    const desktop = path.join(process.env.LOCALAPPDATA, 'LineCallYomiProbe');
    await mkdir(desktop);
    await writeFile(path.join(desktop, 'synthetic.txt'), 'unchanged');
    const dir = await prepareDataDirectory();
    assert.equal(dir, path.join(process.env.LOCALAPPDATA, 'LineCallYomiProbe-IOSIPAD'));
    assert.equal(process.env.YOMI_DATA_DIR, dir);
    assert.equal(process.env.YOMI_NO_KEYCHAIN, '1');
    assert.deepEqual(await readdir(dir), []);
    assert.equal(await readFile(path.join(desktop, 'synthetic.txt'), 'utf8'), 'unchanged');
    const { LINE_APP_CONFIG } = await import('./node_modules/@rikaidev/yomi/dist/line/core/config.js');
    assert.match(LINE_APP_CONFIG.lineApp, /^IOSIPAD\\t/);
    process.stdout.write('runtime-verified');
  `], { cwd: root, windowsHide: true, timeout: 35000, env: { ...process.env, LOCALAPPDATA: temporary, LINEPORT_LINE_DEVICE: 'IOSIPAD' } });
  assert.match(stdout, /runtime-verified/);
});
