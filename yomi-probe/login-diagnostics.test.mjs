import test from 'node:test';
import assert from 'node:assert/strict';
import { loginDiagnostic, loginFailureMessage } from './login-diagnostics.mjs';

test('passwordless response diagnostics expose only stage and numeric codes', () => {
  const error = new Error('createSession failed: ' + JSON.stringify({ fields: { 1: { 1: 89, 2: 'SYNTHETIC_SECRET' }, 0: { 1: 'SYNTHETIC_SESSION' } }, statusCode: 403, nextToken: 'SYNTHETIC_TOKEN' }));
  const diagnostic = loginDiagnostic(error, 'logging_in');
  assert.deepEqual(diagnostic, { stage: 'createSession', httpStatus: 403, lineCode: 89, networkCode: null, timeout: false });
  const message = loginFailureMessage(diagnostic, 'iPad 實驗模式');
  assert.match(message, /建立登入工作階段失敗.*HTTP 403.*LINE code 89/);
  assert.ok(!JSON.stringify({ diagnostic, message }).includes('SYNTHETIC'));
});

test('final login codes, PIN timeout and network failures stay distinguishable', () => {
  assert.equal(loginDiagnostic(new Error('loginV2 failed: code=20 msg="SYNTHETIC_SECRET"')).lineCode, 20);
  assert.equal(loginDiagnostic(new Error('requestPinCodeVerif failed: {"error":"timeout"}')).timeout, true);
  assert.equal(loginDiagnostic(Object.assign(new Error('private hostname'), { code: 'ENOTFOUND' })).networkCode, 'ENOTFOUND');
  assert.equal(loginDiagnostic(new Error('PIN verification failed or timed out'), 'waiting_pin').stage, 'pin');
});

test('unknown and malformed error formats cannot leak strings as codes', () => {
  for (const message of ['SYNTHETIC_SECRET', 'createSession failed: invalid SYNTHETIC_SECRET', 'loginV2 failed: code=SYNTHETIC_SECRET', 'createSession failed: {"statusCode":"SYNTHETIC_SECRET","fields":{"1":{"1":"SYNTHETIC_SECRET"}}}']) {
    const diagnostic = loginDiagnostic(Object.assign(new Error(message), { code: 'SYNTHETIC_SECRET' }));
    assert.equal(diagnostic.httpStatus, null);
    assert.equal(diagnostic.lineCode, null);
    assert.equal(diagnostic.networkCode, null);
    assert.ok(!loginFailureMessage(diagnostic, 'iPad 實驗模式').includes('SYNTHETIC'));
  }
});
