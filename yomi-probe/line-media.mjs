import { RelayError } from './relay-health.mjs';
import { mediaPayload } from './media-payload.mjs';
import { destinationReply } from './reply-links.mjs';
import { sendRelayText } from './relay-send.mjs';

export async function sendLinePhoto(service, destination, value, prepared, { signal } = {}) {
  const payload = mediaPayload(value);
  if (payload.kind !== 'photo' || !Buffer.isBuffer(prepared?.bytes) || prepared.bytes.length !== payload.fileSize
    || !['image.jpg', 'image.png'].includes(prepared.fileName)) throw new RelayError('圖片未完成安全下載，不能發送');
  const image = await service.sendImage(destination, prepared.bytes, prepared.fileName);
  const imageId = destinationReply('line', destination, image?.messageId);
  if (!imageId) throw new RelayError('LINE 圖片發送未取得有效回應；請核對目的圖片，不要直接重送');
  if (!payload.caption) return { id: imageId, ids: [imageId] };
  if (signal?.aborted) throw new RelayError('圖片回應已逾時，尚未發送說明文字；請核對目的圖片，不要直接重送');
  // LINE's image API has no caption field. A failed second acknowledgement
  // leaves the entire source item uncertain; restart must never resend it.
  let caption;
  try { caption = await sendRelayText(service, destination, payload.caption); }
  catch { throw new RelayError('圖片已取得平台回應，說明文字結果不明；請同時核對圖片與說明，不要直接重送'); }
  const captionId = destinationReply('line', destination, caption?.id);
  if (!captionId) throw new RelayError('圖片已取得平台回應，說明文字結果不明；請同時核對圖片與說明，不要直接重送');
  return { id: captionId, ids: [imageId, captionId] };
}
