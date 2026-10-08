import http from 'node:http';
import path from 'node:path';
import { mkdir, readFile, appendFile } from 'node:fs/promises';
import { unseenText } from './relay-rules.mjs';
const dataDir = path.join(process.env.LOCALAPPDATA, 'LineCallYomiProbe');
process.env.YOMI_DATA_DIR = dataDir;
process.env.YOMI_NO_KEYCHAIN = '1';
for (const key of ['log', 'warn', 'error', 'debug', 'info', 'trace']) console[key] = () => {};
const state = { phase: 'starting', source: '來源1', destination: '目的2', intervalSeconds: 3, startedAt: null, polls: 0, forwarded: 0, uncertain: 0, errors: 0, lastPoll: null, stage: 'start' };
const server = http.createServer((req, res) => {
  if (req.headers.host !== '127.0.0.1:18766' || req.url !== '/status' || req.method !== 'GET') { res.writeHead(403); res.end(); return; }
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(state));
});
server.on('error', () => process.exit(1));
await new Promise(resolve => server.listen(18766, '127.0.0.1', resolve));
const journal = path.join(dataDir, 'relay-source1-destination2.jsonl');
const seen = new Set();
let startedAt;
async function record(row) { await appendFile(journal, JSON.stringify(row) + '\n', 'utf8'); }
try {
  await mkdir(dataDir, { recursive: true });
  try {
    const lines = (await readFile(journal, 'utf8')).trim().split('\n').filter(Boolean);
    for (const line of lines) {
      const row = JSON.parse(line);
      if (row.startedAt) startedAt = row.startedAt;
      if (row.id) seen.add(row.id);
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
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
  state.stage = 'baseline';
  if (!startedAt) {
    startedAt = Date.now();
    const baseline = await service.getRecentMessages(source, 50);
    await record({ startedAt });
    for (const message of baseline) {
      if (!message.id) continue;
      const id = String(message.id);
      await record({ id, outcome: 'baseline' });
      seen.add(id);
    }
  }
  state.startedAt = new Date(startedAt).toISOString();
  state.phase = 'running';
  async function poll() {
    try {
      state.stage = 'read';
      const messages = await service.getRecentMessages(source, 50);
      state.polls++; state.lastPoll = new Date().toISOString();
      for (const message of unseenText(messages, seen, startedAt)) {
        const id = String(message.id);
        // Persist before sending: ambiguous network failures must not cause duplicates.
        state.stage = 'journal';
        await record({ id, outcome: 'sending' });
        seen.add(id);
        state.stage = 'send';
        try {
          await service.sendMessage(destination, message.text);
        } catch {
          state.uncertain++;
          await record({ id, outcome: 'uncertain' });
          continue;
        }
        state.forwarded++;
        state.stage = 'journal';
        await record({ id, outcome: 'sent' });
      }
      state.stage = 'waiting';
    } catch {
      state.errors++;
      if (state.stage === 'journal') { state.phase = 'failed'; return; }
    }
    setTimeout(poll, 3000);
  }
  await poll();
} catch { state.phase = 'failed'; state.errors++; }
