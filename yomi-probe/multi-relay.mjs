import path from 'node:path';
import { createHash } from 'node:crypto';
import { appendRecord, loadJournal, establishBaseline } from './relay-core.mjs';
import { unseenText } from './relay-rules.mjs';
import { createSettingsStore, configRevision, endpointKey, chatKey, matchingContent, textRejection } from './route-config.mjs';
import { lineDirectory, readLineSince } from './line-directory.mjs';
import { requireRelayEncryption, inspectRelayRead, relayFailure, RelayError, destinationEncryptionFailure } from './relay-health.mjs';
import { sendRelayText, prepareRelayDestination } from './relay-send.mjs';
import { createTelegramClient, createTelegramInbox, TelegramRateLimit } from './telegram.mjs';
import { createDiscordClient, DiscordRateLimit } from './discord.mjs';
import { inspectDelivery } from './delivery-review.mjs';
import { inSchedule } from './rule-options.mjs';
import { readJournalFile, storageHealth } from './storage-health.mjs';
import { sourceReply, destinationReply } from './reply-links.mjs';
import { sendLinePhoto } from './line-media.mjs';
import { splitTextChunks } from './text-chunk.mjs';

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
      status.stage = 'platform';
      const from = adapters[source.platform], to = adapters[destination.platform];
      if (!from || !to) throw new RelayError(platformErrors[!from ? source.platform : destination.platform] || '此平台尚未連結，請先設定帳號');
      const identity = digest([rule.id, from.identity, sourceKey, to.identity, destinationKey]);
      edge.file = path.join(directory, `lineport-route-${identity}.jsonl`);
      edge.record = row => writeRecord(edge.file, row);
      status.stage = 'journal';
      const saved = await loadJournal(edge.file);
      status.stage = 'route_identity';
      if (saved.routeIdentity && saved.routeIdentity !== identity) throw new Error('Invalid identity');
      edge.seen = saved.seen;
      edge.pending = saved.pending;
      edge.replies = saved.replies;
      edge.delivered = saved.delivered;
      cooldowns.set(destination.platform, Math.max(cooldowns.get(destination.platform) || 0, saved.retryAt));
      status.pending = edge.pending.size;
      edge.startedAt = saved.startedAt || now();
      status.stage = 'journal';
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
      status.stage = destination.platform === 'line' ? 'destination_e2ee' : 'destination_prepare';
      if (!preparations.has(destinationKey)) preparations.set(destinationKey, withDeadline(to.prepare(destination.id, destination), operationTimeoutMs));
      const protection = await preparations.get(destinationKey);
      if (destination.platform === 'line' && ['e2ee', 'transport'].includes(protection)) status.lineProtection = protection;
      if (protection === 'transport' && rule.media) {
        status.stage = 'destination_prepare';
        throw new RelayError('此目的 Bot 群組目前僅支援相容文字傳送；請關閉此規則的圖片／檔案，或另建純文字規則。');
      }
      if (!saved.startedAt) {
        status.stage = 'baseline';
        if (!baselines.has(sourceKey)) baselines.set(sourceKey, withDeadline(from.recent(source.id), operationTimeoutMs));
        const baseline = await baselines.get(sourceKey);
        status.stage = 'journal';
        await establishBaseline({ messages: baseline, startedAt: edge.startedAt, record: edge.record, seen: edge.seen });
      }
      status.phase = 'running'; status.stage = 'waiting';
    } catch (error) {
      status.phase = 'failed'; status.errors++;
      if (status.stage === 'destination_e2ee') Object.assign(status, destinationEncryptionFailure(error instanceof OperationTimeout ? { name: 'TimeoutError' } : error));
      else status.warning = error instanceof RelayError ? error.message : relayFailure(status.stage);
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
          edge.status.lastRead = inspectRelayRead(filtered, edge.seen, edge.startedAt, edge.rule.media);
          const candidates = unseenText(filtered, edge.seen, edge.startedAt, edge.rule.media);
          edge.status.lastRead.matched = candidates.filter(message => textRejection(edge.rule, message, key, Boolean(edge.rule.media && message.media)) === null).length;
          edge.status.lastRead.filtered = candidates.length - edge.status.lastRead.matched;
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
          const id = String(message.id), text = matchingContent(edge.rule, message, endpointKey(edge.source), edge.source);
          if (text === null) {
            await edge.record({ id, outcome: 'baseline' }); edge.seen.add(id); edge.status.skipped++; continue;
          }
          if (edge.destination.platform === 'discord' && typeof text !== 'string') throw new RelayError('Discord 目的只支援純文字發送；請關閉媒體或改選其他目的');
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
      // Telegram topics share the chat's delivery spacing while keeping separate route journals.
      const key = chatKey(edge.destination);
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
              const chunkLimit = edge.destination.platform === 'telegram' ? 4000 : edge.destination.platform === 'discord' ? 1900 : Infinity;
              const chunks = typeof text === 'string' && text.length > chunkLimit ? splitTextChunks(text, chunkLimit) : [text];
              let firstResult = null;
              const allOutputIds = [];
              for (let i = 0; i < chunks.length; i++) {
                if (i > 0) await pause(300);
                const currentText = chunks[i];
                const currentReply = i === 0 ? replyTo : undefined;
                const controller = new AbortController();
                const sendResult = await withDeadline(adapters[edge.destination.platform].send(edge.destination.id, currentText, {
                  ...(prepared ? { ...(i === 0 ? { prepared } : {}), signal: controller.signal } : {}),
                  ...(currentReply ? { replyTo: currentReply } : {}),
                  ...(edge.destination.threadId !== undefined ? { threadId: edge.destination.threadId } : {})
                }), operationTimeoutMs, () => controller.abort());
                if (!sendResult?.id) throw new Error('Missing acknowledgement');
                if (!firstResult) firstResult = sendResult;
                allOutputIds.push(sendResult.id, ...(sendResult.ids || []));
              }
              result = { id: firstResult.id, ids: allOutputIds };
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
              const key = `${adapters[edge.destination.platform].identity}:${chatKey(edge.destination)}:${outputId}`;
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

export async function createLineRelayAdapter(service, endpoints, { downloadPhoto } = {}) {
  service.on('error', () => {});
  if (!await service.resumeSession()) throw new RelayError('LINE 登入已失效，請先重新授權');
  requireRelayEncryption(service);
  const line = endpoints.filter(endpoint => endpoint.platform === 'line');
  const allowed = new Set((await lineDirectory(service, {
    groups: line.some(endpoint => /^[cr]/.test(endpoint.id)),
    contacts: line.some(endpoint => /^u/.test(endpoint.id)),
  })).map(endpoint => endpoint.id));
  const check = id => {
    if (service.loginRequired) throw new RelayError('LINE 登入已失效，請停止後重新授權');
    if (!allowed.has(id)) throw new RelayError('LINE 聊天室已不在群組或好友列表內');
  };
  const protection = new Map();
  return {
    identity: `line:${service.profile.mid}`,
    async prepare(id) {
      check(id); protection.delete(id);
      const mode = await prepareRelayDestination(service, id);
      protection.set(id, mode); return mode;
    },
    async recent(id) { check(id); return service.getRecentMessages(id, 50); },
    async read(id, time, known) { check(id); return readLineSince(service, id, time, known); },
    preparePayload: text => typeof text === 'string' ? undefined : downloadPhoto
      ? downloadPhoto(text) : Promise.reject(new RelayError('Telegram 圖片來源未連結，待送已保留；請重新連結平台')),
    send(id, text, options = {}) {
      check(id);
      if (!protection.has(id)) throw new RelayError('目的聊天室尚未完成準備，請停止後重新啟動轉送');
      if (typeof text === 'string') return sendRelayText(service, id, text, { ...options, transportOnly: protection.get(id) === 'transport' });
      if (protection.get(id) === 'transport') throw new RelayError('Bot 群組相容模式目前僅支援文字');
      return sendLinePhoto(service, id, text, options.prepared, options);
    },
  };
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
      adapters.line = await createLineRelayAdapter(await createLineService(), endpoints, { downloadPhoto: text => telegramMediaClient
        ? telegramMediaClient.downloadPhoto(text) : Promise.reject(new RelayError('Telegram 圖片來源未連結，待送已保留；請重新連結平台')) });
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
        async prepare(id, destination) {
          const chat = await client.getChat(id);
          if (destination.threadId !== undefined && (chat.type !== 'supergroup' || !chat.is_forum)) throw new RelayError('Telegram 目的未開啟群組話題，請停止並重新選擇目的話題');
        },
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
