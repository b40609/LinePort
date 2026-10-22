import nacl from 'tweetnacl';
import QRCode from 'qrcode';
import { selectLineSelfKey } from './line-e2ee-state.mjs';

const stages = { createSession: '建立 QR 工作階段', createQrCode: '產生 QR Code', checkQrCodeVerified: '等待掃碼授權', verifyCertificate: '驗證 QR 認證書', createPinCode: '取得 PIN', checkPinCodeVerified: '等待 PIN 授權', qrCodeLogin: '完成 QR 裝置登入', bootstrap: '初始化加密金鑰', profile: '驗證帳號', persist: '保存登入與加密金鑰' };
export class QrLoginError extends Error {
  constructor(stage, detail = '', lineCode) { super(`iPad QR 實驗：${stages[stage] || '登入'}失敗${detail ? `（${detail}）` : ''}。請保留此訊息供排查。`); this.lineCode = lineCode; }
}

// IOSIPAD uses legacy secondary QR login, not the TokenV3/ForSecure flow.
// Never register or migrate a primary account.
// Schema: evex-dev/linejs 4fc512ab8c19a2490ca73bb71777beb775ca3ae3.
export async function qrHandshake({ request, onQr, onPin, onFinalizing, signal, now = Date.now }) {
  const deadline = now() + 360000;
  let session;
  const check = () => { if (signal?.aborted || now() >= deadline) throw new QrLoginError('checkQrCodeVerified', signal?.aborted ? '已取消' : '已逾時'); };
  async function call(method, fields = [], poll = false, interval = 30, committing = false) {
    if (!committing) check();
    let response;
    // The live IOSIPAD endpoint rejects a session access header on createQR.
    // Keep temporary access and poll timing scoped to the long-poll endpoint.
    const headers = poll ? { 'x-line-access': session, 'x-lst': String(interval * 1000) } : {};
    let abort;
    try {
      const cancelled = !committing && signal && new Promise((_, reject) => {
        abort = () => reject(new QrLoginError(method, '已取消'));
        signal.addEventListener('abort', abort, { once: true });
      });
      const pending = request(method, fields, { poll, interval, headers });
      // Yomi transport cannot abort sockets. Ignore its late result after
      // cancellation, and never advance that session to the next request.
      response = await (cancelled ? Promise.race([pending, cancelled]) : pending);
    }
    catch { if (!committing) check(); throw new QrLoginError(method, '網路或回應格式異常'); }
    finally { if (abort) signal.removeEventListener('abort', abort); }
    if (!committing) check();
    if (poll && (response?.error === 'timeout' || [408, 410].includes(response?.statusCode))) return null;
    const code = response?.fields?.[1]?.[1];
    if (response?.fields?.[1] !== undefined) throw new QrLoginError(method, Number.isInteger(code) ? `LINE code ${code}` : 'LINE 拒絕請求', Number.isInteger(code) ? code : undefined);
    if (response?.error || !response?.fields || response?.type !== 'REPLY' || response?.statusCode >= 400) throw new QrLoginError(method, Number.isInteger(response?.statusCode) ? `HTTP ${response.statusCode}` : '回應格式異常');
    return response.fields[0] ?? {};
  }
  session = (await call('createSession'))[1];
  if (typeof session !== 'string' || !session) throw new QrLoginError('createSession');
  const args = extra => [[12, 1, [[11, 1, session], ...extra]]];
  const qr = await call('createQrCode', args([]));
  if (typeof qr[1] !== 'string' || !/^https:\/\//.test(qr[1])) throw new QrLoginError('createQrCode', '缺少網址');
  // Legacy QR returns only a URL. Allow twelve 30-second long polls within
  // the shared six-minute budget; do not interpret legacy fields as V3 timing.
  const count = 12, interval = 30;
  const pair = nacl.box.keyPair();
  const url = new URL(qr[1]);
  url.searchParams.set('secret', Buffer.from(pair.publicKey).toString('base64'));
  url.searchParams.set('e2eeVersion', '1');
  await onQr(await QRCode.toDataURL(url.href, { width: 280, margin: 4 }));
  async function poll(method) {
    for (let attempt = 0; attempt < count; attempt++) {
      const remainingSec = Math.max(1, Math.floor((deadline - now()) / 1000));
      if (await call(method, args([]), true, Math.min(interval, remainingSec))) return;
    }
    throw new QrLoginError(method, '已逾時，請重新產生 QR Code');
  }
  await poll('checkQrCodeVerified');
  // Certificate verification is a protocol state transition even on first login.
  // An empty QR certificate cannot reuse the unrelated passwordless certificate.
  try { await call('verifyCertificate', args([[11, 2, '']])); }
  catch (error) {
    if (!(error instanceof QrLoginError) || ![1, 2, 100].includes(error.lineCode)) throw error;
    const pin = (await call('createPinCode', args([])))[1];
    if (!/^\d{4,8}$/.test(String(pin))) throw new QrLoginError('createPinCode', 'PIN 格式異常');
    onPin(String(pin));
    await poll('checkPinCodeVerified');
  }
  check();
  // The final request can establish a device session remotely. Stop offering
  // cancellation before sending it, so success can still be saved locally.
  onFinalizing?.();
  // The transport still has its own 30-second timeout. The QR waiting budget
  // must not discard a session LINE has already issued.
  const result = await call('qrCodeLogin', args([[11, 2, 'IOSIPAD'], [2, 3, true]]), false, 30, true);
  if (typeof result[2] !== 'string' || !result[2] || typeof result[5] !== 'string' || !result[5]) throw new QrLoginError('qrCodeLogin', '缺少登入結果');
  let metadata = result[4];
  if (typeof metadata === 'string') { try { metadata = JSON.parse(metadata); } catch { throw new QrLoginError('bootstrap', '金鑰資料格式異常'); } }
  // Legacy auth tokens have no TokenV3 refresh token or expiry fields.
  return { authToken: result[2], mid: result[5], secretKey: Buffer.from(pair.secretKey), publicKey: Buffer.from(pair.publicKey), metaData: metadata };
}

export async function runQrLogin(service, hooks) {
  // Loaded only after runtime.mjs has configured the isolated IOSIPAD profile.
  const { LINE_APP_CONFIG: config } = await import('./node_modules/@rikaidev/yomi/dist/line/core/config.js');
  if (!config.lineApp.startsWith('IOSIPAD\t')) throw new QrLoginError('createSession', '請使用 iPad 實驗啟動器');
  const { sendRequest } = await import('./node_modules/@rikaidev/yomi/dist/line/client/transport.js');
  const { encodeCallMessage } = await import('./node_modules/@rikaidev/yomi/dist/line/core/thrift/index.js');
  let seq = 1;
  service.setState('logging_in');
  try {
    const result = await qrHandshake({ ...hooks, request: (method, fields, { poll, interval, headers }) => sendRequest(config.host, poll ? config.qrLongPollPath : config.qrPath, encodeCallMessage(method, seq++, fields), headers, poll ? interval * 1000 + 5000 : 30000, { logger: {} }) });
    await completeQrLogin(service, result);
  } catch (error) {
    service.setState('error');
    throw error instanceof QrLoginError ? error : new QrLoginError('bootstrap');
  }
}

// Keep the real bootstrap and persistence path testable without a LINE account.
export async function completeQrLogin(service, result, { createClient } = {}) {
  const { extractE2EEInfo } = await import('./node_modules/@rikaidev/yomi/dist/line/auth/protocol/login-metadata.js');
  const { initE2EE } = await import('./node_modules/@rikaidev/yomi/dist/line/auth/protocol/e2ee-bootstrap.js');
  const { LineClient } = await import('./node_modules/@rikaidev/yomi/dist/line/client/index.js');
  try {
    result.e2eeInfo = extractE2EEInfo(result.metaData);
    if (!result.e2eeInfo) throw new QrLoginError('bootstrap', '未收到加密金鑰');
    service.client = createClient ? createClient(result.authToken) : new LineClient(result.authToken, { ...service.config, logger: service.logger });
    service.client.on('error', () => {});
    try { service.profile = await service.client.getProfile(); } catch { throw new QrLoginError('profile'); }
    if (!service.profile?.mid || service.profile.mid !== result.mid) throw new QrLoginError('profile', '帳號識別不一致');
    const bootstrap = await initE2EE(service, result);
    if (!bootstrap.success) throw new QrLoginError('bootstrap', '金鑰解密未完成');
    selectLineSelfKey(service, result.e2eeInfo.keyId);
    service.sessionState.bindClient(service.client);
    try {
      await service.sessionState.initializeFromLogin(result);
      const token = await service.credentialStore.get('line_auth_token');
      const mid = await service.credentialStore.get('line_mid');
      const keys = JSON.parse(await service.credentialStore.get('line_e2ee_keys'));
      const savedBootstrap = JSON.parse(await service.credentialStore.get('line_e2ee_bootstrap'));
      if (!savedBootstrap || savedBootstrap.keyId !== result.e2eeInfo.keyId ||
        savedBootstrap.encryptedKeyChain !== result.e2eeInfo.encryptedKeyChain.toString('base64') ||
        savedBootstrap.serverPublicKey !== result.e2eeInfo.serverPublicKey.toString('base64') ||
        savedBootstrap.secretKey !== result.secretKey.toString('base64')) throw new Error('Bootstrap read-back mismatch');
      if (token !== result.authToken || mid !== result.mid || !Array.isArray(keys) || keys.length !== bootstrap.keyCount || !keys.every(key => {
        const imported = service.e2eeManager.getSelfKeyById(key.keyId);
        return key.mid === result.mid && imported && Buffer.from(key.publicKey).equals(imported.publicKey) && Buffer.from(key.privateKey).equals(imported.privateKey);
      })) throw new Error('Session read-back mismatch');
    } catch { throw new QrLoginError('persist', '寫入後核對失敗，請檢查本機儲存空間與權限'); }
    service.loginRequired = false; service.loginReason = null;
    service.setState('connected');
    service.emit('loginComplete', { profile: service.profile });
  } catch (error) {
    service.loginRequired = true;
    service.setState('error');
    throw error instanceof QrLoginError ? error : new QrLoginError('bootstrap');
  }
}
