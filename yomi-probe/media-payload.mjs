// Reuse same-Bot Telegram file IDs. No downloads, temporary files or remote URLs.
export function mediaPayload(value) {
  if (!value || !['photo', 'document'].includes(value.kind) || typeof value.fileId !== 'string' || !/^[a-zA-Z0-9_-]{1,1024}$/.test(value.fileId)
    || !Number.isSafeInteger(value.fileSize) || value.fileSize <= 0 || value.fileSize > (value.kind === 'photo' ? 10 : 50) * 1000000
    || typeof value.caption !== 'string' || value.caption.length > 1024) throw new Error('Invalid media payload');
  return { kind: value.kind, fileId: value.fileId, fileSize: value.fileSize, caption: value.caption };
}
export const describePayload = value => typeof value === 'string' ? value : `[Telegram ${value.kind === 'photo' ? '圖片' : '檔案'} · ${value.fileSize} bytes]\n${value.caption}`;
