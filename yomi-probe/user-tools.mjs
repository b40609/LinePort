import { normalizeConfig, matchingText, textRejection } from './route-config.mjs';
import { HttpError } from './local-http.mjs';
import { inSchedule } from './rule-options.mjs';

export function previewRules(input) {
  const config = normalizeConfig(input.config);
  if (typeof input.text !== 'string' || input.text.length > 10000 || typeof input.source !== 'string') throw new HttpError(400, '請選來源並輸入最多 10,000 字的模擬文字');
  return { simulated: true, results: config.rules.filter(rule => rule.sources.some(source => `${source.platform}:${source.id}` === input.source)).map(rule => {
    const timestamp = input.timestamp === undefined ? Date.now() : input.timestamp;
    if (!Number.isSafeInteger(timestamp) || timestamp <= 0 || (input.sender !== undefined && (typeof input.sender !== 'string' || input.sender.length > 100))) throw new HttpError(400, '模擬時間或發訊者 ID 格式不正確');
    const message = { text: input.text, from: input.sender || '', createdTime: timestamp, protected: input.protected === true };
    const text = matchingText(rule, message, input.source);
    const held = rule.schedule?.outside === 'hold' && !inSchedule(rule.schedule, timestamp);
    return { rule: rule.name, enabled: rule.enabled, text: rule.enabled ? text : null,
      destinations: rule.destinations.map(destination => ({ ...destination,
        eligible: rule.enabled && text !== null && !(destination.platform === 'telegram' && text.length > 4096 || destination.platform === 'discord' && text.length > 2000),
        reason: !rule.enabled ? '規則已暫停' : text === null ? textRejection(rule, message, input.source) : destination.platform === 'telegram' && text.length > 4096 ? '含前綴超過 Telegram 4,096 字元上限' : destination.platform === 'discord' && text.length > 2000 ? '含前綴超過 Discord 2,000 字元上限' : held ? '符合規則；時段外保留待送，到時段內才發送' : '符合文字規則；實際送達仍取決於平台權限與連線' })) };
  }) };
}

export function settingsBackup(config) {
  return { format: 'lineport-settings', version: 1, appVersion: '0.6.0', exportedAt: new Date().toISOString(), config: normalizeConfig(config) };
}
export function validateBackup(backup) {
  if (!backup || backup.format !== 'lineport-settings' || backup.version !== 1) throw new HttpError(400, '不支援的備份格式；請使用 LinePort 設定備份 JSON');
  return normalizeConfig(backup.config);
}

// Allowlist only; do not export names, IDs, arbitrary errors, paths or free text.
export function safeDiagnostics(relay, connected) {
  const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
  const phases = new Set(['running', 'stopped', 'starting', 'degraded', 'failed', 'blocked', 'unavailable', 'legacy']);
  return { format: 'lineport-diagnostics', version: 1, appVersion: '0.6.0', exportedAt: new Date().toISOString(), lineConnected: connected === true,
    phase: phases.has(relay.phase) ? relay.phase : 'unavailable',
    totals: Object.fromEntries(['forwarded', 'uncertain', 'errors', 'polls'].map(key => [key, count(relay[key])])),
    routes: (Array.isArray(relay.routes) ? relay.routes : []).slice(0, 100).map((route, index) => ({ route: index + 1, phase: phases.has(route.phase) ? route.phase : 'unavailable',
      ...Object.fromEntries(['forwarded', 'pending', 'uncertain', 'errors', 'skipped'].map(key => [key, count(route[key])])) })) };
}
