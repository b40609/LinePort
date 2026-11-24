import { normalizeConfig, normalizeHealthAlert, matchingContent, textRejection } from './route-config.mjs';
import { HttpError } from './local-http.mjs';
import { inSchedule } from './rule-options.mjs';
import { RelayError, safeRelayStage, safeDestinationFailureReason } from './relay-health.mjs';
import { mediaRejection, mediaNotice, needsDownload } from './media-payload.mjs';
export const APP_VERSION = '1.2.0';

export function previewRules(input) {
  const config = normalizeConfig(input.config);
  if (typeof input.text !== 'string' || input.text.length > 10000 || typeof input.source !== 'string') throw new HttpError(400, '請選來源並輸入最多 10,000 字的模擬文字');
  const timestamp = input.timestamp === undefined ? Date.now() : input.timestamp;
  if (!config.rules.some(rule => rule.sources.some(source => `${source.platform}:${source.id}` === input.source))) throw new HttpError(400, '模擬來源必須是規則已選取的來源');
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0 || timestamp > 8640000000000000 || (input.sender !== undefined && (typeof input.sender !== 'string' || input.sender.length > 100))
    || input.protected !== undefined && typeof input.protected !== 'boolean' || input.reply !== undefined && typeof input.reply !== 'boolean') throw new HttpError(400, '模擬時間、發訊者或保護設定格式不正確');
  if (input.media !== undefined && (!input.media || !['photo', 'document'].includes(input.media.kind) || !Number.isSafeInteger(input.media.fileSize) || input.media.fileSize < 0)) throw new HttpError(400, '模擬媒體需選圖片或檔案，並提供整數位元組大小');
  if (input.media && !/^(?:telegram|line):/.test(input.source)) throw new HttpError(400, '附件模擬需選 LINE 或 Telegram 來源');
  const lineSource = input.source.startsWith('line:');
  // Simulated attachments mirror what the inbox stores: over-limit files become "unsupported" notices.
  const simulated = input.media && (input.media.fileSize > (input.media.kind === 'photo' ? 10 : 50) * 1000000 ? { kind: 'unsupported', fileSize: input.media.fileSize }
    : lineSource ? { source: 'line', kind: input.media.kind, chatId: input.source.slice(5), messageId: '1', fileSize: input.media.fileSize, ...(input.media.kind === 'document' ? { fileName: 'simulated.bin' } : {}) }
      : { kind: input.media.kind, fileSize: input.media.fileSize, fileId: 'SIMULATED_FILE', ...(input.media.kind === 'document' ? { fileName: 'simulated.bin' } : {}) });
  const message = { text: lineSource && input.media ? '' : input.text, from: input.sender || '', createdTime: timestamp, protected: input.protected === true,
    ...(simulated ? { media: simulated } : {}) };
  return { simulated: true, results: config.rules.filter(rule => rule.sources.some(source => `${source.platform}:${source.id}` === input.source)).map(rule => {
    let content = null, failure = '';
    if (rule.enabled) {
      const sourceEndpoint = rule.sources.find(s => `${s.platform}:${s.id}` === input.source);
      try { content = matchingContent(rule, message, input.source, sourceEndpoint); }
      catch (error) { if (!(error instanceof RelayError)) throw error; failure = error.message.replace('已暫停此路線', '實際運作時會暫停此路線'); }
    }
    const text = typeof content === 'string' ? content : content?.caption ?? null;
    const media = content !== null && typeof content === 'object';
    const kind = media ? content.kind === 'photo' ? '圖片' : '檔案' : '文字';
    const held = rule.schedule?.outside === 'hold' && !inSchedule(rule.schedule, timestamp);
    const size = media ? content.fileSize ? `${content.fileSize} bytes` : '大小未知' : '';
    return { rule: rule.name, enabled: rule.enabled, text, contentKind: content === null ? null : media ? content.kind : 'text',
      summary: media ? `${kind} · ${size}；說明含前綴 ${text.length} 字元` : text === null ? '不轉送' : input.media && !rule.media ? (lineSource ? '媒體轉送關閉；LINE 附件不轉送' : '媒體轉送關閉；只轉送說明文字，不含附件') : input.media ? '附件無法轉送，改送文字通知' : '文字',
      replyReason: input.reply && content !== null ? rule.replies ? '實際轉送將引用此路線已確認送達的原訊息；找不到對照時改送一般訊息。模擬不讀取真實對照' : '回覆關聯關閉；會以一般訊息轉送' : '',
      destinations: rule.destinations.map(destination => {
        const rejection = media ? mediaRejection(content, destination.platform) : null;
        const delivered = rejection ? mediaNotice(content, rejection) : text;
        const tooLong = !media && delivered !== null && (destination.platform === 'telegram' && delivered.length > 4096 || destination.platform === 'discord' && delivered.length > 2000);
        const mediaReason = rejection ? `附件${rejection}；實際運作會改送文字通知，不送附件本身`
          : !media ? '' : destination.platform === 'line' ? `符合${kind}規則；LINE 先送${kind}（JPEG／PNG 用圖片，其餘格式用檔案），再另送說明；任一步結果不明即暫停，不自動重送`
            : needsDownload(content, destination.platform) ? `符合${kind}規則；會先從來源安全下載（記憶體驗證大小），再上傳到${destination.platform === 'discord' ? ' Discord' : ' Telegram'}；結果不明即暫停，不自動重送`
              : `符合${kind}規則；Telegram 直接引用同一 Bot 的檔案，說明超過 1,024 字元時另送`;
        return { ...destination,
          eligible: rule.enabled && delivered !== null && !tooLong,
          reason: !rule.enabled ? '規則已暫停' : failure || (text === null ? textRejection(rule, message, input.source, Boolean(input.media && rule.media)) : tooLong ? (destination.platform === 'telegram' ? '含前綴超過 Telegram 4,096 字元上限' : '含前綴超過 Discord 2,000 字元上限') : held ? '符合規則；時段外保留待送，到時段內才發送' : mediaReason || `符合${kind}規則；實際送達仍取決於平台權限與連線`) };
      }) };
  }) };
}

export function settingsBackup(config, healthAlert) {
  return { format: 'lineport-settings', version: 1, appVersion: APP_VERSION, exportedAt: new Date().toISOString(), config: normalizeConfig(config),
    ...(healthAlert ? { healthAlert: normalizeHealthAlert(healthAlert) } : {}) };
}
// Optional and absent from older backups; undefined means "leave current alert settings unchanged".
export function backupHealthAlert(backup) {
  return backup?.healthAlert === undefined ? undefined : normalizeHealthAlert(backup.healthAlert);
}
export function validateBackup(backup) {
  if (!backup || backup.format !== 'lineport-settings' || backup.version !== 1) throw new HttpError(400, '不支援的備份格式；請使用 LinePort 設定備份 JSON');
  return normalizeConfig(backup.config);
}

// Allowlist only; do not export names, IDs, arbitrary errors, paths or free text.
export function safeDiagnostics(relay, connected) {
  const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
  const phases = new Set(['running', 'stopped', 'starting', 'degraded', 'failed', 'blocked', 'unavailable', 'legacy']);
  return { format: 'lineport-diagnostics', version: 1, appVersion: APP_VERSION, exportedAt: new Date().toISOString(), lineConnected: connected === true,
    phase: phases.has(relay.phase) ? relay.phase : 'unavailable',
    stage: safeRelayStage(relay.stage),
    totals: Object.fromEntries(['forwarded', 'uncertain', 'errors', 'polls'].map(key => [key, count(relay[key])])),
    routes: (Array.isArray(relay.routes) ? relay.routes : []).slice(0, 100).map((route, index) => ({ route: index + 1, phase: phases.has(route.phase) ? route.phase : 'unavailable',
      stage: safeRelayStage(route.stage),
      ...(['e2ee', 'transport'].includes(route.lineProtection) ? { lineProtection: route.lineProtection } : {}),
      ...(route.stage === 'destination_e2ee' ? { failureReason: safeDestinationFailureReason(route.failureReason) } : {}),
      ...Object.fromEntries(['forwarded', 'pending', 'uncertain', 'errors', 'skipped'].map(key => [key, count(route[key])])) })) };
}
