import { normalizeConfig, matchingContent, textRejection } from './route-config.mjs';
import { HttpError } from './local-http.mjs';
import { inSchedule } from './rule-options.mjs';
import { RelayError } from './relay-health.mjs';

export function previewRules(input) {
  const config = normalizeConfig(input.config);
  if (typeof input.text !== 'string' || input.text.length > 10000 || typeof input.source !== 'string') throw new HttpError(400, '請選來源並輸入最多 10,000 字的模擬文字');
  const timestamp = input.timestamp === undefined ? Date.now() : input.timestamp;
  if (!config.rules.some(rule => rule.sources.some(source => `${source.platform}:${source.id}` === input.source))) throw new HttpError(400, '模擬來源必須是規則已選取的來源');
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0 || timestamp > 8640000000000000 || (input.sender !== undefined && (typeof input.sender !== 'string' || input.sender.length > 100))
    || input.protected !== undefined && typeof input.protected !== 'boolean' || input.reply !== undefined && typeof input.reply !== 'boolean') throw new HttpError(400, '模擬時間、發訊者或保護設定格式不正確');
  if (input.media !== undefined && (!input.media || !['photo', 'document'].includes(input.media.kind) || !Number.isSafeInteger(input.media.fileSize))) throw new HttpError(400, '模擬媒體需選圖片或檔案，並提供整數位元組大小');
  if (input.media && !input.source.startsWith('telegram:')) throw new HttpError(400, '媒體模擬目前僅支援 Telegram 來源；LINE 媒體仍在評估，請選文字模擬');
  const message = { text: input.text, from: input.sender || '', createdTime: timestamp, protected: input.protected === true,
    ...(input.media ? { media: { kind: input.media.kind, fileSize: input.media.fileSize, fileId: 'SIMULATED_FILE' } } : {}) };
  return { simulated: true, results: config.rules.filter(rule => rule.sources.some(source => `${source.platform}:${source.id}` === input.source)).map(rule => {
    let content = null, failure = '';
    if (rule.enabled) {
      try { content = matchingContent(rule, message, input.source); }
      catch (error) { if (!(error instanceof RelayError)) throw error; failure = error.message.replace('已暫停此路線', '實際運作時會暫停此路線'); }
    }
    const text = typeof content === 'string' ? content : content?.caption ?? null;
    const media = content !== null && typeof content === 'object';
    const kind = media ? content.kind === 'photo' ? '圖片' : '檔案' : '文字';
    const held = rule.schedule?.outside === 'hold' && !inSchedule(rule.schedule, timestamp);
    return { rule: rule.name, enabled: rule.enabled, text, contentKind: content === null ? null : media ? content.kind : 'text',
      summary: media ? `${kind} · ${content.fileSize} bytes；說明含前綴 ${text.length} 字元` : text === null ? '不轉送' : input.media ? '媒體轉送關閉；只轉送說明文字，不含附件' : '文字',
      replyReason: input.reply && content !== null ? rule.replies ? '實際轉送將引用此路線已確認送達的原訊息；找不到對照時改送一般訊息。模擬不讀取真實對照' : '回覆關聯關閉；會以一般訊息轉送' : '',
      destinations: rule.destinations.map(destination => ({ ...destination,
        eligible: rule.enabled && text !== null && !(media && destination.platform === 'line' && content.kind !== 'photo') && !(destination.platform === 'telegram' && text.length > 4096 || destination.platform === 'discord' && text.length > 2000),
        reason: !rule.enabled ? '規則已暫停' : failure || (media && destination.platform === 'line' && content.kind !== 'photo' ? 'LINE 目的尚不支援檔案；實際運作會保留待送並暫停此配對，Telegram 目的仍可處理' : text === null ? textRejection(rule, message, input.source, Boolean(input.media && rule.media)) : destination.platform === 'telegram' && text.length > 4096 ? '含前綴超過 Telegram 4,096 字元上限' : destination.platform === 'discord' && text.length > 2000 ? '含前綴超過 Discord 2,000 字元上限' : held ? '符合規則；時段外保留待送，到時段內才發送' : media && destination.platform === 'line' ? '符合圖片規則；只接受 JPEG／PNG。LINE 先送圖片，再另送說明；任一步結果不明即暫停，不自動重送' : `符合${kind}規則；實際送達仍取決於平台權限與連線`) })) };
  }) };
}

export function settingsBackup(config) {
  return { format: 'lineport-settings', version: 1, appVersion: '0.8.3', exportedAt: new Date().toISOString(), config: normalizeConfig(config) };
}
export function validateBackup(backup) {
  if (!backup || backup.format !== 'lineport-settings' || backup.version !== 1) throw new HttpError(400, '不支援的備份格式；請使用 LinePort 設定備份 JSON');
  return normalizeConfig(backup.config);
}

// Allowlist only; do not export names, IDs, arbitrary errors, paths or free text.
export function safeDiagnostics(relay, connected) {
  const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
  const phases = new Set(['running', 'stopped', 'starting', 'degraded', 'failed', 'blocked', 'unavailable', 'legacy']);
  return { format: 'lineport-diagnostics', version: 1, appVersion: '0.8.3', exportedAt: new Date().toISOString(), lineConnected: connected === true,
    phase: phases.has(relay.phase) ? relay.phase : 'unavailable',
    totals: Object.fromEntries(['forwarded', 'uncertain', 'errors', 'polls'].map(key => [key, count(relay[key])])),
    routes: (Array.isArray(relay.routes) ? relay.routes : []).slice(0, 100).map((route, index) => ({ route: index + 1, phase: phases.has(route.phase) ? route.phase : 'unavailable',
      ...Object.fromEntries(['forwarded', 'pending', 'uncertain', 'errors', 'skipped'].map(key => [key, count(route[key])])) })) };
}
