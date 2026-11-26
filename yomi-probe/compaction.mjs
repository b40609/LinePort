// Safe, stopped-state compaction of the append-only journals (docs/DATA-RETENTION.md).
// 1. A verified private snapshot (SHA-256 manifest) is taken first and always kept.
// 2. Candidates are written to a fresh directory and fsynced.
// 3. Each candidate is re-parsed and compared with the original's meaning (seen IDs, queue,
//    unresolved sends, retry deadline, reply mappings, outputs, Telegram offset), then hashed.
// 4. Files are switched one at a time with an atomic rename, after re-checking the original is
//    unchanged. Every compacted file is self-consistent on its own, so a crash between renames
//    still leaves a readable data set.
import path from 'node:path';
import { readdir, lstat, mkdir, open, rename, readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { parseJournal } from './relay-core.mjs';
import { privateSnapshot, readJournalFile } from './storage-health.mjs';
import { RelayError } from './relay-health.mjs';
import { journalPayload, payloadVersion } from './media-payload.mjs';

const ROUTE = /^lineport-route-([a-f0-9]{64})\.jsonl$/;
const INBOX = /^lineport-telegram-inbox-\d+\.jsonl$/;
const OUTPUT = 'lineport-output.jsonl';
const PLACEHOLDER = '（已壓縮：原文已送達，保存在壓縮前的私人封存）';
export const RECENT_BODIES = 500;
const sha256 = text => createHash('sha256').update(text).digest('hex');
const rowsOf = text => text.split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
const jsonl = rows => rows.map(row => JSON.stringify(row) + '\n').join('');

function routeMeaning(text, now) {
  const parsed = parseJournal(text);
  return {
    routeIdentity: parsed.routeIdentity, startedAt: parsed.startedAt,
    seen: [...parsed.seen].sort(), unresolved: [...parsed.doubts.keys()].sort(),
    doubts: [...parsed.doubts.entries()].sort((a, b) => a[0].localeCompare(b[0])),
    pending: [...parsed.pending.entries()], replies: [...parsed.replies.entries()].filter(([id]) => parsed.pending.has(id)).sort(),
    delivered: [...parsed.delivered.entries()].sort(), retryAt: parsed.retryAt > now ? parsed.retryAt : 0,
  };
}
export function compactRouteJournal(text, { now = Date.now(), recentBodies = RECENT_BODIES } = {}) {
  if (!text) return text;
  const rows = rowsOf(text), parsed = parseJournal(text), unresolved = new Set(parsed.doubts.keys());
  const identityRow = rows.find(row => 'routeIdentity' in row);
  const queuedRow = new Map(), order = [];
  for (const row of rows) if (['queued', 'media_queued'].includes(row.outcome)) { queuedRow.set(row.id, row); order.push(row.id); }
  const deliveredOrder = order.filter(id => parsed.delivered.has(id));
  const keepBody = new Set(deliveredOrder.slice(-recentBodies));
  const own = new Set([...parsed.pending.keys(), ...parsed.delivered.keys(), ...unresolved]);
  const out = [];
  if (identityRow) out.push(identityRow);
  if (parsed.startedAt !== null) out.push({ startedAt: parsed.startedAt, baseline: [...parsed.seen].filter(id => !own.has(id)) });
  const queue = (id, original) => {
    const reply = original && 'replyTo' in original ? { replyVersion: 1, replyTo: original.replyTo } : {};
    const time = original && Number.isSafeInteger(original.time) && original.time > 0 ? { time: original.time } : {};
    const value = parsed.pending.get(id);
    if (value !== undefined) return typeof value === 'string' ? { id, outcome: 'queued', text: value, ...reply, ...time }
      : { id, outcome: 'media_queued', payloadVersion: payloadVersion(value), payload: value, ...reply, ...time };
    // Already delivered: keep recent bodies verbatim, older ones as a placeholder that keeps the reply mapping.
    if (original && keepBody.has(id)) return original;
    return { id, outcome: 'queued', text: PLACEHOLDER, ...reply };
  };
  const uncertainRow = id => ({
    id, outcome: 'uncertain',
    ...(parsed.doubts.get(id) > 1 ? { attempts: parsed.doubts.get(id) } : {}),
    ...(parsed.uncertainAt.has(id) ? { at: parsed.uncertainAt.get(id) } : {}),
  });
  for (const id of order) {
    if (!own.has(id)) continue;
    if (parsed.pending.has(id) || parsed.delivered.has(id) || unresolved.has(id)) out.push(queue(id, queuedRow.get(id)));
    if (parsed.delivered.has(id)) out.push({ id, outcome: 'sent', destinationId: parsed.delivered.get(id) });
    else if (unresolved.has(id)) out.push(uncertainRow(id));
  }
  // Unresolved IDs without a queued row (older journals) still need their evidence.
  for (const id of unresolved) if (!queuedRow.has(id)) out.push(uncertainRow(id));
  // A future retry deadline must survive; attach it to a pending, resolved item.
  if (parsed.retryAt > now) {
    const anchor = [...parsed.pending.keys()].find(id => !unresolved.has(id));
    if (anchor) out.push({ id: anchor, outcome: 'retry', retryAt: parsed.retryAt });
  }
  return jsonl(out);
}
export function verifyRouteCompaction(original, candidate, { now = Date.now() } = {}) {
  const before = routeMeaning(original, now), after = routeMeaning(candidate, now);
  // A future retry deadline only matters while some resolved item is still queued.
  const retryable = before.pending.some(([id]) => !before.unresolved.includes(id));
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const { retryAt: beforeRetry, ...restBefore } = before, { retryAt: afterRetry, ...restAfter } = after;
  if (!same(restBefore, restAfter) || (retryable ? beforeRetry !== afterRetry : afterRetry !== 0))
    throw new RelayError('壓縮候選與原紀錄語意不一致；已中止，原資料未變更');
  // Every unsent payload must also round-trip through the journal's media versioning.
  for (const [, value] of after.pending) if (typeof value !== 'string') journalPayload(payloadVersion(value), value);
}
export function compactOutputJournal(text) {
  const keys = [...new Set(rowsOf(text).map(row => { if (typeof row.key !== 'string') throw new Error('Invalid output journal'); return row.key; }))];
  return jsonl(keys.map(key => ({ key })));
}
// Telegram inbox: keep the offset and every message some route on that chat has not handled yet.
export function compactInbox(text, handledBy) {
  const rows = rowsOf(text);
  let offset = 0; const messages = new Map();
  for (const row of rows) { if (!Number.isSafeInteger(row.offset) || row.offset < 0) throw new Error('Invalid Telegram inbox'); offset = row.offset; if (row.message) messages.set(row.message.id, row.message); }
  const kept = [...messages.values()].filter(message => !handledBy(message));
  return jsonl([...kept.map(message => ({ offset, message })), ...(kept.length ? [] : [{ offset }])]);
}
function inboxMeaning(text) {
  let offset = 0; const messages = new Map();
  for (const row of rowsOf(text)) { offset = row.offset; if (row.message) messages.set(row.message.id, row.message); }
  return { offset, messages };
}

async function writeSynced(file, text) {
  const handle = await open(file, 'wx', 0o600);
  try { await handle.writeFile(text, 'utf8'); await handle.sync(); } finally { await handle.close(); }
}
export async function compactStorage(directory, { now = Date.now(), recentBodies = RECENT_BODIES, beforeSwitch } = {}) {
  // 1. Verified backup first; it is never deleted by this tool.
  const backup = await privateSnapshot(directory);
  const names = (await readdir(directory)).filter(name => ROUTE.test(name) || INBOX.test(name) || name === OUTPUT);
  const originals = new Map();
  for (const name of names) {
    const file = path.join(directory, name), info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) throw new RelayError('資料目錄含異常紀錄檔案；已中止壓縮，原資料未變更');
    const text = await readJournalFile(file);
    if (text && !text.endsWith('\n')) throw new RelayError('紀錄末行不完整；已中止壓縮，原資料未變更');
    originals.set(name, { text, size: info.size, mtimeMs: info.mtimeMs });
  }
  // Which Telegram messages every route reading that chat has already handled.
  const routesByChat = new Map();
  for (const [name, { text }] of originals) {
    if (!ROUTE.test(name) || !text) continue;
    const rows = rowsOf(text), identity = rows.find(row => 'routeIdentity' in row), parsed = parseJournal(text);
    if (identity?.source?.platform !== 'telegram') continue;
    const chat = String(identity.source.id);
    if (!routesByChat.has(chat)) routesByChat.set(chat, []);
    routesByChat.get(chat).push({ seen: parsed.seen, startedAt: parsed.startedAt || Infinity });
  }
  const handledBy = message => {
    const routes = routesByChat.get(message.chatId);
    return Boolean(routes?.length) && routes.every(route => route.seen.has(message.id) || message.createdTime < route.startedAt);
  };
  // 2. Candidates in a fresh private directory.
  const candidateName = `lineport-compact-${randomUUID()}`, candidateDir = path.join(directory, candidateName);
  await mkdir(candidateDir, { mode: 0o700 });
  const plan = [];
  try {
    for (const [name, { text }] of originals) {
      const compacted = ROUTE.test(name) ? compactRouteJournal(text, { now, recentBodies })
        : name === OUTPUT ? compactOutputJournal(text) : compactInbox(text, handledBy);
      // 3. Semantic verification before anything is switched.
      if (ROUTE.test(name)) verifyRouteCompaction(text, compacted, { now });
      else if (name === OUTPUT) { if (JSON.stringify([...new Set(rowsOf(text).map(row => row.key))].sort()) !== JSON.stringify(rowsOf(compacted).map(row => row.key).sort())) throw new Error('Output mismatch'); }
      else {
        const before = inboxMeaning(text), after = inboxMeaning(compacted);
        if (before.offset !== after.offset || [...before.messages.values()].some(message => !handledBy(message) && JSON.stringify(after.messages.get(message.id)) !== JSON.stringify(message))) throw new Error('Inbox mismatch');
      }
      const before = Buffer.byteLength(text), after = Buffer.byteLength(compacted);
      if (after >= before) continue;
      await writeSynced(path.join(candidateDir, name), compacted);
      plan.push({ name, before, after, sha256: sha256(compacted) });
    }
    for (const entry of plan) if (sha256(await readFile(path.join(candidateDir, entry.name), 'utf8')) !== entry.sha256) throw new Error('Candidate hash mismatch');
    await writeSynced(path.join(candidateDir, 'manifest.json'), JSON.stringify({ version: 1, at: new Date(now).toISOString(), backup: backup.archive, files: plan }));
  } catch (error) {
    throw error instanceof RelayError ? error : new RelayError('壓縮候選產生或驗證失敗；已中止，原資料未變更，私人封存已保留');
  }
  await beforeSwitch?.(plan);
  // 4. Per-file atomic switch, refusing if anything changed since it was read.
  const switched = [];
  for (const entry of plan) {
    const file = path.join(directory, entry.name), info = await lstat(file), original = originals.get(entry.name);
    if (info.size !== original.size || info.mtimeMs !== original.mtimeMs)
      throw new RelayError(`壓縮切換時發現 ${entry.name} 已被其他程序修改；已切換 ${switched.length} 個檔案（皆已驗證），其餘保持原狀，私人封存 ${backup.archive} 已保留`);
    await rename(path.join(candidateDir, entry.name), file);
    switched.push(entry.name);
  }
  const bytesBefore = plan.reduce((sum, entry) => sum + entry.before, 0), bytesAfter = plan.reduce((sum, entry) => sum + entry.after, 0);
  return { compacted: switched.length, backup: backup.archive, candidate: candidateName, bytesBefore, bytesAfter, files: plan.map(({ name, before, after }) => ({ name, before, after })) };
}
