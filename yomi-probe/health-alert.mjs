// System health alerts: turn the sanitized relay/account/storage snapshot into a few fixed
// event types, deduplicate them per channel and deliver a safe summary. Alerts carry event
// type, route name, stage, message IDs awaiting review and time only: never tokens, message
// text, sender IDs or raw errors. Delivery failures are swallowed; this runs in the UI
// process on its own timer, so it can never block or break the relay loop.

const clean = value => String(value ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 100);
const READ_FAILURE_LIMIT = 5;

const titles = {
  route_uncertain: '路線已暫停：發送結果不明，需人工核對',
  route_blocked: '路線已暫停',
  route_failed: '路線失敗停止',
  route_quarantined: '有訊息被平台明確拒絕，已單筆隔離（路線繼續運作）',
  relay_failed: '轉送程序失敗',
  line_login_required: 'LINE 登入已失效，需要重新授權',
  source_read_failing: '來源連續讀取失敗，轉送暫停中',
  storage_blocked: '儲存容量已達上限，轉送已停止',
  storage_warning: '儲存容量接近上限（80%）',
};

export function healthEvents({ relay = {}, account = {}, storage = null } = {}) {
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

async function attempt(send, timeoutMs) {
  let timer;
  try {
    await Promise.race([Promise.resolve().then(send), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), timeoutMs); })]);
    return true;
  } catch { return false; }
  finally { clearTimeout(timer); }
}

// channels: [{ name, enabled: async () => boolean, send: async (text, event) => void }]
// A channel resends an unresolved event only when its signature changes or after cooldownMs.
export function createHealthMonitor({ channels, now = Date.now, cooldownMs = 6 * 60 * 60 * 1000, sendTimeoutMs = 20000 }) {
  const states = new Map(channels.map(channel => [channel.name, { active: new Map(), recover: false }]));
  return {
    async check(snapshot = {}) {
      const events = healthEvents(snapshot), at = now(), keys = new Set(events.map(event => event.key)), delivered = [];
      // While the relay is down its routes are absent; keep their alerts until it is back to judge them.
      const relayUp = ['running', 'degraded', 'failed'].includes(snapshot.relay?.phase);
      for (const channel of channels) {
        const state = states.get(channel.name);
        let enabled = false;
        try { enabled = await channel.enabled(); } catch {}
        if (!enabled) { state.active.clear(); state.recover = false; continue; }
        if (relayUp) for (const key of [...state.active.keys()]) if (!keys.has(key)) state.active.delete(key);
        for (const event of events) {
          const previous = state.active.get(event.key);
          if (previous && previous.signature === event.signature && (event.informational || at - previous.sentAt < cooldownMs)) continue;
          // Undelivered alerts are retried on the next check rather than marked sent.
          if (!await attempt(() => channel.send(formatAlert(event, at), event), sendTimeoutMs)) continue;
          state.active.set(event.key, { signature: event.signature, sentAt: at }); if (!event.informational) state.recover = true;
          delivered.push({ channel: channel.name, kind: event.kind });
        }
        if (!events.some(event => !event.informational) && state.recover && snapshot.relay?.phase === 'running'
          && await attempt(() => channel.send(formatRecovery(at), { kind: 'recovered', title: 'LinePort 已恢復' }), sendTimeoutMs)) {
          state.recover = false; for (const [key] of state.active) if (!key.startsWith('quarantine:')) state.active.delete(key); delivered.push({ channel: channel.name, kind: 'recovered' });
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

// Remote channel: reuses the saved Telegram Bot; settings are re-read on every delivery.
export function telegramAlertChannel(settingsStore, telegramFactory) {
  return {
    name: 'telegram',
    async enabled() { return (await settingsStore.healthAlert()).enabled && Boolean(await settingsStore.telegramToken()); },
    async send(text) {
      const settings = await settingsStore.healthAlert();
      const client = telegramFactory(await settingsStore.telegramToken());
      await client.send(settings.telegramChatId, text, settings.telegramThreadId ? { threadId: settings.telegramThreadId } : {});
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
