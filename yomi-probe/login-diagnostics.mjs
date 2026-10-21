// Never expose upstream error text: Yomi can embed tokens, certificates and
// account identifiers in its serialized error responses. Return allowlisted
// stages and bounded numeric codes only.
const stages = {
  createSession: '建立登入工作階段',
  requestPinCodeVerif: '取得手機 PIN',
  loginV2: '完成裝置登入',
  pin: '等待手機 PIN 驗證',
  approval: '等待手機授權',
  unknown: '手機授權登入',
};
const networkCodes = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE']);
const numericCode = value => Number.isSafeInteger(value) && value >= 0 && value <= 65535 ? value : null;

export function loginDiagnostic(error, phase) {
  const message = typeof error?.message === 'string' ? error.message : '';
  const match = /^(createSession|requestPinCodeVerif|loginV2)(?: failed:|:)/.exec(message);
  const stage = match?.[1] || (phase === 'waiting_pin' ? 'pin' : phase === 'waiting_approval' ? 'approval' : 'unknown');
  let httpStatus = null, lineCode = null, timeout = false;
  if (match && stage !== 'loginV2' && message.length < 65536) {
    try {
      const response = JSON.parse(message.slice(message.indexOf(':') + 1));
      if (Number.isInteger(response?.statusCode) && response.statusCode >= 100 && response.statusCode <= 599) httpStatus = response.statusCode;
      lineCode = numericCode(response?.fields?.[1]?.[1]);
      timeout = response?.error === 'timeout';
    } catch { /* An unrecognized upstream format stays redacted. */ }
  } else if (stage === 'loginV2') {
    const code = /^loginV2 failed: code=(\d{1,5})(?: |$)/.exec(message);
    if (code) lineCode = numericCode(Number(code[1]));
  }
  const networkCode = networkCodes.has(error?.code) ? error.code : networkCodes.has(error?.cause?.code) ? error.cause.code : null;
  return { stage, httpStatus, lineCode, networkCode, timeout };
}

export function loginFailureMessage(diagnostic, deviceLabel) {
  const codes = [diagnostic.httpStatus === null ? '' : `HTTP ${diagnostic.httpStatus}`,
    diagnostic.lineCode === null ? '' : `LINE code ${diagnostic.lineCode}`,
    diagnostic.networkCode || '', diagnostic.timeout ? '連線逾時' : ''].filter(Boolean);
  return `${deviceLabel}：${stages[diagnostic.stage] || stages.unknown}失敗${codes.length ? `（${codes.join('；')}）` : ''}。請保留此訊息供排查。`;
}
