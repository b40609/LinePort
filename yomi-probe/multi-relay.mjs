import path from 'node:path';
import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { appendRecord, loadJournal, establishBaseline } from './relay-core.mjs';
import { unseenText } from './relay-rules.mjs';
import { createSettingsStore, configRevision, endpointKey, chatKey, matchingContent, textRejection } from './route-config.mjs';
import { lineDirectory, readLineSince, LineHistoryError } from './line-directory.mjs';
import { ProtocolReadError } from './protocol-guard.mjs';
import { requireRelayEncryption, inspectRelayRead, relayFailure, RelayError, destinationEncryptionFailure, FAILURE_KINDS } from './relay-health.mjs';
import { networkFailure } from './network-errors.mjs';
import { formatTime } from './health-alert.mjs';
import { sendRelayText, prepareRelayDestination } from './relay-send.mjs';
import { createTelegramClient, createTelegramInbox, TelegramRateLimit } from './telegram.mjs';
import { createDiscordClient, DiscordRateLimit } from './discord.mjs';
import { inspectDelivery } from './delivery-review.mjs';
import { inSchedule } from './rule-options.mjs';
import { readJournalFile, storageHealth } from './storage-health.mjs';
import { sourceReply, destinationReply } from './reply-links.mjs';
import { sendLineMedia, downloadLineMedia, normalizeLineMessage } from './line-media.mjs';
import { mediaRejection, mediaNotice, payloadVersion, needsDownload } from './media-payload.mjs';
import { splitTextChunks } from './text-chunk.mjs';
import { createDedupeWindow } from './content-dedupe.mjs';

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
// Why a failed send failed, as a fixed word for the journal and the per-route counters (never the error text).
function failureKind(error) {
  if (error instanceof TelegramRateLimit || error instanceof DiscordRateLimit) return 'rate_limit';
  if (error?.unsent === true) return 'unsent';
  if (error?.rejected === true) return error.status >= 400 && error.status < 500 ? 'rejected' : 'server_error';
  if (error?.notSent === true) return 'not_sent';
  if (error instanceof OperationTimeout) return 'timeout';
  if (['timeout', 'network', 'bad_response'].includes(error?.failure)) return error.failure;
  if (error?.message === 'Missing acknowledgement') return 'no_ack';
  return networkFailure(error).failure;
}
// Only fixed, non-identifying details reach the journal: HTTP status and a Node error code.
function failureDetail(error) {
  const code = typeof error?.code === 'string' ? error.code : networkFailure(error).code;
  return { ...(Number.isSafeInteger(error?.status) && error.status >= 100 && error.status <= 599 ? { status: error.status } : {}),
    ...(typeof code === 'string' && /^[A-Z][A-Z0-9_]{2,39}$/.test(code) ? { code } : {}) };
}
// The platform answered with a client error, or a local check failed before any request: nothing was delivered.
const definitelyNotSent = error => error?.notSent === true || error?.rejected === true && error.status >= 400 && error.status < 500;

export async function createMultiRelay({ config, adapters, platformErrors = {}, directory, now = Date.now, pause = sleep, operationTimeoutMs = 30000, queueLimit = 1000, deliveryBudget = 10, writeRecord = appendRecord, resendDelayMs = 30000 }) {
  if (!Number.isSafeInteger(queueLimit) || queueLimit < 1 || !Number.isSafeInteger(deliveryBudget) || deliveryBudget < 1) throw new Error('Invalid queue limits');
  const cursors = new Map();
  const cooldowns = new Map(), cooldownNotes = new Map();
  const dedupe = createDedupeWindow();
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
      phase: 'starting', stage: 'baseline', forwarded: 0, uncertain: 0, errors: 0, skipped: 0, deduplicated: 0, quarantined: 0, resent: 0, retrying: 0, failures: {}, pending: 0, lastSend: null, warning: '' };
    state.routes.push(status);
    const edge = { rule, source, destination, status, seen: new Set(), startedAt: now() };
    edges.push(edge);
    if (!sources.has(sourceKey)) sources.set(sourceKey, { endpoint: source, edges: [], polls: 0, lastPoll: null, received: 0, decryptFailed: 0, warning: '', failures: 0, retryAt: 0, lastNewAt: now() });
    sources.get(sourceKey).edges.push(edge);
    try {
      status.stage = 'platform';
      const from = adapters[source.platform], to = adapters[destination.platform];
      if (!from || !to) throw new RelayError(platformErrors[!from ? source.platform : destination.platform] || '此平台尚未連結，請先設定帳號');
      const identity = digest([rule.id, from.identity, sourceKey, to.identity, destinationKey]);
      edge.file = path.join(directory, `lineport-route-${identity}.jsonl`); edge.identity = identity;
      edge.record = row => writeRecord(edge.file, row);
      status.stage = 'journal';
      const saved = await loadJournal(edge.file);
      status.stage = 'route_identity';
      if (saved.routeIdentity && saved.routeIdentity !== identity) throw new Error('Invalid identity');
      edge.seen = saved.seen;
      edge.pending = saved.pending;
      edge.replies = saved.replies;
      edge.delivered = saved.delivered;
      status.failures = { ...saved.failures };
      cooldowns.set(destination.platform, Math.max(cooldowns.get(destination.platform) || 0, saved.retryAt));
      status.pending = edge.pending.size;
      edge.startedAt = saved.startedAt || now();
      status.stage = 'journal';
      if (!saved.routeIdentity) await edge.record({ routeIdentity: identity, name: rule.name, source, destination });
      // A stalled route writes nothing more, so the journal's last write approximates the first attempt's time.
      let stalledAt = 0;
      try { stalledAt = Math.floor((await stat(edge.file)).mtimeMs); } catch {}
      const reviewed = await inspectDelivery(directory, identity);
      const unresolved = reviewed.unresolved;
      edge.pending = reviewed.pending;
      edge.doubts = reviewed.doubts; edge.times = reviewed.times; edge.uncertainAt = reviewed.uncertainAt;
      // A manual fast-forward treats everything before the decision as history for this route.
      if (reviewed.fastForwardAt > edge.startedAt) { edge.startedAt = reviewed.fastForwardAt; status.fastForwardAt = new Date(reviewed.fastForwardAt).toISOString(); }
      status.pending = edge.pending.size;
      if (reviewed.quarantined.length) { status.quarantined = reviewed.quarantined.length; status.quarantineIds = reviewed.quarantined.slice(-5).map(row => row.id); }
      // User decision 2026-11-27 (SECURITY.md): a text whose single attempt ended unknown is resent once,
      // marked as a possible duplicate. Attachments, and a text whose resend was unknown too, wait for a person.
      const manual = [...unresolved].filter(id => !resendable(edge, id));
      if (manual.length) {
        status.phase = 'blocked'; status.stage = 'send_uncertain'; status.uncertain = unresolved.size; status.uncertainIds = [...manual, ...[...unresolved].filter(id => !manual.includes(id))].slice(0, 5);
        status.warning = '有發送結果不明的訊息，已暫停此路線；請停止轉送，到人工處理逐筆核對。附件與已自動重送過一次的文字不會再自動重送。';
        continue;
      }
      if (unresolved.size) {
        for (const id of unresolved) if (!edge.uncertainAt.has(id) && stalledAt) edge.uncertainAt.set(id, stalledAt);
        holdForResend(edge);
        status.retryAt = edge.holdUntil;
        status.retrying = 1;
        status.warning = edge.holdNote;
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
      status.phase = 'running'; status.stage = edge.holdStage || 'waiting';
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
    state.sources = [...sources.entries()].map(([key, source]) => ({ ...source.endpoint, polls: source.polls, lastPoll: source.lastPoll, received: source.received, decryptFailed: source.decryptFailed, warning: source.warning,
      consecutiveErrors: source.consecutiveErrors || 0, loginRequired: Boolean(source.loginRequired), pollIntervalMs: pollDelay(key) }));
    state.phase = edges.every(edge => ['failed', 'blocked'].includes(edge.status.phase)) ? 'failed'
      : edges.some(edge => edge.status.phase !== 'running' || edge.status.warning) || [...sources.values()].some(source => source.warning && !source.historyOnly) ? 'degraded' : 'running';
    state.warning = state.phase === 'running' ? '' : '部分路線受阻，請查看各路線與來源狀態';
    state.stage = 'waiting';
  }
  // LINE reads cost a protocol request each; slow down when nothing is happening, never when something is.
  function pollDelay(key) {
    const source = sources.get(key);
    if (!source || source.endpoint.platform !== 'line') return 3000;
    const time = now(), live = source.edges.filter(edge => edge.status.phase === 'running');
    if (!live.length) return 3000;
    const idle = time - (source.lastNewAt || time);
    if (idle < 10 * 60000) return 3000;
    if (live.every(edge => edge.rule.schedule && !inSchedule(edge.rule.schedule, time))) return 30000;
    const minute = Math.floor((time + 8 * 3600000) / 60000) % 1440;
    if (minute >= 60 && minute < 360) return 30000; // 01:00-06:00 Asia/Taipei
    return idle < 30 * 60000 ? 10000 : 15000;
  }
  // Soft dead-letter: a message the platform definitively rejected for its own content (never an
  // uncertain send) is set aside with an audit row so later messages keep flowing. More than three in
  // a row suggests a configuration problem, so the route pauses instead.
  async function quarantine(edge, id, error, phase) {
    if (error?.permanent !== true || (edge.quarantineStreak || 0) >= 3) return false;
    edge.quarantineStreak = (edge.quarantineStreak || 0) + 1;
    const reason = String(error.message || '平台拒絕').replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 200);
    await writeRecord(path.join(directory, `lineport-review-${edge.identity}.jsonl`), { version: 3, id, decision: 'skip', quarantined: true, phase, reason, at: now() });
    edge.pending.delete(id); edge.seen.add(id);
    edge.status.quarantined++; edge.status.quarantinedSinceStart = (edge.status.quarantinedSinceStart || 0) + 1; edge.status.quarantineIds = [...(edge.status.quarantineIds || []), id].slice(-5);
    edge.status.stage = 'waiting';
    return true;
  }
  function resendable(edge, id) { return typeof edge.pending.get(id) === 'string' && edge.doubts.get(id) === 1; }
  function recordFailure(edge, kind) {
    const safe = FAILURE_KINDS.includes(kind) ? kind : 'unknown';
    edge.status.failures[safe] = (edge.status.failures[safe] || 0) + 1;
  }
  function clearHold(edge) { edge.holdUntil = 0; edge.holdFailures = 0; edge.holdNote = ''; edge.holdStage = ''; }
  // Nothing was delivered: keep the item queued and try again later (5 s doubling to 5 min) instead of
  // stopping the route. The health monitor alerts once the same item has failed three times in a row.
  function defer(edge, error, stage) {
    edge.holdFailures = (edge.holdFailures || 0) + 1;
    edge.holdUntil = now() + Math.min(300000, 5000 * 2 ** Math.min(edge.holdFailures - 1, 6));
    edge.holdStage = stage;
    edge.holdNote = `${error instanceof RelayError ? error.message : relayFailure(stage)}；訊息確定尚未送出，待送已保留，自動重試中（連續第 ${edge.holdFailures} 次）`;
    edge.status.errors++;
  }
  function holdForResend(edge) {
    edge.holdUntil = now() + resendDelayMs; edge.holdFailures = 0; edge.holdStage = 'resend_pending';
    edge.holdNote = '發送結果不明；稍後會加註「可能重複」自動重送一次，重送結果仍不明才暫停';
  }
  function settleAttempt(edge, id) {
    const doubt = (edge.doubts.get(id) || 0) - 1;
    if (doubt > 0) edge.doubts.set(id, doubt); else edge.doubts.delete(id);
  }
  // First line of the one automatic resend, so readers can tell a possible duplicate from a new message.
  function duplicateNotice(edge, id) {
    const sourceTime = edge.times.get(id), firstTry = edge.uncertainAt.get(id);
    return `⚠️ 可能重複：前一次發送結果不明，系統自動重送一次（${sourceTime ? `原訊息時間 ${formatTime(sourceTime)}` : firstTry ? `原訊息時間不明，首次發送約 ${formatTime(firstTry)}` : '原訊息時間不明'}）`;
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
        // Each active route must have handled the message or be unable to forward it.
        const known = message => {
          const time = Number(message.createdTime || message.deliveredTime);
          const hasText = typeof message.text === 'string' && Boolean(message.text.trim());
          return live.every(edge => edge.seen.has(String(message.id)) || time < edge.startedAt
            || (Number.isFinite(time) && !message.e2eeDecryptFailure && !hasText && !(edge.rule.media && message.media)));
        };
        // A checkpoint must be durable for every active route, not merely ignored.
        known.checkpoint = message => {
          const time = Number(message.createdTime || message.deliveredTime);
          return live.every(edge => edge.seen.has(String(message.id)) || time < edge.startedAt);
        };
        // Keep an outstanding read after timeout: retry must not spawn overlapping requests.
        source.pendingRead ||= Promise.resolve().then(() => adapters[source.endpoint.platform].read(source.endpoint.id, oldest, known));
        const messages = await withDeadline(source.pendingRead, operationTimeoutMs);
        source.pendingRead = null;
        source.retryAt = 0; source.consecutiveErrors = 0; source.loginRequired = false;
        if (messages === null) {
          source.warning = 'LINE 正在分批補讀歷史訊息';
          source.historyOnly = false;
          return;
        }
        const health = adapters[source.endpoint.platform].health?.();
        if (health) { source.polls = health.polls; source.lastPoll = health.lastPoll; }
        else { source.polls++; source.lastPoll = new Date(now()).toISOString(); }
        state.polls = [...sources.values()].reduce((sum, value) => sum + value.polls, 0);
        state.lastPoll = [...sources.values()].map(value => value.lastPoll).filter(Boolean).sort().at(-1) || null;
        source.received = messages.length;
        source.decryptFailed = messages.filter(message => message.e2eeDecryptFailure && Number(message.createdTime || message.deliveredTime) >= oldest).length;
        source.warning = source.decryptFailed ? '來源有文字無法解密，請確認 E2EE 金鑰' : health?.warning || '';
        source.historyOnly = false;
        const filtered = messages.filter(message => !outputs.has(`${adapters[source.endpoint.platform].identity}:${key}:${message.id}`));
        batches.set(key, filtered);
        // Any message some live route has not handled yet counts as activity for adaptive polling.
        if (live.some(edge => unseenText(filtered, edge.seen, edge.startedAt, edge.rule.media).length)) source.lastNewAt = now();
        // Items queued by an older release carry no source time; pick it up while the message is still readable.
        for (const edge of live) for (const message of messages) {
          const id = String(message?.id), time = Number(message?.createdTime || message?.deliveredTime);
          if (edge.pending.has(id) && !edge.times.has(id) && Number.isSafeInteger(time) && time > 0) edge.times.set(id, time);
        }
        for (const edge of live) {
          edge.status.lastRead = inspectRelayRead(filtered, edge.seen, edge.startedAt, edge.rule.media);
          const candidates = unseenText(filtered, edge.seen, edge.startedAt, edge.rule.media);
          edge.status.lastRead.matched = candidates.filter(message => textRejection(edge.rule, message, key, Boolean(edge.rule.media && message.media)) === null).length;
          edge.status.lastRead.filtered = candidates.length - edge.status.lastRead.matched;
        }
        if (!source.warning && live.some(edge => edge.status.lastRead.invalidTime > 0)) source.warning = '來源有訊息缺少有效時間，已略過；請回報此狀態供排查';
        if (!source.warning && live.some(edge => edge.status.lastRead.history > 0)) {
          source.warning = '來源有早於此路線首次啟動的歷史訊息，已依規則略過';
          source.historyOnly = true;
        }
      } catch (error) {
        if (!(error instanceof OperationTimeout)) source.pendingRead = null;
        source.failures++; source.consecutiveErrors = (source.consecutiveErrors || 0) + 1;
        source.retryAt = now() + Math.min(60000, 3000 * 2 ** Math.min(source.consecutiveErrors - 1, 5));
        source.historyOnly = false;
        source.loginRequired = error?.loginRequired === true;
        if (error instanceof LineHistoryError) {
          source.warning = 'LINE 歷史補讀游標無法前進，稍後重試';
        } else if (error instanceof ProtocolReadError) {
          source.warning = error.code === 'network_timeout' ? 'LINE 網路請求逾時，稍後重試' : 'LINE API 未回傳可用資料，稍後重試';
        } else {
          source.warning = error instanceof RelayError ? error.message : '來源讀取失敗，稍後重試';
        }
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
          // Opt-in: the same announcement from another source already went to this destination recently.
          if (edge.rule.dedupe && typeof text === 'string' && !message.media
            && dedupe.duplicate(endpointKey(edge.destination), message.text, Number(message.createdTime || message.deliveredTime), edge.rule.dedupe.windowMinutes * 60000)) {
            await edge.record({ id, outcome: 'baseline' }); edge.seen.add(id); edge.status.skipped++; edge.status.deduplicated++; continue;
          }
          let content = text;
          // Attachments that provably exceed this destination's limits become a visible notice instead.
          const rejection = mediaRejection(text, edge.destination.platform);
          if (rejection) content = mediaNotice(text, rejection);
          const parent = edge.rule.replies ? sourceReply(message, edge.source.platform, edge.source.id) : null;
          const reply = parent ? { replyVersion: 1, replyTo: parent } : {};
          const sourceTime = Number(message.createdTime || message.deliveredTime), time = Number.isSafeInteger(sourceTime) && sourceTime > 0 ? { time: sourceTime } : {};
          await edge.record(typeof content === 'string' ? { id, outcome: 'queued', text: content, ...reply, ...time } : { id, outcome: 'media_queued', payloadVersion: payloadVersion(content), payload: content, ...reply, ...time });
          if (time.time) edge.times.set(id, time.time);
          if (parent) edge.replies.set(id, parent);
          edge.pending.set(id, content); edge.seen.add(id);
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
          if (candidate.status.phase === 'running' && candidate.pending.size && inSchedule(candidate.rule.schedule, now()) && !(cooldowns.get(candidate.destination.platform) > now()) && !(candidate.holdUntil > now())) { edge = candidate; break; }
        }
        if (!edge) break;
        const status = edge.status;
        try {
          {
            const [id, rawPayload] = edge.pending.entries().next().value;
            const isResend = resendable(edge, id);
            const text = isResend ? `${duplicateNotice(edge, id)}\n${rawPayload}` : rawPayload;
            if (attempted) await pause(1100);
            if (cooldowns.get(edge.destination.platform) > now() || edge.holdUntil > now() || !inSchedule(edge.rule.schedule, now())) break;
            status.stage = 'prepare';
            // Attachments may take longer to download and upload than a text message.
            const deadline = typeof text === 'string' ? operationTimeoutMs : operationTimeoutMs * 4;
            let prepared;
            try {
              prepared = adapters[edge.destination.platform].preparePayload
                ? await withDeadline(adapters[edge.destination.platform].preparePayload(text), deadline) : undefined;
            } catch (error) {
              recordFailure(edge, failureKind(error));
              // Nothing was sent yet: an attachment that can never be prepared is quarantined; definite auth/config
              // errors stop cleanly; transient download failures back off (5 s doubling to 5 min) up to 6 attempts.
              if (await quarantine(edge, id, error, 'prepare')) { clearHold(edge); continue; }
              if (error?.loginRequired === true || definitelyNotSent(error)) {
                clearHold(edge);
                status.phase = 'failed';
                status.stage = error?.loginRequired === true ? 'login_required' : error?.rejected === true ? 'destination_rejected' : 'prepare';
                if (error?.loginRequired === true) status.loginRequired = true;
                status.errors++;
                status.warning = `${error instanceof RelayError ? error.message : relayFailure(status.stage)}；訊息確定尚未送出，待送已保留，排除問題後重新啟動即可續送。`;
                continue;
              }
              defer(edge, error, 'prepare');
              if (edge.holdFailures >= 6) {
                const note = error instanceof RelayError ? error.message : relayFailure('prepare');
                clearHold(edge);
                status.phase = 'failed'; status.stage = 'prepare';
                status.warning = `${note}；連續重試 6 次仍失敗，已暫停此路線，請檢查來源附件與連線後重新啟動。`;
              } else {
                status.stage = 'waiting';
              }
              continue;
            }
            status.stage = 'journal';
            await edge.record({ id, outcome: 'sending', ...(isResend ? { resend: true } : {}) });
            edge.doubts.set(id, (edge.doubts.get(id) || 0) + 1);
            edge.seen.add(id);
            status.stage = 'send';
            const parent = edge.replies.get(id);
            const replyTo = edge.rule.replies && parent ? destinationReply(edge.destination.platform, edge.destination.id, edge.delivered.get(parent)) : undefined;
            status.replyNotice = parent && !replyTo ? '原訊息未轉送、尚未確認送達或沒有可用對照；這則改送一般訊息，不補送原訊息' : replyTo ? (edge.destination.platform === 'line' ? '引用此路線已確認送達的原訊息；引用失敗會暫停此路線，請先確認平台狀態' : '引用此路線已確認送達的原訊息；平台找不到原訊息時可能改送一般訊息') : '';
            let result, deliveredChunks = 0;
            try {
              attempted = true;
              attemptedDestinations.add(destinationKey);
              const chunkLimit = edge.destination.platform === 'telegram' ? 4000 : edge.destination.platform === 'discord' ? 1900 : Infinity;
              const chunks = typeof text === 'string' && text.length > chunkLimit ? splitTextChunks(text, chunkLimit) : [text];
              let firstResult = null;
              const allOutputIds = [];
              for (let i = 0; i < chunks.length; i++) {
                if (i > 0) await pause(1100);
                const currentText = chunks[i];
                const currentReply = i === 0 ? replyTo : undefined;
                const controller = new AbortController();
                const sendResult = await withDeadline(adapters[edge.destination.platform].send(edge.destination.id, currentText, {
                  ...(prepared ? { ...(i === 0 ? { prepared } : {}), signal: controller.signal } : {}),
                  ...(currentReply ? { replyTo: currentReply } : {}),
                  ...(edge.destination.threadId !== undefined ? { threadId: edge.destination.threadId } : {})
                }), deadline, () => controller.abort());
                if (!sendResult?.id) throw new Error('Missing acknowledgement');
                deliveredChunks++;
                if (!firstResult) firstResult = sendResult;
                allOutputIds.push(sendResult.id, ...(sendResult.ids || []));
              }
              result = { id: firstResult.id, ids: allOutputIds };
            } catch (error) {
              if ((edge.destination.platform === 'telegram' && error instanceof TelegramRateLimit || edge.destination.platform === 'discord' && error instanceof DiscordRateLimit) && deliveredChunks === 0) {
                recordFailure(edge, 'rate_limit');
                settleAttempt(edge, id);
                const retryAt = Math.max(cooldowns.get(edge.destination.platform) || 0, now() + error.retryAfterMs);
                await edge.record({ id, outcome: 'retry', retryAt, failure: 'rate_limit' });
                cooldowns.set(edge.destination.platform, retryAt);
                cooldownNotes.delete(edge.destination.platform);
                status.stage = 'waiting';
                break;
              }
              // A definite per-message rejection with nothing delivered is quarantined, never retried or resent.
              if (error?.rejected === true && deliveredChunks === 0 && await quarantine(edge, id, error, 'send')) {
                recordFailure(edge, 'rejected');
                edge.doubts.delete(id); clearHold(edge);
                continue;
              }
              // Only a request that provably never left this machine may be retried; any delivered chunk
              // means a retry would duplicate it without a notice, so that case falls through to uncertain.
              if (error?.unsent === true && deliveredChunks === 0) {
                recordFailure(edge, 'unsent');
                settleAttempt(edge, id);
                edge.unsentFailures = (edge.unsentFailures || 0) + 1;
                const retryAt = Math.max(cooldowns.get(edge.destination.platform) || 0, now() + Math.min(300000, 5000 * 2 ** Math.min(edge.unsentFailures - 1, 6)));
                await edge.record({ id, outcome: 'retry', retryAt, failure: 'unsent', ...failureDetail(error) });
                cooldowns.set(edge.destination.platform, retryAt);
                cooldownNotes.set(edge.destination.platform, error.message);
                status.stage = 'waiting';
                break;
              }
              // Pre-send validation failures and chat/auth 4xx rejections delivered nothing: resolve the sending
              // row with a retry record, fail the route for attention, and keep the item queued verbatim.
              if ((definitelyNotSent(error) || error?.loginRequired === true) && deliveredChunks === 0) {
                const kind = failureKind(error);
                recordFailure(edge, kind);
                settleAttempt(edge, id); clearHold(edge);
                await edge.record({ id, outcome: 'retry', retryAt: Math.max(1, now()), failure: kind, ...failureDetail(error) });
                status.phase = 'failed';
                status.stage = error?.loginRequired === true ? 'login_required' : error?.rejected === true ? 'destination_rejected' : 'send_not_sent';
                if (error?.loginRequired === true) status.loginRequired = true;
                status.errors++;
                status.warning = `${error instanceof RelayError ? error.message : relayFailure(status.stage)}；訊息確定尚未送出，待送已保留，排除問題後重新啟動即可續送。`;
                continue;
              }
              const kind = failureKind(error), at = now();
              recordFailure(edge, kind);
              if (!edge.uncertainAt.has(id)) edge.uncertainAt.set(id, at);
              await edge.record({ id, outcome: 'uncertain', at, failure: kind, ...failureDetail(error) });
              if (resendable(edge, id)) {
                holdForResend(edge);
                status.errors++;
                status.stage = 'resend_pending';
                continue;
              }
              clearHold(edge);
              status.uncertain = edge.doubts.size;
              status.uncertainIds = [...edge.doubts.keys()].slice(-5);
              status.stage = 'send_uncertain'; status.phase = 'blocked'; status.errors++;
              status.warning = (error instanceof RelayError ? error.message + '；' : '')
                + (typeof rawPayload === 'string' ? '自動重送一次後結果仍不明，已暫停此路線，請核對目的訊息；其他路線繼續。' : '附件發送結果不明，已暫停此路線，請核對目的訊息（附件不自動重送）；其他路線繼續。');
              continue;
            }
            status.stage = 'journal';
            for (const outputId of new Set([result.id, ...(result.ids || [])])) {
              const key = `${adapters[edge.destination.platform].identity}:${chatKey(edge.destination)}:${outputId}`;
              await writeRecord(outputFile, { key }); outputs.add(key);
            }
            const acknowledged = destinationReply(edge.destination.platform, edge.destination.id, result.id);
            await edge.record({ id, outcome: 'sent', ...(acknowledged ? { destinationId: acknowledged } : {}), ...(isResend ? { resent: true } : {}) });
            if (acknowledged) edge.delivered.set(id, acknowledged);
            edge.pending.delete(id); edge.doubts.delete(id); edge.times.delete(id); edge.uncertainAt.delete(id);
            clearHold(edge); edge.unsentFailures = 0; edge.quarantineStreak = 0;
            status.forwarded++; if (isResend) status.resent++; status.lastSend = new Date(now()).toISOString();
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
      const platformRetry = cooldowns.get(edge.destination.platform) > now() ? cooldowns.get(edge.destination.platform) : 0;
      const holdRetry = edge.holdUntil > now() ? edge.holdUntil : 0;
      edge.status.retryAt = Math.max(platformRetry, holdRetry);
      edge.status.retrying = holdRetry || platformRetry && edge.pending.size ? 1 : 0;
      if (edge.status.phase === 'running') {
        if (holdRetry) {
          edge.status.warning = edge.holdNote;
          if (edge.holdStage === 'resend_pending') edge.status.stage = 'resend_pending';
        } else if (platformRetry) {
          edge.status.warning = cooldownNotes.get(edge.destination.platform) || `${edge.destination.platform === 'discord' ? 'Discord' : 'Telegram'} 限流中，待送訊息已保存，等待後自動重試`;
        } else if (edge.pending.size && !inSchedule(edge.rule.schedule, now())) {
          edge.status.warning = '時段外，已保留待送；進入時段後自動處理';
        } else if (edge.pending.size >= Math.ceil(queueLimit * 0.8)) {
          edge.status.warning = `待送佇列接近容量（${edge.pending.size}/${queueLimit}）；未入列的訊息將於後續補讀`;
        } else {
          edge.status.warning = capacity.warning;
        }
      }
    }
    refresh();
  }
  return { state, tick, pollDelay, sourceKeys: [...sources.keys()] };
}

export async function createLineRelayAdapter(service, endpoints, { downloadPhoto, downloadMedia = downloadPhoto } = {}) {
  service.on('error', () => {});
  if (!await service.resumeSession()) throw new RelayError('LINE 登入已失效，請先重新授權');
  requireRelayEncryption(service);
  const line = endpoints.filter(endpoint => endpoint.platform === 'line');
  const allowed = new Set((await lineDirectory(service, {
    groups: line.some(endpoint => /^[cr]/.test(endpoint.id)),
    contacts: line.some(endpoint => /^u/.test(endpoint.id)),
  })).map(endpoint => endpoint.id));
  const check = id => {
    if (service.loginRequired) throw Object.assign(new RelayError('LINE 登入已失效，請停止後重新授權'), { loginRequired: true });
    if (!allowed.has(id)) throw new RelayError('LINE 聊天室已不在群組或好友列表內');
  };
  const protection = new Map();
  const scans = new Map();
  // Classify media and non-text messages before any matching, paging or journaling sees them.
  const reader = {
    getRecentMessages: async (id, count) => (await service.getRecentMessages(id, count)).map(message => normalizeLineMessage(message, id)),
    getPreviousMessages: async (id, count, before) => (await service.getPreviousMessages(id, count, before)).map(message => normalizeLineMessage(message, id)),
  };
  return {
    identity: `line:${service.profile.mid}`,
    async prepare(id) {
      check(id); protection.delete(id);
      const mode = await prepareRelayDestination(service, id);
      protection.set(id, mode); return mode;
    },
    async recent(id) { check(id); return (await service.getRecentMessages(id, 50)).map(message => normalizeLineMessage(message, id)); },
    async read(id, time, known) {
      check(id);
      if (!scans.has(id)) scans.set(id, { messages: new Map() });
      try {
        const messages = await readLineSince(reader, id, time, known, { progress: scans.get(id) });
        if (messages !== null) scans.delete(id);
        return messages;
      } catch (error) {
        if (error instanceof LineHistoryError) scans.delete(id);
        throw error;
      }
    },
    downloadMedia: payload => downloadLineMedia(service, payload),
    preparePayload: text => typeof text === 'string' ? undefined : text.source === 'line' ? downloadLineMedia(service, text) : downloadMedia
      ? downloadMedia(text) : Promise.reject(new RelayError('Telegram 附件來源未連結，待送已保留；請重新連結平台')),
    send(id, text, options = {}) {
      try {
        check(id);
        if (!protection.has(id)) throw new RelayError('目的聊天室尚未完成準備，請停止後重新啟動轉送');
        if (typeof text !== 'string' && protection.get(id) === 'transport') {
          throw new RelayError('Bot 群組相容模式目前僅支援文字；請關閉此規則的圖片／檔案，或另建純文字規則');
        }
      } catch (error) {
        throw Object.assign(error, { notSent: true });
      }
      if (typeof text === 'string') return sendRelayText(service, id, text, { ...options, transportOnly: protection.get(id) === 'transport' });
      return sendLineMedia(service, id, text, options.prepared, options);
    },
  };
}

export async function runMultiRelay(state, directory, { createLineService }) {
  const store = createSettingsStore(directory), config = await store.load();
  if (configRevision(config) !== process.env.LINEPORT_CONFIG_REVISION) throw new RelayError('規則已變動，請停止後重新啟動');
  const endpoints = config.rules.filter(rule => rule.enabled).flatMap(rule => [...rule.sources, ...rule.destinations]);
  const adapters = {}, platformErrors = {};
  let telegramMediaClient;
  // Attachments are fetched from the platform that received them, only when a destination needs bytes.
  const downloadMedia = payload => payload.source === 'line'
    ? adapters.line?.downloadMedia ? adapters.line.downloadMedia(payload) : Promise.reject(new RelayError('LINE 附件來源未連結，待送已保留；請重新授權 LINE'))
    : telegramMediaClient ? telegramMediaClient.downloadMedia(payload) : Promise.reject(new RelayError('Telegram 附件來源未連結，待送已保留；請重新連結平台'));
  if (endpoints.some(endpoint => endpoint.platform === 'discord')) {
    try {
      const client = createDiscordClient(await store.discordToken()), me = await client.getMe();
      adapters.discord = { identity: `discord:${me.id}`, prepare: id => client.getChannel(id), send: (id, text, options) => client.send(id, text, options),
        preparePayload: text => needsDownload(text, 'discord') ? downloadMedia(text) : undefined };
    } catch (error) { platformErrors.discord = error instanceof RelayError ? error.message : 'Discord 連結失敗；請檢查 Bot 與目的頻道權限'; }
  }
  if (endpoints.some(endpoint => endpoint.platform === 'line')) {
    try {
      adapters.line = await createLineRelayAdapter(await createLineService(), endpoints, { downloadMedia });
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
        preparePayload: text => needsDownload(text, 'telegram') ? downloadMedia(text) : undefined,
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
    setTimeout(() => void poll(sourceKeys), sourceKeys.length === 1 ? relay.pollDelay(sourceKeys[0]) : 3000);
  }
  for (const key of relay.sourceKeys) void poll([key]);
  // Recover persisted queues even while every source is offline.
  void poll([]);
}
