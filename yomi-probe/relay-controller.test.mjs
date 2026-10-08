import test from 'node:test';
import assert from 'node:assert/strict';
import { createRelayController } from './relay-controller.mjs';

test('group names are environment data, not shell commands', async () => {
  const calls = [];
  const controller = createRelayController({ run: async (...args) => { calls.push(args); } });
  const source = '來源🔥 $(Get-Content secret) " ; &';
  await controller.start(source, '測試✅');
  await controller.stop();
  assert.equal(calls.length, 2);
  const [executable, args, options] = calls[0];
  assert.ok(executable.endsWith('powershell.exe'));
  assert.ok(args.at(-1).endsWith('start-relay.ps1'));
  assert.ok(!args.some(argument => argument.includes(source)));
  assert.equal(options.env.LINECALL_SOURCE, source);
  assert.equal(options.windowsHide, true);
  assert.ok(!options.shell);
  assert.ok(calls[1][1].at(-1).endsWith('stop-relay.ps1'));
});

test('status only exposes known fields and distinguishes unavailable services', async () => {
  const request = async () => ({ ok: true, json: async () => ({ app: 'line-relay-bridge', phase: 'running', forwarded: 7, token: 'SYNTHETIC_SECRET' }) });
  const state = await createRelayController({ request }).status();
  assert.equal(state.forwarded, 7);
  assert.ok(!('token' in state));
  assert.equal((await createRelayController({ request: async () => ({ ok: true, json: async () => ({ phase: 'running' }) }) }).status()).phase, 'legacy');
  assert.equal((await createRelayController({ request: async () => { throw new Error('timeout'); } }).status()).phase, 'unavailable');
  assert.equal((await createRelayController({ request: async () => { throw Object.assign(new Error('offline'), { cause: { code: 'ECONNREFUSED' } }); } }).status()).phase, 'stopped');
});

test('decrypt failures are visible without exposing upstream diagnostics or message content', async () => {
  const request = async () => ({ ok: true, json: async () => ({ app: 'line-relay-bridge', phase: 'running', lastRead: { received: 4, decryptFailed: 2, text: 'SYNTHETIC_SECRET', eligible: -1 } }) });
  const state = await createRelayController({ request }).status();
  assert.match(state.warning, /無法解密/);
  assert.equal(state.lastRead.eligible, 0);
  assert.ok(!JSON.stringify(state).includes('SYNTHETIC_SECRET'));
});

test('startup errors report the failed relay stage without subprocess output', async () => {
  const request = async () => ({ ok: true, json: async () => ({ app: 'line-relay-bridge', phase: 'failed', stage: 'e2ee_keys' }) });
  const controller = createRelayController({ request, run: async () => { throw new Error('SYNTHETIC_SECRET'); } });
  await assert.rejects(controller.start('來源', '目的'), error => /加解密金鑰/.test(error.message) && !error.message.includes('SYNTHETIC_SECRET'));
});
