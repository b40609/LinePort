import { HttpError } from './local-http.mjs';

const invalid = message => { throw new HttpError(400, message); };
export function normalizeOptions(rule, sources, destinations) {
  const senderAllowlist = {};
  if (rule.senderAllowlist !== undefined) {
    if (!rule.senderAllowlist || typeof rule.senderAllowlist !== 'object' || Array.isArray(rule.senderAllowlist)) invalid('指定發訊者格式不正確');
    for (const [source, ids] of Object.entries(rule.senderAllowlist)) {
      const endpoint = sources.find(value => `${value.platform}:${value.id}` === source);
      if (!endpoint || !Array.isArray(ids) || ids.length > 20 || ids.some(id => typeof id !== 'string' || !(endpoint.platform === 'line' ? /^u[a-zA-Z0-9_-]{1,80}$/ : endpoint.platform === 'telegram' ? /^(?:chat:)?-?[1-9]\d{0,15}$/ : /^[1-9]\d{5,19}$/).test(id))) invalid('指定發訊者需對應來源，最多 20 個有效 ID');
      if (ids.length) senderAllowlist[source] = [...new Set(ids)];
    }
  }
  let schedule = null;
  if (rule.schedule != null) {
    const value = rule.schedule;
    if (value.timezone !== 'Asia/Taipei' || !['hold', 'skip'].includes(value.outside) || !Array.isArray(value.days) || !value.days.length || value.days.some(day => !Number.isInteger(day) || day < 0 || day > 6)
      || !Number.isInteger(value.start) || !Number.isInteger(value.end) || value.start < 0 || value.start >= 1440 || value.end < 0 || value.end >= 1440 || value.start === value.end) invalid('時段需指定台北時間、星期、起訖及時段外保留或略過');
    schedule = { timezone: 'Asia/Taipei', days: [...new Set(value.days)].sort(), start: value.start, end: value.end, outside: value.outside };
  }
  if (rule.media !== undefined && typeof rule.media !== 'boolean') invalid('圖片與檔案設定需為開啟或關閉');
  if (rule.media && [...sources, ...destinations].some(value => value.platform !== 'telegram')) invalid('圖片／檔案目前僅支援同一 Bot 的 Telegram → Telegram；請另建純 Telegram 規則');
  return { senderAllowlist, schedule, media: rule.media === true };
}
export function inSchedule(schedule, timestamp) {
  if (!schedule) return true;
  const date = new Date(timestamp + 8 * 3600000), day = date.getUTCDay(), minute = date.getUTCHours() * 60 + date.getUTCMinutes();
  return schedule.start < schedule.end ? schedule.days.includes(day) && minute >= schedule.start && minute < schedule.end
    : minute >= schedule.start ? schedule.days.includes(day) : minute < schedule.end && schedule.days.includes((day + 6) % 7);
}
export function senderMatches(rule, source, message) {
  const ids = rule.senderAllowlist?.[source];
  return !ids?.length || ids.includes(String(message.from || ''));
}
