import { createHash, randomUUID } from 'node:crypto';
import { readFile, open, rename } from 'node:fs/promises';
import path from 'node:path';
import { HttpError } from './local-http.mjs';
import { normalizeOptions, senderMatches, inSchedule } from './rule-options.mjs';
import { mediaPayload } from './media-payload.mjs';
import { RelayError } from './relay-health.mjs';
import { discordId } from './discord.mjs';
import { botCredentials } from './bot-credentials.mjs';

const invalid = message => { throw new HttpError(400, message); };
export const endpointKey = endpoint => `${endpoint.platform}:${endpoint.id}`;
export const configRevision = config => createHash('sha256').update(JSON.stringify(config)).digest('hex');
export function normalizeConfig(input) {
  if (!input || input.version !== 1 || !Array.isArray(input.rules) || input.rules.length > 30) invalid('規則格式不正確，最多 30 條');
  const ruleIds = new Set(), edges = new Set(), graph = new Map();
  const endpoint = value => {
    if (!value || !['line', 'telegram', 'discord'].includes(value.platform) || typeof value.id !== 'string'
      || !(value.platform === 'discord' ? discordId(value.id) : (value.platform === 'line' ? /^[ucr][a-zA-Z0-9_-]{1,80}$/ : /^-?[1-9]\d{0,15}$/).test(value.id))) invalid('聊天室 ID 格式不正確');
    if (value.platform === 'telegram' && !Number.isSafeInteger(Number(value.id))) invalid('Telegram ID 超出範圍');
    return { platform: value.platform, id: value.id, name: typeof value.name === 'string' ? value.name.slice(0, 100) : value.id };
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
    if (sources.some(source => source.platform === 'discord')) invalid('Discord 目前只支援純文字目的頻道；來源請選 LINE 或 Telegram');
    if ([sources, destinations].some(rows => new Set(rows.map(endpointKey)).size !== rows.length)) invalid('同一規則不可重複選取聊天室');
    if (typeof value.prefix !== 'undefined' && (typeof value.prefix !== 'string' || value.prefix.length > 200)) invalid('訊息前綴最多 200 字');
    for (const source of sources) for (const destination of destinations) {
      const from = endpointKey(source), to = endpointKey(destination);
      if (from === to) invalid('來源與目的不可相同');
      if (value.enabled) {
        if (++totalEdges > 100) invalid('啟用中的來源與目的配對最多 100 組');
        const key = `${from}>${to}`;
        if (edges.has(key)) invalid('不同規則有重複的來源與目的配對');
        edges.add(key);
        if (!graph.has(from)) graph.set(from, new Set());
        graph.get(from).add(to);
      }
    }
    return { id: value.id, name: typeof value.name === 'string' ? value.name.slice(0, 100) : value.id,
      enabled: value.enabled, sources, destinations, include: keywords(value.include), exclude: keywords(value.exclude), prefix: value.prefix || '', ...normalizeOptions(value, sources, destinations) };
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
  return { version: 1, rules };
}
export function textRejection(rule, message, sourceKey, allowEmpty = false) {
  if (!senderMatches(rule, sourceKey, message)) return '非指定發訊者；請核對此來源的人員 ID';
  if (rule.schedule?.outside === 'skip' && !inSchedule(rule.schedule, Number(message.createdTime || message.deliveredTime))) return '訊息時間在時段外；此規則設定為略過';
  if (message.protected) return '平台標示為受保護內容，不轉送';
  if (message.e2eeDecryptFailure) return '無法解密原訊息，請先確認來源可正常讀取';
  if (typeof message.text !== 'string' || !allowEmpty && !message.text.trim()) return '沒有可轉送的文字';
  const text = message.text.toLocaleLowerCase();
  if (rule.include.length && !rule.include.some(word => text.includes(word.toLocaleLowerCase()))) return '沒有包含任一必要關鍵字；請核對訊息格式';
  if (rule.exclude.some(word => text.includes(word.toLocaleLowerCase()))) return '包含排除關鍵字；請核對是否誤排除有效訊息';
  return null;
}
export function matchingText(rule, message, sourceKey) {
  if (textRejection(rule, message, sourceKey) !== null) return null;
  return rule.prefix + message.text;
}
export function matchingContent(rule, message, sourceKey) {
  if (!message.media || !rule.media) return matchingText(rule, message, sourceKey);
  if (textRejection(rule, message, sourceKey, true) !== null) return null;
  try { return mediaPayload({ ...message.media, caption: rule.prefix + (message.text || '') }); }
  catch { throw new RelayError('圖片／檔案格式、大小或說明不符限制，已暫停此路線；請核對 10／50 MB 大小及 1,024 字元說明，保留原訊息後調整規則'); }
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
  const telegram = botCredentials(directory, 'telegram', atomicJson, protectionOptions);
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
    telegramToken: () => telegram.token(),
    saveTelegram: (token, useProtection = false) => telegram.save(token, useProtection),
    telegramProtected: () => telegram.protected(),
    discordToken: () => discord.token(),
    saveDiscord: (token, useProtection = false) => discord.save(token, useProtection),
    discordProtected: () => discord.protected(),
  };
}
