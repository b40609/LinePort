function directoryName(id, ...values) {
  return values.find(value => typeof value === 'string' && value.trim())?.trim() || id;
}

export function linePictureUrl(profile) {
  for (const value of [profile.picturePath, profile.thumbnailUrl, profile.pictureStatus]) {
    if (typeof value !== 'string' || !value.trim()) continue;
    const raw = value.trim();
    if (raw.startsWith('//') || /[\\\s?#]/.test(raw)) continue;
    try {
      const url = new URL(raw, 'https://obs.line-scdn.net/');
      if (url.protocol === 'https:' && url.hostname === 'obs.line-scdn.net' && !url.port && !url.username && !url.password && url.pathname !== '/') return url.href;
    } catch {}
  }
  return '';
}

export async function lineDirectory(service, { contacts = true, groups = true } = {}) {
  const chats = [];
  if (groups) {
    const directory = await service.client.getAllChatMids();
    const ids = [...new Set(directory.memberChats.filter(id => /^[cr]/.test(id)))];
    for (let index = 0; index < ids.length; index += 100) {
      const batch = ids.slice(index, index + 100);
      const rows = await service.client.getChats(batch, false);
      chats.push(...rows.filter(chat => batch.includes(chat.chatMid)).map(chat => ({ platform: 'line', id: chat.chatMid, name: directoryName(chat.chatMid, chat.chatName), pictureUrl: linePictureUrl(chat), kind: 'group' })));
    }
  }
  let people = [];
  if (contacts) {
    const mids = (await service.client.getAllContactIds()).filter(id => /^u/.test(id));
    for (let index = 0; index < mids.length; index += 100) {
      const batch = mids.slice(index, index + 100);
      const rows = await service.client.getContacts(batch);
      people.push(...rows.filter(person => batch.includes(person.mid) && !person.isOfficial).map(person => ({ platform: 'line', id: person.mid, name: directoryName(person.mid, person.displayNameOverridden, person.displayName), pictureUrl: linePictureUrl(person), kind: 'person' })));
    }
  }
  return [...chats, ...people];
}

export class LineHistoryError extends Error {}

export async function readLineSince(service, id, startedAt, known, { maxPages = 20, progress } = {}) {
  const scan = progress || { messages: new Map() };
  const covered = typeof known === 'function' ? known : message => known.has(String(message.id));
  const checkpoint = typeof known === 'function' && known.checkpoint ? known.checkpoint : covered;
  for (let count = 0; count < maxPages; count++) {
    const page = scan.cursor
      ? await service.getPreviousMessages(id, 50, scan.cursor)
      : await service.getRecentMessages(id, 50);
    if (scan.cursor && page.length && page.every(message => scan.messages.has(String(message.id)))) {
      throw new LineHistoryError('History cursor did not advance');
    }
    for (const message of page) if (message?.id) scan.messages.set(String(message.id), message);
    // Ignored messages alone do not prove that older, eligible messages were handled.
    const beforeStart = message => Number(message.createdTime || message.deliveredTime) < startedAt;
    if (page.length < 50 || (page.some(message => checkpoint(message) || beforeStart(message))
      && page.every(message => covered(message) || beforeStart(message)))) {
      return [...scan.messages.values()];
    }
    const oldest = [...page].sort((a, b) => Number(a.deliveredTime || a.createdTime) - Number(b.deliveredTime || b.createdTime))[0];
    if (!oldest?.id || !oldest.deliveredTime) throw new LineHistoryError('Missing history cursor');
    scan.cursor = { messageId: oldest.id, deliveredTime: oldest.deliveredTime };
  }
  if (progress) return null;
  throw new LineHistoryError('History window exceeded');
}
