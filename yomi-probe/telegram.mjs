import path from 'node:path';
import { appendRecord } from './relay-core.mjs';
import { RelayError } from './relay-health.mjs';
import { mediaPayload } from './media-payload.mjs';
import { readJournalFile, storageHealth } from './storage-health.mjs';
import { destinationReply } from './reply-links.mjs';
export class TelegramRateLimit extends RelayError {
  constructor(seconds) {
    super('Telegram 限流，等待後自動重試');
    this.retryAfterMs = seconds * 1000;
  }
}

export function createTelegramClient(token, { request = fetch } = {}) {
  if (typeof token !== 'string' || !/^\d{4,20}:[a-zA-Z0-9_-]{20,100}$/.test(token)) throw new RelayError('請設定有效的 Telegram Bot Token');
  async function call(method, data = {}) {
    try {
      const response = await request(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
        signal: AbortSignal.timeout(method === 'getUpdates' ? 25000 : 15000), redirect: 'error',
      });
      const body = await response.json();
      if (!response.ok || !body.ok) {
        if (response.status === 429 && body.ok === false && body.error_code === 429
          && Number.isSafeInteger(body.parameters?.retry_after) && body.parameters.retry_after > 0
          && body.parameters.retry_after <= 2147483) throw new TelegramRateLimit(body.parameters.retry_after);
        const messages = { 401: 'Telegram Token 無效', 403: 'Telegram Bot 沒有讀取或發送權限', 409: 'Telegram 更新被其他程式或 webhook 占用', 429: 'Telegram 發送過於頻繁，請稍後再啟動該路線' };
        throw new RelayError(messages[body.error_code] || 'Telegram API 拒絕操作，請檢查聊天室 ID 與 Bot 權限');
      }
      return body.result;
    } catch (error) {
      // Network exceptions can contain the token-bearing URL. Never return them.
      if (error instanceof RelayError) throw error;
      throw new RelayError('Telegram 連線失敗或逾時；發送結果可能不明');
    }
  }
  return {
    getMe: () => call('getMe'),
    getWebhookInfo: () => call('getWebhookInfo'),
    getChat: id => call('getChat', { chat_id: id }),
    getChatMember: (id, userId) => call('getChatMember', { chat_id: id, user_id: userId }),
    getUpdates: (offset, timeout = 15) => call('getUpdates', { offset, timeout, limit: 100, allowed_updates: ['message', 'channel_post'] }),
    async downloadPhoto(value) {
      const payload = mediaPayload(value);
      if (payload.kind !== 'photo') throw new RelayError('Telegram → LINE 目前只支援圖片，檔案仍保留待送；請另建 Telegram 檔案規則');
      let reader;
      try {
        const file = await call('getFile', { file_id: payload.fileId });
        if (file?.file_id !== payload.fileId || file.file_size !== payload.fileSize
          || typeof file.file_path !== 'string' || !/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_.-]+)+$/.test(file.file_path)
          || file.file_path.split('/').some(part => part === '.' || part === '..')) throw new Error('Invalid file metadata');
        const response = await request(`https://api.telegram.org/file/bot${token}/${file.file_path}`, { signal: AbortSignal.timeout(15000), redirect: 'error' });
        if (!response.ok || !response.body?.getReader) throw new Error('Missing stream');
        reader = response.body.getReader();
        const chunks = []; let length = 0;
        while (true) {
          const { done, value: chunk } = await reader.read(); if (done) break;
          length += chunk.byteLength;
          if (length > payload.fileSize || length > 10000000) throw new Error('Download too large');
          chunks.push(Buffer.from(chunk));
        }
        if (length !== payload.fileSize) throw new Error('Truncated download');
        const bytes = Buffer.concat(chunks, length);
        const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
        const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
        if (!jpeg && !png) throw new Error('Unsupported image format');
        return { bytes, fileName: png ? 'image.png' : 'image.jpg' };
      } catch {
        throw new RelayError('圖片下載或格式驗證失敗，尚未呼叫 LINE 發送；待送紀錄已保留，請檢查來源附件與連線後停止並重新啟動');
      } finally { if (reader) { try { await reader.cancel(); } catch {} reader.releaseLock(); } }
    },
    async send(id, text, { replyTo } = {}) {
      let method = 'sendMessage', data = { chat_id: id, text };
      if (typeof text !== 'string') {
        const payload = mediaPayload(text);
        method = payload.kind === 'photo' ? 'sendPhoto' : 'sendDocument';
        data = { chat_id: id, [payload.kind]: payload.fileId, caption: payload.caption };
      } else if (!text || text.length > 4096) throw new RelayError('Telegram 文字含前綴後不可超過 4,096 字元');
      if (replyTo !== undefined) {
        if (!destinationReply('telegram', String(id), replyTo)) throw new RelayError('Telegram 回覆對照不符目的聊天室，請停止並核對紀錄');
        data.reply_parameters = { message_id: Number(replyTo.split(':')[1]), allow_sending_without_reply: true };
      }
      const result = await call(method, data);
      const confirmed = Number.isSafeInteger(result?.message_id) && result.message_id > 0
        && Number.isSafeInteger(result.chat?.id) && String(result.chat.id) === String(id);
      return { id: confirmed ? `${result.chat.id}:${result.message_id}` : '' };
    },
  };
}
export function telegramMessage(update) {
  const message = update.message || update.channel_post;
  if (!message || !Number.isSafeInteger(message.chat?.id) || !Number.isSafeInteger(message.message_id)) return null;
  const photo = Array.isArray(message.photo) ? message.photo.at(-1) : null;
  const file = photo || message.document;
  let media;
  if (file) {
    try { media = mediaPayload({ kind: photo ? 'photo' : 'document', fileId: file.file_id, fileSize: file.file_size, caption: '' }); }
    catch { media = { kind: 'unsupported' }; }
  }
  return { id: `${message.chat.id}:${message.message_id}`, chatId: String(message.chat.id),
    ...(Number.isSafeInteger(message.reply_to_message?.message_id) && message.reply_to_message.message_id > 0 && message.reply_to_message.chat?.id === message.chat.id
      ? { replyTo: `${message.chat.id}:${message.reply_to_message.message_id}` } : {}),
    createdTime: Number(message.date) * 1000, text: typeof message.text === 'string' ? message.text : typeof message.caption === 'string' ? message.caption : '', ...(media ? { media } : {}),
    protected: Boolean(message.has_protected_content || message.chat.has_protected_content || message.is_paid_post || message.is_ephemeral),
    from: message.sender_chat ? `chat:${message.sender_chat.id}` : String(message.from?.id || ''), bot: !message.sender_chat && Boolean(message.from?.is_bot) };
}
export async function createTelegramInbox(file, client, sourceIds) {
  const sources = new Set(sourceIds), messages = new Map();
  let offset = 0, halted = false;
  function validate(row) {
    if (!Number.isSafeInteger(row.offset) || row.offset < 0) throw new Error('Invalid Telegram inbox');
    if (row.message) {
      const message = row.message;
      if (typeof message.id !== 'string' || typeof message.chatId !== 'string' || typeof message.text !== 'string' || !Number.isSafeInteger(message.createdTime) || message.createdTime <= 0) throw new Error('Invalid Telegram message');
      if (message.media && message.media.kind !== 'unsupported') mediaPayload(message.media);
      if (message.replyTo !== undefined && !destinationReply('telegram', message.chatId, message.replyTo)) throw new Error('Invalid Telegram reply');
    }
  }
  function apply(row) {
    validate(row);
    // Offsets need not remain monotonic after a week without updates (Telegram randomizes IDs).
    offset = row.offset;
    if (row.message) messages.set(row.message.id, row.message);
  }
  try {
    const text = await readJournalFile(file);
    if (text && !text.endsWith('\n')) throw new Error('Incomplete Telegram inbox');
    for (const line of text.split('\n').filter(Boolean)) apply(JSON.parse(line));
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return {
    messages: id => [...messages.values()].filter(message => message.chatId === id),
    health: () => ({ warning: messages.size >= 40000 ? `Telegram 收件紀錄接近容量（${messages.size}/50000），請停止並備份` : '' }),
    async poll() {
      if (halted) throw new RelayError('Telegram 本機收件紀錄寫入失敗，請停止並檢查紀錄；尚未確認的新更新會保留在 Telegram');
      const capacity = await storageHealth(path.dirname(file));
      if (capacity.blocked) throw new RelayError(capacity.warning);
      if (messages.size >= 50000) throw new RelayError('Telegram 本機收件紀錄已達 50,000 則，請先停止並整理備份');
      const updates = await client.getUpdates(offset);
      if (!Array.isArray(updates)) throw new Error('Invalid Telegram updates');
      for (const update of updates) {
        if (!Number.isSafeInteger(update.update_id) || update.update_id < 0) throw new Error('Invalid Telegram update ID');
        const message = telegramMessage(update);
        const selected = message && sources.has(message.chatId) && !message.protected && !message.bot && (message.text.trim() || message.media) ? message : null;
        if (selected && !messages.has(selected.id) && messages.size >= 50000) throw new RelayError('Telegram 本機收件紀錄已達 50,000 則，請先停止並整理備份');
        const row = { offset: update.update_id + 1, ...(selected ? { message: selected } : {}) };
        // Validate before touching either the durable journal or the in-memory offset.
        validate(row);
        // Confirm updates only on the next poll, after the message is durably stored.
        try { await appendRecord(file, row); }
        catch { halted = true; throw new RelayError('Telegram 本機收件紀錄寫入失敗，已暫停確認更新'); }
        apply(row);
      }
      return updates.length;
    },
  };
}
