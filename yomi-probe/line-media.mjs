import { RelayError } from './relay-health.mjs';
import { mediaPayload, safeFileName, imageFileName, MEDIA_LIMITS } from './media-payload.mjs';
import { destinationReply } from './reply-links.mjs';
import { sendRelayText } from './relay-send.mjs';

// LINE content types (Yomi CONTENT_TYPE): 0 text, 1 image, 14 file. Everything else
// (stickers, locations, calls, video, audio, rich/flex, ...) is never forwarded as text.
const LINE_TEXT = 0, LINE_IMAGE = 1, LINE_FILE = 14;
const parseJson = value => { try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' ? parsed : null; } catch { return null; } };

// Decrypted E2EE media messages carry JSON (keyMaterial, fileName) in `text`. Classify by
// contentType so that JSON is never forwarded or matched as a chat message.
export function normalizeLineMessage(message, chatId) {
  if (!message || typeof message !== 'object') return message;
  const contentType = Number(message.contentType ?? LINE_TEXT);
  if (contentType === LINE_TEXT || !Number.isFinite(contentType)) return message;
  const { text: _raw, ...rest } = message;
  const normalized = { ...rest, text: '', lineContentType: contentType };
  if (![LINE_IMAGE, LINE_FILE].includes(contentType) || message.e2eeDecryptFailure) return normalized;
  const metadata = message.contentMetadata || {};
  const data = message.e2eeDecrypted ? parseJson(message.text) || {} : {};
  const fileName = safeFileName(data.fileName || metadata.FILE_NAME || metadata.FILE_NAME_ORIGINAL || '', '');
  const declared = Number(metadata.FILE_SIZE);
  const kind = contentType === LINE_IMAGE ? 'photo' : 'document';
  const fileSize = Number.isSafeInteger(declared) && declared > 0 ? declared : 0;
  const base = { source: 'line', kind, chatId: String(message.chatMid || chatId || ''), messageId: String(message.id || ''), fileSize, caption: '',
    ...(kind === 'document' && fileName ? { fileName } : {}) };
  if (metadata.OID && metadata.SID) base.obs = { oid: String(metadata.OID), sid: String(metadata.SID), ...(typeof data.keyMaterial === 'string' ? { keyMaterial: data.keyMaterial } : {}) };
  try { normalized.media = mediaPayload(base); }
  catch { normalized.media = { kind: 'unsupported', ...(fileSize ? { fileSize } : {}), ...(fileName ? { fileName } : {}), source: 'line' }; }
  return normalized;
}

async function yomiMedia() {
  const [obs, decrypt] = await Promise.all([
    import('./node_modules/@rikaidev/yomi/dist/line/client/obs-media-client.js'),
    import('./node_modules/@rikaidev/yomi/dist/line/core/media-decrypt.js'),
  ]);
  return { downloadObject: obs.downloadLineObsMediaObject, downloadLegacy: obs.downloadLineMessageData, decrypt: decrypt.decryptLineMediaBytes };
}
// Download and (for E2EE) MAC-verify and decrypt one LINE attachment in memory.
export async function downloadLineMedia(service, value, { load = yomiMedia } = {}) {
  const payload = mediaPayload(value);
  if (payload.source !== 'line') throw new RelayError('附件來源不是 LINE，尚未發送；請停止並核對規則');
  const cap = MEDIA_LIMITS[payload.kind];
  if (payload.fileSize > cap) throw Object.assign(new RelayError(`LINE 附件超過 ${cap / 1000000} MB 上限，尚未發送；請至來源查看`), { permanent: true });
  let bytes;
  try {
    const tools = await load();
    if (payload.obs) {
      const encrypted = await tools.downloadObject(service.client, { messageId: payload.messageId, oid: payload.obs.oid, sid: payload.obs.sid, preview: false });
      if (!Buffer.isBuffer(encrypted) || encrypted.length > cap + 64) throw new Error('Unexpected object');
      bytes = payload.obs.keyMaterial ? await tools.decrypt(encrypted, payload.obs.keyMaterial) : encrypted;
    } else {
      bytes = (await tools.downloadLegacy(service.client, { messageId: payload.messageId, preview: false }))?.bytes;
    }
    if (!Buffer.isBuffer(bytes) || !bytes.length) throw new Error('Empty object');
    if (bytes.length > cap) throw Object.assign(new Error('Too large'), { permanent: true });
    if (payload.kind === 'document' && payload.fileSize && bytes.length !== payload.fileSize) throw Object.assign(new Error('Size mismatch'), { permanent: true });
  } catch (error) {
    // A failed MAC check or a size that can never fit is permanent for this attachment; network errors are not.
    throw Object.assign(new RelayError('LINE 附件下載、驗證或解密失敗，尚未呼叫目的發送；待送紀錄已保留，會自動重試，持續失敗請確認 LINE 登入與來源附件'),
      { permanent: error?.permanent === true || error?.name === 'MediaMacVerificationError' });
  }
  if (payload.kind === 'photo') {
    const fileName = imageFileName(bytes);
    if (!fileName) throw Object.assign(new RelayError('LINE 圖片格式無法辨識，尚未發送；待送紀錄已保留，請至來源查看'), { permanent: true });
    return { bytes, fileName };
  }
  return { bytes, fileName: safeFileName(payload.fileName, 'file.bin') };
}

async function sendCaption(service, destination, caption, signal) {
  if (signal?.aborted) throw new RelayError('附件回應已逾時，尚未發送說明文字；請核對目的附件，不要直接重送');
  // LINE's media API has no caption field. A failed second acknowledgement
  // leaves the entire source item uncertain; restart must never resend it.
  let result;
  try { result = await sendRelayText(service, destination, caption); }
  catch { throw new RelayError('附件已取得平台回應，說明文字結果不明；請同時核對附件與說明，不要直接重送'); }
  const captionId = destinationReply('line', destination, result?.id);
  if (!captionId) throw new RelayError('附件已取得平台回應，說明文字結果不明；請同時核對附件與說明，不要直接重送');
  return captionId;
}
// Images use the LINE image API (JPEG/PNG only); every other attachment goes through the E2EE file API.
export async function sendLineMedia(service, destination, value, prepared, { signal } = {}) {
  let payload;
  // Local checks before any LINE request: a failure here means nothing was sent.
  try { payload = mediaPayload(value); } catch { throw Object.assign(new RelayError('附件內容無法組成，尚未發送'), { notSent: true }); }
  if (!Buffer.isBuffer(prepared?.bytes) || !prepared.bytes.length || prepared.bytes.length > MEDIA_LIMITS[payload.kind]
    || typeof prepared.fileName !== 'string' || safeFileName(prepared.fileName, '') !== prepared.fileName
    || payload.fileSize && payload.source !== 'line' && prepared.bytes.length !== payload.fileSize) throw Object.assign(new RelayError('附件未完成安全下載，不能發送'), { notSent: true });
  const asImage = payload.kind === 'photo' && ['image.jpg', 'image.png'].includes(prepared.fileName);
  const media = asImage ? await service.sendImage(destination, prepared.bytes, prepared.fileName)
    : await service.sendFile(destination, prepared.bytes, prepared.fileName);
  const mediaId = destinationReply('line', destination, media?.messageId);
  if (!mediaId) throw new RelayError(`LINE ${asImage ? '圖片' : '檔案'}發送未取得有效回應；請核對目的訊息，不要直接重送`);
  if (!payload.caption) return { id: mediaId, ids: [mediaId] };
  const captionId = await sendCaption(service, destination, payload.caption, signal);
  return { id: captionId, ids: [mediaId, captionId] };
}
// Backwards-compatible name used by older tests and callers.
export async function sendLinePhoto(service, destination, value, prepared, options = {}) {
  const payload = mediaPayload(value);
  if (payload.kind !== 'photo' || !['image.jpg', 'image.png'].includes(prepared?.fileName)) throw new RelayError('圖片未完成安全下載，不能發送');
  return sendLineMedia(service, destination, payload, prepared, options);
}
