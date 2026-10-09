export function unseenText(messages, seen, startedAt, includeMedia = false) {
  if (!Number.isFinite(startedAt) || startedAt <= 0) throw new Error('Invalid baseline');
  const batch = new Set();
  return messages.filter(m => {
    if (!m || !m.id || seen.has(String(m.id)) || batch.has(String(m.id))) return false;
    const time = Number(m.createdTime || m.deliveredTime || 0);
    if (!Number.isFinite(time) || time < startedAt || typeof m.text !== 'string'
      || (!m.text.trim() && !(includeMedia && m.media)) || m.e2eeDecryptFailure) return false;
    batch.add(String(m.id));
    return true;
  }).sort((a, b) => Number(a.createdTime || a.deliveredTime) - Number(b.createdTime || b.deliveredTime));
}
