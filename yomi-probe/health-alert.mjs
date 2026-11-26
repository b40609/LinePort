// System health alerts: turn the sanitized relay/account/storage snapshot into fixed event
// types, deduplicate them per channel, record a bounded local delivery log, and deliver a safe
// summary + daily liveness heartbeat. Alerts carry event type, route name, stage, message IDs
// awaiting review and time only: never tokens, message text, sender IDs or raw errors.
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, rename } from 'node:fs/promises';

const clean = value => String(value ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 100);
const READ_FAILURE_LIMIT = 5;
const MAX_ALERT_LOG_LINES = 1000;

const titles = {
  route_uncertain: '路線已暫停：發送結果不明，需人工核對',
  route_blocked: '路線已暫停',
  route_failed: '路線失敗停止',
  route_quarantined: '有訊息被平台明確拒絕，已單筆隔離（路線繼續運作）',
  relay_failed: '轉送程序失敗',
  relay_down: '轉送程序已停止或無回應',
  watchdog_circuit_open: '看門狗連續重啟失敗，已暫停自動重啟',
  line_login_required: 'LINE 登入已失效，需要重新授權',
  source_read_failing: '來源連續讀取失敗，轉送暫停中',
  storage_blocked: '儲存容量已達上限，轉送已停止',
  storage_warning: '儲存容量接近上限（80%）',
};

export function healthEvents({ relay = {}, account = {}, storage = null, relayDown = false, watchdogCircuitAt = '' } = {}) {
  const events = [];
  const routes = Array.isArray(relay.routes) ? relay.routes : [];
  routes.forEach((route, index) => {
    if (!['blocked', 'failed'].includes(route?.phase)) return;
    if (route?.loginRequired === true || route?.stage === 'login_required') return;
    const kind = route.phase === 'failed' ? 'route_failed' : route.stage === 'send_uncertain' ? 'route_uncertain' : 'route_blocked';
    const ids = Array.isArray(route.uncertainIds) ? route.uncertainIds.map(clean).filter(Boolean).slice(-5) : [];
    events.push({ key: `route:${clean(route.key) || index}`, kind, subject: clean(route.name), stage: clean(route.stage), ids,
      signature: [kind, route.stage, Number(route.uncertain) || 0, ids.join(',')].join('|') });
  });
  // Soft dead-letter: informational, alerted once per new quarantined ID during this run.
  routes.forEach((route, index) => {
    const count = Number(route?.quarantinedSinceStart) || 0;
    if (!count) return;
    const ids = Array.isArray(route.quarantineIds) ? route.quarantineIds.map(clean).filter(Boolean).slice(-5) : [];
    events.push({ key: `quarantine:${clean(route.key) || index}`, kind: 'route_quarantined', subject: clean(route.name), ids, informational: true,
      signature: ['route_quarantined', count, ids.join(',')].join('|') });
  });
  if (relay.phase === 'failed' && !routes.length) events.push({ key: 'relay', kind: 'relay_failed', stage: clean(relay.stage), signature: `relay_failed|${relay.stage}` });
  if (relayDown === true) {
    const stage = clean(relay.phase || 'unavailable');
    events.push({ key: 'relay:down', kind: 'relay_down', stage, signature: `relay_down|${stage}` });
  }
  if (typeof watchdogCircuitAt === 'string' && watchdogCircuitAt.trim()) {
    const stamp = clean(watchdogCircuitAt);
    events.push({ key: 'watchdog:circuit', kind: 'watchdog_circuit_open', signature: `watchdog_circuit_open|${stamp}` });
  }
  const sources = Array.isArray(relay.sources) ? relay.sources : [];
  if (account.phase === 'login_required' || sources.some(source => source?.loginRequired === true) || routes.some(route => route?.loginRequired === true || route?.stage === 'login_required')) {
    events.push({ key: 'line:login', kind: 'line_login_required', signature: 'line_login_required' });
  }
  for (const source of sources) {
    if (source?.loginRequired === true || !(Number(source?.consecutiveErrors) >= READ_FAILURE_LIMIT)) continue;
    events.push({ key: `source:${clean(source.platform)}:${clean(source.id)}`, kind: 'source_read_failing', subject: clean(source.name), signature: 'source_read_failing' });
  }
  if (storage?.blocked) events.push({ key: 'storage', kind: 'storage_blocked', signature: 'storage_blocked' });
  else if (storage?.warning) events.push({ key: 'storage', kind: 'storage_warning', signature: 'storage_warning' });
  return events.map(event => ({ ...event, title: titles[event.kind] }));
}

export function formatTime(at) {
  const date = new Date(at), pad = value => String(Math.abs(value)).padStart(2, '0');
  const offset = -date.getTimezoneOffset();
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} (UTC${offset < 0 ? '-' : '+'}${pad(Math.trunc(offset / 60))}:${pad(offset % 60)})`;
}

export function formatAlert(event, at) {
  return ['⚠️ LinePort 健康告警', `事件：${event.title}`,
    ...(event.subject ? [`${event.key.startsWith('source:') ? '來源' : '路線'}：${event.subject}`] : []),
    ...(event.stage ? [`階段：${event.stage}`] : []),
    ...(event.ids?.length ? [`${event.kind === 'route_quarantined' ? '已隔離訊息 ID' : '待核對訊息 ID'}：${event.ids.join(', ')}`] : []),
    `時間：${formatTime(at)}`, '請開啟 LinePort 本機頁面查看與處理。'].join('\n');
}
export const formatRecovery = at => ['✅ LinePort 已恢復', '所有路線恢復正常運作（running）。', `時間：${formatTime(at)}`].join('\n');
export const formatTestAlert = at => ['🔔 LinePort 測試告警', '系統健康告警設定正確，這是測試訊息。', `時間：${formatTime(at)}`].join('\n');

export function formatDailySummary(snapshot, at) {
  const relay = snapshot?.relay || {};
  const routes = Array.isArray(relay.routes) ? relay.routes : [];
  const lastSend = routes.map(r => r?.lastSend).filter(v => typeof v === 'string' && v).sort().at(-1) || '尚無紀錄';
  const routeLines = routes.slice(0, 20).map((r, i) => `路線 ${i + 1}：${clean(r?.phase || 'unknown')}（已送 ${Number(r?.forwarded) || 0}、待送 ${Number(r?.pending) || 0}）`);
  return [
    '📊 LinePort 每日存活摘要',
    `整體狀態：${clean(relay.phase || 'unknown')}`,
    `累計轉送：${Number(relay.forwarded) || 0}（待核對：${Number(relay.uncertain) || 0}）`,
    `最後成功發送：${clean(lastSend)}`,
    ...routeLines,
    `時間：${formatTime(at)}`,
  ].join('\n');
}

function taipeiClock(at) {
  const shifted = new Date(at + 8 * 3600000);
  const pad = v => String(v).padStart(2, '0');
  return {
    date: `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`,
    hour: shifted.getUTCHours(),
  };
}

async function appendAlertLog(directory, row) {
  if (!directory) return;
  const file = path.join(directory, 'lineport-alerts.jsonl');
  try {
    let lines = [];
    try { lines = (await readFile(file, 'utf8')).split('\n').filter(Boolean); } catch (error) { if (error.code !== 'ENOENT') return; }
    lines.push(JSON.stringify(row));
    if (lines.length > MAX_ALERT_LOG_LINES) lines = lines.slice(-MAX_ALERT_LOG_LINES);
    const temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(temporary, lines.join('\n') + '\n', { mode: 0o600, flag: 'wx' });
    await rename(temporary, file);
  } catch {}
}

async function attempt(send, timeoutMs) {
  let timer;
  try {
    await Promise.race([Promise.resolve().then(send), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), timeoutMs); })]);
    return true;
  } catch { return false; }
  finally { clearTimeout(timer); }
}

// Guard against sending operational alerts to a monitored destination topic or sharing the monitored relay Bot.
export function alertTargetConflict(config, settings, { hasDedicatedBot = false, sameAsRelayBot = false } = {}) {
  if (!settings?.telegramChatId) return null;
  if (sameAsRelayBot) return '獨立告警 Bot Token 不可與轉送路線的 Telegram Bot 相同';
  const rules = Array.isArray(config?.rules) ? config.rules : [];
  for (const rule of rules) {
    for (const dest of rule?.destinations || []) {
      if (dest?.platform !== 'telegram' || String(dest.id) !== String(settings.telegramChatId)) continue;
      if (dest.threadId === undefined || settings.telegramThreadId === undefined || dest.threadId === settings.telegramThreadId) {
        return '告警目的地不可與被監控的轉送目的聊天室／話題相同，請改填獨立聊天室或私訊';
      }
    }
  }
  const relayUsesTelegram = rules.some(rule => [...(rule?.sources || []), ...(rule?.destinations || [])].some(ep => ep?.platform === 'telegram'));
  if (relayUsesTelegram && !hasDedicatedBot) {
    return '轉送規則已使用此 Telegram Bot；請設定獨立的告警專用 Bot（alertBotToken）或改用獨立 Webhook，避免與被監控路線共用同一個 Bot';
  }
  return null;
}

// channels: [{ name, enabled: async () => boolean, send: async (text, event) => void }]
// A channel resends an unresolved event only when its signature changes or after cooldownMs.
export function createHealthMonitor({ channels, dataDirectory = null, now = Date.now, cooldownMs = 6 * 60 * 60 * 1000, sendTimeoutMs = 20000 }) {
  const states = new Map(channels.map(channel => [channel.name, { active: new Map(), recover: false, summaryDate: '' }]));
  let downStreak = 0, seededSummary = false;
  async function seedSummaryDates(today) {
    if (seededSummary || !dataDirectory) { seededSummary = true; return; }
    seededSummary = true;
    try {
      const text = await readFile(path.join(dataDirectory, 'lineport-alerts.jsonl'), 'utf8');
      for (const line of text.split('\n').filter(Boolean)) {
        const row = JSON.parse(line);
        if (row?.kind === 'daily_summary' && row?.ok === true && row?.date === today && states.has(row.channel)) {
          states.get(row.channel).summaryDate = today;
        }
      }
    } catch {}
  }
  return {
    async check(snapshot = {}) {
      const phase = snapshot.relay?.phase;
      if (snapshot.relayWanted === true && ['stopped', 'unavailable'].includes(phase)) downStreak++;
      else downStreak = 0;
      const events = healthEvents({ ...snapshot, relayDown: snapshot.relayDown === true || downStreak >= 3 });
      const at = now(), keys = new Set(events.map(event => event.key)), delivered = [];
      // While the relay is down its routes are absent; keep their alerts until it is back to judge them.
      const relayUp = ['running', 'degraded', 'failed'].includes(phase);
      const clock = taipeiClock(at);
      const wantSummary = snapshot.dailySummary === true && clock.hour >= (Number.isSafeInteger(snapshot.dailySummaryHour) ? snapshot.dailySummaryHour : 9);
      if (wantSummary) await seedSummaryDates(clock.date);

      for (const channel of channels) {
        const state = states.get(channel.name);
        let enabled = false;
        try { enabled = await channel.enabled(); } catch {}
        if (!enabled) { state.active.clear(); state.recover = false; continue; }
        if (relayUp) for (const key of [...state.active.keys()]) if (!keys.has(key)) state.active.delete(key);
        for (const event of events) {
          const previous = state.active.get(event.key);
          if (previous && previous.signature === event.signature && (event.informational || at - previous.sentAt < cooldownMs)) continue;
          // Undelivered alerts are retried on the next check rather than marked sent, and every attempt is logged locally.
          const ok = await attempt(() => channel.send(formatAlert(event, at), event), sendTimeoutMs);
          await appendAlertLog(dataDirectory, { at: new Date(at).toISOString(), channel: channel.name, kind: event.kind, ok, ...(event.stage ? { stage: event.stage } : {}) });
          if (!ok) continue;
          state.active.set(event.key, { signature: event.signature, sentAt: at }); if (!event.informational) state.recover = true;
          delivered.push({ channel: channel.name, kind: event.kind });
        }
        if (!events.some(event => !event.informational) && state.recover && phase === 'running') {
          const ok = await attempt(() => channel.send(formatRecovery(at), { kind: 'recovered', title: 'LinePort 已恢復' }), sendTimeoutMs);
          await appendAlertLog(dataDirectory, { at: new Date(at).toISOString(), channel: channel.name, kind: 'recovered', ok });
          if (ok) {
            state.recover = false; for (const [key] of state.active) if (!key.startsWith('quarantine:')) state.active.delete(key);
            delivered.push({ channel: channel.name, kind: 'recovered' });
          }
        }
        if (wantSummary && channel.name !== 'windows' && state.summaryDate !== clock.date) {
          const summaryEvent = { kind: 'daily_summary', title: 'LinePort 每日存活摘要', informational: true };
          const ok = await attempt(() => channel.send(formatDailySummary(snapshot, at), summaryEvent), sendTimeoutMs);
          await appendAlertLog(dataDirectory, { at: new Date(at).toISOString(), date: clock.date, channel: channel.name, kind: 'daily_summary', ok });
          if (ok) {
            state.summaryDate = clock.date;
            delivered.push({ channel: channel.name, kind: 'daily_summary' });
          }
        }
      }
      return delivered;
    },
  };
}

// Runs checks on an unref'd timer; any failure in the snapshot or delivery is contained here.
export function startHealthMonitor({ monitor, snapshot, intervalMs = 60000, delayMs = 15000 }) {
  let timer, stopped = false;
  async function run() {
    try { await monitor.check(await snapshot()); } catch {}
    if (!stopped) { timer = setTimeout(run, intervalMs); timer.unref?.(); }
  }
  timer = setTimeout(run, delayMs); timer.unref?.();
  return () => { stopped = true; clearTimeout(timer); };
}

export function localLogAlertChannel(directory) {
  return {
    name: 'local',
    enabled: async () => Boolean(directory),
    send: async () => {},
  };
}

// Remote Telegram channel: uses a dedicated alert Bot when configured, and refuses to send to a monitored topic or shared Bot.
export function telegramAlertChannel(settingsStore, telegramFactory) {
  async function resolveTarget() {
    const settings = await settingsStore.healthAlert();
    if (!settings.enabled || !settings.telegramChatId) return null;
    const dedicated = settingsStore.alertTelegramToken ? await settingsStore.alertTelegramToken() : '';
    const shared = await settingsStore.telegramToken();
    const token = dedicated || shared;
    if (!token) return null;
    if (settingsStore.load) {
      const config = await settingsStore.load();
      const conflict = alertTargetConflict(config, settings, {
        hasDedicatedBot: Boolean(dedicated),
        sameAsRelayBot: Boolean(dedicated && shared && dedicated === shared),
      });
      if (conflict) return null;
    }
    return { token, settings };
  }
  return {
    name: 'telegram',
    async enabled() { return Boolean(await resolveTarget()); },
    async send(text) {
      const target = await resolveTarget();
      if (!target) throw new Error('Alert target disabled or conflicting');
      const client = telegramFactory(target.token);
      await client.send(target.settings.telegramChatId, text, target.settings.telegramThreadId ? { threadId: target.settings.telegramThreadId } : {});
    },
  };
}

export function webhookAlertChannel(settingsStore, request = fetch) {
  return {
    name: 'webhook',
    async enabled() {
      const settings = await settingsStore.healthAlert();
      return Boolean(settings.enabled && settings.webhookUrl);
    },
    async send(text, event = {}) {
      const settings = await settingsStore.healthAlert();
      if (!settings.webhookUrl) throw new Error('Missing webhook URL');
      const response = await request(settings.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, content: text, kind: event.kind || 'test', at: new Date().toISOString() }),
        signal: AbortSignal.timeout(15000),
        redirect: 'error',
      });
      if (!response.ok) throw new Error(`Webhook HTTP ${response.status}`);
    },
  };
}

export function windowsAlertChannel(notify, platform = process.platform) {
  return {
    name: 'windows',
    enabled: async () => platform === 'win32',
    async send(_text, event) {
      if (!notify(event.kind === 'recovered' ? 'LinePort 已恢復' : 'LinePort 健康告警', [event.title, event.subject].filter(Boolean).join('：'),
        { throttleMs: 0, icon: event.kind === 'recovered' ? 'Info' : 'Warning' })) throw new Error('Notification not shown');
    },
  };
}
