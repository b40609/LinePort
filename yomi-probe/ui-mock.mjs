// Local UI verification only: no credentials, persistence or platform network calls.
import { EventEmitter } from 'node:events';
import { createProbeServer } from './server.mjs';
import { normalizeConfig } from './route-config.mjs';

const service = new EventEmitter();
service.e2eeManager = { getSelfKeyByMid: () => ({ synthetic: true }) };
service.resumeSession = async () => true;
service.profile = { mid: 'usynthetic' };
service.client = {
  getAllChatMids: async () => ({ memberChats: ['csource', 'cdestination'] }),
  getChats: async () => [{ chatMid: 'csource', chatName: 'LINE 團隊示範群組', extra: { 1: { 4: { usender: 1, usilent: 1, ubystander: 1 }, 5: { uinvited: 1 } } } }, { chatMid: 'cdestination', chatName: '示範目的群組' }],
  getAllContactIds: async () => ['ufriend'], getContacts: async () => [{ mid: 'ufriend', displayName: '示範朋友' }, { mid: 'usender', displayName: '示範成員' }, { mid: 'ubystander', displayName: '示範路人' }, { mid: 'usilent', displayName: '尚未發言成員' }],
};
service.getRecentMessages = async () => [{ id: 'synthetic-message', from: 'usender', text: '公告：明天系統更新 <script> 不會執行', createdTime: Date.now() }];
let config = { version: 1, rules: [] }, token = '', discordToken = '', tgProtected = false, dcProtected = false, relay = { phase: 'stopped' };
const settingsStore = { load: async () => config, save: async value => { config = normalizeConfig(value); return config; }, restore: async value => { config = normalizeConfig(value); return { config, backup: 'mock-original-settings.json' }; }, telegramToken: async () => token, saveTelegram: async (value, protect) => { token = value; tgProtected ||= protect; }, telegramProtected: async () => tgProtected, discordToken: async () => discordToken, saveDiscord: async (value, protect) => { discordToken = value; dcProtected ||= protect; }, discordProtected: async () => dcProtected };
const relayController = {
  status: async () => relay,
  async startRules(revision) {
    relay = { version: 3, revision, phase: 'running', forwarded: 0, errors: 0, polls: 1,
      routes: config.rules.filter(rule => rule.enabled).flatMap(rule => rule.sources.flatMap(source => rule.destinations.map(destination => ({ name: rule.name, source, destination, phase: 'running', forwarded: 0, pending: 0, uncertain: 0, errors: 0, skipped: 0, warning: '' })))),
      sources: config.rules.filter(rule => rule.enabled).flatMap(rule => rule.sources).map(source => ({ ...source, polls: 1, received: 0, decryptFailed: 0, lastPoll: new Date().toISOString(), warning: '' })) };
    return relay;
  },
  async stop() { relay = { phase: 'stopped' }; return relay; },
};
const telegramFactory = () => ({ getMe: async () => ({ id: 12345, username: 'LinePortDemoBot' }),
  getWebhookInfo: async () => ({ url: '' }), getChatMember: async () => ({ status: 'administrator', can_post_messages: true }),
  getChat: async id => ({ id: Number(id), title: 'Telegram 示範群組', type: 'supergroup' }),
  getUpdates: async () => [{ update_id: 1, message: { message_id: 1, date: Math.floor(Date.now()/1000), from: { id: 123, first_name: '示範成員' }, text: '通知：明天系統更新', chat: { id: -10012345, title: 'Telegram 示範群組', type: 'supergroup' } } }],
});
const discordFactory = () => ({ getMe: async () => ({ id: '123456789012345678', username: 'LinePortDemoBot', bot: true }), getChannel: async id => ({ id, type: 0, guild_id: '234567890123456789', name: 'notifications-demo' }) });
const reviewStore = { list: async () => ({ items: [] }), resolve: async () => { throw new Error('No mock review items'); } };
const server = createProbeServer({ service, runPwlessLogin: async () => {}, relayController, settingsStore, reviewStore, telegramFactory, discordFactory, port: 18767 });
server.listen(18767, '127.0.0.1', () => process.stdout.write('LinePort mock UI: http://127.0.0.1:18767/\n'));
// Automatic cleanup also protects interrupted verification sessions.
setTimeout(() => server.close(() => process.exit(0)), 10 * 60 * 1000).unref();
process.stdin.on('data', data => { if (data.toString().trim() === 'stop') server.close(() => process.exit(0)); });
