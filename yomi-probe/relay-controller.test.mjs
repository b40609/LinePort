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
