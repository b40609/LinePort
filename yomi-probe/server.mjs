import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, mkdir } from 'node:fs/promises';
import { randomBytes, timingSafeEqual } from 'node:crypto';

const root = path.dirname(fileURLToPath(import.meta.url));
const port = 18765;
const origin = `http://127.0.0.1:${port}`;
const token = randomBytes(32).toString('hex');
process.env.YOMI_DATA_DIR = path.join(process.env.LOCALAPPDATA || root, 'LineCallYomiProbe');
process.env.YOMI_NO_KEYCHAIN = '1';
await mkdir(process.env.YOMI_DATA_DIR, { recursive: true });
// Upstream log contexts can contain credentials. Only our static diagnostics reach stdout.
const print = console.log.bind(console);
for (const method of ['log', 'warn', 'error', 'debug', 'info', 'trace']) console[method] = () => {};
const { LineProtocolService } = await import('./node_modules/@rikaidev/yomi/dist/line/core/service.js');
const { runPwlessLogin } = await import('./node_modules/@rikaidev/yomi/dist/cli/login.js');
const service = new LineProtocolService();
service.on('error', () => {});
const state = { phase: 'idle', connected: false, busy: false, pin: '', error: '', reads: 0, messages: 0, readable: 0, decryptFailed: 0, checkedAt: null };
let groups = new Map();

function failure(error) {
  const code = error?.code;
  const suffix = typeof code === 'number' ? ` (${code})` : '';
  return `操作失敗${suffix}；請確認手機授權、網路及 LINE 登入狀態後重試。`;
}
function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY' });
  res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
}
function authorized(req) {
  const supplied = Buffer.from(String(req.headers['x-probe-token'] || ''));
  const expected = Buffer.from(token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
async function body(req) {
  let text = '';
  for await (const part of req) {
    text += part;
    if (text.length > 4096) throw new Error('Body too large');
  }
  return JSON.parse(text || '{}');
}
async function operation(fn) {
  state.busy = true;
  state.error = '';
  try { return await fn(); }
  catch (error) { state.error = failure(error); throw error; }
  finally { state.busy = false; }
}

const server = http.createServer(async (req, res) => {
  if (req.headers.host !== `127.0.0.1:${port}` || (req.headers.origin && req.headers.origin !== origin)) return send(res, 403, { error: '拒絕非本機來源' });
  try {
    if (req.method === 'GET' && req.url === '/') {
      const nonce = randomBytes(16).toString('base64');
      const html = (await readFile(path.join(root, 'index.html'), 'utf8')).replaceAll('__TOKEN__', token).replaceAll('__NONCE__', nonce);
      res.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`);
      return send(res, 200, html, 'text/html; charset=utf-8');
    }
    if (!authorized(req)) return send(res, 403, { error: '請從本機首頁開啟' });
    if (req.method === 'GET' && req.url === '/api/status') return send(res, 200, state);
    if (req.method !== 'POST') return send(res, 404, { error: '找不到操作' });
    if (state.busy) return send(res, 409, { error: '前一個操作尚未完成' });
    const input = await body(req);
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
  } catch (error) { send(res, 500, { error: failure(error) }); }
});
server.on('error', () => { print('Local server could not start; check port 18765.'); process.exitCode = 1; });
server.listen(port, '127.0.0.1', () => print(`LINE Relay Bridge: ${origin}`));
