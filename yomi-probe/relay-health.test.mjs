import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectRelayRead, relayWarning, requireRelayEncryption, destinationEncryptionFailure } from './relay-health.mjs';

test('group access alone cannot start a relay without a bound encryption key', () => {
  assert.throws(() => requireRelayEncryption({ profile: { mid: 'fake-account' }, e2eeManager: { getSelfKeyByMid: () => undefined } }), /加解密金鑰/);
  assert.doesNotThrow(() => requireRelayEncryption({ profile: { mid: 'fake-account' }, e2eeManager: { getSelfKeyByMid: mid => mid === 'fake-account' } }));
});

test('running relay exposes silently skipped new encrypted messages', () => {
  const lastRead = inspectRelayRead([
    { id: 'old', createdTime: 80, text: 'history' },
    { id: 'baseline', createdTime: 90, text: 'baseline' },
    { id: 'new', createdTime: 110, text: '', e2eeDecryptFailure: { error: 'SYNTHETIC_SECRET' } },
    { id: 'ready', createdTime: 120, text: 'readable' },
    { id: 'invalid', createdTime: 0, text: 'bad time' },
  ], new Set(['baseline']), 100);
  assert.deepEqual(lastRead, { received: 5, processed: 1, eligible: 1, decryptFailed: 1, invalidTime: 1, history: 1 });
  assert.match(relayWarning({ phase: 'running', lastRead }), /無法解密/);
  assert.ok(!JSON.stringify(lastRead).includes('SYNTHETIC_SECRET'));
});

test('already processed baseline encryption failures do not block healthy forwarding', () => {
  const lastRead = inspectRelayRead([{ id: 'baseline', createdTime: 90, e2eeDecryptFailure: true }], new Set(['baseline']), 100);
  assert.equal(relayWarning({ phase: 'running', lastRead }), '');
  assert.match(relayWarning({ phase: 'failed', stage: 'send_uncertain', lastRead }), /不會自動重送/);
});

test('unseen messages filtered by a future local baseline are visible for diagnosis', () => {
  const lastRead = inspectRelayRead([{ id: 'new', createdTime: 110, text: 'new' }], new Set(), 200);
  assert.equal(lastRead.history, 1);
  assert.equal(lastRead.eligible, 0);
  assert.match(relayWarning({ phase: 'running', lastRead }), /電腦日期與時間/);
});

test('destination encryption failures distinguish key and network causes without leaking upstream data', () => {
  const cases = [
    [new Error('Missing self E2EE key for receiverKeyId=SYNTHETIC_SECRET'), 'missing_receiver_key', /舊代接收金鑰/],
    [new Error('Missing self E2EE key for mid=SYNTHETIC_SECRET'), 'missing_self_key', /帳號的發送金鑰/],
    [new Error('No existing LINE group E2EE key for SYNTHETIC_SECRET'), 'missing_group_key', /未提供/],
    [new Error('Peer E2EE key mismatch for SYNTHETIC_SECRET'), 'peer_key_mismatch', /版本不符/],
    [new Error('Incomplete group shared key payload'), 'invalid_group_key', /無法解密/],
    [Object.assign(new Error('SYNTHETIC_SECRET'), { code: 'ERR_OSSL_BAD_DECRYPT' }), 'invalid_group_key', /無法解密/],
    [Object.assign(new Error('SYNTHETIC_SECRET'), { cause: { code: 'ECONNRESET' } }), 'network', /連線失敗/],
    [Object.assign(new Error('SYNTHETIC_SECRET'), { code: 'ETIMEDOUT' }), 'timeout', /逾時/],
    [Object.assign(new Error('SYNTHETIC_SECRET'), { name: 'TimeoutError' }), 'timeout', /逾時/],
    [new Error('SYNTHETIC_SECRET'), 'unknown', /匯出診斷/],
    [null, 'unknown', /匯出診斷/],
  ];
  for (const [error, reason, text] of cases) {
    const result = destinationEncryptionFailure(error);
    assert.equal(result.failureReason, reason); assert.match(result.warning, text);
    assert.ok(!JSON.stringify(result).includes('SYNTHETIC_SECRET'));
  }
});
