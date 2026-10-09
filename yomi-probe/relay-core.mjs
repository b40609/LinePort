import { open, readFile } from 'node:fs/promises';
import { unseenText } from './relay-rules.mjs';

export async function appendRecord(file, row) {
  const handle = await open(file, 'a', 0o600);
  try {
    await handle.writeFile(JSON.stringify(row) + '\n', 'utf8');
    await handle.sync();
  } finally { await handle.close(); }
}

export function parseJournal(text) {
  const result = { seen: new Set(), pending: new Map(), retryAt: 0, startedAt: null, routeIdentity: null };
  // A truncated final row is ambiguous. Fail closed; never discard it and resend.
  if (text && !text.endsWith('\n')) throw new Error('Incomplete journal');
  for (const line of text.split('\n').filter(line => line.trim())) {
    const row = JSON.parse(line);
    if (!row || typeof row !== 'object') throw new Error('Invalid journal');
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
    } else if (typeof row.id === 'string' && row.id && row.outcome === 'queued') {
      if (typeof row.text !== 'string' || !row.text || result.seen.has(row.id)) throw new Error('Invalid queued message');
      result.pending.set(row.id, row.text);
      result.seen.add(row.id);
    } else if (typeof row.id === 'string' && row.id && ['baseline', 'sending', 'sent', 'uncertain'].includes(row.outcome)) {
      result.seen.add(row.id);
      if (row.outcome === 'sent') result.pending.delete(row.id);
    } else { throw new Error('Unknown journal record'); }
  }
  if (result.seen.size && result.startedAt === null) throw new Error('Missing baseline');
  return result;
}

export async function loadJournal(file) {
  try { return parseJournal(await readFile(file, 'utf8')); }
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
