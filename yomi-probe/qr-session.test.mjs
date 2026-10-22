import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash, createCipheriv } from 'node:crypto';
import https from 'node:https';
import nacl from 'tweetnacl';
import { completeQrLogin } from './qr-login.mjs';
import { guardLineSession } from './line-e2ee-state.mjs';
import { LineProtocolService } from './node_modules/@rikaidev/yomi/dist/line/core/service.js';
import { LineClient } from './node_modules/@rikaidev/yomi/dist/line/client/index.js';
import { writeFieldsArray } from './node_modules/@rikaidev/yomi/dist/line/core/thrift/struct/writer.js';

const originalRequest = https.request, originalTalk = LineClient.prototype.sendTalk;
https.request = () => { throw new Error('Unexpected network call'); };
LineClient.prototype.sendTalk = async method => {
  assert.equal(method, 'getProfile');
  return { fields: { 0: { 1: 'usynthetic', 20: 'Synthetic profile' } } };
};
after(() => { https.request = originalRequest; LineClient.prototype.sendTalk = originalTalk; });
const logger = { info() {}, warn() {}, error() {}, debug() {} };
const pair = seed => nacl.box.keyPair.fromSecretKey(Buffer.alloc(32, seed));
function fixture({ count = 8, invalidPair = false, keyId = 108 } = {}) {
  const ours = pair(40), server = pair(41);
  const structs = Array.from({ length: count }, (_, index) => {
    const key = pair(index + 1);
    return Buffer.concat([writeFieldsArray([[8, 1, 1], [8, 2, 101 + index], [11, 4, Buffer.from(key.publicKey)], [11, 5, Buffer.from(invalidPair && !index ? pair(99).secretKey : key.secretKey)]], { v: 0 }), Buffer.from([0])]);
  });
  const plain = Buffer.concat([Buffer.from([0x19, count << 4 | 12]), ...structs, Buffer.from([0])]);
  const shared = Buffer.from(nacl.scalarMult(server.secretKey, ours.publicKey));
  const hash = label => createHash('sha256').update(shared).update(label).digest();
  const ivHash = hash('IV'), iv = Buffer.from(ivHash.subarray(0, 16).map((value, index) => value ^ ivHash[index + 16]));
  const cipher = createCipheriv('aes-256-cbc', hash('Key'), iv);
  return { authToken: 'synthetic-token', mid: 'usynthetic', secretKey: Buffer.from(ours.secretKey), publicKey: Buffer.from(ours.publicKey), metaData: {
    encryptedKeyChain: Buffer.concat([cipher.update(plain), cipher.final()]).toString('base64'), publicKey: Buffer.from(server.publicKey).toString('base64'), keyId, e2eeVersion: 1,
  } };
}
function memory(drop) {
  const values = new Map(), writes = [];
  return { values, writes, get: async key => values.get(key), set: async (key, value) => { writes.push(key); if (key !== drop) values.set(key, value); } };
}
function service(store = memory()) { return guardLineSession(new LineProtocolService({ credentialStore: store, logger })); }
const createClient = token => Object.assign(new EventEmitter(), { authToken: token, getProfile: async () => ({ mid: 'usynthetic' }) });

test('real QR bootstrap retains eight key generations and selects the issued ID without timestamps', async () => {
  const store = memory(), live = service(store);
  let completed = 0; live.on('loginComplete', () => completed++);
  await completeQrLogin(live, fixture(), { createClient });
  assert.equal(live.e2eeManager.importedKeys.size, 8);
  assert.equal(Number(live.e2eeManager.getSelfKeyByMid('usynthetic').keyId), 108);
  assert.equal(live.state, 'connected'); assert.equal(completed, 1);
  const before = [...store.values], writes = store.writes.length;
  const restored = service(store);
  assert.equal(await restored.resumeSession(), true);
  assert.equal(restored.e2eeManager.importedKeys.size, 8);
  assert.equal(Number(restored.e2eeManager.getSelfKeyByMid('usynthetic').keyId), 108);
  assert.deepEqual([...store.values], before); assert.equal(store.writes.length, writes);
  assert.equal(guardLineSession(restored), restored);
});

for (const blob of [undefined, '[]', '{broken']) test(`restart recovers bootstrap read-only when key cache is ${String(blob)}`, async () => {
  const store = memory(); await completeQrLogin(service(store), fixture(), { createClient });
  store.values.set('line_e2ee_keys', blob);
  const before = [...store.values], writes = store.writes.length, restored = service(store);
  assert.equal(await restored.resumeSession(), true);
  assert.equal(Number(restored.e2eeManager.getSelfKeyByMid('usynthetic').keyId), 108);
  assert.equal(restored.e2eeManager.importedKeys.size, 8);
  assert.deepEqual([...store.values], before); assert.equal(store.writes.length, writes);
});

for (const dropped of ['line_auth_token', 'line_mid', 'line_e2ee_keys', 'line_e2ee_bootstrap']) test(`QR does not report success if storage silently drops ${dropped}`, async () => {
  const store = memory(dropped), live = service(store);
  store.values.set(dropped, dropped === 'line_e2ee_keys' ? '[]' : 'old-synthetic-value');
  let completed = false; live.on('loginComplete', () => completed = true);
  await assert.rejects(completeQrLogin(live, fixture(), { createClient }), error => /保存登入與加密金鑰/.test(error.message) && !error.message.includes('synthetic-token'));
  assert.equal(completed, false); assert.equal(live.state, 'error'); assert.equal(live.loginRequired, true);
});

for (const options of [{ count: 0 }, { invalidPair: true }, { keyId: 999 }]) test(`QR rejects invalid key material ${JSON.stringify(options)}`, async () => {
  const live = service(); await assert.rejects(completeQrLogin(live, fixture(options), { createClient }), /初始化加密金鑰/);
  assert.equal(live.state, 'error'); assert.equal(live.loginRequired, true);
});

test('QR profile mismatch fails before saving credentials or importing keys', async () => {
  const store = memory(), live = service(store);
  await assert.rejects(completeQrLogin(live, fixture(), { createClient: token => Object.assign(createClient(token), { getProfile: async () => ({ mid: 'uother' }) }) }), /帳號識別不一致/);
  assert.equal(store.writes.length, 0); assert.equal(live.e2eeManager.importedKeys.size, 0);
});

test('restart rejects a saved account mismatch without changing durable state', async () => {
  const store = memory(); await completeQrLogin(service(store), fixture(), { createClient });
  store.values.set('line_mid', 'uother');
  const before = [...store.values], restored = service(store);
  await assert.rejects(restored.resumeSession(), /validation failed/);
  assert.equal(restored.state, 'error'); assert.equal(restored.loginRequired, true); assert.deepEqual([...store.values], before);
});

test('restart rejects a foreign-account key cache without rewriting it', async () => {
  const store = memory(); await completeQrLogin(service(store), fixture(), { createClient });
  const keys = JSON.parse(store.values.get('line_e2ee_keys')); keys[0].mid = 'uother';
  store.values.set('line_e2ee_keys', JSON.stringify(keys));
  const before = [...store.values];
  await assert.rejects(service(store).resumeSession(), /validation failed/);
  assert.deepEqual([...store.values], before);
});
