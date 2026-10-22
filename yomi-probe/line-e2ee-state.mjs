import nacl from 'tweetnacl';

// A QR keychain may contain several generations, sometimes without timestamps.
// Keep every generation for reading, but use the explicitly issued key for send.
export function selectLineSelfKey(service, keyId) {
  const manager = service.e2eeManager;
  for (const key of manager.importedKeys.values()) {
    const secret = Buffer.from(key.privateKey), publicKey = Buffer.from(key.publicKey);
    if (secret.length !== 32 || publicKey.length !== 32 || !Buffer.from(nacl.scalarMult.base(secret)).equals(publicKey)) {
      throw new Error('Invalid LINE self key pair');
    }
  }
  const selected = keyId == null ? manager.getSelfKeyByMid(service.profile.mid) : manager.getSelfKeyById(keyId);
  if (!selected) throw new Error('Missing issued LINE self key');
  manager.selfKeyByMid.set(service.profile.mid, selected);
}

const installed = Symbol('lineport-session-validation');
export function guardLineSession(service) {
  if (service[installed]) return service;
  const resume = service.resumeSession.bind(service);
  service.resumeSession = async () => {
    if (!await resume()) return false;
    try {
      const mid = await service.credentialStore.get('line_mid');
      if (!mid || service.profile?.mid !== mid) throw new Error('LINE account mismatch');
      let savedKeys;
      try { savedKeys = JSON.parse(await service.credentialStore.get('line_e2ee_keys')); } catch {}
      if (Array.isArray(savedKeys) && savedKeys.some(key => key.mid !== mid)) throw new Error('LINE key account mismatch');
      const raw = await service.credentialStore.get('line_e2ee_bootstrap');
      const bootstrap = raw ? JSON.parse(raw) : null;
      if (bootstrap) {
        const { recoverBootstrapKeys } = await import('./node_modules/@rikaidev/yomi/dist/line/core/e2ee/recovery/bootstrap-keys.js');
        const manager = service.e2eeManager;
        // A non-empty cache can still lack older group receiver keys or the
        // issued send key. Merge every bootstrap generation without replacing
        // newer cached keys, persisting secrets, or rebinding the send key.
        await recoverBootstrapKeys({ profile: service.profile, credentialStore: service.credentialStore, e2eeManager: {
          importKeys(keys) {
            for (const key of keys) {
              const cached = manager.getSelfKeyById(key.keyId);
              if (cached && (!Buffer.from(cached.publicKey).equals(Buffer.from(key.publicKey))
                || !Buffer.from(cached.privateKey).equals(Buffer.from(key.privateKey)))) throw new Error('Conflicting LINE self key');
            }
            manager.importKeys(keys.filter(key => !manager.getSelfKeyById(key.keyId)));
          },
          bindSelfKeysToMid() {},
        } }, { persist: false });
      }
      selectLineSelfKey(service, bootstrap?.keyId);
      service.e2eeWarning = false;
      return true;
    } catch {
      service.e2eeWarning = true;
      service.loginRequired = true;
      service.setState('error');
      throw new Error('Saved LINE session or E2EE state validation failed');
    }
  };
  service[installed] = true;
  return service;
}
