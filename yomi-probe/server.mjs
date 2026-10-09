import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { authorized, readJson, localRequest, hardenServer, HttpError } from './local-http.mjs';
import { prepareDataDirectory } from './runtime.mjs';
import { guardProtocol } from './protocol-guard.mjs';
import { createRelayController } from './relay-controller.mjs';
import { RelayError } from './relay-health.mjs';
import { normalizeConfig, configRevision, createSettingsStore } from './route-config.mjs';
import { lineDirectory } from './line-directory.mjs';
import { createTelegramClient } from './telegram.mjs';
import { previewRules, settingsBackup, validateBackup, safeDiagnostics } from './user-tools.mjs';
import { createDeliveryReviewStore } from './delivery-review.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
export function createProbeServer({ service, runPwlessLogin, relayController, settingsStore, reviewStore, telegramFactory = createTelegramClient, port = 18765, token = randomBytes(32).toString('hex') }) {
service.on('error', () => {});
const state = { phase: 'idle', connected: false, busy: false, pin: '', error: '', reads: 0, messages: 0, readable: 0, decryptFailed: 0, checkedAt: null };
let groups = new Map();
let relayAction = '';
async function requireStopped() {
  if (!relayController || (await relayController.status()).phase !== 'stopped') throw new HttpError(409, '請先停止轉送，再修改規則或平台連結');
  if (state.busy) throw new HttpError(409, '前一個操作尚未完成');
}

function failure(error) {
  if (error instanceof RelayError || error instanceof HttpError) return error.message;
  const code = error?.code;
  const suffix = typeof code === 'number' ? ` (${code})` : '';
  return `操作失敗${suffix}；請確認手機授權、網路及 LINE 登入狀態後重試。`;
}
function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY' });
  res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
}
async function operation(fn) {
  if (state.busy) throw new HttpError(409, '前一個操作尚未完成');
  state.busy = true;
  state.error = '';
  try { return await fn(); }
  catch (error) { state.error = failure(error); throw error; }
  finally { state.busy = false; }
}

const server = http.createServer(async (req, res) => {
  if (!localRequest(req, port)) return send(res, 403, { error: '拒絕非本機來源' });
  try {
    if (req.method === 'GET' && req.url === '/') {
      const nonce = randomBytes(16).toString('base64');
      const html = (await readFile(path.join(root, 'index.html'), 'utf8')).replaceAll('__TOKEN__', token).replaceAll('__NONCE__', nonce);
      res.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`);
      return send(res, 200, html, 'text/html; charset=utf-8');
    }
    if (!authorized(req, token)) return send(res, 403, { error: '請從本機首頁開啟' });
    if (req.method === 'GET' && req.url === '/api/status') return send(res, 200, state);
    if (req.method === 'GET' && req.url === '/api/relay/status') return send(res, 200, { ...(relayController ? await relayController.status() : { phase: 'unavailable' }), action: relayAction });
    if (req.method === 'GET' && req.url === '/api/rules' && settingsStore) {
      const config = await settingsStore.load();
      return send(res, 200, { config, revision: configRevision(config), telegramConfigured: Boolean(await settingsStore.telegramToken()) });
    }
    if (req.method === 'GET' && req.url === '/api/settings/backup' && settingsStore) return send(res, 200, settingsBackup(await settingsStore.load()));
    if (req.method === 'GET' && req.url === '/api/diagnostics') return send(res, 200, safeDiagnostics(relayController ? await relayController.status() : {}, state.connected));
    if (req.method === 'GET' && req.url === '/api/delivery/review' && reviewStore) {
      await requireStopped();
      return send(res, 200, await operation(() => reviewStore.list()));
    }
    if (req.method !== 'POST') return send(res, 404, { error: '找不到操作' });
    if (state.busy) return send(res, 409, { error: '前一個操作尚未完成' });
    const input = await readJson(req, ['/api/rules', '/api/rules/preview', '/api/settings/validate', '/api/settings/restore'].includes(req.url) ? 131072 : 4096);
    // Body streams can overlap. Recheck after awaiting the body, before starting work.
    if (state.busy) return send(res, 409, { error: '前一個操作尚未完成' });
    if (req.url === '/api/rules/preview') return send(res, 200, previewRules(input));
    if (req.url === '/api/delivery/resolve' && reviewStore) {
      await requireStopped();
      return send(res, 200, await operation(() => reviewStore.resolve(input)));
    }
    if (req.url === '/api/settings/validate') return send(res, 200, { config: validateBackup(input.backup) });
    if (req.url === '/api/platform/check' && settingsStore) {
      await requireStopped();
      const checks = await operation(async () => {
        const config = await settingsStore.load();
        const checks = [];
        const endpoints = config.rules.filter(rule => rule.enabled).flatMap(rule => [...rule.sources, ...rule.destinations]);
        if (endpoints.some(endpoint => endpoint.platform === 'line')) checks.push({ platform: 'LINE', message: state.connected && service.e2eeManager?.getSelfKeyByMid(service.profile?.mid) ? '已連結並具有本機 E2EE 金鑰；實際聊天室權限仍由平台決定' : '尚未連結或缺少 E2EE 金鑰；相關路線無法啟動，請重新手機授權並載入聊天室' });
        if (endpoints.some(endpoint => endpoint.platform === 'telegram')) {
          const client = telegramFactory(await settingsStore.telegramToken());
          const me = await client.getMe(), webhook = await client.getWebhookInfo();
          checks.push({ platform: 'Telegram', message: webhook.url ? '已設定 Webhook；收件會衝突，請在原管理工具停用後再啟動' : '未設定 Webhook；請確認沒有其他程式同時輪詢。群組來源需關閉 Privacy Mode 或給 Bot 管理員權限' });
          for (const endpoint of new Map(endpoints.filter(endpoint => endpoint.platform === 'telegram').map(endpoint => [endpoint.id, endpoint])).values()) {
            try {
              const chat = await client.getChat(endpoint.id), member = chat.type === 'private' ? null : await client.getChatMember(endpoint.id, me.id);
              const unavailable = member && (['left', 'kicked'].includes(member.status) || member.status === 'restricted' && (!member.is_member || member.can_send_messages === false));
              checks.push({ platform: endpoint.name, message: chat.has_protected_content ? '受保護聊天室，不能作為轉送來源；請改選未受保護來源' : unavailable ? 'Bot 不在聊天室或禁止發送；此路線受阻，請加入 Bot 並調整權限' : chat.type === 'channel' && !(member?.status === 'creator' || member?.can_post_messages) ? '頻道發送權限不足；若作為目的，請授予 Bot 發布訊息權限' : '可存取；未發送測試訊息。私訊需先 Start，來源可讀範圍仍受 Privacy Mode 與平台限制' });
            } catch (error) { checks.push({ platform: endpoint.name, message: error instanceof RelayError ? error.message + '；請核對 ID、Bot 成員與權限' : '無法確認聊天室權限；請核對 ID 與網路後重試' }); }
          }
        }
        if (!checks.length) checks.push({ platform: '設定', message: '請先保存並啟用至少一條規則，再檢查平台權限' });
        return checks;
      });
      return send(res, 200, { checks });
    }
    if (req.url === '/api/settings/restore' && settingsStore) {
      await requireStopped();
      const config = validateBackup(input.backup);
      const result = await operation(async () => {
        if (input.revision !== configRevision(await settingsStore.load())) throw new HttpError(409, '設定已變更，請重新載入並檢查備份後再還原');
        if (!settingsStore.restore) throw new HttpError(503, '此環境未提供設定還原');
        return settingsStore.restore(config);
      });
      return send(res, 200, { ...result, revision: configRevision(result.config) });
    }
    if (req.url === '/api/relay/stop' && relayController) {
      relayAction = 'stopping';
      void operation(() => relayController.stop()).catch(() => {}).finally(() => { relayAction = ''; });
      return send(res, 202, { accepted: true });
    }
    if (req.url === '/api/rules' && settingsStore) {
      await requireStopped();
      const config = normalizeConfig(input);
      await operation(async () => {
        if (input.revision !== configRevision(await settingsStore.load())) throw new HttpError(409, '規則已被其他視窗更新；請先保留編輯內容，重新整理後再修改');
        await settingsStore.save(config);
      });
      return send(res, 200, { config, revision: configRevision(config) });
    }
    if (req.url === '/api/telegram/connect' && settingsStore) {
      await requireStopped();
      const result = await operation(async () => {
        const client = telegramFactory(input.token), me = await client.getMe();
        await settingsStore.saveTelegram(input.token);
        return { configured: true, name: String(me.username || me.first_name || 'Bot').slice(0, 100) };
      });
      return send(res, 200, result);
    }
    if (req.url === '/api/telegram/chat' && settingsStore) {
      await requireStopped();
      if (typeof input.id !== 'string' || !/^-?[1-9]\d{0,15}$/.test(input.id) || !Number.isSafeInteger(Number(input.id))) throw new HttpError(400, '請輸入數字聊天室 ID');
      const result = await operation(async () => {
        const chat = await telegramFactory(await settingsStore.telegramToken()).getChat(input.id);
        if (chat.has_protected_content) throw new HttpError(400, '此 Telegram 聊天室禁止轉送');
        return { platform: 'telegram', id: String(chat.id), name: String(chat.title || chat.first_name || chat.username || input.id).slice(0, 100), kind: chat.type === 'private' ? 'person' : 'group' };
      });
      return send(res, 200, result);
    }
    if (req.url === '/api/telegram/chats' && settingsStore) {
      await requireStopped();
      const result = await operation(async () => {
        const updates = await telegramFactory(await settingsStore.telegramToken()).getUpdates(undefined, 0);
        const rows = new Map();
        for (const update of updates) {
          const chat = (update.message || update.channel_post)?.chat;
          if (chat && Number.isSafeInteger(chat.id) && !chat.has_protected_content) rows.set(String(chat.id), { platform: 'telegram', id: String(chat.id), name: String(chat.title || chat.first_name || chat.username || chat.id).slice(0, 100), kind: chat.type === 'private' ? 'person' : 'group' });
        }
        return { endpoints: [...rows.values()] };
      });
      return send(res, 200, result);
    }
    if (req.url === '/api/relay/start' && input.useRules && settingsStore && relayController) {
      await requireStopped();
      const config = await settingsStore.load();
      const rules = config.rules.filter(rule => rule.enabled);
      if (!rules.length) throw new HttpError(400, '請新增並啟用至少一條規則');
      const endpoints = rules.flatMap(rule => [...rule.sources, ...rule.destinations]);
      if (endpoints.some(endpoint => endpoint.platform === 'line') && !state.connected) throw new HttpError(401, '請先登入 LINE');
      if (endpoints.some(endpoint => endpoint.platform === 'telegram') && !await settingsStore.telegramToken()) throw new HttpError(400, '請先連結 Telegram Bot');
      // Recheck after asynchronous configuration reads before acquiring the lock.
      if (state.busy) throw new HttpError(409, '前一個操作尚未完成');
      relayAction = 'starting';
      void operation(() => relayController.startRules(configRevision(config))).catch(() => {}).finally(() => { relayAction = ''; });
      return send(res, 202, { accepted: true });
    }
    if (relayController && ['/api/login', '/api/resume'].includes(req.url)) {
      const relay = await relayController.status();
      if (relay.phase !== 'stopped') return send(res, 409, { error: '請先停止轉送，再連結帳號；無法確認狀態時請先排查本機服務' });
      // Status lookup yields to the event loop; another request may have acquired the lock.
      if (state.busy) return send(res, 409, { error: '前一個操作尚未完成' });
    }
    if (req.url === '/api/login') {
      if (state.connected) return send(res, 409, { error: '已登入，請直接讀取群組' });
      let phone = String(input.phone || '').replace(/[\s-]/g, '');
      if (/^09\d{8}$/.test(phone)) phone = '+886' + phone.slice(1);
      if (!/^\+[1-9]\d{7,14}$/.test(phone)) return send(res, 400, { error: '請輸入 09 開頭台灣手機號碼或 + 國碼手機號碼' });
      state.phase = 'logging_in'; state.pin = '';
      void operation(async () => {
        await runPwlessLogin(service, phone, 'TW', {
          onPin: pin => { state.pin = String(pin); state.phase = 'waiting_pin'; },
          onWaitingBiometric: () => { state.phase = 'waiting_approval'; },
        });
        state.connected = true; state.phase = 'connected';
      }).catch(() => { state.phase = 'failed'; }).finally(() => { state.pin = ''; });
      return send(res, 202, { accepted: true });
    }
    if (req.url === '/api/resume') {
      await operation(async () => {
        state.connected = Boolean(await service.resumeSession());
        state.phase = state.connected ? 'connected' : 'idle';
      });
      return send(res, 200, { connected: state.connected });
    }
    if (!state.connected) return send(res, 401, { error: '請先登入 LINE' });
    if (req.url === '/api/directory') {
      const result = await operation(async () => {
        const rows = await lineDirectory(service);
        groups = new Map(rows.map(row => [row.id, row.name]));
        return { endpoints: rows };
      });
      return send(res, 200, result);
    }
    if (req.url === '/api/relay/start' && relayController) {
      const source = groups.get(input.sourceId), destination = groups.get(input.destinationId);
      if (!source || !destination || input.sourceId === input.destinationId) return send(res, 400, { error: '請選擇不同的來源與目的群組' });
      if ([source, destination].some(name => /[\r\n\x00]/.test(name) || [...groups.values()].filter(value => value === name).length !== 1)) return send(res, 400, { error: '群組名稱重複或含無法使用的字元，請先調整群名' });
      relayAction = 'starting';
      void operation(() => relayController.start(source, destination)).catch(() => {}).finally(() => { relayAction = ''; });
      return send(res, 202, { accepted: true });
    }
    if (req.url === '/api/groups') {
      const result = await operation(async () => {
        const directory = await service.client.getAllChatMids();
        const ids = directory.memberChats.filter(id => /^[cr]/.test(id));
        const chats = await service.client.getChats(ids, false);
        const rows = chats.map(chat => ({ id: chat.chatMid, name: chat.chatName || chat.chatMid })).filter(chat => ids.includes(chat.id));
        groups = new Map(rows.map(chat => [chat.id, chat.name]));
        return { groups: rows, joinedCount: ids.length };
      });
      return send(res, 200, result);
    }
    if (req.url === '/api/messages') {
      const id = String(input.id || '');
      if (!groups.has(id)) return send(res, 400, { error: '請先讀取群組列表並選擇群組' });
      const result = await operation(async () => {
        const raw = await service.getRecentMessages(id, 50);
        const messages = raw.map(message => ({
          id: String(message.id || ''),
          time: Number(message.createdTime || message.deliveredTime || 0),
          sender: String(message.from || ''),
          text: typeof message.text === 'string' ? message.text : '',
          type: message.contentType ?? null,
          decryptFailed: Boolean(message.e2eeDecryptFailure),
        })).sort((a, b) => a.time - b.time);
        state.reads++; state.messages = messages.length;
        state.readable = messages.filter(message => message.text.length > 0).length;
        state.decryptFailed = messages.filter(message => message.decryptFailed).length;
        state.checkedAt = new Date().toISOString();
        return { group: groups.get(id), messages, checkedAt: state.checkedAt };
      });
      return send(res, 200, result);
    }
    return send(res, 404, { error: '找不到操作' });
  } catch (error) { send(res, error instanceof HttpError ? error.status : 500, { error: error instanceof HttpError ? error.message : failure(error) }); }
});
return hardenServer(server);
}

async function main() {
const print = console.log.bind(console);
for (const method of ['log', 'warn', 'error', 'debug', 'info', 'trace']) console[method] = () => {};
const dataDir = await prepareDataDirectory();
const { LineClient } = await import('./node_modules/@rikaidev/yomi/dist/line/client/index.js');
guardProtocol(LineClient);
const { LineProtocolService } = await import('./node_modules/@rikaidev/yomi/dist/line/core/service.js');
const { runPwlessLogin } = await import('./node_modules/@rikaidev/yomi/dist/cli/login.js');
const server = createProbeServer({ service: new LineProtocolService(), runPwlessLogin, relayController: createRelayController(), settingsStore: createSettingsStore(dataDir), reviewStore: createDeliveryReviewStore(dataDir) });
server.on('error', () => { print('Local server could not start; check port 18765.'); process.exitCode = 1; });
server.listen(18765, '127.0.0.1', () => print('LinePort: http://127.0.0.1:18765/'));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { process.stderr.write('Startup failed; check data permissions and dependencies.\n'); process.exitCode = 1; });
}
