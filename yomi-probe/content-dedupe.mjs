import { createHash } from 'node:crypto';
// Opt-in, per-rule deduplication of the same announcement arriving from several sources.
// Fingerprints ignore case, width, whitespace, punctuation and symbols, so "【公告】明天停班！"
// and "公告 明天停班" collide. Text only; attachments are never deduplicated.
export function contentFingerprint(text) {
  if (typeof text !== 'string') return '';
  const normalized = text.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
  return normalized ? createHash('sha256').update(normalized).digest('hex') : '';
}
export function createDedupeWindow({ maxEntries = 5000 } = {}) {
  const byDestination = new Map();
  return {
    // Returns true when an equivalent text reached this destination within the window.
    duplicate(destinationKey, text, time, windowMs) {
      const fingerprint = contentFingerprint(text);
      if (!fingerprint || !Number.isFinite(time)) return false;
      if (!byDestination.has(destinationKey)) byDestination.set(destinationKey, new Map());
      const seen = byDestination.get(destinationKey), previous = seen.get(fingerprint);
      if (previous !== undefined && Math.abs(time - previous) <= windowMs) return true;
      seen.delete(fingerprint); seen.set(fingerprint, time);
      // Bounded memory: drop the oldest fingerprints first.
      while (seen.size > maxEntries) seen.delete(seen.keys().next().value);
      return false;
    },
  };
}
