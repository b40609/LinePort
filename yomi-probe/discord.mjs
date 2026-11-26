import { RelayError } from './relay-health.mjs';
import { destinationReply } from './reply-links.mjs';
import { requestNeverSent, networkFailure } from './network-errors.mjs';
import { mediaPayload, safeFileName, DESTINATION_LIMITS } from './media-payload.mjs';
import { splitTextChunks } from './text-chunk.mjs';

export const discordId = id => typeof id === 'string' && /^[1-9]\d{5,19}$/.test(id) && BigInt(id) < (1n << 64n);
export class DiscordRateLimit extends RelayError {
  constructor(seconds) { super('Discord 限流，等待後自動重試'); this.retryAfterMs = Math.ceil(seconds * 1000); }
}
// Raised only when no connection was made (DNS, refused, TLS): safe to retry without duplicates.
export class DiscordUnsent extends RelayError {
  constructor() { super('Discord 連線未建立（網路、DNS 或 TLS 失敗），訊息尚未送出；待送已保存，稍後自動重試'); this.unsent = true; }
}
const MENTIONS = { parse: [], users: [], roles: [], replied_user: false };
export function createDiscordClient(token, { request = fetch } = {}) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_.-]{30,200}$/.test(token)) throw new RelayError('請設定 Discord Bot Token，不能使用個人帳號 Token 或 Webhook');
  async function call(route, data, file) {
    try {
      let body = data === undefined ? undefined : JSON.stringify(data), headers = { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' };
      if (file) {
        body = new FormData(); headers = { Authorization: `Bot ${token}` };
        body.append('payload_json', JSON.stringify({ ...data, attachments: [{ id: 0, filename: file.fileName }] }));
        body.append('files[0]', new Blob([file.bytes]), file.fileName);
      }
      const response = await request(`https://discord.com/api/v10${route}`, {
        method: data === undefined ? 'GET' : 'POST', headers, body, signal: AbortSignal.timeout(file ? 110000 : 15000), redirect: 'error',
      });
      let result;
      try { result = await response.json(); }
      catch { throw Object.assign(new RelayError('Discord 連線失敗或回應無法確認；發送結果可能不明'), { failure: 'bad_response', status: response.status }); }
      if (!response.ok) {
        if (response.status === 429 && typeof result.retry_after === 'number' && Number.isFinite(result.retry_after) && result.retry_after > 0 && result.retry_after <= 2147483 && typeof result.global === 'boolean') throw new DiscordRateLimit(result.retry_after);
        // Invalid form body (50035), empty message (50006), payload or file too large (40005, 50045, 413) concern this message only.
        const permanent = response.status === 413 || response.status === 400 && [50035, 50006, 40005, 50045].includes(result?.code);
        if (permanent) throw Object.assign(new RelayError('Discord 拒絕此則內容（格式、長度或附件不被接受）'), { status: response.status, rejected: true, permanent: true });
        throw Object.assign(new RelayError(({ 401: 'Discord Bot Token 無效；請重新連結', 403: 'Discord Bot 權限不足；請確認已加入伺服器並允許查看、發送訊息及附加檔案', 404: 'Discord 找不到頻道；請核對頻道 ID 與 Bot 存取權限', 413: 'Discord 拒絕：附件超過伺服器上傳上限' })[response.status] || 'Discord API 拒絕操作；請檢查頻道及權限後重試'),
          { status: response.status, rejected: true });
      }
      return result;
    } catch (error) {
      if (error instanceof RelayError) throw error;
      if (requestNeverSent(error)) throw new DiscordUnsent();
      throw Object.assign(new RelayError('Discord 連線失敗或回應無法確認；發送結果可能不明'), networkFailure(error));
    }
  }
  const check = id => { if (!discordId(id)) throw new RelayError('Discord 頻道 ID 格式不正確'); };
  const acknowledged = (id, result) => discordId(result?.id) && result.channel_id === id ? result.id : '';
  return {
    async getMe() { const me = await call('/users/@me'); if (!discordId(me?.id) || me.bot !== true) throw new RelayError('無法確認 Discord Bot 身分；請重新連結 Bot'); return me; },
    async getChannel(id) {
      check(id); const channel = await call(`/channels/${id}`);
      if (channel?.id !== id || channel.type !== 0 || !discordId(channel.guild_id)) throw new RelayError('目前僅支援 Discord 伺服器的一般文字目的頻道；私訊、討論串及公告頻道尚未支援');
      return channel;
    },
    async send(id, text, { replyTo, prepared } = {}) {
      // Local checks before any API call: a failure here means nothing was sent.
      const unsent = message => Object.assign(new RelayError(message), { notSent: true });
      try { check(id); } catch (error) { throw Object.assign(error, { notSent: true }); }
      if (replyTo !== undefined && !destinationReply('discord', id, replyTo)) throw unsent('Discord 回覆對照格式不正確，請停止並核對紀錄');
      const reference = replyTo ? { message_reference: { message_id: replyTo, channel_id: id, fail_if_not_exists: false } } : {};
      if (typeof text === 'string') {
        if (!text.trim() || text.length > 2000) throw unsent('Discord 文字含前綴後不可超過 2,000 字元；請縮短內容或改選目的');
        const result = await call(`/channels/${id}/messages`, { content: text, allowed_mentions: MENTIONS, flags: 4, ...reference });
        return { id: acknowledged(id, result) };
      }
      let payload;
      try { payload = mediaPayload(text); } catch { throw unsent('Discord 附件內容無法組成，尚未發送'); }
      const limit = DESTINATION_LIMITS.discord[payload.kind];
      if (!Buffer.isBuffer(prepared?.bytes) || !prepared.bytes.length || prepared.bytes.length > limit
        || typeof prepared.fileName !== 'string' || safeFileName(prepared.fileName, '') !== prepared.fileName) throw unsent(`附件未完成安全下載或超過 Discord ${limit / 1000000} MB 上限，尚未發送`);
      // Captions longer than one Discord message follow the attachment as separate messages.
      const inline = payload.caption.length <= 2000 ? payload.caption : '';
      const first = acknowledged(id, await call(`/channels/${id}/messages`, { ...(inline ? { content: inline } : {}), allowed_mentions: MENTIONS, flags: 4, ...reference },
        { bytes: prepared.bytes, fileName: prepared.fileName }));
      if (inline || !payload.caption || !first) return { id: first };
      const ids = [first];
      try {
        for (const chunk of splitTextChunks(payload.caption, 1900)) {
          const next = acknowledged(id, await call(`/channels/${id}/messages`, { content: chunk, allowed_mentions: MENTIONS, flags: 4 }));
          if (!next) throw new Error('Missing acknowledgement');
          ids.push(next);
        }
      } catch { throw new RelayError('附件已送出，但後續說明文字結果不明；請核對附件與說明，不要直接重送'); }
      return { id: ids.at(-1), ids };
    },
  };
}
