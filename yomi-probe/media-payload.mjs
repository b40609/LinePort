// Media payloads are references only: never bytes, temporary files or remote URLs.
// payloadVersion 1: Telegram file IDs (same Bot). payloadVersion 2 adds file names,
// unknown sizes (0) and LINE message references that are downloaded at send time.
export const MEDIA_LIMITS = Object.freeze({ photo: 10 * 1000000, document: 50 * 1000000 });
// Telegram Bot API getFile serves at most 20 MB; larger files can only be reused by file ID.
export const TELEGRAM_DOWNLOAD_LIMIT = 20 * 1000000;
// Per destination upload ceilings (decimal MB). Discord's default non-boosted limit is 10 MB.
export const DESTINATION_LIMITS = Object.freeze({
  telegram: Object.freeze({ photo: 10 * 1000000, document: 50 * 1000000 }),
  line: Object.freeze({ photo: 10 * 1000000, document: 50 * 1000000 }),
  discord: Object.freeze({ photo: 10 * 1000000, document: 10 * 1000000 }),
});
export const CAPTION_LIMIT = 4000;

const RESERVED = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i;
// Produce a name that is safe as a single path segment on every platform and in multipart headers.
export function safeFileName(value, fallback = 'file.bin') {
  if (typeof value !== 'string') return fallback;
  let name = value.normalize('NFC').replace(/[\x00-\x1f\x7f<>:"/\\|?*‪-‮⁦-⁩]/g, '_').replace(/\s+/g, ' ').trim();
  name = name.replace(/^[. ]+|[. ]+$/g, '');
  if (!name || /^_+$/.test(name)) return fallback;
  if (RESERVED.test(name)) name = `_${name}`;
  if (name.length > 120) {
    const dot = name.lastIndexOf('.'), ext = dot > 0 && name.length - dot <= 12 ? name.slice(dot) : '';
    name = name.slice(0, 120 - ext.length) + ext;
  }
  return name;
}
const fileNameValid = value => value === undefined || (typeof value === 'string' && value.length > 0 && value.length <= 120 && safeFileName(value, '') === value);
const lineId = value => typeof value === 'string' && /^[ucr][a-zA-Z0-9_-]{1,80}$/.test(value);

export function mediaPayload(value) {
  if (!value || !['photo', 'document'].includes(value.kind) || !Number.isSafeInteger(value.fileSize) || value.fileSize < 0
    || value.fileSize > MEDIA_LIMITS[value.kind] || typeof value.caption !== 'string' || value.caption.length > CAPTION_LIMIT
    || !fileNameValid(value.fileName)) throw new Error('Invalid media payload');
  const base = { kind: value.kind, fileSize: value.fileSize, caption: value.caption, ...(value.fileName ? { fileName: value.fileName } : {}) };
  if (value.source === 'line') {
    if (!lineId(value.chatId) || typeof value.messageId !== 'string' || !/^\d{1,30}$/.test(value.messageId)) throw new Error('Invalid media payload');
    let obs;
    if (value.obs !== undefined) {
      const { oid, sid, keyMaterial } = value.obs || {};
      if (typeof oid !== 'string' || !/^[a-zA-Z0-9_.-]{1,200}$/.test(oid) || typeof sid !== 'string' || !/^[a-zA-Z0-9_-]{1,40}$/.test(sid)
        || keyMaterial !== undefined && (typeof keyMaterial !== 'string' || !/^[A-Za-z0-9+/=_-]{16,200}$/.test(keyMaterial))) throw new Error('Invalid media payload');
      obs = { oid, sid, ...(keyMaterial ? { keyMaterial } : {}) };
    }
    return { source: 'line', ...base, chatId: value.chatId, messageId: value.messageId, ...(obs ? { obs } : {}) };
  }
  if (value.source !== undefined && value.source !== 'telegram') throw new Error('Invalid media payload');
  if (typeof value.fileId !== 'string' || !/^[a-zA-Z0-9_-]{1,1024}$/.test(value.fileId)) throw new Error('Invalid media payload');
  return { ...base, fileId: value.fileId };
}
// Version 1 is kept for every payload an older release can read, so downgrades still parse journals.
export function payloadVersion(payload) {
  return payload.source === undefined && payload.fileSize > 0 && payload.fileName === undefined && payload.caption.length <= 1024 ? 1 : 2;
}
export function journalPayload(version, value) {
  if (version === 1) {
    if (!value || value.source !== undefined || value.fileName !== undefined || !(value.fileSize > 0) || value.caption?.length > 1024) throw new Error('Invalid media payload');
    return mediaPayload(value);
  }
  if (version === 2) return mediaPayload(value);
  throw new Error('Invalid media payload');
}
const sizeLabel = bytes => !bytes ? '大小未知' : bytes >= 1000000 ? `${(bytes / 1000000).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1000))} KB`;
export const mediaLabel = value => `${value.source === 'line' ? 'LINE' : 'Telegram'} ${value.kind === 'photo' ? '圖片' : '檔案'}${value.fileName ? ` ${value.fileName}` : ''} · ${sizeLabel(value.fileSize)}`;
export const describePayload = value => typeof value === 'string' ? value : `[${mediaLabel(value)}]\n${value.caption}`;
// Bytes must be downloaded first unless Telegram can reuse its own file ID.
export const needsDownload = (payload, destinationPlatform) => typeof payload !== 'string' && !(destinationPlatform === 'telegram' && payload.source !== 'line');
// Returns a reason when a payload provably cannot be delivered to the destination; null when it may be attempted.
export function mediaRejection(payload, destinationPlatform) {
  if (typeof payload === 'string') return null;
  const limit = DESTINATION_LIMITS[destinationPlatform]?.[payload.kind];
  if (!limit) return '此目的不支援附件';
  if (payload.fileSize > limit) return `超過${destinationPlatform === 'discord' ? ' Discord' : destinationPlatform === 'line' ? ' LINE' : ' Telegram'} ${limit / 1000000} MB 上限`;
  if (needsDownload(payload, destinationPlatform) && payload.source !== 'line' && payload.fileSize > TELEGRAM_DOWNLOAD_LIMIT) return '超過 Telegram Bot 20 MB 下載上限';
  return null;
}
// A notice delivered instead of an attachment that cannot be transferred; never silently drop the item.
export function mediaNotice(payload, reason) {
  return `${payload.caption ? payload.caption + '\n' : ''}[附件未轉送：${mediaLabel(payload)}；${reason}，請至來源查看]`;
}
export function imageFileName(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image.jpg';
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image.png';
  if (bytes.subarray(0, 6).toString('latin1') === 'GIF89a' || bytes.subarray(0, 6).toString('latin1') === 'GIF87a') return 'image.gif';
  if (bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') return 'image.webp';
  return '';
}
