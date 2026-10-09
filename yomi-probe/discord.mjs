import { RelayError } from './relay-health.mjs';
import { destinationReply } from './reply-links.mjs';

export const discordId = id => typeof id === 'string' && /^[1-9]\d{5,19}$/.test(id) && BigInt(id) < (1n << 64n);
export class DiscordRateLimit extends RelayError {
  constructor(seconds) { super('Discord 限流，等待後自動重試'); this.retryAfterMs = Math.ceil(seconds * 1000); }
}
export function createDiscordClient(token, { request = fetch } = {}) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_.-]{30,200}$/.test(token)) throw new RelayError('請設定 Discord Bot Token，不能使用個人帳號 Token 或 Webhook');
  async function call(route, data) {
    try {
      const response = await request(`https://discord.com/api/v10${route}`, {
        method: data === undefined ? 'GET' : 'POST', headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
        body: data === undefined ? undefined : JSON.stringify(data), signal: AbortSignal.timeout(15000), redirect: 'error',
      });
      const body = await response.json();
      if (!response.ok) {
        if (response.status === 429 && typeof body.retry_after === 'number' && Number.isFinite(body.retry_after) && body.retry_after > 0 && body.retry_after <= 2147483 && typeof body.global === 'boolean') throw new DiscordRateLimit(body.retry_after);
        throw new RelayError(({ 401: 'Discord Bot Token 無效；請重新連結', 403: 'Discord Bot 權限不足；請確認已加入伺服器並允許查看及發送訊息', 404: 'Discord 找不到頻道；請核對頻道 ID 與 Bot 存取權限' })[response.status] || 'Discord API 拒絕操作；請檢查頻道及權限後重試');
      }
      return body;
    } catch (error) {
      if (error instanceof RelayError) throw error;
      throw new RelayError('Discord 連線失敗或回應無法確認；發送結果可能不明');
    }
  }
  const check = id => { if (!discordId(id)) throw new RelayError('Discord 頻道 ID 格式不正確'); };
  return {
    async getMe() { const me = await call('/users/@me'); if (!discordId(me?.id) || me.bot !== true) throw new RelayError('無法確認 Discord Bot 身分；請重新連結 Bot'); return me; },
    async getChannel(id) {
      check(id); const channel = await call(`/channels/${id}`);
      if (channel?.id !== id || channel.type !== 0 || !discordId(channel.guild_id)) throw new RelayError('目前僅支援 Discord 伺服器的一般文字目的頻道；私訊、討論串及公告頻道尚未支援');
      return channel;
    },
    async send(id, text, { replyTo } = {}) {
      check(id);
      if (typeof text !== 'string' || !text.trim() || text.length > 2000) throw new RelayError('Discord 文字含前綴後不可超過 2,000 字元；請縮短內容或改選目的');
      if (replyTo !== undefined && !destinationReply('discord', id, replyTo)) throw new RelayError('Discord 回覆對照格式不正確，請停止並核對紀錄');
      const result = await call(`/channels/${id}/messages`, { content: text, allowed_mentions: { parse: [], users: [], roles: [], replied_user: false }, flags: 4,
        ...(replyTo ? { message_reference: { message_id: replyTo, channel_id: id, fail_if_not_exists: false } } : {}) });
      return { id: discordId(result?.id) && result.channel_id === id ? result.id : '' };
    },
  };
}
