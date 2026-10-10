export function recentSenders(messages, platform) {
  const senders = new Map();
  for (const message of messages.slice(0, 100)) {
    const id = String(message.from || '');
    if (!(platform === 'line' ? /^u[a-zA-Z0-9_-]{1,80}$/ : /^(?:chat:)?-?[1-9]\d{0,15}$/).test(id)) continue;
    if (!senders.has(id)) senders.set(id, { id, name: String(message.senderName || id).slice(0, 100) });
  }
  return [...senders.values()];
}

// Membership queries do not open a conversation or acknowledge messages.
export async function lineSourceSenders(service, chatId) {
  let ids, listing = 'recent';
  if (/^u/.test(chatId)) {
    ids = [chatId]; listing = 'person';
  } else {
    const chats = await service.client.getChats([chatId], true);
    const members = (Array.isArray(chats) ? chats.find(chat => chat.chatMid === chatId) : chats)?.extra?.['1']?.['4'];
    if (members && typeof members === 'object' && !Array.isArray(members)) {
      ids = Object.keys(members).filter(id => /^u[a-zA-Z0-9_-]{1,80}$/.test(id));
      listing = 'members';
    } else {
      ids = recentSenders(await service.getRecentMessages(chatId, 50), 'line').map(sender => sender.id);
    }
  }
  if (ids.length > 5000) throw new Error('Membership exceeds supported capacity');
  const names = new Map();
  for (let start = 0; start < ids.length; start += 100) {
    const contacts = await service.client.getContacts(ids.slice(start, start + 100));
    for (const contact of contacts) {
      const originalName = String(contact.displayName || contact.mid).slice(0, 100);
      const customName = typeof contact.displayNameOverridden === 'string' ? contact.displayNameOverridden.trim().slice(0, 100) : '';
      names.set(contact.mid, { name: customName || originalName, ...(customName && customName !== originalName ? { originalName } : {}) });
    }
  }
  return { senders: ids.map(id => ({ id, ...(names.get(id) || { name: id }) })), listing,
    explanation: listing === 'members' ? 'LINE 回傳的已加入成員清單，包含尚未發言的人；不包含受邀未加入者。固定 ID 不受改名影響。勾選後加入，留空代表不限制人員。'
      : listing === 'person' ? '此來源為個人聊天室。使用固定 ID，名稱僅供辨認。'
      : 'LINE 未提供成員清單，改列最近可讀訊息的發訊者；尚未發言的人可能未列出，可手動輸入固定 ID。' };
}
