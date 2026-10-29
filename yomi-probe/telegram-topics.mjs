// Telegram forum topics are destinations within a supergroup, never separate chats.
export const telegramThreadId = value => Number.isSafeInteger(value) && value > 0 && value <= 2147483647;

export function telegramChatEndpoint(chat) {
  return { platform: 'telegram', id: String(chat.id),
    name: String(chat.title || chat.first_name || chat.username || chat.id).slice(0, 100),
    kind: chat.type === 'private' ? 'person' : chat.type === 'channel' ? 'channel' : 'group' };
}

export function createTopicEndpoint(chat, threadId, topicName = '') {
  const base = telegramChatEndpoint(chat);
  const title = typeof topicName === 'string' ? topicName.trim().slice(0, 50) : '';
  const baseName = base.name.split(' / ')[0];
  const name = title ? `${baseName} / ${title}`.slice(0, 100) : base.name;
  return { ...base, name, ...(telegramThreadId(threadId) ? { threadId } : {}) };
}

export function telegramDestinations(updates) {
  const rows = new Map();
  for (const update of updates) {
    const message = update.message || update.channel_post, chat = message?.chat;
    if (!chat || !Number.isSafeInteger(chat.id) || chat.has_protected_content || message.has_protected_content) continue;
    const endpoint = telegramChatEndpoint(chat);
    rows.set(endpoint.id, endpoint);
    if (chat.type !== 'supergroup' || !(chat.is_forum || message.is_topic_message) || !telegramThreadId(message.message_thread_id)) continue;
    const threadId = message.message_thread_id, key = `${endpoint.id}:${threadId}`;
    const title = message.forum_topic_edited?.name || message.forum_topic_created?.name || message.reply_to_message?.forum_topic_created?.name;
    rows.set(key, { ...endpoint, name: title ? `${endpoint.name} / ${title}`.slice(0, 100) : rows.get(key)?.name || endpoint.name, threadId });
  }
  return [...rows.values()];
}
