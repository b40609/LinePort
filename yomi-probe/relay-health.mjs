import { unseenText } from './relay-rules.mjs';

export class RelayError extends Error {}

export function requireRelayEncryption(service) {
  if (!service.profile?.mid || !service.e2eeManager?.getSelfKeyByMid(service.profile.mid)) {
    throw new RelayError(relayFailure('e2ee_keys'));
  }
}

// Snapshot counts only: never include message text, sender IDs or key material.
export function inspectRelayRead(messages, seen, startedAt, includeMedia = false) {
  const fresh = messages.filter(message => message?.id && !seen.has(String(message.id)));
  return {
    received: messages.length,
    processed: messages.filter(message => message?.id && seen.has(String(message.id))).length,
    eligible: unseenText(messages, seen, startedAt, includeMedia).length,
    decryptFailed: fresh.filter(message => Boolean(message.e2eeDecryptFailure)).length,
    invalidTime: fresh.filter(message => !Number.isFinite(Number(message.createdTime || message.deliveredTime || 0)) || Number(message.createdTime || message.deliveredTime || 0) <= 0).length,
    history: fresh.filter(message => {
      const time = Number(message.createdTime || message.deliveredTime || 0);
      return Number.isFinite(time) && time > 0 && time < startedAt;
    }).length,
  };
}

const stageFailures = {
  data_permissions: '本機資料權限設定失敗；請檢查 Windows 使用者權限。',
  resume: '背景轉送無法恢復登入；請先停止轉送，再用手機重新授權。',
  groups: '背景轉送無法確認來源與目的群組；請重新載入群組列表並核對名稱。',
  route_identity: '帳號或群組與原轉送紀錄不符；請核對設定並保留原紀錄。',
  e2ee_keys: '登入成功，但背景轉送缺少加解密金鑰；請停止轉送，再用手機重新授權。',
  destination_e2ee: '目的群組加密準備失敗，原因未能識別；請匯出診斷供排查，停止後重試。',
  platform: '此路線的平台尚未就緒；請檢查帳號連結後停止並重新啟動轉送。',
  destination_prepare: '目的聊天室準備失敗；請確認網路、聊天室成員與平台權限，停止後重試。',
  baseline: '來源訊息或首次基準讀取失敗；請確認網路、登入狀態及來源聊天室讀取權限。',
  journal: '轉送紀錄無法讀寫或不完整；請保留原紀錄並檢查磁碟與權限。',
  read: '來源訊息連續讀取失敗，轉送已停止；請確認網路與登入狀態。',
  login_required: '背景登入已失效；請停止轉送，再用手機重新授權。',
  send: '目的群組發送失敗；請先人工確認是否收到，再停止並重啟。',
  send_uncertain: '目的群組發送結果不明，轉送已停止；請人工確認是否收到，該訊息不會自動重送。',
};

export function relayFailure(stage) {
  return stageFailures[stage] || '背景轉送啟動或執行失敗；請檢查本機服務狀態。';
}

const destinationFailures = {
  missing_self_key: '缺少目前帳號的發送金鑰；請停止轉送，再用手機重新授權。',
  missing_receiver_key: '缺少此群組要求的舊代接收金鑰；請先停止並重啟轉送以恢復登入金鑰鏈。若仍失敗，請重新授權。',
  missing_group_key: 'LINE 未提供此群組可用的加密金鑰；請確認仍為群組成員，並用官方 LINE 在目的群組發一則新文字後停止並重啟轉送。',
  peer_key_mismatch: '群組金鑰建立者的金鑰版本不符；請用官方 LINE 確認目的群組可正常收發，再停止並重啟轉送。若仍失敗，請匯出診斷。',
  invalid_group_key: '群組共享金鑰資料不完整或無法解密；請用官方 LINE 確認目的群組可正常收發，再停止並重啟轉送。若仍失敗，請匯出診斷。',
  network: '取得目的群組加密金鑰時連線失敗；請確認網路，再停止並重啟轉送。',
  timeout: '取得目的群組加密金鑰逾時；請確認網路，再停止並重啟轉送。',
};

export function safeDestinationFailureReason(reason) {
  return typeof reason === 'string' && Object.hasOwn(destinationFailures, reason) ? reason : 'unknown';
}

// Match upstream signatures internally; only fixed codes and text leave here.
export function destinationEncryptionFailure(error) {
  const message = typeof error?.message === 'string' ? error.message : '';
  const code = error?.code || error?.cause?.code;
  let reason = 'unknown';
  if (message.startsWith('Missing self E2EE key for receiverKeyId=')) reason = 'missing_receiver_key';
  else if (message.startsWith('Missing self E2EE key for mid=') || message === 'Cannot encrypt E2EE message without an authenticated LINE profile') reason = 'missing_self_key';
  else if (message.startsWith('No existing LINE group E2EE key for ')) reason = 'missing_group_key';
  else if (message.startsWith('Peer E2EE key mismatch for ')) reason = 'peer_key_mismatch';
  else if (message === 'Incomplete group shared key payload' || ['ERR_OSSL_BAD_DECRYPT', 'ERR_OSSL_WRONG_FINAL_BLOCK_LENGTH'].includes(code)) reason = 'invalid_group_key';
  else if (['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT'].includes(code) || error?.name === 'TimeoutError') reason = 'timeout';
  else if (['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_SOCKET'].includes(code)) reason = 'network';
  return { failureReason: reason, warning: reason === 'unknown' ? relayFailure('destination_e2ee') : `目的群組加密準備失敗：${destinationFailures[reason]}` };
}

// Only fixed operation names may cross the status/diagnostic boundary.
export function safeRelayStage(stage) {
  return typeof stage === 'string' && (Object.hasOwn(stageFailures, stage) || ['start', 'rules', 'waiting', 'prepare'].includes(stage)) ? stage : 'unknown';
}

export function relayWarning(state) {
  if (state.phase === 'failed') return relayFailure(state.stage);
  if (state.lastRead?.decryptFailed > 0) return '來源有訊息無法解密，這些訊息尚未轉送；請停止轉送，再用手機重新授權並用新文字測試。';
  if (state.lastRead?.invalidTime > 0) return '來源有訊息缺少有效時間，已略過；請回報此狀態供排查。';
  if (state.lastRead?.history > 0) return '來源有未處理訊息早於啟動基準，已略過；請核對電腦日期與時間，並在啟動後發一則新文字測試。';
  return '';
}
