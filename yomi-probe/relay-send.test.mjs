import test from 'node:test';
import assert from 'node:assert/strict';
import { sendRelayText, prepareRelayDestination } from './relay-send.mjs';

test('forwarded text stays a string for the always-encrypted public service', async () => {
  const service = { async sendMessage(destination, options) {
    assert.equal(destination, 'synthetic-group');
    assert.equal(options, '測試文字🔥');
    return { id: 'acknowledged' };
  } };
  assert.deepEqual(await sendRelayText(service, 'synthetic-group', '測試文字🔥'), { id: 'acknowledged' });
});

test('destination encryption readiness is checked without posting a message', async () => {
  let checked = false;
  const service = {
    e2eeManager: { async encryptE2EEMessage(destination, text, type) {
      assert.equal(destination, 'synthetic-group'); assert.equal(text, ''); assert.equal(type, 0);
      checked = true; throw new Error('missing group key');
    } },
    sendMessage() { assert.fail('Preflight must not send'); },
  };
  await assert.rejects(prepareRelayDestination(service, 'synthetic-group'), /missing group key/);
  assert.equal(checked, true);
});

test('encrypted send failures propagate without a plaintext fallback', async () => {
  let attempts = 0;
  const service = { async sendMessage() { attempts++; throw new Error('encryption unavailable'); } };
  await assert.rejects(sendRelayText(service, 'synthetic-group', 'text'), /encryption unavailable/);
  assert.equal(attempts, 1);
});
