import { normalizeConfig, matchingText } from './route-config.mjs';
import { HttpError } from './local-http.mjs';

export function previewRules(input) {
  const config = normalizeConfig(input.config);
  if (typeof input.text !== 'string' || input.text.length > 10000 || typeof input.source !== 'string') throw new HttpError(400, '請選來源並輸入最多 10,000 字的模擬文字');
  return { simulated: true, results: config.rules.filter(rule => rule.sources.some(source => `${source.platform}:${source.id}` === input.source)).map(rule => {
    const text = matchingText(rule, { text: input.text, protected: input.protected === true });
    return { rule: rule.name, enabled: rule.enabled, text: rule.enabled ? text : null,
      destinations: rule.destinations.map(destination => ({ ...destination,
        eligible: rule.enabled && text !== null && !(destination.platform === 'telegram' && text.length > 4096),
        reason: !rule.enabled ? '規則已暫停' : text === null ? '受保護、空白或未通過關鍵字篩選' : destination.platform === 'telegram' && text.length > 4096 ? '含前綴超過 Telegram 4,096 字元上限' : '符合文字規則；實際送達仍取決於平台權限與連線' })) };
  }) };
}

export function settingsBackup(config) {
  return { format: 'lineport-settings', version: 1, appVersion: '0.5.0', exportedAt: new Date().toISOString(), config: normalizeConfig(config) };
}
export function validateBackup(backup) {
  if (!backup || backup.format !== 'lineport-settings' || backup.version !== 1) throw new HttpError(400, '不支援的備份格式；請使用 LinePort 設定備份 JSON');
  return normalizeConfig(backup.config);
}

// Allowlist only; do not export names, IDs, arbitrary errors, paths or free text.
export function safeDiagnostics(relay, connected) {
  const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
  const phases = new Set(['running', 'stopped', 'starting', 'degraded', 'failed', 'blocked', 'unavailable', 'legacy']);
  return { format: 'lineport-diagnostics', version: 1, appVersion: '0.5.0', exportedAt: new Date().toISOString(), lineConnected: connected === true,
    phase: phases.has(relay.phase) ? relay.phase : 'unavailable',
    totals: Object.fromEntries(['forwarded', 'uncertain', 'errors', 'polls'].map(key => [key, count(relay[key])])),
    routes: (Array.isArray(relay.routes) ? relay.routes : []).slice(0, 100).map((route, index) => ({ route: index + 1, phase: phases.has(route.phase) ? route.phase : 'unavailable',
      ...Object.fromEntries(['forwarded', 'pending', 'uncertain', 'errors', 'skipped'].map(key => [key, count(route[key])])) })) };
}
