import { createHash, randomUUID } from 'node:crypto';
import { readFile, open, rename } from 'node:fs/promises';
import path from 'node:path';
import { HttpError } from './local-http.mjs';
import { normalizeOptions, senderMatches, inSchedule } from './rule-options.mjs';
import { mediaPayload, mediaNotice, CAPTION_LIMIT } from './media-payload.mjs';
import { RelayError } from './relay-health.mjs';
import { discordId } from './discord.mjs';
import { botCredentials } from './bot-credentials.mjs';
import { telegramThreadId } from './telegram-topics.mjs';
import { renderMessageText, matchKeywordRule } from './text-template.mjs';

const invalid = message => { throw new HttpError(400, message); };
export const chatKey = endpoint => `${endpoint.platform}:${endpoint.id}`;
export const endpointKey = endpoint => chatKey(endpoint) + (endpoint.threadId !== undefined ? `:thread:${endpoint.threadId}` : '');
export const configRevision = config => createHash('sha256').update(JSON.stringify(config)).digest('hex');
export function normalizeConfig(input) {
  if (!input || ![1, 2].includes(input.version) || !Array.isArray(input.rules) || input.rules.length > 30) invalid('規則格式不正確，最多 30 條');
  const ruleIds = new Set(), edges = new Set(), graph = new Map();
  const endpoint = value => {
    if (!value || !['line', 'telegram', 'discord'].includes(value.platform) || typeof value.id !== 'string'
      || !(value.platform === 'discord' ? discordId(value.id) : (value.platform === 'line' ? /^[ucr][a-zA-Z0-9_-]{1,80}$/ : /^-?[1-9]\d{0,15}$/).test(value.id))) invalid('聊天室 ID 格式不正確');
    if (value.platform === 'telegram' && !Number.isSafeInteger(Number(value.id))) invalid('Telegram ID 超出範圍');
    if (value.threadId !== undefined && (value.platform !== 'telegram' || !telegramThreadId(value.threadId))) invalid('Telegram 話題 ID 必須為 1–2147483647 的整數，且只能用於 Telegram 目的');
    return { platform: value.platform, id: value.id, name: typeof value.name === 'string' ? value.name.slice(0, 100) : value.id,
      ...(value.threadId !== undefined ? { threadId: value.threadId } : {}) };
  };
  const keywords = value => {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > 20 || value.some(word => typeof word !== 'string' || !word.trim() || word.length > 100)) invalid('關鍵字最多 20 個，每個最多 100 字');
    return [...new Set(value.map(word => word.trim()))];
  };
  let totalEdges = 0;
  const rules = input.rules.map(value => {
    if (!value || typeof value.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(value.id) || ruleIds.has(value.id)) invalid('規則 ID 重複或不正確');
    ruleIds.add(value.id);
    if (typeof value.enabled !== 'boolean' || !Array.isArray(value.sources) || !Array.isArray(value.destinations)
      || !value.sources.length || !value.destinations.length || value.sources.length > 10 || value.destinations.length > 10) invalid('每條規則需有 1–10 個來源與目的');
    const sources = value.sources.map(endpoint), destinations = value.destinations.map(endpoint);
    if (sources.some(source => source.threadId !== undefined)) invalid('Telegram 話題目前只支援轉發目的；來源請選整個聊天室');
    if (sources.some(source => source.platform === 'discord')) invalid('Discord 目前只支援純文字目的頻道；來源請選 LINE 或 Telegram');
    if ([sources, destinations].some(rows => new Set(rows.map(endpointKey)).size !== rows.length)) invalid('同一規則不可重複選取聊天室');
    if (typeof value.prefix !== 'undefined' && (typeof value.prefix !== 'string' || value.prefix.length > 200)) invalid('訊息前綴最多 200 字');
    for (const source of sources) for (const destination of destinations) {
      const from = endpointKey(source), to = endpointKey(destination);
      if (chatKey(source) === chatKey(destination)) invalid('來源與目的聊天室不可相同，即使指定不同話題');
      if (value.enabled) {
        if (++totalEdges > 100) invalid('啟用中的來源與目的配對最多 100 組');
        const key = `${from}>${to}`;
        if (edges.has(key)) invalid('不同規則有重複的來源與目的配對');
        edges.add(key);
        // Sources read the whole chat, so topic destinations must retain chat-level loop protection.
        const fromChat = chatKey(source), toChat = chatKey(destination);
        if (!graph.has(fromChat)) graph.set(fromChat, new Set());
        graph.get(fromChat).add(toChat);
      }
    }
    return { id: value.id, name: typeof value.name === 'string' ? value.name.slice(0, 100) : value.id,
      enabled: value.enabled, sources, destinations, include: keywords(value.include), exclude: keywords(value.exclude), prefix: value.prefix || '',
      ...(typeof value.template === 'string' && value.template.trim() ? { template: value.template.slice(0, 500) } : {}),
      ...normalizeOptions(value, sources, destinations) };
  });
  const visiting = new Set(), visited = new Set();
  function visit(node) {
    if (visiting.has(node)) invalid('規則形成循環，請移除會回流的路線');
    if (visited.has(node)) return;
    visiting.add(node);
    for (const next of graph.get(node) || []) visit(next);
    visiting.delete(node); visited.add(node);
  }
  for (const node of graph.keys()) visit(node);
  // Older releases reject version 2 instead of silently dropping a destination topic.
  return { version: rules.some(rule => rule.destinations.some(destination => destination.threadId !== undefined)) ? 2 : 1, rules };
}
// System health alerts default to disabled (local log + Windows toast only); remote destinations must be independent.
export const DEFAULT_HEALTH_ALERT = Object.freeze({ enabled: false, telegramChatId: '' });
export function validAlertWebhookUrl(value) {
  if (typeof value !== 'string' || !value || value.length > 500) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password && Boolean(parsed.hostname);
  } catch { return false; }
}
export function normalizeHealthAlert(input) {
  if (input === undefined || input === null) return { ...DEFAULT_HEALTH_ALERT };
  if (typeof input !== 'object' || Array.isArray(input) || typeof input.enabled !== 'boolean') invalid('系統健康告警設定格式不正確');
  const chatId = input.telegramChatId === undefined ? '' : input.telegramChatId;
  if (typeof chatId !== 'string' || chatId && (!/^-?[1-9]\d{0,15}$/.test(chatId) || !Number.isSafeInteger(Number(chatId)))) invalid('告警 Telegram 聊天室 ID 必須是數字');
  const webhookUrl = input.webhookUrl === undefined ? '' : input.webhookUrl;
  if (webhookUrl !== '' && !validAlertWebhookUrl(webhookUrl)) invalid('告警 Webhook 必須是有效的 HTTPS 網址，且不可在網址內嵌帳號密碼');
  if (input.enabled && !chatId && !webhookUrl) invalid('啟用遠端系統健康告警前，請填寫獨立的 Telegram 聊天室 ID 或 HTTPS Webhook 網址');
  if (input.telegramThreadId !== undefined && input.telegramThreadId !== null && !telegramThreadId(input.telegramThreadId)) invalid('告警話題 ID 必須為 1–2147483647 的整數');
  if (input.dailySummary !== undefined && typeof input.dailySummary !== 'boolean') invalid('每日存活摘要開關格式不正確');
  if (input.dailySummaryHour !== undefined && (!Number.isSafeInteger(input.dailySummaryHour) || input.dailySummaryHour < 0 || input.dailySummaryHour > 23)) invalid('每日存活摘要時間必須為 0–23 的整數小時');
  return {
    enabled: input.enabled,
    telegramChatId: chatId,
    ...(telegramThreadId(input.telegramThreadId) ? { telegramThreadId: input.telegramThreadId } : {}),
    ...(webhookUrl ? { webhookUrl } : {}),
    ...(typeof input.dailySummary === 'boolean' ? { dailySummary: input.dailySummary } : {}),
    ...(Number.isSafeInteger(input.dailySummaryHour) ? { dailySummaryHour: input.dailySummaryHour } : {}),
  };
}
export function textRejection(rule, message, sourceKey, allowEmpty = false) {
  if (!senderMatches(rule, sourceKey, message)) return '非指定發訊者；請核對此來源的人員 ID';
  if (rule.schedule?.outside === 'skip' && !inSchedule(rule.schedule, Number(message.createdTime || message.deliveredTime))) return '訊息時間在時段外；此規則設定為略過';
  if (message.protected) return '平台標示為受保護內容，不轉送';
  if (message.e2eeDecryptFailure) return '無法解密原訊息，請先確認來源可正常讀取';
  if (typeof message.text !== 'string' || !allowEmpty && !message.text.trim()) return '沒有可轉送的文字';
  if (rule.include.length && !rule.include.some(word => matchKeywordRule(message.text, word))) return '沒有包含任一必要關鍵字；請核對訊息格式';
  if (rule.exclude.some(word => matchKeywordRule(message.text, word))) return '包含排除關鍵字；請核對是否誤排除有效訊息';
  return null;
}
export function matchingText(rule, message, sourceKey, sourceEndpoint) {
  if (textRejection(rule, message, sourceKey) !== null) return null;
  return renderMessageText({ template: rule.template, prefix: rule.prefix, message, source: sourceEndpoint, rule });
}
export function matchingContent(rule, message, sourceKey, sourceEndpoint) {
  if (!message.media || !rule.media) return matchingText(rule, message, sourceKey, sourceEndpoint);
  if (textRejection(rule, message, sourceKey, true) !== null) return null;
  let caption = renderMessageText({ template: rule.template, prefix: rule.prefix, message, source: sourceEndpoint, rule });
  if (caption.length > CAPTION_LIMIT) caption = caption.slice(0, CAPTION_LIMIT - 12) + '…（說明過長已截斷）';
  // An attachment that cannot be transferred (too large or unknown format) becomes a visible notice
  // instead of pausing the whole route; nothing is silently dropped.
  if (message.media.kind === 'unsupported') return mediaNotice({ ...message.media, kind: 'document', caption }, '超過大小上限或格式不支援');
  try { return mediaPayload({ ...message.media, caption }); }
  catch { throw new RelayError('附件資料格式不符限制，已暫停此路線；請保留原訊息並回報此狀態'); }
}
export async function atomicJson(file, value) {
  // Retain the previous file if the write fails; never truncate an active configuration.
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value), 'utf8'); await handle.sync(); }
  finally { await handle.close(); }
  await rename(temporary, file);
}
export function createSettingsStore(directory, protectionOptions) {
  const configFile = path.join(directory, 'lineport-rules.json');
  const topicsFile = path.join(directory, 'lineport-telegram-topics.json');
  const healthAlertFile = path.join(directory, 'lineport-health-alert.json');
  const telegram = botCredentials(directory, 'telegram', atomicJson, protectionOptions);
  const alertTelegram = botCredentials(directory, 'alert-telegram', atomicJson, protectionOptions);
  const discord = botCredentials(directory, 'discord', atomicJson, protectionOptions);
  return {
    async load() {
      try { return normalizeConfig(JSON.parse(await readFile(configFile, 'utf8'))); }
      catch (error) { if (error.code === 'ENOENT') return { version: 1, rules: [] }; throw error; }
    },
    async save(config) { const normalized = normalizeConfig(config); await atomicJson(configFile, normalized); return normalized; },
    async restore(config) {
      const normalized = normalizeConfig(config);
      const previous = await this.load();
      const backup = `lineport-settings-before-restore-${randomUUID()}.json`;
      try {
        await atomicJson(path.join(directory, backup), previous);
        await atomicJson(configFile, normalized);
      } catch { throw new HttpError(409, '設定還原未完成；未取代原設定，請保留已產生的備份並檢查磁碟空間與權限後重試'); }
      return { config: normalized, backup };
    },
    async telegramTopics() {
      try {
        const raw = JSON.parse(await readFile(topicsFile, 'utf8'));
        if (!Array.isArray(raw)) return [];
        return raw.filter(item => item && item.platform === 'telegram' && typeof item.id === 'string' && telegramThreadId(item.threadId))
          .map(item => ({ platform: 'telegram', id: String(item.id), name: String(item.name || item.id).slice(0, 100), kind: 'group', threadId: item.threadId }));
      } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error;
      }
    },
    async saveTelegramTopics(topics) {
      if (!Array.isArray(topics)) return [];
      const valid = topics.filter(item => item && item.platform === 'telegram' && typeof item.id === 'string' && telegramThreadId(item.threadId))
        .slice(0, 50)
        .map(item => ({ platform: 'telegram', id: String(item.id), name: String(item.name || item.id).slice(0, 100), kind: 'group', threadId: item.threadId }));
      await atomicJson(topicsFile, valid);
      return valid;
    },
    // Stored apart from the rules so changing alerts never alters the running relay's config revision.
    async healthAlert() {
      try { return normalizeHealthAlert(JSON.parse(await readFile(healthAlertFile, 'utf8'))); }
      catch (error) { if (error.code === 'ENOENT') return { ...DEFAULT_HEALTH_ALERT }; throw error; }
    },
    async saveHealthAlert(value) { const normalized = normalizeHealthAlert(value); await atomicJson(healthAlertFile, normalized); return normalized; },
    telegramToken: () => telegram.token(),
    saveTelegram: (token, useProtection = false) => telegram.save(token, useProtection),
    telegramProtected: () => telegram.protected(),
    alertTelegramToken: () => alertTelegram.token(),
    saveAlertTelegram: (token, useProtection = false) => alertTelegram.save(token, useProtection),
    alertTelegramProtected: () => alertTelegram.protected(),
    discordToken: () => discord.token(),
    saveDiscord: (token, useProtection = false) => discord.save(token, useProtection),
    discordProtected: () => discord.protected(),
  };
}
