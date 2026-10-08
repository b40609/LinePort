import http from 'node:http';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { appendRecord, loadJournal, establishBaseline, forwardBatch } from './relay-core.mjs';
import { localRequest, hardenServer } from './local-http.mjs';
import { prepareDataDirectory } from './runtime.mjs';
import { guardProtocol } from './protocol-guard.mjs';
import { inspectRelayRead, requireRelayEncryption } from './relay-health.mjs';
import { sendRelayText, prepareRelayDestination } from './relay-send.mjs';
for (const key of ['log', 'warn', 'error', 'debug', 'info', 'trace']) console[key] = () => {};
const state = { app: 'line-relay-bridge', version: 2, pid: process.pid, phase: 'starting', source: process.env.LINECALL_SOURCE || '來源1', destination: process.env.LINECALL_DESTINATION || '目的2', intervalSeconds: 3, retrySeconds: 0, consecutiveErrors: 0, startedAt: null, polls: 0, forwarded: 0, uncertain: 0, errors: 0, lastPoll: null, stage: 'start' };
const server = http.createServer((req, res) => {
  if (!localRequest(req, 18766) || req.url !== '/status' || req.method !== 'GET') { res.writeHead(403); res.end(); return; }
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'", 'Referrer-Policy': 'no-referrer' });
  res.end(JSON.stringify(state));
});
server.on('error', () => process.exit(1));
hardenServer(server);
await new Promise(resolve => server.listen(18766, '127.0.0.1', resolve));
try {
state.stage = 'data_permissions';
const dataDir = await prepareDataDirectory();
const { LineClient } = await import('./node_modules/@rikaidev/yomi/dist/line/client/index.js');
guardProtocol(LineClient);
const routeKey = createHash('sha256').update(JSON.stringify([state.source, state.destination])).digest('hex').slice(0, 24);
const journal = path.join(dataDir, state.source === '來源1' && state.destination === '目的2'
  ? 'relay-source1-destination2.jsonl' : `relay-${routeKey}.jsonl`);
const record = row => appendRecord(journal, row);
state.stage = 'journal';
const saved = await loadJournal(journal);
const seen = saved.seen;
let startedAt = saved.startedAt;
  const { LineProtocolService } = await import('./node_modules/@rikaidev/yomi/dist/line/core/service.js');
  const service = new LineProtocolService();
  service.on('error', () => {});
  state.stage = 'resume';
  if (!await service.resumeSession()) throw new Error('No session');
  state.stage = 'groups';
  const directory = await service.client.getAllChatMids();
  const chats = await service.client.getChats(directory.memberChats.filter(id => /^[cr]/.test(id)), false);
  const find = name => {
    const matches = chats.filter(chat => chat.chatName === name);
    if (matches.length !== 1) throw new Error('Ambiguous group');
    return matches[0].chatMid;
  };
  const source = find(state.source), destination = find(state.destination);
  if (source === destination) throw new Error('Same group');
  state.stage = 'route_identity';
  if (!service.profile?.mid) throw new Error('Missing account identity');
  state.stage = 'e2ee_keys';
  requireRelayEncryption(service);
  state.stage = 'destination_e2ee';
  await prepareRelayDestination(service, destination);
  state.stage = 'route_identity';
  const routeIdentity = createHash('sha256').update(JSON.stringify([service.profile.mid, source, destination])).digest('hex');
  if (saved.routeIdentity && saved.routeIdentity !== routeIdentity) throw new Error('Route identity changed');
  if (!saved.routeIdentity) await record({ routeIdentity });
  state.stage = 'baseline';
  if (!startedAt) {
    startedAt = Date.now();
    const baseline = await service.getRecentMessages(source, 50);
    await establishBaseline({ messages: baseline, startedAt, record, seen });
  }
  state.startedAt = new Date(startedAt).toISOString();
  state.phase = 'running';
  async function poll() {
    try {
      state.stage = 'read';
      const messages = await service.getRecentMessages(source, 50);
      if (service.loginRequired) { state.stage = 'login_required'; throw new Error('Login required'); }
      state.polls++; state.lastPoll = new Date().toISOString();
      state.lastRead = inspectRelayRead(messages, seen, startedAt);
      await forwardBatch({ messages, seen, startedAt, record, send: text => sendRelayText(service, destination, text), state });
      state.consecutiveErrors = 0; state.retrySeconds = 0;
      state.stage = 'waiting';
    } catch {
      state.errors++;
      state.consecutiveErrors++;
      if (state.stage !== 'read' || service.loginRequired || state.consecutiveErrors >= 5) { state.phase = 'failed'; return; }
      state.retrySeconds = Math.min(60, 3 * 2 ** (state.consecutiveErrors - 1));
    }
    setTimeout(poll, (state.retrySeconds || 3) * 1000);
  }
  await poll();
} catch { state.phase = 'failed'; state.errors++; }
