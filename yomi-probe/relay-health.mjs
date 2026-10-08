import { unseenText } from './relay-rules.mjs';

export class RelayError extends Error {}

export function requireRelayEncryption(service) {
  if (!service.profile?.mid || !service.e2eeManager?.getSelfKeyByMid(service.profile.mid)) {
    throw new RelayError(relayFailure('e2ee_keys'));
  }
}

// Snapshot counts only: never include message text, sender IDs or key material.
export function inspectRelayRead(messages, seen, startedAt) {
  const fresh = messages.filter(message => message?.id && !seen.has(String(message.id)));
  return {
    received: messages.length,
    eligible: unseenText(messages, seen, startedAt).length,
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
  destination_e2ee: '目的群組加密準備失敗；請確認網路，並用官方 LINE 在目的群組發一則新文字後重啟。若仍失敗，停止轉送並重新授權。',
  baseline: '來源訊息或首次基準讀取失敗；請確認網路、磁碟空間及資料權限。',
  journal: '轉送紀錄無法讀寫或不完整；請保留原紀錄並檢查磁碟與權限。',
  read: '來源訊息連續讀取失敗，轉送已停止；請確認網路與登入狀態。',
  login_required: '背景登入已失效；請停止轉送，再用手機重新授權。',
  send: '目的群組發送失敗；請先人工確認是否收到，再停止並重啟。',
  send_uncertain: '目的群組發送結果不明，轉送已停止；請人工確認是否收到，該訊息不會自動重送。',
};

export function relayFailure(stage) {
  return stageFailures[stage] || '背景轉送啟動或執行失敗；請檢查本機服務狀態。';
}

export function relayWarning(state) {
  if (state.phase === 'failed') return relayFailure(state.stage);
  if (state.lastRead?.decryptFailed > 0) return '來源有訊息無法解密，這些訊息尚未轉送；請停止轉送，再用手機重新授權並用新文字測試。';
  if (state.lastRead?.invalidTime > 0) return '來源有訊息缺少有效時間，已略過；請回報此狀態供排查。';
  if (state.lastRead?.history > 0) return '來源有未處理訊息早於啟動基準，已略過；請核對電腦日期與時間，並在啟動後發一則新文字測試。';
  return '';
}
