import path from 'node:path';
import { readdir, lstat, statfs, mkdir, copyFile, readFile, open } from 'node:fs/promises';
import { constants, createReadStream } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { RelayError } from './relay-health.mjs';

export const MAX_JOURNAL_BYTES = 16 * 1024 * 1024;
export const MAX_DATA_BYTES = 256 * 1024 * 1024;
export const MIN_FREE_BYTES = 64 * 1024 * 1024;
const included = name => /^(?:lineport-(?:route-[a-f0-9]{64}|review-[a-f0-9]{64}|telegram-inbox-\d+|output)\.jsonl|lineport-rules\.json|relay-(?:[a-f0-9]{24}|source1-destination2)\.jsonl)$/.test(name);
async function hashFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
// Verify a copied archive without restoring, changing or deleting any live data.
export async function verifySnapshot(target) {
  const folder = await lstat(target), manifestFile = path.join(target, 'manifest.json');
  if (!folder.isDirectory() || folder.isSymbolicLink()) throw new RelayError('封存目錄異常；不使用捷徑或連結目錄');
  const info = await lstat(manifestFile);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) throw new RelayError('封存清單異常或不完整；請保留原資料');
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
  if (manifest.version !== 1 || !Array.isArray(manifest.files) || manifest.files.length > 10000) throw new RelayError('封存清單格式不支援；請保留原資料');
  const seen = new Set();
  let bytes = 0;
  for (const entry of manifest.files) {
    if (!entry || typeof entry.name !== 'string' || !included(entry.name) || seen.has(entry.name) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new RelayError('封存清單含無效或重複檔案；請保留原資料');
    seen.add(entry.name);
    const file = path.join(target, entry.name), before = await lstat(file);
    if (!before.isFile() || before.isSymbolicLink() || before.size !== entry.bytes || await hashFile(file) !== entry.sha256) throw new RelayError('封存檔案大小或 SHA-256 不符；封存不可作為已驗證備份，原資料仍須保留');
    const after = await lstat(file);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new RelayError('封存核對期間被修改；請停止其他程序後重試');
    bytes += entry.bytes;
  }
  const entries = await readdir(target);
  if (entries.some(name => name !== 'manifest.json' && !seen.has(name))) throw new RelayError('封存目錄有清單外檔案；請保留原資料並核對完整性');
  return { verified: true, files: seen.size, bytes };
}
export async function readJournalFile(file) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_JOURNAL_BYTES) throw new RelayError('本機紀錄超過安全讀取容量或檔案異常；已停止相關路線，請私下備份並保留原檔，勿刪改去重／待送紀錄');
  return readFile(file, 'utf8');
}
export async function storageHealth(directory) {
  let bytes = 0, files = 0, largest = 0;
  for (const name of await readdir(directory)) {
    if (!included(name)) continue;
    const info = await lstat(path.join(directory, name));
    if (!info.isFile() || info.isSymbolicLink()) throw new RelayError('資料目錄含異常紀錄檔案，請停止並檢查，勿刪改原資料');
    bytes += info.size; files++; largest = Math.max(largest, info.size);
  }
  const disk = await statfs(directory);
  const freeBytes = disk.bavail * disk.bsize;
  const blocked = freeBytes < MIN_FREE_BYTES || bytes >= MAX_DATA_BYTES || largest >= MAX_JOURNAL_BYTES;
  return { bytes, files, largest, freeBytes, blocked, warning: blocked ? '儲存容量已達保守上限；新收件與發送停止，請停止服務並私下備份，保留全部待送與去重證據'
    : bytes >= MAX_DATA_BYTES * .8 || largest >= MAX_JOURNAL_BYTES * .8 || freeBytes < MIN_FREE_BYTES * 4 ? '儲存容量接近上限，請安排停止與私人封存；封存不會清除原資料或增加可用空間' : '' };
}
export async function assertWritable(file) {
  const disk = await statfs(path.dirname(file));
  if (disk.bavail * disk.bsize < MIN_FREE_BYTES) throw new RelayError('可用磁碟空間不足 64 MiB，已停止寫入／發送，請釋放其他資料的空間並保留本程式紀錄');
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size >= MAX_JOURNAL_BYTES) throw new RelayError('紀錄容量已達 16 MiB 或檔案異常，已停止；請私人封存並保留原檔');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
export async function privateSnapshot(directory) {
  const health = await storageHealth(directory);
  if (health.freeBytes < health.bytes + MIN_FREE_BYTES) throw new RelayError('磁碟空間不足以完整封存，請保留原資料並先釋放其他資料的空間');
  const name = `lineport-private-archive-${randomUUID()}`;
  const target = path.join(directory, name);
  await mkdir(target, { mode: 0o700 });
  const files = [];
  for (const entry of await readdir(directory)) {
    if (!included(entry)) continue;
    const source = path.join(directory, entry), before = await lstat(source);
    if (!before.isFile() || before.isSymbolicLink()) throw new RelayError('封存遇到異常檔案，原檔未變更；請保留不完整封存並排查');
    const dest = path.join(target, entry);
    await copyFile(source, dest, constants.COPYFILE_EXCL);
    const copied = await open(dest, 'r+');
    try { await copied.sync(); } finally { await copied.close(); }
    const copiedHash = await hashFile(dest), sourceHash = await hashFile(source);
    const after = await lstat(source);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || copiedHash !== sourceHash) throw new RelayError('封存期間紀錄被其他程序修改，請保留原檔與不完整封存，停止其他程序後重試');
    files.push({ name: entry, bytes: after.size, sha256: copiedHash });
  }
  const handle = await open(path.join(target, 'manifest.json'), 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify({ version: 1, at: new Date().toISOString(), files })); await handle.sync(); }
  finally { await handle.close(); }
  const verified = await verifySnapshot(target);
  return { archive: name, ...verified };
}
