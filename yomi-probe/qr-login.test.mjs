import test from 'node:test';
import assert from 'node:assert/strict';
import { qrHandshake } from './qr-login.mjs';
import { encodeCallMessage, decodeResponseMessage } from './node_modules/@rikaidev/yomi/dist/line/core/thrift/index.js';

function fixture(override = {}) {
  const calls = [];
  const replies = {
    createSession: { 1: 'synthetic-session' },
    createQrCode: { 1: 'https://example.test/qr' },
    checkQrCodeVerified: {}, createPinCode: { 1: '123456' }, checkPinCodeVerified: {},
    qrCodeLogin: { 2: 'synthetic-token', 4: { keyId: 123 }, 5: 'synthetic-mid' },
  };
  return { calls, request: async (method, fields, options) => {
    const wire = decodeResponseMessage(encodeCallMessage(method, 1, fields));
    calls.push({ method, fields: wire.fields, options });
    return override[method] ? override[method]() : method === 'verifyCertificate' ? { type: 'REPLY', statusCode: 200, fields: { 1: { 1: 2 } } } : { type: 'REPLY', statusCode: 200, fields: { 0: replies[method] } };
  } };
}
test('iPad legacy QR handshake encodes PIN and device identity and maps legacy token/E2EE fields', async () => {
  const f = fixture(); let image, pin;
  const result = await qrHandshake({ request: f.request, onQr: value => { image = value; }, onPin: value => { pin = value; } });
  assert.match(image, /^data:image\/png;base64,/); assert.equal(pin, '123456');
  assert.equal(result.authToken, 'synthetic-token'); assert.deepEqual(result.metaData, { keyId: 123 });
  assert.equal(result.secretKey.length, 32);
  assert.equal(result.mid, 'synthetic-mid');
  assert.equal(result.refreshToken, undefined); assert.equal(result.durationUntilRefreshInSec, undefined);
  assert.deepEqual(f.calls.at(-1).fields[1], { 1: 'synthetic-session', 2: 'IOSIPAD', 3: true });
  assert.deepEqual(f.calls.map(x => x.method), ['createSession', 'createQrCode', 'checkQrCodeVerified', 'verifyCertificate', 'createPinCode', 'checkPinCodeVerified', 'qrCodeLogin']);
});
test('code zero is a failure and never exposes upstream text', async () => {
  const f = fixture({ qrCodeLogin: () => ({ type: 'REPLY', fields: { 1: { 1: 0, 2: 'private upstream text' } } }) });
  await assert.rejects(qrHandshake({ request: f.request, onQr() {}, onPin() {} }), error => /LINE code 0/.test(error.message) && !error.message.includes('private'));
});

test('temporary QR access and timeout headers stay scoped to long polls', async () => {
  const f = fixture();
  await qrHandshake({ request: f.request, onQr() {}, onPin() {} });
  assert.deepEqual(f.calls[0].options.headers, {});
  for (const call of f.calls.slice(1)) {
    assert.equal(call.options.headers['x-line-access'], call.options.poll ? 'synthetic-session' : undefined, call.method);
    assert.equal(call.options.headers['x-lst'], call.options.poll ? '30000' : undefined, call.method);
  }
});

test('final verification notice failure retains code 4 without exposing upstream data or retrying', async () => {
  const f = fixture({ qrCodeLogin: () => ({ type: 'REPLY', fields: { 1: { 1: 4, 2: 'private upstream text' } } }) });
  await assert.rejects(qrHandshake({ request: f.request, onQr() {}, onPin() {} }), error => error.lineCode === 4 && /完成 QR 裝置登入失敗（LINE code 4）/.test(error.message) && !error.message.includes('private'));
  assert.equal(f.calls.filter(x => x.method === 'qrCodeLogin').length, 1);
});
test('poll retries are bounded and do not finalize an unapproved session', async () => {
  const f = fixture({ checkQrCodeVerified: () => ({ statusCode: 410, error: 'empty_response' }) });
  await assert.rejects(qrHandshake({ request: f.request, onQr() {}, onPin() {} }), /逾時/);
  assert.equal(f.calls.filter(x => x.method === 'checkQrCodeVerified').length, 12);
  assert.ok(!f.calls.some(x => x.method === 'qrCodeLogin'));
});
test('cancel after QR rendering prevents subsequent requests', async () => {
  const f = fixture(), controller = new AbortController();
  await assert.rejects(qrHandshake({ request: f.request, signal: controller.signal, onQr() { controller.abort(); }, onPin() {} }), /已取消/);
  assert.equal(f.calls.length, 2);
});

for (const stage of ['checkQrCodeVerified', 'checkPinCodeVerified']) {
  test(`cancel during ${stage} releases login without waiting for the upstream poll`, async t => {
    const controller = new AbortController();
    let release, entered;
    const waiting = new Promise(resolve => { entered = resolve; });
    const upstream = new Promise(resolve => { release = resolve; });
    t.after(() => release({ type: 'REPLY', fields: { 0: {} } }));
    const f = fixture({ [stage]: () => { entered(); return upstream; } });
    let finished = false;
    const login = qrHandshake({ request: f.request, signal: controller.signal, onQr() {}, onPin() {} });
    const rejection = assert.rejects(login, /已取消/).then(() => { finished = true; });
    await waiting;
    controller.abort();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(finished, true, 'Cancellation must not wait for a network response');
    await rejection;
    assert.ok(!f.calls.some(call => call.method === 'qrCodeLogin'));
  });
}

test('finalization disables cancellation before the final login request is sent', async () => {
  const f = fixture(); let finalizing = false;
  await qrHandshake({ request: (...args) => {
    if (args[0] === 'qrCodeLogin') assert.equal(finalizing, true);
    return f.request(...args);
  }, onQr() {}, onPin() {}, onFinalizing() { finalizing = true; } });
  assert.equal(finalizing, true);
});

test('a remotely completed login survives the QR waiting deadline and late cancellation', async () => {
  const f = fixture(), controller = new AbortController();
  let time = 0;
  const result = await qrHandshake({ now: () => time, signal: controller.signal,
    request: async (...args) => {
      const reply = await f.request(...args);
      if (args[0] === 'qrCodeLogin') { time = 360001; controller.abort(); }
      return reply;
    }, onQr() {}, onPin() {} });
  assert.equal(result.authToken, 'synthetic-token');
  assert.equal(f.calls.filter(call => call.method === 'qrCodeLogin').length, 1);
});

test('legacy QR without nonce or V3 timing uses 30-second long polls', async () => {
  const f = fixture();
  await qrHandshake({ request: f.request, onQr() {}, onPin() {} });
  assert.deepEqual(f.calls.filter(x => x.options.poll).map(x => x.options.interval), [30, 30]);
});

test('long polling cannot extend beyond the remaining login budget', async () => {
  let time = 0;
  const f = fixture();
  await assert.rejects(qrHandshake({ now: () => time, request: async (...args) => {
    const reply = await f.request(...args);
    if (args[0] === 'checkQrCodeVerified') time = 360001;
    return reply;
  }, onQr() {}, onPin() {} }), /已逾時/);
  assert.ok(!f.calls.some(x => x.method === 'qrCodeLogin'));
});

test('accepted certificate verification skips PIN creation', async () => {
  const f = fixture({ verifyCertificate: () => ({ type: 'REPLY', statusCode: 200, fields: { 0: {} } }) });
  await qrHandshake({ request: f.request, onQr() {}, onPin() { assert.fail('Unexpected PIN'); } });
  assert.ok(!f.calls.some(x => x.method === 'createPinCode'));
});

test('certificate service errors stop login without masking failure as a PIN challenge', async () => {
  const f = fixture({ verifyCertificate: () => ({ type: 'REPLY', statusCode: 200, fields: { 1: { 1: 0, 2: 'private text' } } }) });
  await assert.rejects(qrHandshake({ request: f.request, onQr() {}, onPin() {} }), /驗證 QR 認證書失敗（LINE code 0）/);
  assert.ok(!f.calls.some(x => x.method === 'createPinCode' || x.method === 'qrCodeLogin'));
});

test('V3 response cannot be mistaken for a successful legacy login', async () => {
  const f = fixture({ qrCodeLogin: () => ({ type: 'REPLY', fields: { 0: { 3: { 1: 'synthetic-token' }, 4: 'synthetic-mid' } } }) });
  await assert.rejects(qrHandshake({ request: f.request, onQr() {}, onPin() {} }), /缺少登入結果/);
});

test('legacy JSON E2EE metadata is normalized and malformed JSON fails safely', async () => {
  const response = metadata => ({ type: 'REPLY', fields: { 0: { 2: 'synthetic-token', 4: metadata, 5: 'synthetic-mid' } } });
  const f = fixture({ qrCodeLogin: () => response('{"keyId":123}') });
  assert.deepEqual((await qrHandshake({ request: f.request, onQr() {}, onPin() {} })).metaData, { keyId: 123 });
  const bad = fixture({ qrCodeLogin: () => response('{private') });
  await assert.rejects(qrHandshake({ request: bad.request, onQr() {}, onPin() {} }), error => /金鑰資料格式異常/.test(error.message) && !error.message.includes('private'));
});
