import { open } from 'node:fs/promises';
import { unseenText } from './relay-rules.mjs';
import { journalPayload } from './media-payload.mjs';
import { assertWritable, readJournalFile } from './storage-health.mjs';
import { validMessageId } from './reply-links.mjs';

export async function appendRecord(file, row) {
  await assertWritable(file);
  const handle = await open(file, 'a', 0o600);
  try {
    await handle.writeFile(JSON.stringify(row) + '\n', 'utf8');
    await handle.sync();
  } finally { await handle.close(); }
}

export function parseJournal(text) {
  // doubts: per unsent message, how many send attempts ended without a known result (a "sending" row
  // with no "sent"; a "retry" row means that attempt provably delivered nothing). times: source time.
  const result = { seen: new Set(), pending: new Map(), replies: new Map(), delivered: new Map(), retryAt: 0, startedAt: null, routeIdentity: null,
    doubts: new Map(), times: new Map(), uncertainAt: new Map(), failures: {} };
  const open = new Set();
  const countFailure = row => {
    if (typeof row.failure === 'string' && /^[a-z_]{2,30}$/.test(row.failure)) {
      result.failures[row.failure] = (result.failures[row.failure] || 0) + 1;
    }
  };
  const queuedTime = row => {
    if (!('time' in row)) return;
    if (!Number.isSafeInteger(row.time) || row.time <= 0) throw new Error('Invalid queued time');
    result.times.set(row.id, row.time);
  };
  // A truncated final row is ambiguous. Fail closed; never discard it and resend.
  if (text && !text.endsWith('\n')) throw new Error('Incomplete journal');
  for (const line of text.split('\n').filter(line => line.trim())) {
    const row = JSON.parse(line);
    if (!row || typeof row !== 'object') throw new Error('Invalid journal');
    if ('replyTo' in row || 'replyVersion' in row) {
      if (!['queued', 'media_queued'].includes(row.outcome) || row.replyVersion !== 1 || !validMessageId(row.replyTo)) throw new Error('Invalid queued reply');
      result.replies.set(row.id, row.replyTo);
    }
    if ('destinationId' in row) {
      if (row.outcome !== 'sent' || !result.pending.has(row.id) || !validMessageId(row.destinationId)) throw new Error('Invalid reply acknowledgement');
      result.delivered.set(row.id, row.destinationId);
    }
    if ('startedAt' in row) {
      if (!Number.isFinite(row.startedAt) || row.startedAt <= 0 || result.startedAt !== null) throw new Error('Invalid baseline');
      result.startedAt = row.startedAt;
      if ('baseline' in row) {
        if (!Array.isArray(row.baseline) || row.baseline.some(id => typeof id !== 'string' || !id)) throw new Error('Invalid snapshot');
        row.baseline.forEach(id => result.seen.add(id));
      }
    } else if ('routeIdentity' in row) {
      if (!/^[a-f0-9]{64}$/.test(row.routeIdentity) || result.routeIdentity) throw new Error('Invalid route identity');
      result.routeIdentity = row.routeIdentity;
    } else if (typeof row.id === 'string' && row.outcome === 'retry') {
      if (!result.pending.has(row.id) || !Number.isSafeInteger(row.retryAt) || row.retryAt <= 0) throw new Error('Invalid retry');
      result.retryAt = Math.max(result.retryAt, row.retryAt);
      countFailure(row);
      if (open.delete(row.id)) {
        const doubt = (result.doubts.get(row.id) || 0) - 1;
        if (doubt > 0) result.doubts.set(row.id, doubt); else result.doubts.delete(row.id);
      }
    } else if (typeof row.id === 'string' && row.id && row.outcome === 'media_queued') {
      if (![1, 2].includes(row.payloadVersion) || result.seen.has(row.id)) throw new Error('Invalid queued media');
      result.pending.set(row.id, journalPayload(row.payloadVersion, row.payload));
      result.seen.add(row.id); queuedTime(row);
    } else if (typeof row.id === 'string' && row.id && row.outcome === 'queued') {
      if (typeof row.text !== 'string' || !row.text || result.seen.has(row.id)) throw new Error('Invalid queued message');
      result.pending.set(row.id, row.text);
      result.seen.add(row.id); queuedTime(row);
    } else if (typeof row.id === 'string' && row.id && ['baseline', 'sending', 'sent', 'uncertain'].includes(row.outcome)) {
      result.seen.add(row.id);
      if (row.outcome === 'sent') {
        result.pending.delete(row.id); result.doubts.delete(row.id); result.times.delete(row.id); result.uncertainAt.delete(row.id); open.delete(row.id);
      } else if (row.outcome === 'sending') {
        result.doubts.set(row.id, (result.doubts.get(row.id) || 0) + 1); open.add(row.id);
      } else if (row.outcome === 'uncertain') {
        countFailure(row);
        // Normally closes the attempt its "sending" row opened; a lone row (compacted journals) preserves attempt count.
        if (!open.delete(row.id)) {
          const attempts = Number.isSafeInteger(row.attempts) && row.attempts >= 1 ? row.attempts : 1;
          result.doubts.set(row.id, (result.doubts.get(row.id) || 0) + attempts);
        }
        if (Number.isSafeInteger(row.at) && row.at > 0 && !result.uncertainAt.has(row.id)) result.uncertainAt.set(row.id, row.at);
      }
    } else { throw new Error('Unknown journal record'); }
  }
  if (result.seen.size && result.startedAt === null) throw new Error('Missing baseline');
  return result;
}

export async function loadJournal(file) {
  try { return parseJournal(await readJournalFile(file)); }
  catch (error) { if (error.code === 'ENOENT') return parseJournal(''); throw error; }
}

export async function establishBaseline({ messages, startedAt, record, seen }) {
  const baseline = [...new Set(messages.filter(m => m?.id).map(m => String(m.id)))];
  // One durable checkpoint: there can be no committed timestamp without its snapshot.
  await record({ startedAt, baseline });
  baseline.forEach(id => seen.add(id));
}

export async function forwardBatch({ messages, seen, startedAt, record, send, state, pause = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  let sentInBatch = false;
  for (const message of unseenText(messages, seen, startedAt)) {
    if (sentInBatch) await pause(1000);
    const id = String(message.id);
    state.stage = 'journal';
    await record({ id, outcome: 'sending' });
    seen.add(id);
    state.stage = 'send';
    try {
      const result = await send(message.text);
      if (!result?.id) throw new Error('Missing delivery acknowledgement');
    } catch {
      state.uncertain++;
      state.stage = 'journal';
      await record({ id, outcome: 'uncertain' });
      state.stage = 'send_uncertain';
      throw new Error('Delivery uncertain');
    }
    state.forwarded++;
    state.stage = 'journal';
    await record({ id, outcome: 'sent' });
    sentInBatch = true;
  }
}
