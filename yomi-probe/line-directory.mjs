export async function lineDirectory(service, { contacts = true } = {}) {
  const directory = await service.client.getAllChatMids();
  const ids = directory.memberChats.filter(id => /^[cr]/.test(id));
  const chats = ids.length ? await service.client.getChats(ids, false) : [];
  const groups = chats.filter(chat => ids.includes(chat.chatMid)).map(chat => ({ platform: 'line', id: chat.chatMid, name: chat.chatName || chat.chatMid, kind: 'group' }));
  let people = [];
  if (contacts) {
    const mids = (await service.client.getAllContactIds()).filter(id => /^u/.test(id));
    for (let index = 0; index < mids.length; index += 100) {
      const batch = mids.slice(index, index + 100);
      const rows = await service.client.getContacts(batch);
      people.push(...rows.filter(person => batch.includes(person.mid) && !person.isOfficial).map(person => ({ platform: 'line', id: person.mid, name: person.displayNameOverridden || person.displayName || person.mid, kind: 'person' })));
    }
  }
  return [...groups, ...people];
}

export async function readLineSince(service, id, startedAt, known, { maxPages = 20 } = {}) {
  let page = await service.getRecentMessages(id, 50);
  const result = new Map();
  for (let count = 0; ; count++) {
    for (const message of page) if (message?.id) result.set(String(message.id), message);
    if (page.length < 50 || page.some(message => known.has(String(message.id)) || Number(message.createdTime || message.deliveredTime) < startedAt)) return [...result.values()];
    if (count >= maxPages - 1) throw new Error('History window exceeded');
    const oldest = [...page].sort((a, b) => Number(a.createdTime || a.deliveredTime) - Number(b.createdTime || b.deliveredTime))[0];
    if (!oldest?.id || !oldest.deliveredTime) throw new Error('Missing history cursor');
    const previous = await service.getPreviousMessages(id, 50, { messageId: oldest.id, deliveredTime: oldest.deliveredTime });
    if (!previous.length) return [...result.values()];
    if (previous.every(message => result.has(String(message.id)))) throw new Error('History cursor did not advance');
    page = previous;
  }
}
