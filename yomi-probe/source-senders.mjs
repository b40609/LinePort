export function recentSenders(messages, platform) {
  const senders = new Map();
  for (const message of messages.slice(0, 100)) {
    const id = String(message.from || '');
    if (!(platform === 'line' ? /^u[a-zA-Z0-9_-]{1,80}$/ : /^(?:chat:)?-?[1-9]\d{0,15}$/).test(id)) continue;
    if (!senders.has(id)) senders.set(id, { id, name: String(message.senderName || id).slice(0, 100) });
  }
  return [...senders.values()];
}
