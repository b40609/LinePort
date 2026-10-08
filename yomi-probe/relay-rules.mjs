export function unseenText(messages, seen, startedAt) {
  return messages.filter(m => m.id && !seen.has(String(m.id))
    && Number(m.createdTime || m.deliveredTime || 0) >= startedAt
    && typeof m.text === 'string' && m.text.trim() && !m.e2eeDecryptFailure)
    .sort((a, b) => Number(a.createdTime || a.deliveredTime || 0) - Number(b.createdTime || b.deliveredTime || 0));
}
