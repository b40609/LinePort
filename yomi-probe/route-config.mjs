import { createHash } from 'node:crypto';
import { readFile, open, rename } from 'node:fs/promises';
import path from 'node:path';
import { HttpError } from './local-http.mjs';

const invalid = message => { throw new HttpError(400, message); };
export const endpointKey = endpoint => `${endpoint.platform}:${endpoint.id}`;
export const configRevision = config => createHash('sha256').update(JSON.stringify(config)).digest('hex');
export function normalizeConfig(input) {
  if (!input || input.version !== 1 || !Array.isArray(input.rules) || input.rules.length > 30) invalid('規則格式不正確，最多 30 條');
  const ruleIds = new Set(), edges = new Set(), graph = new Map();
  const endpoint = value => {
    if (!value || !['line', 'telegram'].includes(value.platform) || typeof value.id !== 'string'
      || !(value.platform === 'line' ? /^[ucr][a-zA-Z0-9_-]{1,80}$/ : /^-?[1-9]\d{0,15}$/).test(value.id)) invalid('聊天室 ID 格式不正確');
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
      enabled: value.enabled, sources, destinations, include: keywords(value.include), exclude: keywords(value.exclude), prefix: value.prefix || '' };
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
export function matchingText(rule, message) {
  if (message.protected || message.e2eeDecryptFailure || typeof message.text !== 'string' || !message.text.trim()) return null;
  const text = message.text.toLocaleLowerCase();
  if (rule.include.length && !rule.include.some(word => text.includes(word.toLocaleLowerCase()))) return null;
  if (rule.exclude.some(word => text.includes(word.toLocaleLowerCase()))) return null;
  return rule.prefix + message.text;
}
export async function atomicJson(file, value) {
  // Retain the previous file if the write fails; never truncate an active configuration.
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value), 'utf8'); await handle.sync(); }
  finally { await handle.close(); }
  await rename(temporary, file);
}
export function createSettingsStore(directory) {
  const configFile = path.join(directory, 'lineport-rules.json');
  const telegramFile = path.join(directory, 'lineport-telegram.json');
  return {
    async load() {
      try { return normalizeConfig(JSON.parse(await readFile(configFile, 'utf8'))); }
      catch (error) { if (error.code === 'ENOENT') return { version: 1, rules: [] }; throw error; }
    },
    async save(config) { const normalized = normalizeConfig(config); await atomicJson(configFile, normalized); return normalized; },
    async telegramToken() {
      try { return JSON.parse(await readFile(telegramFile, 'utf8')).token || ''; }
      catch (error) { if (error.code === 'ENOENT') return process.env.LINEPORT_TELEGRAM_TOKEN || ''; throw error; }
    },
    async saveTelegram(token) { await atomicJson(telegramFile, { token }); },
  };
}
