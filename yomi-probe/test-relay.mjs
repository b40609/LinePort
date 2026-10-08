import path from 'node:path';
process.env.YOMI_DATA_DIR = path.join(process.env.LOCALAPPDATA, 'LineCallYomiProbe');
process.env.YOMI_NO_KEYCHAIN = '1';
const print = console.log.bind(console);
for (const key of ['log', 'warn', 'error', 'debug', 'info', 'trace']) console[key] = () => {};
const { LineProtocolService } = await import('./node_modules/@rikaidev/yomi/dist/line/core/service.js');
const service = new LineProtocolService();
service.on('error', () => {});
let stage = 'resume';
let sent = false;
try {
  if (!await service.resumeSession()) throw new Error('No session');
  stage = 'groups';
  const directory = await service.client.getAllChatMids();
  const chats = await service.client.getChats(directory.memberChats.filter(id => /^[cr]/.test(id)), false);
  const find = name => {
    const matches = chats.filter(chat => chat.chatName === name);
    if (matches.length !== 1) throw new Error('Ambiguous group');
    return matches[0].chatMid;
  };
  const source = find('來源1');
  const destination = find('目的2');
  if (source === destination) throw new Error('Same group');
  stage = 'read_source';
  const messages = await service.getRecentMessages(source, 50);
  const latest = messages.filter(m => typeof m.text === 'string' && m.text.trim() && !m.e2eeDecryptFailure)
    .sort((a, b) => Number(b.createdTime || b.deliveredTime || 0) - Number(a.createdTime || a.deliveredTime || 0))[0];
  if (!latest) throw new Error('No readable text');
  stage = 'send';
  const result = await service.sendMessage(destination, latest.text);
  sent = true;
  stage = 'verify_destination';
  const received = await service.getRecentMessages(destination, 50);
  const verified = received.some(m => String(m.id) === String(result.id) && m.text === latest.text && !m.e2eeDecryptFailure);
  print(JSON.stringify({ source: '來源1', destination: '目的2', sent, verified, sourceTextLength: latest.text.length }));
  process.exit(verified ? 0 : 2);
} catch (error) {
  print(JSON.stringify({ stage, sent, verified: false, code: typeof error?.code === 'number' ? error.code : null }));
  process.exit(1);
}
