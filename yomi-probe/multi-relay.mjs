import path from 'node:path';
import { createHash } from 'node:crypto';
import { appendRecord, loadJournal, establishBaseline } from './relay-core.mjs';
import { unseenText } from './relay-rules.mjs';
import { createSettingsStore, configRevision, endpointKey, matchingContent } from './route-config.mjs';
import { lineDirectory, readLineSince } from './line-directory.mjs';
import { requireRelayEncryption, inspectRelayRead, RelayError } from './relay-health.mjs';
import { sendRelayText, prepareRelayDestination } from './relay-send.mjs';
import { createTelegramClient, createTelegramInbox, TelegramRateLimit } from './telegram.mjs';
import { createDiscordClient, DiscordRateLimit } from './discord.mjs';
import { inspectDelivery } from './delivery-review.mjs';
import { inSchedule } from './rule-options.mjs';
import { readJournalFile, storageHealth } from './storage-health.mjs';
import { sourceReply, destinationReply } from './reply-links.mjs';
import { sendLinePhoto } from './line-media.mjs';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
class OperationTimeout extends RelayError {}
async function withDeadline(operation, timeoutMs, onTimeout) {
  let timer;
  try {
    return await Promise.race([operation, new Promise((_, reject) => {
      timer = setTimeout(() => { onTimeout?.(); reject(new OperationTimeout('平台請求逾時')); }, timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}
async function rowsFrom(file) {
  try {
    const text = await readJournalFile(file);
    if (text && !text.endsWith('\n')) throw new Error('Incomplete journal');
    return text.split('\n').filter(Boolean).map(line => JSON.parse(line));
  } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
export async function createMultiRelay({ config, adapters, platformErrors = {}, directory, now = Date.now, pause = sleep, operationTimeoutMs = 30000, queueLimit = 1000, deliveryBudget = 10, writeRecord = appendRecord }) {
  if (!Number.isSafeInteger(queueLimit) || queueLimit < 1 || !Number.isSafeInteger(deliveryBudget) || deliveryBudget < 1) throw new Error('Invalid queue limits');
  const cursors = new Map();
  const cooldowns = new Map();
  const reading = new Set(), delivering = new Set();
  const attemptedDestinations = new Set();
  const outputFile = path.join(directory, 'lineport-output.jsonl');
  const outputs = new Set();
  for (const row of await rowsFrom(outputFile)) {
    if (typeof row.key !== 'string') throw new Error('Invalid output journal');
    outputs.add(row.key);
  }
  const edges = [], sources = new Map(), preparations = new Map(), baselines = new Map();
  const state = { version: 3, revision: configRevision(config), phase: 'starting', stage: 'rules', polls: 0, forwarded: 0, uncertain: 0, errors: 0, lastPoll: null, routes: [], sources: [] };
  for (const rule of config.rules.filter(rule => rule.enabled)) for (const source of rule.sources) for (const destination of rule.destinations) {
    const sourceKey = endpointKey(source), destinationKey = endpointKey(destination);
    const status = { key: digest([sourceKey, destinationKey]).slice(0, 24), ruleId: rule.id, name: rule.name, source, destination,
      phase: 'starting', stage: 'baseline', forwarded: 0, uncertain: 0, errors: 0, skipped: 0, pending: 0, lastSend: null, warning: '' };
    state.routes.push(status);
    const edge = { rule, source, destination, status, seen: new Set(), startedAt: now() };
    edges.push(edge);
    if (!sources.has(sourceKey)) sources.set(sourceKey, { endpoint: source, edges: [], polls: 0, lastPoll: null, received: 0, decryptFailed: 0, warning: '', failures: 0, retryAt: 0 });
    sources.get(sourceKey).edges.push(edge);
    try {
      const from = adapters[source.platform], to = adapters[destination.platform];
      if (!from || !to) throw new RelayError(platformErrors[!from ? source.platform : destination.platform] || '此平台尚未連結，請先設定帳號');
      const identity = digest([rule.id, from.identity, sourceKey, to.identity, destinationKey]);
      edge.file = path.join(directory, `lineport-route-${identity}.jsonl`);
      edge.record = row => writeRecord(edge.file, row);
      const saved = await loadJournal(edge.file);
      if (saved.routeIdentity && saved.routeIdentity !== identity) throw new Error('Invalid identity');
      edge.seen = saved.seen;
      edge.pending = saved.pending;
      edge.replies = saved.replies;
      edge.delivered = saved.delivered;
      cooldowns.set(destination.platform, Math.max(cooldowns.get(destination.platform) || 0, saved.retryAt));
      status.pending = edge.pending.size;
      edge.startedAt = saved.startedAt || now();
      if (!saved.routeIdentity) await edge.record({ routeIdentity: identity, name: rule.name, source, destination });
      const reviewed = await inspectDelivery(directory, identity);
      const unresolved = reviewed.unresolved;
      edge.pending = reviewed.pending;
      status.pending = edge.pending.size;
      if (unresolved.size) {
        status.phase = 'blocked'; status.stage = 'send_uncertain'; status.uncertain = unresolved.size;
        status.warning = '有發送結果不明的訊息，已暫停此路線；請停止轉送，到人工處理逐筆核對。重啟不會自動重送。';
        continue;
      }
      if (!preparations.has(destinationKey)) preparations.set(destinationKey, withDeadline(to.prepare(destination.id), operationTimeoutMs));
      await preparations.get(destinationKey);
      if (!saved.startedAt) {
        if (!baselines.has(sourceKey)) baselines.set(sourceKey, withDeadline(from.recent(source.id), operationTimeoutMs));
        const baseline = await baselines.get(sourceKey);
        await establishBaseline({ messages: baseline, startedAt: edge.startedAt, record: edge.record, seen: edge.seen });
      }
      status.phase = 'running'; status.stage = 'waiting';
    } catch (error) {
      status.phase = 'failed'; status.errors++;
      status.warning = error instanceof RelayError ? error.message : '此路線初始化失敗；請檢查帳號、讀取權限、E2EE 與本機紀錄';
    }
  }
  if (!edges.length) throw new RelayError('請至少啟用一條轉送規則');
  function refresh() {
    for (const key of ['forwarded', 'uncertain', 'errors']) state[key] = edges.reduce((sum, edge) => sum + edge.status[key], 0);
    state.errors += [...sources.values()].reduce((sum, source) => sum + source.failures, 0);
    state.sources = [...sources.values()].map(source => ({ ...source.endpoint, polls: source.polls, lastPoll: source.lastPoll, received: source.received, decryptFailed: source.decryptFailed, warning: source.warning }));
    state.phase = edges.every(edge => ['failed', 'blocked'].includes(edge.status.phase)) ? 'failed'
      : edges.some(edge => edge.status.phase !== 'running' || edge.status.warning) || [...sources.values()].some(source => source.warning) ? 'degraded' : 'running';
    state.warning = state.phase === 'running' ? '' : '部分路線受阻，請查看各路線與來源狀態';
    state.stage = 'waiting';
  }
  refresh();
  async function tick({ sourceKeys = [...sources.keys()], deliver = true } = {}) {
    let capacity;
    try { capacity = await storageHealth(directory); }
    catch { capacity = { blocked: true, warning: '本機容量或紀錄狀態無法確認；已停止相關路線，請保留原檔並檢查磁碟與權限' }; }
    if (capacity.blocked) {
      for (const edge of edges.filter(edge => edge.status.phase === 'running')) { edge.status.phase = 'failed'; edge.status.errors++; edge.status.warning = capacity.warning; }
      refresh(); return;
    }
    const batches = new Map();
    await Promise.all([...sources.entries()].map(async ([key, source]) => {
      const live = source.edges.filter(edge => edge.status.phase === 'running');
      if (!sourceKeys.includes(key) || !live.length || source.retryAt > now() || reading.has(key)) return;
      reading.add(key);
      try {
        const oldest = Math.min(...live.map(edge => edge.startedAt));
        // Only stop paging at a checkpoint shared by EVERY active destination.
        const known = new Set([...live[0].seen].filter(id => live.every(edge => edge.seen.has(id))));
        // Keep an outstanding read after timeout: retry must not spawn overlapping requests.
        source.pendingRead ||= Promise.resolve().then(() => adapters[source.endpoint.platform].read(source.endpoint.id, oldest, known));
        const messages = await withDeadline(source.pendingRead, operationTimeoutMs);
        source.pendingRead = null;
        const health = adapters[source.endpoint.platform].health?.();
        if (health) { source.polls = health.polls; source.lastPoll = health.lastPoll; }
        else { source.polls++; source.lastPoll = new Date(now()).toISOString(); }
        state.polls = [...sources.values()].reduce((sum, value) => sum + value.polls, 0);
        state.lastPoll = [...sources.values()].map(value => value.lastPoll).filter(Boolean).sort().at(-1) || null;
        source.received = messages.length;
        source.decryptFailed = messages.filter(message => message.e2eeDecryptFailure && Number(message.createdTime || message.deliveredTime) >= oldest).length;
        source.warning = source.decryptFailed ? '來源有文字無法解密，請確認 E2EE 金鑰' : health?.warning || '';
        source.retryAt = 0; source.consecutiveErrors = 0;
        const filtered = messages.filter(message => !outputs.has(`${adapters[source.endpoint.platform].identity}:${key}:${message.id}`));
        batches.set(key, filtered);
        for (const edge of live) {
          edge.status.lastRead = inspectRelayRead(filtered, edge.seen, edge.startedAt);
        }
        if (!source.warning && live.some(edge => edge.status.lastRead.invalidTime > 0)) source.warning = '來源有訊息缺少有效時間，已略過；請回報此狀態供排查';
        if (!source.warning && live.some(edge => edge.status.lastRead.history > 0)) source.warning = '來源有未處理訊息早於啟動基準，已略過；請核對電腦日期與時間';
      } catch (error) {
        if (!(error instanceof OperationTimeout)) source.pendingRead = null;
        source.failures++; source.consecutiveErrors = (source.consecutiveErrors || 0) + 1;
        source.retryAt = now() + Math.min(60000, 3000 * 2 ** Math.min(source.consecutiveErrors - 1, 5));
        source.warning = error instanceof RelayError ? error.message : '讀取失敗或超過補讀上限；退避重試，已保存的待送訊息繼續處理，請檢查登入與歷史訊息';
      } finally { reading.delete(key); }
    }));
    // Commit the payload before advancing the source checkpoint.
    for (const edge of edges.filter(edge => edge.status.phase === 'running' && batches.has(endpointKey(edge.source)))) {
      try {
        for (const message of unseenText(batches.get(endpointKey(edge.source)), edge.seen, edge.startedAt, edge.rule.media)) {
          if (edge.pending.size >= queueLimit) break;
          const id = String(message.id), text = matchingContent(edge.rule, message, endpointKey(edge.source));
          if (text === null) {
            await edge.record({ id, outcome: 'baseline' }); edge.seen.add(id); edge.status.skipped++; continue;
          }
          if (edge.destination.platform === 'telegram' && typeof text === 'string' && text.length > 4096) throw new RelayError('含前綴的文字超過 Telegram 4,096 字元上限；此路線已暫停');
          if (edge.destination.platform === 'discord' && (typeof text !== 'string' || text.length > 2000)) throw new RelayError('含前綴的文字超過 Discord 2,000 字元上限，已暫停此路線；請縮短內容或改選目的');
          const parent = edge.rule.replies ? sourceReply(message, edge.source.platform, edge.source.id) : null;
          const reply = parent ? { replyVersion: 1, replyTo: parent } : {};
          await edge.record(typeof text === 'string' ? { id, outcome: 'queued', text, ...reply } : { id, outcome: 'media_queued', payloadVersion: 1, payload: text, ...reply });
          if (parent) edge.replies.set(id, parent);
          edge.pending.set(id, text); edge.seen.add(id);
        }
      } catch (error) {
        edge.status.phase = 'failed'; edge.status.errors++;
        edge.status.warning = error instanceof RelayError ? error.message : '待送訊息保存失敗，已暫停此路線';
      }
    }
    const destinations = new Map();
    for (const edge of edges.filter(edge => edge.status.phase === 'running')) {
      const key = endpointKey(edge.destination);
      if (!destinations.has(key)) destinations.set(key, []);
      destinations.get(key).push(edge);
    }
    await Promise.all([...destinations.entries()].map(async ([destinationKey, group]) => {
      if (!deliver || delivering.has(destinationKey)) return;
      delivering.add(destinationKey);
      try {
      let attempted = attemptedDestinations.has(destinationKey);
      let cursor = cursors.get(destinationKey) || 0;
      for (let count = 0; count < deliveryBudget; count++) {
        let edge;
        for (let scan = 0; scan < group.length; scan++) {
          const candidate = group[cursor++ % group.length];
          if (candidate.status.phase === 'running' && candidate.pending.size && inSchedule(candidate.rule.schedule, now()) && !(cooldowns.get(candidate.destination.platform) > now())) { edge = candidate; break; }
        }
        if (!edge) break;
        const status = edge.status;
        try {
          {
            const [id, text] = edge.pending.entries().next().value;
            if (attempted) await pause(1100);
            if (cooldowns.get(edge.destination.platform) > now() || !inSchedule(edge.rule.schedule, now())) break;
            status.stage = 'prepare';
            const prepared = adapters[edge.destination.platform].preparePayload
              ? await withDeadline(adapters[edge.destination.platform].preparePayload(text), operationTimeoutMs) : undefined;
            status.stage = 'journal';
            await edge.record({ id, outcome: 'sending' }); edge.seen.add(id);
            status.stage = 'send';
            const parent = edge.replies.get(id);
            const replyTo = edge.rule.replies && parent ? destinationReply(edge.destination.platform, edge.destination.id, edge.delivered.get(parent)) : undefined;
            status.replyNotice = parent && !replyTo ? '原訊息未轉送、尚未確認送達或沒有可用對照；這則改送一般訊息，不補送原訊息' : replyTo ? (edge.destination.platform === 'line' ? '引用此路線已確認送達的原訊息；引用失敗會暫停此路線，請先確認平台狀態' : '引用此路線已確認送達的原訊息；平台找不到原訊息時可能改送一般訊息') : '';
            let result;
            try {
              attempted = true;
              attemptedDestinations.add(destinationKey);
              const controller = new AbortController();
              result = await withDeadline(adapters[edge.destination.platform].send(edge.destination.id, text, { ...(prepared ? { prepared, signal: controller.signal } : {}), ...(replyTo ? { replyTo } : {}) }), operationTimeoutMs, () => controller.abort());
              if (!result?.id) throw new Error('Missing acknowledgement');
            } catch (error) {
              if (edge.destination.platform === 'telegram' && error instanceof TelegramRateLimit || edge.destination.platform === 'discord' && error instanceof DiscordRateLimit) {
                const retryAt = Math.max(cooldowns.get(edge.destination.platform) || 0, now() + error.retryAfterMs);
                await edge.record({ id, outcome: 'retry', retryAt });
                cooldowns.set(edge.destination.platform, retryAt);
                status.stage = 'waiting';
                break;
              }
              status.uncertain++; status.stage = 'send_uncertain'; status.phase = 'blocked';
              status.warning = (error instanceof RelayError ? error.message + '；' : '') + '發送結果不明，已暫停此路線，請核對目的訊息；其他路線繼續。';
              await edge.record({ id, outcome: 'uncertain' });
              throw error;
            }
            status.stage = 'journal';
            for (const outputId of new Set([result.id, ...(result.ids || [])])) {
              const key = `${adapters[edge.destination.platform].identity}:${endpointKey(edge.destination)}:${outputId}`;
              await writeRecord(outputFile, { key }); outputs.add(key);
            }
            const acknowledged = destinationReply(edge.destination.platform, edge.destination.id, result.id);
            await edge.record({ id, outcome: 'sent', ...(acknowledged ? { destinationId: acknowledged } : {}) });
            if (acknowledged) edge.delivered.set(id, acknowledged);
            edge.pending.delete(id);
            status.forwarded++; status.lastSend = new Date(now()).toISOString();
          }
          status.stage = 'waiting';
        } catch (error) {
          status.errors++;
          if (status.phase !== 'blocked') {
            status.phase = 'failed';
            status.warning = error instanceof RelayError ? error.message : '本機紀錄或發送處理失敗，已暫停此路線；請核對訊息後再處理';
          }
        }
      }
      cursors.set(destinationKey, cursor % group.length);
      } finally { delivering.delete(destinationKey); }
    }));
    for (const edge of edges) {
      if (!edge.pending) continue;
      edge.status.pending = edge.pending.size;
      edge.status.retryAt = cooldowns.get(edge.destination.platform) > now() ? cooldowns.get(edge.destination.platform) : 0;
      if (edge.status.phase === 'running') edge.status.warning = cooldowns.get(edge.destination.platform) > now()
        ? `${edge.destination.platform === 'discord' ? 'Discord' : 'Telegram'} 限流中，待送訊息已保存，等待後自動重試` : edge.pending.size && !inSchedule(edge.rule.schedule, now()) ? '時段外，已保留待送；進入時段後自動處理' : edge.pending.size >= Math.ceil(queueLimit * 0.8)
        ? `待送佇列接近容量（${edge.pending.size}/${queueLimit}）；未入列的訊息將於後續補讀` : capacity.warning;
    }
    refresh();
  }
  return { state, tick, sourceKeys: [...sources.keys()] };
}

export async function runMultiRelay(state, directory, { createLineService }) {
  const store = createSettingsStore(directory), config = await store.load();
  if (configRevision(config) !== process.env.LINEPORT_CONFIG_REVISION) throw new RelayError('規則已變動，請停止後重新啟動');
  const endpoints = config.rules.filter(rule => rule.enabled).flatMap(rule => [...rule.sources, ...rule.destinations]);
  const adapters = {}, platformErrors = {};
  let telegramMediaClient;
  if (endpoints.some(endpoint => endpoint.platform === 'discord')) {
    try {
      const client = createDiscordClient(await store.discordToken()), me = await client.getMe();
      adapters.discord = { identity: `discord:${me.id}`, prepare: id => client.getChannel(id), send: (id, text, options) => client.send(id, text, options) };
    } catch (error) { platformErrors.discord = error instanceof RelayError ? error.message : 'Discord 連結失敗；請檢查 Bot 與目的頻道權限'; }
  }
  if (endpoints.some(endpoint => endpoint.platform === 'line')) {
    try {
      const service = await createLineService();
      service.on('error', () => {});
      if (!await service.resumeSession()) throw new RelayError('LINE 登入已失效，請先重新授權');
      requireRelayEncryption(service);
      const allowed = new Set((await lineDirectory(service)).map(endpoint => endpoint.id));
      if (!service.profile?.mid) throw new Error('Missing LINE identity');
      const check = id => { if (!allowed.has(id)) throw new RelayError('LINE 聊天室已不在群組或好友列表內'); };
      adapters.line = {
        identity: `line:${service.profile.mid}`,
        async prepare(id) { check(id); await prepareRelayDestination(service, id); },
        async recent(id) { check(id); return service.getRecentMessages(id, 50); },
        async read(id, time, known) {
          check(id);
          if (service.loginRequired) throw new RelayError('LINE 登入已失效，請停止後重新授權');
          return readLineSince(service, id, time, known);
        },
        preparePayload: text => typeof text === 'string' ? undefined : telegramMediaClient
          ? telegramMediaClient.downloadPhoto(text) : Promise.reject(new RelayError('Telegram 圖片來源未連結，待送已保留；請重新連結平台')),
        send: (id, text, options) => typeof text === 'string' ? sendRelayText(service, id, text, options) : sendLinePhoto(service, id, text, options.prepared, options),
      };
    } catch (error) { platformErrors.line = error instanceof RelayError ? error.message : 'LINE 連結失敗，請檢查登入、好友列表與 E2EE 金鑰'; }
  }
  if (endpoints.some(endpoint => endpoint.platform === 'telegram')) {
    try {
      const client = createTelegramClient(await store.telegramToken()), me = await client.getMe();
      if (!Number.isSafeInteger(me?.id)) throw new Error('Missing Telegram identity');
      telegramMediaClient = client;
      const sourceIds = config.rules.filter(rule => rule.enabled).flatMap(rule => rule.sources).filter(endpoint => endpoint.platform === 'telegram').map(endpoint => endpoint.id);
      if (sourceIds.length && (await client.getWebhookInfo()).url) throw new RelayError('此 Bot 已設定 webhook，請使用另一個專用 Bot');
      const inbox = await createTelegramInbox(path.join(directory, `lineport-telegram-inbox-${me.id}.jsonl`), client, sourceIds);
      let pollError = sourceIds.length ? 'Telegram 正在等待第一次讀取' : '', polls = 0, lastPoll = null;
      adapters.telegram = {
        identity: `telegram:${me.id}`,
        async prepare(id) { await client.getChat(id); },
        async recent(id) {
          if ((await client.getChat(id)).has_protected_content) throw new RelayError('Telegram 來源禁止轉送');
          return inbox.messages(id);
        },
        async read(id) { if (pollError) throw new RelayError(pollError); return inbox.messages(id); },
        health: () => ({ polls, lastPoll, ...inbox.health() }),
        send: (id, text, options) => client.send(id, text, options),
      };
      if (sourceIds.length) {
        async function receive() {
          try { await inbox.poll(); pollError = ''; polls++; lastPoll = new Date().toISOString(); }
          catch (error) { pollError = error instanceof RelayError ? error.message : 'Telegram 本機收件紀錄失敗，已暫停確認更新'; }
          setTimeout(receive, pollError ? 10000 : 1000);
        }
        void receive();
      }
    } catch (error) { platformErrors.telegram = error instanceof RelayError ? error.message : 'Telegram 連結或本機紀錄失敗，請檢查 Bot 與 webhook 設定'; }
  }
  const relay = await createMultiRelay({ config, adapters, platformErrors, directory });
  Object.assign(state, relay.state);
  async function poll(sourceKeys) {
    try { await relay.tick({ sourceKeys }); Object.assign(state, relay.state); }
    catch { state.phase = 'failed'; state.stage = 'journal'; state.errors++; return; }
    setTimeout(() => void poll(sourceKeys), 3000);
  }
  for (const key of relay.sourceKeys) void poll([key]);
  // Recover persisted queues even while every source is offline.
  void poll([]);
}
