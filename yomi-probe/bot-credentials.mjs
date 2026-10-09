import path from 'node:path';
import { lstat, readFile } from 'node:fs/promises';
import { protectToken, unprotectToken } from './dpapi.mjs';
import { RelayError } from './relay-health.mjs';

export function botCredentials(directory, platform, write, { protect = protectToken, unprotect = unprotectToken } = {}) {
  const plain = path.join(directory, `lineport-${platform}.json`), protectedFile = path.join(directory, `lineport-${platform}-protected.json`);
  async function read(file) {
    try {
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 32768) throw new Error();
      const record = JSON.parse(await readFile(file, 'utf8'));
      if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error();
      return record;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw new RelayError('Bot 憑證檔案無法讀取；請保留原檔並重新連結平台，不能自動退回舊 Token');
    }
  }
  return {
    async token() {
      const record = await read(protectedFile);
      if (record) return unprotect(record);
      const old = await read(plain);
      return old?.token || process.env[`LINEPORT_${platform.toUpperCase()}_TOKEN`] || '';
    },
    async protected() { return Boolean(await read(protectedFile)); },
    async save(token, useProtection = false) {
      // Once opted in, reconnects remain protected. Keep legacy plaintext untouched for recovery.
      try {
        if (useProtection || await this.protected()) await write(protectedFile, await protect(token));
        else await write(plain, { token });
      } catch (error) {
        if (error instanceof RelayError) throw error;
        throw new RelayError('Bot 憑證保存失敗，原設定保留；請檢查磁碟空間與資料目錄權限後重新連結');
      }
    },
  };
}
