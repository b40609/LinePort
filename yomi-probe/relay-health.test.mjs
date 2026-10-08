import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectRelayRead, relayWarning, requireRelayEncryption } from './relay-health.mjs';

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
  assert.deepEqual(lastRead, { received: 5, eligible: 1, decryptFailed: 1, invalidTime: 1, history: 1 });
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
