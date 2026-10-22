import { createHash } from 'node:crypto';
import * as nodeModule from 'node:module';

const target = new URL('./node_modules/@rikaidev/yomi/dist/line/core/e2ee/keys/group-key.js', import.meta.url).href;
const sourceHash = '77a47e3af9c3d5a3475258d3a17b12cc2f54f78986035e70b2fa08f9142ce38c';
const original = `    const creatorPublicKey = creator === selfMid
        ? selfKey.publicKey
        : await getPeerPublicKey(ctx, creator, creatorKeyId);`;
const corrected = `    // The envelope's receiver and creator can be different keys of one account.
    // ECDH requires the receiver's private key and the creator's exact public key.
    const creatorSelfKey = creator === selfMid ? ctx.getSelfKeyById(creatorKeyId) : null;
    const creatorPublicKey = creatorSelfKey
        ? creatorSelfKey.publicKey
        : await getPeerPublicKey(ctx, creator, creatorKeyId);`;

export function patchYomiGroupKey(source) {
  const text = Buffer.from(source).toString('utf8').replaceAll('\r\n', '\n');
  // Fail on an unreviewed dependency instead of guessing where to patch crypto.
  if (createHash('sha256').update(text).digest('hex') !== sourceHash || !text.includes(original)) {
    throw new Error('Unsupported Yomi group-key implementation; reinstall pinned dependencies');
  }
  return text.replace(original, corrected);
}

// Node's loader hook changes only this pinned module in memory. npm ci and
// read-only application directories remain supported; node_modules is untouched.
export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  return url === target ? { ...result, source: patchYomiGroupKey(result.source) } : result;
}

let installed = false;
export function installYomiE2EEFix() {
  if (installed) return;
  if (typeof nodeModule.registerHooks === 'function') {
    nodeModule.registerHooks({ load(url, context, nextLoad) {
      const result = nextLoad(url, context);
      return url === target ? { ...result, source: patchYomiGroupKey(result.source) } : result;
    } });
  } else {
    // Yomi also supports Node 22.13/22.14, before synchronous hooks existed.
    nodeModule.register(import.meta.url, import.meta.url);
  }
  installed = true;
}
