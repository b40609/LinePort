import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { patchYomiGroupKey } from './yomi-e2ee-compat.mjs';

const run = promisify(execFile);
const directory = fileURLToPath(new URL('.', import.meta.url));
// Each subprocess starts with a cold module cache. Only synthetic keys and an
// in-memory store are used; no credential store or network is opened.
const fixture = `
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import nacl from 'tweetnacl';
import https from 'node:https';
https.request = () => { throw new Error('Unexpected network request in synthetic E2EE test'); };
if (process.env.SYNTHETIC_E2EE_FIX === 'async') {
  const { register } = await import('node:module');
  register(new URL('./yomi-e2ee-compat.mjs',import.meta.url),import.meta.url);
} else if (process.env.SYNTHETIC_E2EE_FIX === '1') {
  const { installYomiE2EEFix } = await import('./yomi-e2ee-compat.mjs');
  installYomiE2EEFix(); installYomiE2EEFix();
}
const { KeyManager } = await import('./node_modules/@rikaidev/yomi/dist/line/core/e2ee/keys/key-manager.js');
const { LineProtocolService } = await import('./node_modules/@rikaidev/yomi/dist/line/core/service.js');
const { prepareRelayDestination, sendRelayText } = await import('./relay-send.mjs');
const mid = 'usynthetic', chat = 'csynthetic';
const logger = { info() {}, warn() {}, error() {}, debug() {} };
function pair(seed, keyId) {
  const keys = nacl.box.keyPair.fromSecretKey(Buffer.alloc(32, seed));
  return { keyId, createdTime: Number(keyId), publicKey: Buffer.from(keys.publicKey), privateKey: Buffer.from(keys.secretKey) };
}
const creator = pair(1, '101'), receiver = pair(2, '202'), group = pair(3, '303');
const hash = (...parts) => createHash('sha256').update(Buffer.concat(parts.map(p => Buffer.from(p)))).digest();
const shared = (priv, pub) => Buffer.from(nacl.scalarMult(priv, pub));
function envelope(creatorKey = creator, creatorMid = mid, numeric = false) {
  const secret = shared(creatorKey.privateKey, receiver.publicKey);
  const ivHash = hash(secret, 'IV');
  const iv = Buffer.from(ivHash.subarray(0,16).map((b, i) => b ^ ivHash[i+16]));
  const cipher = createCipheriv('aes-256-cbc', hash(secret, 'Key'), iv);
  const encrypted = Buffer.concat([cipher.update(group.privateKey), cipher.final()]);
  return numeric
    ? { 2: 303, 3: creatorMid, 4: Number(creatorKey.keyId), 6: 202, 7: encrypted.toString('base64') }
    : { groupKeyId: 303, creator: creatorMid, creatorKeyId: Number(creatorKey.keyId), receiverKeyId: 202, encryptedSharedKey: encrypted };
}
function setup({ creatorKey = creator, creatorMid = mid, numeric = false, imported = [creator,receiver], peerKey = creator, destination = chat, restored = false } = {}) {
  const store = new Map(); let fetches = 0, negotiations = 0, sends = 0;
  const service = new LineProtocolService({ credentialStore: { get: async k => store.get(k), set: async (k,v) => store.set(k,v) }, logger });
  service.profile = { mid };
  service.client = {
    logger,
    async getLastE2EEGroupSharedKey(version, to) { assert.equal(version,2); assert.equal(to,destination); fetches++; return envelope(creatorKey,creatorMid,numeric); },
    async negotiateE2EEPublicKey(to) { assert.equal(to,creatorMid); negotiations++; return { keyId: Number(peerKey.keyId), keyData: peerKey.publicKey }; },
    async sendMessage(message) { sends++; assert.ok(message.chunks); return {id:'synthetic-ack',...message}; },
    registerE2EEGroupKey() { assert.fail('Must never rotate a group key'); },
  };
  service.e2eeManager.importKeys(restored ? JSON.parse(JSON.stringify(imported)) : imported);
  service.e2eeManager.bindSelfKeysToMid(mid);
  return { service, store, counts: () => ({fetches,negotiations,sends}) };
}
function decryptIndependently(payload, to = chat) {
  const [salt, sealed, nonce, senderId, groupId] = payload.chunks;
  const aad = Buffer.concat([Buffer.from(to),Buffer.from(mid),senderId,groupId,Buffer.from([0,0,0,2,0,0,0,0])]);
  const decipher = createDecipheriv('aes-256-gcm',hash(shared(group.privateKey,receiver.publicKey),salt,'Key'),nonce);
  decipher.setAAD(aad); decipher.setAuthTag(sealed.subarray(-16));
  return JSON.parse(Buffer.concat([decipher.update(sealed.subarray(0,-16)),decipher.final()]).toString());
}
`;

async function scenario(code, fixed = true) {
  const result = await run(process.execPath, ['--input-type=module', '-e', fixture + code], {
    cwd: directory, timeout: 15000,
    env: { ...process.env, SYNTHETIC_E2EE_FIX: fixed === 'async' ? 'async' : fixed ? '1' : '0' },
    windowsHide: true,
  });
  // Yomi probes macOS at import time even on Windows; do not hide other warnings.
  let warnings = result.stderr.replace(/^.*sw_vers.*(?:\r?\n|$)/gm, '');
  if (fixed === 'async') warnings = warnings.replace(/^.*(?:DEP0205|trace-deprecation|ExperimentalWarning|trace-warnings).*(?:\r?\n|$)/gm, '');
  assert.equal(warnings, '');
}

test('unpatched Yomi reproduces startup failure with different creator and receiver keys of one account', async () => {
  await scenario(`
    const f = setup();
    await assert.rejects(prepareRelayDestination(f.service, chat));
    assert.equal(f.counts().sends, 0);
  `, false);
});

test('patched service preflight and text send use the exact creator key, with authenticated round trip', async () => {
  await scenario(`
    for (const numeric of [false,true]) {
      for (const destination of [chat,'rsynthetic']) {
        const f = setup({numeric,destination});
        await prepareRelayDestination(f.service, destination);
        assert.deepEqual(f.counts(), {fetches:1,negotiations:0,sends:0});
        assert.deepEqual(f.service.e2eeManager.groupKeys.get(destination+':303').privateKey, group.privateKey);
        const sent = await sendRelayText(f.service, destination, '合成測試🔥');
        assert.deepEqual(decryptIndependently(sent,destination), {text:'合成測試🔥'});
        assert.equal(f.counts().sends,1);
        // Read after a cold restart must also resolve the correct key, without a send-side cache.
        const resumed = setup({numeric,destination,restored:true});
        const decoded = await resumed.service.e2eeManager.tryDecrypt({...sent,from:mid,to:destination,toType:1});
        assert.equal(decoded.decrypted,true);
        assert.equal(decoded.text,'合成測試🔥');
      }
    }
  `);
});

test('unchanged key and another group creator keep working', async () => {
  await scenario(`
    for (const options of [{creatorKey:receiver},{creatorMid:'uother',imported:[receiver]}]) {
      const f = setup(options);
      const sent = await f.service.e2eeManager.encryptE2EEMessage(chat,'synthetic',0);
      assert.deepEqual(decryptIndependently(sent),{text:'synthetic'});
    }
  `);
});

test('asynchronous loader fallback applies the same key fix', async () => {
  await scenario(`
    const f = setup({restored:true});
    await prepareRelayDestination(f.service,chat);
    assert.deepEqual(f.service.e2eeManager.groupKeys.get(chat+':303').privateKey,group.privateKey);
    assert.equal(f.counts().sends,0);
  `,'async');
});

test('missing imported creator key resolves only its exact public key, rejecting a mismatched key', async () => {
  await scenario(`
    const f = setup({imported:[receiver]});
    await prepareRelayDestination(f.service,chat);
    assert.equal(f.counts().negotiations,1);
    assert.equal(f.counts().sends,0);
    const wrong = setup({imported:[receiver],peerKey:receiver});
    await assert.rejects(prepareRelayDestination(wrong.service,chat),/key mismatch/);
    assert.equal(wrong.counts().sends,0);
    const absent = setup({imported:[creator]});
    await assert.rejects(prepareRelayDestination(absent.service,chat),/Missing self E2EE key/);
    assert.equal(absent.counts().sends,0);
  `);
});

test('compatibility hook rejects unreviewed source and leaves installed dependency unchanged', async () => {
  const source = await readFile(new URL('./node_modules/@rikaidev/yomi/dist/line/core/e2ee/keys/group-key.js', import.meta.url));
  assert.throws(() => patchYomiGroupKey(Buffer.concat([source, Buffer.from('\n// unreviewed')])) , /Unsupported Yomi/);
  assert.equal(patchYomiGroupKey(source).includes('ctx.getSelfKeyById(creatorKeyId)'),true);
  await scenario(`await prepareRelayDestination(setup().service,chat);`);
  assert.deepEqual(await readFile(new URL('./node_modules/@rikaidev/yomi/dist/line/core/e2ee/keys/group-key.js', import.meta.url)),source);
  const runtime = await readFile(new URL('./runtime.mjs', import.meta.url),'utf8');
  assert.ok(runtime.indexOf('  installYomiE2EEFix();') < runtime.indexOf('  await configureLineDevice('));
});
