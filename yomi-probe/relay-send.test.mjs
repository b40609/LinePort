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

function botGroup({ official = true, version = -1, error, getChats } = {}) {
  const failure = error || new Error('No existing LINE group E2EE key for cgroup; synthetic upstream guidance');
  return {
    profile: { mid: 'uself' },
    e2eeManager: { async encryptE2EEMessage() { throw failure; } },
    client: {
      getChats: getChats || (async () => [{ chatMid: 'cgroup', extra: { 1: { 4: { uself: 1, ubot: 1 } } } }]),
      negotiateE2EEPublicKey: async mid => ({ 3: mid === 'ubot' ? version : 2 }),
      getContacts: async ids => ids.map(mid => ({ mid, isOfficial: official })),
      sendMessage() { assert.fail('Readiness must not send'); },
    },
    sendMessage() { assert.fail('Readiness must not send'); },
  };
}

test('missing group keys use transport only after confirming a non-E2EE official member', async () => {
  assert.equal(await prepareRelayDestination(botGroup(), 'cgroup'), 'transport');
  assert.equal(await prepareRelayDestination(botGroup({ version: -1n }), 'cgroup'), 'transport');
  for (const overrides of [{ official: false }, { version: 2 }, { version: undefined, official: false },
    { getChats: async () => [] }, { getChats: async () => { throw new Error('network'); } },
    { getChats: async () => [{ chatMid: 'cgroup', extra: { 1: { 4: { ubot: 1 } } } }] }]) {
    await assert.rejects(prepareRelayDestination(botGroup(overrides), 'cgroup'), /No existing LINE group/);
  }
});

test('available E2EE stays preferred even in a bot group; other encryption failures never downgrade', async () => {
  const ready = botGroup();
  ready.e2eeManager.encryptE2EEMessage = async () => {};
  ready.client.getChats = () => assert.fail('Do not inspect members when E2EE works');
  assert.equal(await prepareRelayDestination(ready, 'cgroup'), 'e2ee');
  for (const message of ['network unavailable', 'Peer E2EE key mismatch for cgroup', 'Missing self E2EE key for mid=uself',
    'No existing LINE group E2EE key for cother; synthetic', 'No existing LINE group E2EE key for ufriend; synthetic']) {
    const service = botGroup({ error: new Error(message), getChats: () => assert.fail('Do not downgrade other failures') });
    await assert.rejects(prepareRelayDestination(service, message.includes('ufriend') ? 'ufriend' : 'cgroup'), { message });
  }
});

test('bot inspection expires and makes no further capability requests after timeout', async () => {
  let release, negotiated = 0;
  const service = botGroup({ getChats: () => new Promise(resolve => { release = resolve; }) });
  service.client.negotiateE2EEPublicKey = async () => { negotiated++; return { 3: -1 }; };
  await assert.rejects(prepareRelayDestination(service, 'cgroup', { diagnosticTimeoutMs: 10 }), /No existing LINE group/);
  release([{ chatMid: 'cgroup', extra: { 1: { 4: { uself: 1, ubot: 1 } } } }]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(negotiated, 0);
});

test('transport text preserves reply fields, returns acknowledgement and never retries failed sends', async () => {
  const calls = [];
  const service = { sendMessage: () => assert.fail('Do not use encrypted sender'), client: {
    sendMessage: async payload => { calls.push(payload); return { id: '123' }; },
  } };
  assert.deepEqual(await sendRelayText(service, 'cgroup', 'Synthetic', { transportOnly: true }), { id: '123' });
  assert.deepEqual(calls[0], { to: 'cgroup', text: 'Synthetic', contentType: 0 });
  await sendRelayText(service, 'cgroup', 'Reply', { transportOnly: true, replyTo: '123' });
  assert.deepEqual(calls[1], { to: 'cgroup', text: 'Reply', contentType: 0, relatedMessageId: '123', messageRelationType: 3, relatedMessageServiceCode: 1 });
  assert.throws(() => sendRelayText(service, 'cgroup', 'Reply', { transportOnly: true, replyTo: 'invalid' }));
  service.client.sendMessage = async () => { calls.push('failed'); throw new Error('uncertain send'); };
  await assert.rejects(sendRelayText(service, 'cgroup', 'Synthetic', { transportOnly: true }), /uncertain/);
  assert.equal(calls.filter(call => call === 'failed').length, 1);
});
