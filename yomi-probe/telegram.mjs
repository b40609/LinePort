import path from 'node:path';
import { appendRecord } from './relay-core.mjs';
import { RelayError } from './relay-health.mjs';
import { mediaPayload, safeFileName, imageFileName, TELEGRAM_DOWNLOAD_LIMIT, MEDIA_LIMITS } from './media-payload.mjs';
import { readJournalFile, storageHealth } from './storage-health.mjs';
import { destinationReply } from './reply-links.mjs';
import { telegramThreadId } from './telegram-topics.mjs';
import { requestNeverSent } from './network-errors.mjs';
import { splitTextChunks } from './text-chunk.mjs';
export { requestNeverSent };
export class TelegramRateLimit extends RelayError {
  constructor(seconds) {
    super('Telegram 限流，等待後自動重試');
    this.retryAfterMs = seconds * 1000;
  }
}

// Raised only when the request provably never reached Telegram (no connection was made),
// so the payload can be retried without risking a duplicate.
export class TelegramUnsent extends RelayError {
  constructor() {
    super('Telegram 連線未建立（網路、DNS 或 TLS 失敗），訊息尚未送出；待送已保存，稍後自動重試');
    this.unsent = true;
  }
}

// Bot API descriptions that concern only the submitted message. "chat not found", missing rights
// and similar chat-wide 400s are deliberately absent: they must pause the route, not skip messages.
const PER_MESSAGE_REJECTION = /wrong (?:remote )?file identifier|wrong file type|file is too big|message is too long|message caption is too long|can't parse entities|text must be non-empty|message text is empty|PHOTO_INVALID_DIMENSIONS|PHOTO_SAVE_FILE_INVALID|IMAGE_PROCESS_FAILED|FILE_PARTS_INVALID|failed to get HTTP URL content|wrong type of the web page content/i;
export function createTelegramClient(token, { request = fetch } = {}) {
  if (typeof token !== 'string' || !/^\d{4,20}:[a-zA-Z0-9_-]{20,100}$/.test(token)) throw new RelayError('請設定有效的 Telegram Bot Token');
  async function call(method, data = {}, file) {
    try {
      let body = JSON.stringify(data), headers = { 'Content-Type': 'application/json' };
      if (file) {
        // Multipart upload of bytes already verified in memory; nothing is written to disk.
        body = new FormData(); headers = {};
        for (const [key, value] of Object.entries(data)) body.append(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
        body.append(file.field, new Blob([file.bytes]), file.fileName);
      }
      const response = await request(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST', headers, body,
        signal: AbortSignal.timeout(method === 'getUpdates' ? 25000 : file ? 110000 : 15000), redirect: 'error',
      });
      const result = await response.json();
      if (!response.ok || !result.ok) {
        if (response.status === 429 && result.ok === false && result.error_code === 429
          && Number.isSafeInteger(result.parameters?.retry_after) && result.parameters.retry_after > 0
          && result.parameters.retry_after <= 2147483) throw new TelegramRateLimit(result.parameters.retry_after);
        const messages = { 401: 'Telegram Token 無效', 403: 'Telegram Bot 沒有讀取或發送權限', 409: 'Telegram 更新被其他程式或 webhook 占用', 413: 'Telegram 拒絕：附件超過平台上限', 429: 'Telegram 發送過於頻繁，請稍後再啟動該路線' };
        // A definite API rejection (the request was answered with an error) is never a delivery.
        // Only rejections about this one message (not the chat, Bot or token) are marked permanent.
        const status = Number(result.error_code || response.status) || 0;
        const permanent = status === 413 || status === 400 && typeof result.description === 'string' && PER_MESSAGE_REJECTION.test(result.description);
        throw Object.assign(new RelayError(permanent ? 'Telegram 拒絕此則內容（格式、長度或附件不被接受）' : messages[result.error_code] || 'Telegram API 拒絕操作，請檢查聊天室 ID 與 Bot 權限'),
          { status, rejected: true, permanent });
      }
      return result.result;
    } catch (error) {
      // Network exceptions can contain the token-bearing URL. Never return them.
      if (error instanceof RelayError) throw error;
      if (requestNeverSent(error)) throw new TelegramUnsent();
      throw new RelayError('Telegram 連線失敗或逾時；發送結果可能不明');
    }
  }
  const confirmed = (id, threadId, result) => Number.isSafeInteger(result?.message_id) && result.message_id > 0
    && Number.isSafeInteger(result.chat?.id) && String(result.chat.id) === String(id)
    && (threadId === undefined || result.message_thread_id === threadId) ? `${result.chat.id}:${result.message_id}` : '';
  return {
    getMe: () => call('getMe'),
    getWebhookInfo: () => call('getWebhookInfo'),
    getChat: id => call('getChat', { chat_id: id }),
    getChatMember: (id, userId) => call('getChatMember', { chat_id: id, user_id: userId }),
    getUpdates: (offset, timeout = 15) => call('getUpdates', { offset, timeout, limit: 100, allowed_updates: ['message', 'channel_post'] }),
    // Kept for older callers: images only.
    async downloadPhoto(value) {
      if (mediaPayload(value).kind !== 'photo') throw new RelayError('此下載只接受圖片');
      return this.downloadMedia(value);
    },
    // Download into memory with a bounded stream; never to disk or through a redirect.
    async downloadMedia(value) {
      const payload = mediaPayload(value);
      if (payload.source === 'line') throw new RelayError('附件來源不是 Telegram，尚未發送；請停止並核對規則');
      if (payload.fileSize > TELEGRAM_DOWNLOAD_LIMIT) throw Object.assign(new RelayError('Telegram 附件超過 Bot 20 MB 下載上限，尚未呼叫目的發送；請至來源查看'), { permanent: true });
      let reader;
      try {
        const file = await call('getFile', { file_id: payload.fileId });
        // Telegram may omit file_size; the stream cap below still bounds memory.
        const expected = payload.fileSize || (Number.isSafeInteger(file?.file_size) && file.file_size > 0 ? file.file_size : 0);
        if (file?.file_id !== payload.fileId || payload.fileSize && file.file_size !== payload.fileSize
          || typeof file.file_path !== 'string' || !/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_.-]+)+$/.test(file.file_path)
          || file.file_path.split('/').some(part => part === '.' || part === '..')) throw new Error('Invalid file metadata');
        const cap = Math.min(TELEGRAM_DOWNLOAD_LIMIT, MEDIA_LIMITS[payload.kind]);
        const response = await request(`https://api.telegram.org/file/bot${token}/${file.file_path}`, { signal: AbortSignal.timeout(60000), redirect: 'error' });
        if (!response.ok || !response.body?.getReader) throw new Error('Missing stream');
        reader = response.body.getReader();
        const chunks = []; let length = 0;
        while (true) {
          const { done, value: chunk } = await reader.read(); if (done) break;
          length += chunk.byteLength;
          if (expected && length > expected || length > cap) throw new Error('Download too large');
          chunks.push(Buffer.from(chunk));
        }
        if (!length || expected && length !== expected) throw new Error('Truncated download');
        const bytes = Buffer.concat(chunks, length);
        if (payload.kind === 'photo') {
          const fileName = imageFileName(bytes);
          if (!['image.jpg', 'image.png'].includes(fileName)) throw Object.assign(new Error('Unsupported image format'), { permanent: true });
          return { bytes, fileName };
        }
        return { bytes, fileName: safeFileName(payload.fileName, 'file.bin') };
      } catch (error) {
        // Over-size and unsupported formats will never succeed; network failures may.
        throw Object.assign(new RelayError('Telegram 附件下載或格式驗證失敗，尚未呼叫目的發送；待送紀錄已保留，請檢查來源附件與連線後停止並重新啟動'),
          { permanent: error?.permanent === true || error?.message === 'Download too large' });
      } finally { if (reader) { try { await reader.cancel(); } catch {} reader.releaseLock(); } }
    },
    async send(id, text, { replyTo, threadId, prepared } = {}) {
      if (threadId !== undefined && !telegramThreadId(threadId)) throw new RelayError('Telegram 話題 ID 不正確，請停止並修改目的話題');
      let method = 'sendMessage', data = { chat_id: id, text }, file, followUp = '';
      if (typeof text !== 'string') {
        const payload = mediaPayload(text);
        method = payload.kind === 'photo' ? 'sendPhoto' : 'sendDocument';
        // Telegram captions stop at 1,024 characters; longer text follows as separate messages.
        const caption = payload.caption.length <= 1024 ? payload.caption : '';
        followUp = caption ? '' : payload.caption;
        data = { chat_id: id, ...(caption ? { caption } : {}) };
        if (payload.source === 'line') {
          if (!Buffer.isBuffer(prepared?.bytes) || !prepared.bytes.length || typeof prepared.fileName !== 'string') throw new RelayError('附件未完成安全下載，尚未發送');
          file = { field: payload.kind, bytes: prepared.bytes, fileName: prepared.fileName };
        } else data[payload.kind] = payload.fileId;
      } else if (!text || text.length > 4096) throw new RelayError('Telegram 文字含前綴後不可超過 4,096 字元');
      if (threadId !== undefined) data.message_thread_id = threadId;
      if (replyTo !== undefined) {
        if (!destinationReply('telegram', String(id), replyTo)) throw new RelayError('Telegram 回覆對照不符目的聊天室，請停止並核對紀錄');
        data.reply_parameters = { message_id: Number(replyTo.split(':')[1]), allow_sending_without_reply: true };
      }
      const first = confirmed(id, threadId, await call(method, data, file));
      if (!followUp || !first) return { id: first };
      // The attachment was accepted: any later failure leaves the whole item uncertain (never resend).
      const ids = [first];
      try {
        for (const chunk of splitTextChunks(followUp, 4000)) {
          const next = confirmed(id, threadId, await call('sendMessage', { chat_id: id, text: chunk, ...(threadId !== undefined ? { message_thread_id: threadId } : {}) }));
          if (!next) throw new Error('Missing acknowledgement');
          ids.push(next);
        }
      } catch { throw new RelayError('附件已送出，但後續說明文字結果不明；請核對附件與說明，不要直接重送'); }
      return { id: ids.at(-1), ids };
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
    const fileName = !photo && typeof file.file_name === 'string' ? safeFileName(file.file_name, '') : '';
    // file_size is optional in the Bot API; 0 marks an unknown size (bounded again at download).
    const fileSize = file.file_size === undefined ? 0 : file.file_size;
    try { media = mediaPayload({ kind: photo ? 'photo' : 'document', fileId: file.file_id, fileSize, caption: '', ...(fileName ? { fileName } : {}) }); }
    catch { media = { kind: 'unsupported', ...(Number.isSafeInteger(fileSize) && fileSize > 0 ? { fileSize } : {}), ...(fileName ? { fileName } : {}) }; }
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
