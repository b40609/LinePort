import path from 'node:path';
import { readFile, readdir, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { appendRecord, parseJournal } from './relay-core.mjs';
import { HttpError } from './local-http.mjs';
import { describePayload } from './media-payload.mjs';
import { readJournalFile } from './storage-health.mjs';

async function readOptional(file) {
  try {
    if (!(await lstat(file)).isFile()) throw new Error('Invalid journal file');
    return await readJournalFile(file);
  } catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
}
export async function inspectDelivery(directory, identity) {
  try { return await readDelivery(directory, identity); }
  catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(409, '處理紀錄無法讀取、格式不完整或磁碟異常；相關配對保持暫停，請保留原檔並檢查磁碟與權限，不要刪改紀錄');
  }
}
async function readDelivery(directory, identity) {
  if (!/^[a-f0-9]{64}$/.test(identity)) throw new HttpError(400, '處理紀錄識別碼不正確');
  const journal = await readOptional(path.join(directory, `lineport-route-${identity}.jsonl`));
  const saved = parseJournal(journal);
  if (saved.routeIdentity !== identity) throw new HttpError(409, '路線紀錄不符，請保留資料並重新檢查');
  const unresolved = new Set();
  let route = null;
  for (const line of journal.split('\n').filter(Boolean)) {
    const row = JSON.parse(line);
    if (row.routeIdentity) route = { name: String(row.name || '').slice(0, 100), source: String(row.source?.name || '').slice(0, 100), destination: String(row.destination?.name || '').slice(0, 100) + (row.destination?.threadId !== undefined ? `（話題 #${row.destination.threadId}）` : '') };
    if (['sending', 'uncertain'].includes(row.outcome)) unresolved.add(row.id);
    if (['sent', 'retry'].includes(row.outcome)) unresolved.delete(row.id);
  }
  const review = await readOptional(path.join(directory, `lineport-review-${identity}.jsonl`));
  if (review && !review.endsWith('\n')) throw new Error('Incomplete review journal');
  const resolutions = [], quarantined = [];
  let fastForwardAt = 0;
  for (const line of review.split('\n').filter(Boolean)) {
    const row = JSON.parse(line);
    // Version 3: automatic soft quarantine of a definite per-message rejection (queued or attempted, never uncertain).
    if (row.version === 3) {
      if (row.quarantined !== true || row.decision !== 'skip' || !['prepare', 'send'].includes(row.phase) || typeof row.reason !== 'string' || row.reason.length > 200
        || !Number.isSafeInteger(row.at) || row.at <= 0 || !(saved.pending.has(row.id) || unresolved.has(row.id))) throw new Error('Invalid review journal');
      unresolved.delete(row.id); saved.pending.delete(row.id); quarantined.push(row);
      continue;
    }
    if (![1, 2].includes(row.version) || !unresolved.has(row.id) || !['received', 'skip'].includes(row.decision) || !Number.isSafeInteger(row.at) || row.at <= 0) throw new Error('Invalid review journal');
    // Version 2 rows fast-forward the route; older releases reject them and keep the route paused (fail closed).
    if (row.version === 2) {
      if (row.fastForward !== true || row.decision !== 'received' || !Array.isArray(row.dropped) || row.dropped.length > 100000 || row.dropped.some(id => typeof id !== 'string')) throw new Error('Invalid review journal');
      for (const id of row.dropped) saved.pending.delete(id);
      fastForwardAt = Math.max(fastForwardAt, row.at);
    } else if ('fastForward' in row || 'dropped' in row) throw new Error('Invalid review journal');
    unresolved.delete(row.id); saved.pending.delete(row.id); resolutions.push(row);
  }
  return { identity, revision: createHash('sha256').update(JSON.stringify([journal, review])).digest('hex'),
    unresolved, pending: saved.pending, resolutions, quarantined, route, fastForwardAt, startedAt: saved.startedAt };
}
export function createDeliveryReviewStore(directory, { now = Date.now } = {}) {
  return {
    async list() {
      const items = [], quarantined = [];
      for (const name of await readdir(directory)) {
        const match = /^lineport-route-([a-f0-9]{64})\.jsonl$/.exec(name);
        if (!match) continue;
        const result = await inspectDelivery(directory, match[1]);
        for (const row of result.quarantined) quarantined.push({ identity: result.identity, id: row.id, phase: row.phase, reason: row.reason, at: new Date(row.at).toISOString(), route: result.route });
        if (!result.unresolved.size) continue;
        // A blocked route writes nothing more, so the journal's last write marks when it stopped.
        const blockedSince = new Date((await lstat(path.join(directory, name))).mtimeMs).toISOString();
        const backlog = [...result.pending.keys()].filter(id => !result.unresolved.has(id)).length;
        for (const id of result.unresolved) items.push({ identity: result.identity, revision: result.revision, id, text: describePayload(result.pending.get(id) || ''),
          pending: result.pending.size, backlog, blockedSince, route: result.route });
      }
      return { items, quarantined: quarantined.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 50) };
    },
    async resolve(input) {
      if (!['received', 'skip'].includes(input.decision)) throw new HttpError(400, '請逐筆選擇確認收到或略過；不提供重送');
      if (input.fastForward !== undefined && (input.fastForward !== true || input.decision !== 'received')) throw new HttpError(400, '快轉只能搭配「確認目的已收到」');
      const result = await inspectDelivery(directory, input.identity);
      if (result.revision !== input.revision || !result.unresolved.has(input.id)) throw new HttpError(409, '紀錄已變更，請重新載入後核對');
      // Fast-forward drops the queued backlog and moves the route's cursor to now; the audit row lists every dropped ID.
      const dropped = input.fastForward ? [...result.pending.keys()].filter(id => id !== input.id && !result.unresolved.has(id)) : [];
      const at = now();
      const row = input.fastForward ? { version: 2, id: input.id, decision: 'received', fastForward: true, dropped, at } : { version: 1, id: input.id, decision: input.decision, at };
      try { await appendRecord(path.join(directory, `lineport-review-${input.identity}.jsonl`), row); }
      catch { throw new HttpError(409, '人工決策未能確認保存；請保持停止、檢查磁碟與權限後重新載入核對，不要重送或刪改原紀錄'); }
      return { resolved: true, decision: input.decision, ...(input.fastForward ? { fastForward: true, dropped: dropped.length } : {}) };
    },
  };
}
